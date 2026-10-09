import crypto from "node:crypto";
import type { BuiltForm, FormEntry, Prisma } from "@prisma/client";
import ExcelJS from "exceljs";
import { prisma } from "../prisma.js";
import { createFormFile, sweepUnattachedFiles } from "../services/fileStore.js";
import { HttpError, badRequest, forbidden, notFound } from "../http.js";
import type { CurrentUser } from "../auth/middleware.js";
import { appBaseUrl } from "../env.js";
import { displayName, recordActivity } from "../services/roster.js";
import { linkOnlyHtml, mailConfigured, sendMail } from "../services/mailer.js";
import { notify } from "../services/notifications.js";
import { TZ, stamp } from "../services/exportCommon.js";
import {
  cleanValues, conditionPasses, formatValue, isEmptyValue, isInputField, renderTemplate, validateValues,
  type Field, type FormDoc, type Values,
} from "./engine.js";
import { readDoc, versionDoc } from "./service.js";

/**
 * Filling in a built form and reading the entries back.
 *
 * Access, in one place:
 *   fill     — the form is live and: public, or anyone signed in, or the person's role is listed
 *   read     — Admin (forms.manage), or a role in the form's entriesRoles; entries made for a
 *              site are further limited to people assigned to that site
 *   void     — can read, and has entries.void (or forms.manage)
 *   edit / delete an entry — forms.manage only
 */

export const DEFAULT_ENTRIES_ROLES = ["main_office", "site_admin", "site_manager"];
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export type Viewer = CurrentUser | undefined;

export function isFormAdmin(user: Viewer) {
  return Boolean(user?.permissions.includes("forms.manage"));
}

export function liveDoc(form: BuiltForm): FormDoc | null {
  return form.liveSchema ? readDoc(form.liveSchema) : null;
}

/** Why this person can't fill the form in, or null if they can. */
export function fillBlocker(form: BuiltForm, doc: FormDoc, user: Viewer): { status: number; message: string } | null {
  if (form.status === "archived" || form.status === "draft" || !form.liveSchema) return { status: 404, message: "This form isn't available." };
  const mode = doc.settings.access?.mode ?? "signed_in";
  if (mode !== "public" && !user) return { status: 401, message: "Sign in to fill in this form." };
  if (mode === "roles" && user && !isFormAdmin(user) && !(doc.settings.access?.roles ?? []).includes(user.roleKey)) {
    return { status: 403, message: "This form is limited to other roles. Ask an administrator if you need it." };
  }
  return null;
}

/** Closed, not open yet, past closing, or full — the message to show instead of the form. */
export async function closedReason(form: BuiltForm, doc: FormDoc, user: Viewer): Promise<string | null> {
  const lim = doc.settings.limits ?? {};
  const closedMsg = lim.closedMessage || "This form isn't taking entries right now.";
  if (form.status === "closed") return closedMsg;
  const now = Date.now();
  if (lim.opensAt && now < Date.parse(lim.opensAt)) return lim.closedMessage || `This form opens ${stamp(new Date(lim.opensAt))}.`;
  if (lim.closesAt && now > Date.parse(lim.closesAt)) return closedMsg;
  if (lim.maxEntries) {
    const n = await prisma.formEntry.count({ where: { formId: form.id, status: "active" } });
    if (n >= lim.maxEntries) return lim.closedMessage || "This form has all the entries it needs.";
  }
  if (lim.perUser && user) {
    const since = periodStart(lim.perUser.period);
    const n = await prisma.formEntry.count({
      where: { formId: form.id, status: "active", createdById: user.userId, ...(since ? { createdAt: { gte: since } } : {}) },
    });
    if (n >= lim.perUser.count) {
      const per = { day: "today", week: "this week", month: "this month", ever: "" }[lim.perUser.period];
      return `You've already filled this in ${lim.perUser.count === 1 ? "" : `${lim.perUser.count} times `}${per}`.trim() + ".";
    }
  }
  return null;
}

