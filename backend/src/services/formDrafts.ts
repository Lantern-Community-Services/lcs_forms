import type { BuiltForm, FormDraft } from "@prisma/client";
import { prisma } from "../prisma.js";
import { HttpError, forbidden, notFound, unauthorized } from "../http.js";
import type { CurrentUser } from "../auth/middleware.js";
import { isInputField, type Field, type FormDoc, type Values } from "../forms/engine.js";
import { fillBlocker, liveDoc } from "../forms/entries.js";
import { findForm } from "../forms/service.js";

/**
 * Unfinished answers to a basic form, kept on the server so they can be picked
 * up on another device (FormDraft). The fill page saves them as people type,
 * a few seconds apart, and still keeps its own copy on the device for when
 * there's no connection (components/formkit/serverDrafts.ts).
 *
 * They can hold clinical answers, so only the person who started one ever
 * reads it: not Admins, not someone viewing the site as them, and nothing
 * else (entries, exports, the MCP server) knows the table is there.
 *
 * Never for a form filled in signed out (public) or through a link, nor when
 * the form turns drafts off (settings.saveDrafts false). Signatures and files
 * aren't kept: a signature is a large picture, and an uploaded file that isn't
 * on an entry is swept after a day (services/fileStore.ts), so a draft would
 * only point at nothing. Both are asked for again on resuming.
 */

const DAY = 86_400_000;
/** Drafts not saved for this long are swept. */
export const DRAFT_KEEP_DAYS = 30;
/** The most unfinished copies one person keeps of one form. */
export const MAX_DRAFTS_PER_FORM = 20;
/** Drafts are typed answers; anything near the request limit (1 MB, app.ts) is something else. */
const MAX_VALUES_CHARS = 900_000;
/** Not kept in a draft (see above). */
const NOT_KEPT = new Set(["signature", "file"]);

export const DRAFT_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Why this form can't keep drafts on the server, or null if it can. */
export function draftsOffReason(doc: FormDoc): string | null {
  const mode = doc.settings.access?.mode ?? "signed_in";
  if (mode === "public" || mode === "link") return "Unfinished answers aren't saved for forms filled in without signing in.";
  if (doc.settings.saveDrafts === false) return "This form doesn't keep unfinished answers.";
  return null;
}

/** The person whose drafts these are: signed in, as themselves. */
function owner(user: CurrentUser | undefined): CurrentUser {
  if (!user) throw unauthorized("Sign in to keep unfinished answers.");
  // Viewing (or acting) as someone shows the site as they see it, but their drafts stay theirs.
  if (user.viewAs) throw forbidden("Unfinished answers are only shown to the person filling the form in.");
  return user;
}

/**
 * The form, for reading or saving drafts: live, one this person may fill in,
 * and one that keeps drafts.
 */
export async function draftForm(slug: string, user: CurrentUser | undefined): Promise<{ form: BuiltForm; doc: FormDoc; me: CurrentUser }> {
  const me = owner(user);
  const form = await findForm(slug);
  const doc = liveDoc(form);
  if (!doc) throw notFound("This form isn't available.");
  const blocked = fillBlocker(form, doc, me);
  if (blocked) throw new HttpError(blocked.status, blocked.message);
  const off = draftsOffReason(doc);
  if (off) throw forbidden(off);
  return { form, doc, me };
}

/**
 * The answers worth keeping: the form's own questions only, without signatures
 * and files (neither can be inside a repeater, forms/engine.ts). `dropped` says
 * whether any were left out.
 */
export function draftValues(doc: Pick<FormDoc, "fields">, values: Values): { values: Values; dropped: boolean } {
  const out: Values = {};
  let dropped = false;
  for (const f of doc.fields) {
    const v = values[f.id];
    if (!isInputField(f) || v === undefined) continue;
    if (NOT_KEPT.has(f.type)) {
      if (v !== "" && v !== null && !(Array.isArray(v) && !v.length)) dropped = true;
      continue;
    }
    out[f.id] = v;
  }
  return { values: out, dropped };
}

/** The resident picked (the first Resident question answered), to tell one draft from another. */
function residentName(doc: Pick<FormDoc, "fields">, values: Values): string | null {
  for (const f of doc.fields as Field[]) {
    if (f.type !== "resident") continue;
    const name = (values[f.id] as { name?: unknown } | undefined)?.name;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return null;
}

export function draftLabel(doc: Pick<FormDoc, "fields">, values: Values, asked?: string | null): string {
  return (asked?.trim() || residentName(doc, values) || "Draft").slice(0, 120);
}

/**
 * A draft as the list shows it: no answers. `writer` (the open copy of the form that saved
 * it last) lets the device tell its own last save from another device's.
 */
export function draftSummary(d: FormDraft) {
  return { id: d.id, label: d.label, siteCode: d.siteCode, page: d.page, formVersion: d.formVersion, writer: d.writer, createdAt: d.createdAt, updatedAt: d.updatedAt };
}

export function draftFull(d: FormDraft) {
  let values: Values = {};
  try {
    const v = JSON.parse(d.values) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) values = v as Values;
  } catch {
    /* unreadable: resumes empty rather than failing */
  }
  return { ...draftSummary(d), values };
}