/** Midnight at the start of the day / week (Monday) / month, New York time. */
function periodStart(period: "day" | "week" | "month" | "ever"): Date | null {
  if (period === "ever") return null;
  const now = new Date();
  const ny = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  const offset = now.getTime() - ny.getTime();
  const start = new Date(ny);
  start.setHours(0, 0, 0, 0);
  if (period === "week") start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  if (period === "month") start.setDate(1);
  return new Date(start.getTime() + offset);
}

export function canReadEntries(doc: FormDoc, user: Viewer): boolean {
  if (!user) return false;
  if (isFormAdmin(user)) return true;
  return (doc.settings.entriesRoles ?? DEFAULT_ENTRIES_ROLES).includes(user.roleKey);
}

export function canVoidEntries(doc: FormDoc, user: Viewer) {
  return canReadEntries(doc, user) && Boolean(user && (user.permissions.includes("entries.void") || isFormAdmin(user)));
}

/** Entries limited to the person's sites; entries not made for a site stay visible to readers. */
export function entryScope(user: Viewer): Prisma.FormEntryWhereInput {
  const ids = user?.siteIds;
  return ids ? { OR: [{ siteId: null }, { siteId: { in: ids } }] } : {};
}

// ── Submitting ───────────────────────────────────────────────────────────

export interface SubmitInput {
  form: BuiltForm;
  values: Values;
  siteCode?: string | null;
  clientId?: string | null;
  user: Viewer;
  /** Who, when there's no signed-in person (an API key, the MCP server). */
  actorName?: string;
  source: "app" | "public" | "api" | "mcp";
  ip?: string;
  userAgent?: string;
  /** Messages from custom code blocks that reported themselves invalid. */
  codeErrors?: Record<string, string>;
  /** Machine callers with no person: the site ids they may use (null = every site). */
  machineSiteIds?: string[] | null;
  /**
   * The published version the person filled in (the fill page sends it). An
   * entry kept on a device offline can upload after the form is republished; it
   * is checked and stored against the fields the person saw, not the new ones.
   */
  formVersion?: number | null;
}

/** The database refused a second entry with this clientId: a retry that raced the first upload. */
export const isDuplicateClientId = (e: unknown) => (e as { code?: unknown } | null)?.code === "P2002";

/** The published version an entry was filled against: the one sent, if it's an older version that exists, else the live one. */
async function filledVersion(form: BuiltForm, live: FormDoc, sent: number | null | undefined): Promise<{ doc: FormDoc; version: number }> {
  if (sent && Number.isInteger(sent) && sent > 0 && sent < form.liveVersion) {
    const doc = await versionDoc(form.id, sent);
    if (doc) return { doc, version: sent };
  }
  return { doc: live, version: form.liveVersion };
}

type SiteAccess = { user: Viewer; machineSiteIds?: string[] | null };

function siteAllowed(who: SiteAccess, siteId: string) {
  if (!who.user) return who.machineSiteIds === null || (who.machineSiteIds?.includes(siteId) ?? false);
  const ids = who.user.siteIds;
  return ids === null || ids.includes(siteId);
}

/**
 * Check lookups the browser can't be trusted with: a site must be one the
 * person may use, a resident must exist on a roster they can see (and their
 * name and unit are taken from the roster, not the request), and files must
 * have been uploaded to this form's field and not used yet.
 */
async function resolveLookups(doc: FormDoc, form: BuiltForm, values: Values, who: SiteAccess, errors: Record<string, string>) {
  for (const f of doc.fields) {
    const v = values[f.id];
    if (isEmptyValue(v)) continue;
    if (f.type === "site") {
      const site = await prisma.site.findUnique({ where: { code: String(v) } });
      if (!site || !site.active) errors[f.id] = "That site doesn't exist.";
      else if (!siteAllowed(who, site.id)) errors[f.id] = "You aren't assigned to that site.";
    }
    if (f.type === "resident") {
      const id = (v as { id?: string }).id;
      const t = id ? await prisma.tenant.findUnique({ where: { id } }) : null;
      if (!t) errors[f.id] = "That resident isn't on the roster.";
      else if (!siteAllowed(who, t.siteId)) errors[f.id] = "That resident is at a site you aren't assigned to.";
      else values[f.id] = { id: t.id, name: displayName(t), unit: t.unit ?? undefined, siteId: t.siteId };
    }
    if (f.type === "file") {
      const list = v as { id: string }[];
      const rows = await prisma.formFile.findMany({ where: { id: { in: list.map((x) => x.id) }, formId: form.id, fieldId: f.id, entryId: null } });
      if (rows.length !== list.length) errors[f.id] = "A file didn't finish uploading. Remove it and add it again.";
      else values[f.id] = rows.map((r) => ({ id: r.id, name: r.name, size: r.size, mime: r.mime }));
    }
  }
}

export async function submitEntry(input: SubmitInput) {
  const { form, user } = input;
  const doc = liveDoc(form);
  if (!doc) throw notFound("This form isn't available.");
  // A person is held to the form's access rules; an API key or the MCP server
  // was already authorised for forms as a whole, so only needs the form live.
  if (input.source === "app" || input.source === "public") {
    const blocked = fillBlocker(form, doc, user);
    if (blocked) throw new HttpError(blocked.status, blocked.message);
  } else if (form.status === "archived" || form.status === "draft") throw notFound("This form isn't live.");
  // A retried upload gets back the entry it already made — before any limit
  // check, which that very entry would now trip.
  if (input.clientId) {
    const dup = await prisma.formEntry.findFirst({ where: { formId: form.id, clientId: input.clientId } });
    if (dup) return { entry: dup, duplicate: true, doc };
  }
  const closed = await closedReason(form, doc, user);
  if (closed) throw new HttpError(409, closed);

  // Who may fill it in and whether it's taking entries are today's rules (above);
  // the answers are judged by the fields the person was shown.
  const filled = await filledVersion(form, doc, input.formVersion);

  let siteId: string | null = null;
  if (filled.doc.settings.requireSite) {
    if (!input.siteCode) throw badRequest("Pick the site this entry is for.", { errors: { _site: "Pick a site." } });
    const site = await prisma.site.findUnique({ where: { code: input.siteCode } });
    if (!site || !site.active) throw badRequest("That site doesn't exist.");
    if (!siteAllowed({ user, machineSiteIds: input.machineSiteIds }, site.id)) throw forbidden("You aren't assigned to that site.");
    siteId = site.id;
  }

  const values = cleanValues(filled.doc, input.values ?? {});
  const errors = validateValues(filled.doc, values, { codeErrors: input.codeErrors });
  await resolveLookups(filled.doc, form, values, { user, machineSiteIds: input.machineSiteIds }, errors);
  // A form without a required site but with a Site field: the entry belongs to that site.
  if (!siteId) {
    const siteField = filled.doc.fields.find((f) => f.type === "site" && values[f.id]);
    if (siteField) siteId = (await prisma.site.findUnique({ where: { code: String(values[siteField.id]) }, select: { id: true } }))?.id ?? null;
  }
  if (Object.keys(errors).length) throw new HttpError(422, "Some answers need fixing.", { errors });

  const actorName = user?.name ?? input.actorName ?? "Public visitor";
  let entry: FormEntry;
  try {
    entry = await prisma.formEntry.create({
      data: {
        formId: form.id,
        formVersion: filled.version,
        data: JSON.stringify(values),
        siteId,
        source: input.source,
        // None sent (the MCP server): the database makes one.
        clientId: input.clientId || undefined,
        createdById: user?.userId ?? null,
        createdByName: actorName,
        ip: input.ip?.slice(0, 64) ?? null,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
      },
    });
  } catch (e) {
    // The same upload sent twice at once (a retry while the first was still
    // being saved): both passed the check above, and the database let one in.
    const dup = input.clientId && isDuplicateClientId(e) ? await prisma.formEntry.findFirst({ where: { formId: form.id, clientId: input.clientId } }) : null;
    if (dup) return { entry: dup, duplicate: true, doc };
    throw e;
  }
  const fileIds = filled.doc.fields.filter((f) => f.type === "file").flatMap((f) => ((values[f.id] as { id: string }[] | undefined) ?? []).map((x) => x.id));
  if (fileIds.length) await prisma.formFile.updateMany({ where: { id: { in: fileIds } }, data: { entryId: entry.id } });

  // The roster hears that these residents were seen.
  for (const f of filled.doc.fields) {
    if (f.type !== "resident" || f.logActivity === false) continue;
    const r = values[f.id] as { id?: string } | undefined;
    if (r?.id) {
      await recordActivity({ tenantId: r.id, source: "form", label: form.title, externalRef: `${entry.id}:${f.id}`, occurredAt: entry.createdAt, recordedBy: actorName }).catch((err) =>
        console.error(`[forms] roster activity for entry ${entry.id} failed:`, err)
      );
    }
  }

  // Notifications go out after the response; their outcome is noted on the entry.
  // Today's notification settings, with the fields the answers belong to.
  const notifyDoc = filled.doc === doc ? doc : { ...doc, fields: filled.doc.fields };
  void runNotifications(form, notifyDoc, entry, values, user).catch((err) => console.error(`[forms] notifications for entry ${entry.id} failed:`, err));
  return { entry, duplicate: false, doc };
}