export function listDrafts(form: BuiltForm, me: CurrentUser) {
  return prisma.formDraft.findMany({ where: { formId: form.id, userId: me.userId }, orderBy: { updatedAt: "desc" }, take: MAX_DRAFTS_PER_FORM });
}

/** One of this person's drafts of this form; anyone else's (or another form's) isn't there. */
export async function ownDraft(form: BuiltForm, me: CurrentUser, id: string) {
  const d = await prisma.formDraft.findUnique({ where: { id } });
  if (!d || d.userId !== me.userId || d.formId !== form.id) throw notFound("That draft isn't there any more.");
  return d;
}

export interface DraftSave {
  values: Values;
  label?: string | null;
  siteCode?: string | null;
  page?: number;
  formVersion?: number | null;
  /** The open copy of the form saving it (random per page load). */
  writer: string;
  /** When the draft was last saved, as this copy last heard (null: it thinks the draft is new). */
  base?: string | null;
}

/**
 * Save a draft under the id the device made: a new one, or over the old one.
 *
 * Two copies of the same draft open at once (an iPad left on it since
 * yesterday, the desktop it was carried on with today): a copy that saves
 * over answers it never saw is refused (409, reason "changed"), and the page
 * keeps its answers as a separate draft instead. Nothing is overwritten
 * unseen, and nothing is lost.
 */
export async function saveDraft(form: BuiltForm, doc: FormDoc, me: CurrentUser, id: string, input: DraftSave) {
  const { values, dropped } = draftValues(doc, input.values);
  const text = JSON.stringify(values);
  if (text.length > MAX_VALUES_CHARS) throw new HttpError(413, "These answers are too long to save to your account. They're still kept on this device.");
  const data = {
    values: text,
    label: draftLabel(doc, values, input.label),
    siteCode: input.siteCode?.slice(0, 80) || null,
    page: Math.max(0, Math.min(500, Math.floor(input.page ?? 0))),
    formVersion: input.formVersion ?? form.liveVersion,
    writer: input.writer,
  };
  const old = await prisma.formDraft.findUnique({ where: { id } });
  if (old) {
    if (old.userId !== me.userId || old.formId !== form.id) throw notFound("That draft isn't there any more.");
    const base = input.base ? Date.parse(input.base) : NaN;
    if (old.writer !== input.writer && (Number.isNaN(base) || old.updatedAt.getTime() > base)) {
      throw new HttpError(409, "These answers were changed on another device too.", { reason: "changed", updatedAt: old.updatedAt });
    }
    const row = await prisma.formDraft.update({ where: { id }, data });
    return { draft: draftSummary(row), dropped };
  }
  const count = await prisma.formDraft.count({ where: { formId: form.id, userId: me.userId } });
  if (count >= MAX_DRAFTS_PER_FORM) {
    throw new HttpError(409, `You have ${MAX_DRAFTS_PER_FORM} unfinished copies of this form saved. Finish or discard one to save another.`, { reason: "full" });
  }
  try {
    const row = await prisma.formDraft.create({ data: { id, formId: form.id, userId: me.userId, ...data } });
    return { draft: draftSummary(row), dropped };
  } catch (e) {
    // The same new draft sent twice at once (a save and the page closing): both found nothing, one got in.
    if ((e as { code?: string }).code !== "P2002") throw e;
    const row = await prisma.formDraft.findUnique({ where: { id } });
    if (!row || row.userId !== me.userId || row.formId !== form.id || row.writer !== input.writer) throw notFound("That draft isn't there any more.");
    return { draft: draftSummary(await prisma.formDraft.update({ where: { id }, data })), dropped };
  }
}

/** Discard one of this person's drafts. Needs no more than being signed in as its owner (the form may have closed since). */
export async function discardDraft(slug: string, user: CurrentUser | undefined, id: string) {
  const me = owner(user);
  const form = await findForm(slug);
  const { count } = await prisma.formDraft.deleteMany({ where: { id, userId: me.userId, formId: form.id } });
  return count > 0;
}

/** The entry a draft became was filed: the draft goes (also when it came from the device's offline queue). */
export async function dropSubmittedDraft(form: BuiltForm, user: CurrentUser | undefined, id: string | null | undefined) {
  if (!user || user.viewAs || !id) return;
  await prisma.formDraft.deleteMany({ where: { id, userId: user.userId, formId: form.id } }).catch((err) => console.error(`[drafts] couldn't remove a filed draft:`, err));
}

/** Drafts nobody has saved for DRAFT_KEEP_DAYS days. */
export async function sweepOldDrafts(now = Date.now()) {
  const { count } = await prisma.formDraft.deleteMany({ where: { updatedAt: { lt: new Date(now - DRAFT_KEEP_DAYS * DAY) } } });
  return count;
}

let timer: NodeJS.Timeout | null = null;

/** Once a day (and a minute after start-up): drop drafts left alone for a month. */
export function startDraftSweep() {
  if (timer) return;
  const tick = () =>
    void sweepOldDrafts()
      .then((n) => n && console.log(`[drafts] removed ${n} unfinished draft${n === 1 ? "" : "s"} not saved for ${DRAFT_KEEP_DAYS} days.`))
      .catch((err) => console.error("[drafts] sweep failed:", err));
  timer = setInterval(tick, DAY);
  timer.unref();
  setTimeout(tick, 60_000).unref();
}