export const entryUrl = (slug: string, id: string) => `${appBaseUrl}/f/${slug}/entries/${id}`;

/** Merge tags a subject may use: the form, entry, site, person and date. Answers ({field_id}, {all_fields}) are left out. */
const SUBJECT_TAGS = new Set(["form", "entry", "user", "site", "date"]);

function linkOnlySubject(tpl: string | undefined, ctx: Parameters<typeof renderTemplate>[1]) {
  const noAnswers = (tpl || "New entry: {form:title}").replace(/\{([a-z][a-z0-9_]*)(?:([.:])([a-z0-9_]+))?\}/gi, (whole, key: string, sep?: string, sub?: string) =>
    sep === ":" && SUBJECT_TAGS.has(key.toLowerCase()) && sub !== "value" ? whole : ""
  );
  return renderTemplate(noAnswers, { ...ctx, html: false }).replace(/\s{2,}/g, " ").trim().slice(0, 200) || `New entry: ${ctx.doc.title}`;
}

async function runNotifications(form: BuiltForm, doc: FormDoc, entry: FormEntry, values: Values, user: Viewer) {
  const site = entry.siteId ? await prisma.site.findUnique({ where: { id: entry.siteId }, select: { name: true, code: true } }) : null;
  for (const n of doc.settings.notifications ?? []) {
    if (!n.enabled || !conditionPasses(n.conditional, values)) continue;
    const ctx = { values, doc, user: user ? { name: user.name, email: user.email } : null, entry: { id: entry.id, createdAt: entry.createdAt }, site, entryUrl: entryUrl(form.slug, entry.id) };
    let note: string;
    try {
      if (n.kind === "webhook") {
        const body = JSON.stringify({
          event: "form.entry.created",
          form: { id: form.id, slug: form.slug, title: form.title, version: entry.formVersion },
          entry: {
            id: entry.id,
            createdAt: entry.createdAt,
            createdBy: entry.createdByName,
            site: site?.code ?? null,
            url: ctx.entryUrl,
            values,
            display: Object.fromEntries(doc.fields.filter((f) => isInputField(f) && values[f.id] !== undefined).map((f) => [f.label || f.id, formatValue(f, values[f.id])])),
          },
        });
        const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "LanternForms/1" };
        if (n.secret) headers["X-Lantern-Signature"] = `sha256=${crypto.createHmac("sha256", n.secret).update(body).digest("hex")}`;
        const res = await fetch(n.url!, { method: "POST", headers, body, signal: AbortSignal.timeout(8000) });
        note = res.ok ? `Webhook “${n.name}” delivered (${res.status}).` : `Webhook “${n.name}” failed: the server answered ${res.status}.`;
      } else if (n.kind === "notify") {
        // In the app, behind sign-in, so the body may carry answers. The title
        // may be emailed (each person's choice), so it gets the subject's rules.
        const users = renderTemplate(n.to, { ...ctx, html: false }).split(/[,;\s]+/).map((s) => s.trim()).filter((s) => s.includes("@"));
        const roles = n.roles ?? [];
        if (!users.length && !roles.length) note = `Notification “${n.name}” not sent: nobody to send it to.`;
        else {
          const out = await notify({
            to: { users, roles, sites: n.siteOnly && roles.length && entry.siteId ? [entry.siteId] : undefined },
            type: "forms.entry",
            title: linkOnlySubject(n.subject, ctx),
            body: renderTemplate(n.body, { ...ctx, html: false }) || null,
            link: (n.link && renderTemplate(n.link, { ...ctx, html: false }).trim()) || ctx.entryUrl,
            source: `form:${form.slug}`,
            sourceLabel: form.title,
            formId: form.id,
            maxRecipients: 500,
          });
          note = `Notification “${n.name}” sent to ${out.sent} ${out.sent === 1 ? "person" : "people"}${out.muted ? ` (${out.muted} had turned these off)` : ""}${out.unknown?.length ? `; no account for ${out.unknown.join(", ")}` : ""}.`;
        }
      } else {
        const to = renderTemplate(n.to, ctx).split(/[,;\s]+/).map((s) => s.trim()).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
        if (!to.length) note = `Email “${n.name}” not sent: no valid address in “${n.to}”.`;
        else if (!mailConfigured()) note = `Email “${n.name}” to ${to.join(", ")} not sent: email isn't set up on this server (MAIL_FROM).`;
        else {
          // Link-only: the entry's answers never go in an email (a saved body is ignored).
          await sendMail({
            to,
            subject: linkOnlySubject(n.subject, ctx),
            html: linkOnlyHtml(`There's a new entry in “${form.title}”${site ? ` for ${site.name}` : ""}.`, ctx.entryUrl),
            replyTo: user?.email,
          });
          note = `Email “${n.name}” sent to ${to.join(", ")}.`;
        }
      }
    } catch (err) {
      note = `${n.kind === "webhook" ? "Webhook" : n.kind === "notify" ? "Notification" : "Email"} “${n.name}” failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    await prisma.formEntryNote.create({ data: { entryId: entry.id, kind: "system", authorName: "System", body: note.slice(0, 2000) } });
  }
}

// ── Files ────────────────────────────────────────────────────────────────

export async function saveUpload(form: BuiltForm, doc: FormDoc, fieldId: string, file: { name: string; mime: string; data: Buffer }) {
  const f = doc.fields.find((x) => x.id === fieldId && x.type === "file");
  if (!f) throw badRequest("That form has no such file field.");
  const cap = Math.min(MAX_FILE_BYTES, (f.maxSizeMb ?? 10) * 1024 * 1024);
  if (file.data.length === 0) throw badRequest("That file is empty.");
  if (file.data.length > cap) throw new HttpError(413, `Files can be at most ${Math.round(cap / 1024 / 1024)} MB.`);
  if (f.accept && !acceptOk(f.accept, file.name, file.mime)) throw badRequest(`This field takes ${f.accept} files.`);
  // Anything uploaded but never submitted, after a day, is swept here — cheap and needs no scheduler.
  await sweepUnattachedFiles();
  return createFormFile({ formId: form.id, fieldId, name: file.name.slice(0, 200), mime: file.mime.slice(0, 100) || "application/octet-stream", data: file.data });
}

function acceptOk(accept: string, name: string, mime: string) {
  const lower = name.toLowerCase();
  return accept.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).some((a) => {
    if (a.startsWith(".")) return lower.endsWith(a);
    if (a.endsWith("/*")) return mime.toLowerCase().startsWith(a.slice(0, -1));
    return mime.toLowerCase() === a;
  });
}

// ── Reading ──────────────────────────────────────────────────────────────

export interface EntryFilter {
  q?: string;
  from?: string;
  to?: string;
  status?: "active" | "voided" | "all";
  starred?: boolean;
  site?: string;
}

export function entryWhere(form: BuiltForm, user: Viewer, filter: EntryFilter): Prisma.FormEntryWhereInput {
  const and: Prisma.FormEntryWhereInput[] = [{ formId: form.id }, entryScope(user)];
  if (filter.status !== "all") and.push({ status: filter.status ?? "active" });
  if (filter.starred) and.push({ starred: true });
  if (filter.from) and.push({ createdAt: { gte: nyDayStart(filter.from) } });
  if (filter.to) and.push({ createdAt: { lt: new Date(nyDayStart(filter.to).getTime() + 86_400_000) } });
  if (filter.site) and.push({ siteId: filter.site });
  if (filter.q?.trim()) {
    const q = filter.q.trim();
    and.push({ OR: [{ data: { contains: q } }, { createdByName: { contains: q } }, { id: q }] });
  }
  return { AND: and };
}

function nyDayStart(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badRequest("Dates are YYYY-MM-DD.");
  const probe = new Date(`${day}T12:00:00Z`);
  const ny = new Date(probe.toLocaleString("en-US", { timeZone: TZ }));
  const utc = new Date(probe.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(Date.parse(`${day}T00:00:00Z`) + (utc.getTime() - ny.getTime()));
}

export function entryRow(e: FormEntry & { site?: { name: string; code: string } | null; _count?: { notes: number } }) {
  return {
    id: e.id,
    formVersion: e.formVersion,
    values: JSON.parse(e.data) as Values,
    site: e.site ?? null,
    source: e.source,
    status: e.status,
    starred: e.starred,
    createdByName: e.createdByName,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    updatedByName: e.updatedByName,
    voidedAt: e.voidedAt,
    voidedByName: e.voidedByName,
    voidReason: e.voidReason,
    noteCount: e._count?.notes,
  };
}

/** The document an entry was filled against (falls back to the live one). */
export async function docForEntry(form: BuiltForm, version: number): Promise<FormDoc> {
  return (await versionDoc(form.id, version)) ?? liveDoc(form) ?? readDoc(form.draftSchema);
}

/**
 * Change an entry's answers (Admin only). Validated like a submission, except
 * that admin-only fields are editable; each change is written as a note.
 */
export async function updateEntry(form: BuiltForm, entry: FormEntry, incoming: Values, editorName: string) {
  const doc = await docForEntry(form, entry.formVersion);
  const before = JSON.parse(entry.data) as Values;
  const values = cleanValues(doc, { ...before, ...incoming }, { includeAdminOnly: true });
  // Files and residents keep what they were unless explicitly replaced with the same shape.
  for (const f of doc.fields) if ((f.type === "file" || f.type === "resident" || f.type === "signature") && !(f.id in incoming) && before[f.id] !== undefined) values[f.id] = before[f.id];
  const errors = validateValues(doc, values, { includeAdminOnly: true });
  for (const f of doc.fields) if (f.type === "file" || f.type === "signature") delete errors[f.id];
  if (Object.keys(errors).length) throw new HttpError(422, "Some answers need fixing.", { errors });
  const changed = doc.fields.filter((f) => isInputField(f) && JSON.stringify(before[f.id] ?? null) !== JSON.stringify(values[f.id] ?? null));
  if (!changed.length) return entry;
  const updated = await prisma.formEntry.update({ where: { id: entry.id }, data: { data: JSON.stringify(values), updatedByName: editorName } });
  await prisma.formEntryNote.create({
    data: {
      entryId: entry.id,
      kind: "system",
      authorName: editorName,
      body: `Edited: ${changed.map((f) => `${f.label || f.id} (“${clip(formatValue(f, before[f.id]))}” → “${clip(formatValue(f, values[f.id]))}”)`).join("; ")}`.slice(0, 4000),
    },
  });
  return updated;
}

const clip = (s: string) => (s.length > 80 ? `${s.slice(0, 77)}…` : s || "empty");

// ── Export ───────────────────────────────────────────────────────────────

/** Columns for an export: one per answer (name/address split into parts), then the record's own. */
function exportColumns(doc: FormDoc): { header: string; get: (v: Values) => string }[] {
  const cols: { header: string; get: (v: Values) => string }[] = [];
  for (const f of doc.fields) {
    if (!isInputField(f) || f.type === "signature") continue;
    const label = f.label || f.id;
    if (f.type === "name" || f.type === "address") {
      const parts = (f.type === "name" ? f.nameParts ?? ["first", "last"] : f.addressParts ?? ["line1", "line2", "city", "state", "zip"]) as string[];
      for (const p of parts) cols.push({ header: `${label} (${p})`, get: (v) => String(((v[f.id] ?? {}) as Record<string, unknown>)[p] ?? "") });
    } else if (f.type === "resident") {
      cols.push({ header: label, get: (v) => formatValue(f, v[f.id]) });
      cols.push({ header: `${label} (roster id)`, get: (v) => String((v[f.id] as { id?: string } | undefined)?.id ?? "") });
    } else cols.push({ header: label, get: (v) => formatValue(f as Field, v[f.id]) });
  }
  if (doc.fields.some((f) => f.type === "signature")) cols.push({ header: "Signed", get: (v) => (doc.fields.some((f) => f.type === "signature" && v[f.id]) ? "Yes" : "") });
  return cols;
}

export async function exportEntries(form: BuiltForm, doc: FormDoc, where: Prisma.FormEntryWhereInput, format: "csv" | "xlsx") {
  const rows = await prisma.formEntry.findMany({ where, orderBy: { createdAt: "desc" }, take: 50_000 });
  const sites = new Map((await prisma.site.findMany({ select: { id: true, name: true } })).map((s) => [s.id, s.name]));
  const cols = exportColumns(doc);
  const header = ["Entry ID", "Submitted", "Submitted by", "Site", ...cols.map((c) => c.header), "Status", "Void reason"];
  const data = rows.map((e) => {
    const v = JSON.parse(e.data) as Values;
    return [e.id, stamp(e.createdAt), e.createdByName, e.siteId ? sites.get(e.siteId) ?? "" : "", ...cols.map((c) => c.get(v)), e.status, e.voidReason ?? ""];
  });
  const base = `${form.slug}-entries-${new Date().toISOString().slice(0, 10)}`;
  if (format === "csv") {
    const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    // A leading BOM so Excel opens the UTF-8 correctly.
    const text = "﻿" + [header, ...data].map((r) => r.map((c) => esc(String(c ?? ""))).join(",")).join("\r\n");
    return { filename: `${base}.csv`, mime: "text/csv; charset=utf-8", body: Buffer.from(text, "utf8") };
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = "Lantern Forms";
  const ws = wb.addWorksheet("Entries", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.addRow(header);
  ws.getRow(1).font = { bold: true };
  for (const r of data) ws.addRow(r);
  ws.columns.forEach((c, i) => (c.width = Math.min(50, Math.max(12, header[i].length + 2))));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: header.length } };
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  return { filename: `${base}.xlsx`, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: buf };
}
