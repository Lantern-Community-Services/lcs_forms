import crypto from "node:crypto";
import type { BuiltForm, FormEntry, Prisma, Site, Tenant } from "@prisma/client";
import { prisma } from "../prisma.js";
import { HttpError, badRequest, forbidden, notFound } from "../http.js";
import type { CurrentUser } from "../auth/middleware.js";
import { displayName, recordActivity } from "../services/roster.js";
import { canReadEntries as canReadBasicEntries } from "../forms/entries.js";
import { readDoc } from "../forms/service.js";
import { buildProject, type Build } from "./compile.js";
import { runInSandbox, type SandboxResult } from "./sandbox.js";
import { DEFAULT_ENTRY_READERS, readManifest, roleAllowed, type Files, type Manifest } from "./project.js";
import * as time from "./time.js";
import { appBaseUrl } from "../env.js";
import { attachFiles, filesToAttach } from "./files.js";
import { queueEmail } from "./email.js";
import type { Request } from "express";
import { createEvent, deleteEvent, eventInput, formEvents, loadOccurrences, scopeSchema, setEventPending, updateEvent, type FormOwner } from "../services/calendar.js";
import { noteCalendarChange } from "../services/outlookSync.js";
import { roleFor } from "../services/permissions.js";
import { enqueueJob, jobsFor, retryJob } from "./jobs.js";

/**
 * A code form at runtime: who can do what (from form.json), entries,
 * collections and server actions. The REST routes (routes/apps.ts) and the MCP
 * server call these; pages reach them through the SDK in the browser.
 */

export interface LoadedApp {
  form: BuiltForm;
  files: Files;
  manifest: Manifest;
  build: Build;
  draft: boolean;
}

export class BuildError extends HttpError {
  constructor(problems: unknown) {
    super(422, "The code form doesn't build — fix the errors and try again.", { problems });
  }
}

export const isDeveloper = (u: CurrentUser | undefined) => Boolean(u && (u.permissions.includes("apps.develop") || u.permissions.includes("forms.manage")));

export async function findCodeForm(slugOrId: string): Promise<BuiltForm> {
  const form = await prisma.builtForm.findFirst({ where: { kind: "code", OR: [{ slug: slugOrId }, { id: slugOrId }] } });
  if (!form) throw notFound("No such code form.");
  return form;
}

/** The draft (developers, built on demand) or the published version. */
export async function loadApp(form: BuiltForm, draft: boolean): Promise<LoadedApp> {
  if (draft || !form.liveSchema) {
    if (!draft) throw notFound("This form hasn't been published yet.");
    const files = (JSON.parse(form.draftSchema) as { files: Files }).files;
    const res = await buildProject(files);
    if (!res.ok) throw new BuildError(res.problems);
    return { form, files, manifest: readManifest(files).manifest!, build: res.build, draft: true };
  }
  const live = JSON.parse(form.liveSchema) as { files: Files; build: Build };
  return { form, files: live.files, manifest: readManifest(live.files).manifest!, build: live.build, draft: false };
}

// ── Access ───────────────────────────────────────────────────────────────

export function access(app: LoadedApp, user: CurrentUser) {
  const m = app.manifest;
  const dev = isDeveloper(user);
  const role = user.roleKey;
  const e = m.entries ?? {};
  const canOpen = (app.form.status !== "archived" || dev) && (app.form.status !== "closed" || true) && roleAllowed(m.access?.roles, role, dev);
  return {
    canOpen,
    pages: m.pages.filter((p) => roleAllowed(p.roles, role, dev)),
    readAll: roleAllowed(e.read ?? DEFAULT_ENTRY_READERS, role, dev),
    create: app.form.status !== "closed" && roleAllowed(e.create, role, dev),
    voidAny: e.void ? roleAllowed(e.void, role, dev) : dev || user.permissions.includes("entries.void"),
    undoMinutes: e.undoMinutes ?? 10,
    /** Edit anyone's entry: form.json entries.edit (only admins and developers when it's left out). */
    editAny: app.form.status !== "closed" && (e.edit ? roleAllowed(e.edit, role, dev) : dev),
    editOwnMinutes: e.editOwnMinutes ?? 0,
    collection(name: string, mode: "read" | "write") {
      const rule = m.collections?.[name];
      if (mode === "read") return roleAllowed(rule?.read ?? ["*"], role, dev);
      return rule?.write ? roleAllowed(rule.write, role, dev) : dev || user.permissions.includes("forms.manage");
    },
  };
}

export function requireOpen(app: LoadedApp, user: CurrentUser) {
  const a = access(app, user);
  if (!a.canOpen) throw forbidden("This form is limited to other roles.");
  return a;
}

// ── Entries ──────────────────────────────────────────────────────────────

type Sites = Map<string, Pick<Site, "id" | "code" | "name">>;

async function siteMap(): Promise<Sites> {
  return new Map((await prisma.site.findMany({ select: { id: true, code: true, name: true } })).map((s) => [s.id, s]));
}

export function entryOut(e: FormEntry, sites: Sites, fields?: string[]) {
  return {
    id: e.id,
    data: pick(JSON.parse(e.data), fields),
    site: e.siteId ? sites.get(e.siteId) ?? null : null,
    siteId: e.siteId,
    tenantId: e.tenantId,
    occurredAt: e.occurredAt.toISOString(),
    createdAt: e.createdAt.toISOString(),
    createdById: e.createdById,
    createdByName: e.createdByName,
    status: e.status,
    overrideReason: e.overrideReason,
    voidReason: e.voidReason,
    voidedByName: e.voidedByName,
    voidedAt: e.voidedAt?.toISOString() ?? null,
    source: e.source,
    clientId: e.clientId,
    updatedAt: e.updatedAt.toISOString(),
    updatedByName: e.updatedByName,
  };
}

function dateWhere(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  const w: Prisma.DateTimeFilter = {};
  try {
    if (from) w.gte = time.lowerBound(from);
    if (to) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(to)) w.lt = time.upperBound(to);
      else w.lte = new Date(to);
    }
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : "Bad date.");
  }
  return w;
}

export interface ClientEntryQuery {
  site?: string | string[];
  tenantId?: string;
  from?: string;
  to?: string;
  status?: "active" | "voided" | "all";
  search?: string;
  mine?: boolean;
  fields?: string[];
  order?: "newest" | "oldest";
  limit?: number;
  offset?: number;
}

/** Entries as a page sees them: limited by role (everyone's, or only mine) and by the person's sites. */
export async function listEntries(app: LoadedApp, user: CurrentUser, q: ClientEntryQuery) {
  const a = requireOpen(app, user);
  if (!a.readAll && !q.mine) throw forbidden("You can only see your own entries on this form (pass mine: true).");
  const and: Prisma.FormEntryWhereInput[] = [{ formId: app.form.id }];
  if (!app.draft) and.push({ source: { not: "preview" } });
  if (q.mine) and.push({ createdById: user.userId });
  if (user.siteIds) and.push({ OR: [{ siteId: null }, { siteId: { in: user.siteIds } }] });
  if (q.site) {
    const codes = Array.isArray(q.site) ? q.site : String(q.site).split(",");
    const sites = await prisma.site.findMany({ where: { code: { in: codes } }, select: { id: true } });
    and.push({ siteId: { in: sites.map((s) => s.id) } });
  }
  if (q.tenantId) and.push({ tenantId: q.tenantId });
  const occurred = dateWhere(q.from, q.to);
  if (occurred) and.push({ occurredAt: occurred });
  if (q.status !== "all") and.push({ status: q.status ?? "active" });
  if (q.search?.trim()) and.push({ OR: [{ data: { contains: q.search.trim() } }, { createdByName: { contains: q.search.trim() } }] });
  const where = { AND: and };
  const take = Math.min(2000, Math.max(1, Number(q.limit) || 100));
  const [rows, total, sites] = await Promise.all([
    prisma.formEntry.findMany({ where, orderBy: { occurredAt: q.order === "oldest" ? "asc" : "desc" }, take, skip: Math.max(0, Number(q.offset) || 0) }),
    prisma.formEntry.count({ where }),
    siteMap(),
  ]);
  return { items: rows.map((e) => entryOut(e, sites, q.fields)), total };
}

export async function getEntry(app: LoadedApp, user: CurrentUser, id: string) {
  const a = requireOpen(app, user);
  const e = await prisma.formEntry.findFirst({ where: { id, formId: app.form.id } });
  if (!e) throw notFound("No such entry.");
  if (!a.readAll && e.createdById !== user.userId) throw forbidden("You can't see this entry.");
  if (user.siteIds && e.siteId && !user.siteIds.includes(e.siteId)) throw forbidden("This entry is for a site you aren't assigned to.");
  return entryOut(e, await siteMap());
}

export interface NewEntryInput {
  data: unknown;
  site?: string | null;
  tenantId?: string | null;
  occurredAt?: string | null;
  clientId?: string | null;
  override?: string | null;
}

const siteAllowed = (user: CurrentUser | null, siteId: string, machineSiteId?: string | null) =>
  user ? user.siteIds === null || user.siteIds.includes(siteId) : !machineSiteId || machineSiteId === siteId;

export type CreateOutcome =
  | { status: "saved"; entry: ReturnType<typeof entryOut>; logs: string[] }
  | { status: "needs_override"; problems: string[]; logs: string[] }
  | { status: "invalid"; errors: Record<string, string>; message: string; logs: string[] };

/**
 * Save an entry, after the form's own server rules (beforeCreate) have their say.
 * `user` null = an API key / the MCP server.
 */
export async function createEntry(app: LoadedApp, user: CurrentUser | null, input: NewEntryInput, opts: { actorName?: string; machineSiteId?: string | null; source?: string; viaForm?: boolean } = {}): Promise<CreateOutcome> {
  // viaForm: made by another form's server code that this form accepts (apps/jobs.ts) — the person needn't
  // be able to open this form, but its rules and their sites still apply.
  if (user && !opts.viaForm) {
    const a = requireOpen(app, user);
    if (!a.create) throw forbidden(app.form.status === "closed" ? "This form isn't taking entries right now." : "You can't add entries to this form.");
  }
  if (input.clientId) {
    const dup = await prisma.formEntry.findFirst({ where: { formId: app.form.id, clientId: input.clientId } });
    if (dup) return { status: "saved", entry: entryOut(dup, await siteMap()), logs: [] };
  }
  if (!input.data || typeof input.data !== "object" || Array.isArray(input.data)) throw badRequest("data must be an object.");
  const dataJson = JSON.stringify(input.data);
  if (dataJson.length > 1_000_000) throw new HttpError(413, "That entry is too big (1 MB max).");

  let site: Site | null = null;
  let tenant: Tenant | null = null;
  if (input.site) {
    site = await prisma.site.findFirst({ where: { OR: [{ code: input.site }, { id: input.site }] } });
    if (!site || !site.active) throw badRequest("That site doesn't exist.");
    if (!siteAllowed(user, site.id, opts.machineSiteId)) throw forbidden("You aren't assigned to that site.");
  }
  if (input.tenantId) {
    tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId } });
    if (!tenant) throw badRequest("That resident isn't on the roster.");
    if (!siteAllowed(user, tenant.siteId, opts.machineSiteId)) throw forbidden("That resident is at a site you aren't assigned to.");
    if (site && tenant.siteId !== site.id) throw badRequest("That resident isn't at that site.");
    site ??= await prisma.site.findUnique({ where: { id: tenant.siteId } });
  }
  let occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) throw badRequest("occurredAt isn't a time.");
  if (occurredAt.getTime() > Date.now()) occurredAt = new Date();
  if (occurredAt.getTime() < Date.now() - 14 * 86_400_000) throw badRequest("That entry is more than 14 days old.");

  let data = input.data as Record<string, unknown>;
  let logs: string[] = [];
  if (app.build.server) {
    const incoming = {
      data,
      site: site && { id: site.id, code: site.code, name: site.name, siteType: site.siteType },
      resident: tenant && { id: tenant.id, siteId: tenant.siteId, name: displayName(tenant), unit: tenant.unit, status: tenant.status },
      occurredAt: occurredAt.toISOString(),
      clientId: input.clientId ?? null,
      override: input.override?.trim() || null,
    };
    const r = await runHook(app, user, "beforeCreate", incoming);
    logs = r.logs;
    if (!r.ok) {
      if (r.userError) return { status: "invalid", errors: {}, message: r.error ?? "Refused.", logs };
      throw new HttpError(500, `The form's server code failed: ${r.error}`, { logs, stack: app.draft ? r.stack : undefined });
    }
    const res = (r.value ?? {}) as { errors?: Record<string, string>; needsOverride?: string[]; data?: Record<string, unknown> };
    if (res.errors && Object.keys(res.errors).length) return { status: "invalid", errors: res.errors, message: Object.values(res.errors)[0], logs };
    if (res.needsOverride?.length && !input.override?.trim()) return { status: "needs_override", problems: res.needsOverride, logs };
    if (res.data && typeof res.data === "object") data = res.data;
  }
  const attach = await filesToAttach(app, user, data);

  const entry = await prisma.formEntry.create({
    data: {
      formId: app.form.id,
      formVersion: app.draft ? 0 : app.form.liveVersion,
      data: JSON.stringify(data),
      siteId: site?.id ?? null,
      tenantId: tenant?.id ?? null,
      occurredAt,
      source: app.draft ? "preview" : opts.source ?? "app",
      clientId: input.clientId ?? crypto.randomUUID(),
      overrideReason: input.override?.trim().slice(0, 500) || null,
      createdById: user?.userId ?? null,
      createdByName: user?.name ?? opts.actorName ?? "System",
    },
  });
  await attachFiles(entry.id, attach);
  if (tenant && app.manifest.entries?.rosterActivity !== false && !app.draft) {
    await recordActivity({ tenantId: tenant.id, source: "form", label: app.form.title, externalRef: entry.id, occurredAt, recordedBy: entry.createdByName }).catch((err) =>
      console.error(`[apps] roster activity for ${entry.id} failed:`, err)
    );
  }
  const out = entryOut(entry, await siteMap());
  if (app.build.server) {
    void runHook(app, user, "afterCreate", out).then((r) => {
      if (!r.ok) console.error(`[apps] ${app.form.slug} afterCreate failed:`, r.error);
    });
  }
  return { status: "saved", entry: out, logs };
}

export async function voidEntry(app: LoadedApp, user: CurrentUser, id: string, reason: string) {
  const a = requireOpen(app, user);
  const e = await prisma.formEntry.findFirst({ where: { id, formId: app.form.id } });
  if (!e) throw notFound("No such entry.");
  const ownUndo = e.createdById === user.userId && Date.now() - e.createdAt.getTime() < a.undoMinutes * 60_000;
  if (!a.voidAny && !ownUndo) throw forbidden("You can't void this entry.");
  if (user.siteIds && e.siteId && !user.siteIds.includes(e.siteId)) throw forbidden("This entry is for a site you aren't assigned to.");
  if (!reason.trim()) throw badRequest("Say why.");
  await prisma.formEntry.update({ where: { id: e.id }, data: { status: "voided", voidedAt: new Date(), voidedByName: user.name, voidReason: reason.trim().slice(0, 500) } });
  await historyNote(e.id, user.name, { kind: "void", reason: reason.trim().slice(0, 500) });
}

export async function restoreEntry(app: LoadedApp, user: CurrentUser, id: string) {
  const a = requireOpen(app, user);
  if (!a.voidAny) throw forbidden("You can't restore entries.");
  const e = await prisma.formEntry.findFirst({ where: { id, formId: app.form.id } });
  if (!e) throw notFound("No such entry.");
  await prisma.formEntry.update({ where: { id: e.id }, data: { status: "active", voidedAt: null, voidedByName: null, voidReason: null } });
  await historyNote(e.id, user.name, { kind: "restore" });
}

// ── Editing and history ──────────────────────────────────────────────────

type HistoryBody =
  | { kind: "edit"; reason: string | null; changes: { field: string; from: unknown; to: unknown }[] }
  | { kind: "void"; reason: string }
  | { kind: "restore" };

/** A code form's entry history: FormEntryNote rows of kind "history", body JSON. */
async function historyNote(entryId: string, by: string, body: HistoryBody) {
  await prisma.formEntryNote.create({ data: { entryId, kind: "history", authorName: by, body: JSON.stringify(body).slice(0, 60_000) } });
}

/** Top-level fields that changed, values cut short so a photo or signature doesn't bloat the history. */
function changesBetween(before: Record<string, unknown>, after: Record<string, unknown>) {
  const short = (v: unknown) => {
    const s = JSON.stringify(v ?? null);
    return s.length > 500 ? `${s.slice(0, 500)}…` : v ?? null;
  };
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)).map((k) => ({ field: k, from: short(before[k]), to: short(after[k]) }));
}

export type UpdateOutcome =
  | { status: "saved"; entry: ReturnType<typeof entryOut>; logs: string[] }
  | { status: "invalid"; errors: Record<string, string>; message: string; logs: string[] };

/**
 * Change an entry's data. Allowed for form.json entries.edit roles, or for the
 * person who made it within entries.editOwnMinutes. The server's beforeUpdate
 * (if any) can refuse or rewrite; every change is kept in the entry's history.
 */
export async function updateEntry(app: LoadedApp, user: CurrentUser, id: string, input: { data: unknown; reason?: string | null }): Promise<UpdateOutcome> {
  const a = requireOpen(app, user);
  const e = await prisma.formEntry.findFirst({ where: { id, formId: app.form.id } });
  if (!e) throw notFound("No such entry.");
  const own = e.createdById === user.userId && a.editOwnMinutes > 0 && Date.now() - e.createdAt.getTime() < a.editOwnMinutes * 60_000;
  if (!a.editAny && !own) throw forbidden("You can't edit this entry.");
  if (user.siteIds && e.siteId && !user.siteIds.includes(e.siteId)) throw forbidden("This entry is for a site you aren't assigned to.");
  if (e.status !== "active") throw badRequest("Restore the entry before editing it.");
  if (!input.data || typeof input.data !== "object" || Array.isArray(input.data)) throw badRequest("data must be an object.");
  if (JSON.stringify(input.data).length > 1_000_000) throw new HttpError(413, "That entry is too big (1 MB max).");
  const before = JSON.parse(e.data) as Record<string, unknown>;
  let data = input.data as Record<string, unknown>;
  let logs: string[] = [];
  if (app.build.server) {
    const r = await runHook(app, user, "beforeUpdate", { entry: serverEntry(e), data, reason: input.reason?.trim() || null });
    logs = r.logs;
    if (!r.ok) {
      if (r.userError) return { status: "invalid", errors: {}, message: r.error ?? "Refused.", logs };
      throw new HttpError(500, `The form's server code failed: ${r.error}`, { logs, stack: app.draft ? r.stack : undefined });
    }
    const res = (r.value ?? {}) as { errors?: Record<string, string>; data?: Record<string, unknown> };
    if (res.errors && Object.keys(res.errors).length) return { status: "invalid", errors: res.errors, message: Object.values(res.errors)[0], logs };
    if (res.data && typeof res.data === "object") data = res.data;
  }
  const changes = changesBetween(before, data);
  if (!changes.length) return { status: "saved", entry: entryOut(e, await siteMap()), logs };
  const attach = await filesToAttach(app, user, data, e.id);
  const saved = await prisma.formEntry.update({ where: { id: e.id }, data: { data: JSON.stringify(data), updatedByName: user.name } });
  await attachFiles(e.id, attach);
  await historyNote(e.id, user.name, { kind: "edit", reason: input.reason?.trim().slice(0, 500) || null, changes });
  return { status: "saved", entry: entryOut(saved, await siteMap()), logs };
}

/** What happened to an entry after it was made: edits (with what changed), voids, restores. */
export async function entryHistory(app: LoadedApp, user: CurrentUser, id: string) {
  await getEntry(app, user, id);
  const notes = await prisma.formEntryNote.findMany({ where: { entryId: id, kind: "history" }, orderBy: { createdAt: "asc" } });
  return notes.map((n) => ({ at: n.createdAt.toISOString(), byName: n.authorName, ...(JSON.parse(n.body) as HistoryBody) }));
}

// ── Collections ──────────────────────────────────────────────────────────

const COLLECTION_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const docOut = (r: { docId: string; data: string; updatedAt: Date; updatedByName: string | null }) => ({ id: r.docId, data: JSON.parse(r.data), updatedAt: r.updatedAt.toISOString(), updatedByName: r.updatedByName });

function checkName(name: string) {
  if (!COLLECTION_RE.test(name)) throw badRequest("Collection names start with a letter and use letters, digits, - and _.");
}

export async function collectionList(formId: string, name: string) {
  checkName(name);
  const rows = await prisma.formRecord.findMany({ where: { formId, collection: name }, orderBy: { createdAt: "asc" }, take: 5000 });
  return rows.map(docOut);
}

export async function collectionGet(formId: string, name: string, id: string) {
  checkName(name);
  const r = await prisma.formRecord.findUnique({ where: { formId_collection_docId: { formId, collection: name, docId: id } } });
  return r ? docOut(r) : null;
}

export async function collectionPut(formId: string, name: string, id: string | null, data: unknown, byName: string) {
  checkName(name);
  const json = JSON.stringify(data ?? null);
  if (json.length > 256_000) throw new HttpError(413, "That document is too big (256 KB max).");
  const docId = id?.trim() || crypto.randomUUID().slice(0, 12);
  if (docId.length > 100) throw badRequest("Document ids are at most 100 characters.");
  const r = await prisma.formRecord.upsert({
    where: { formId_collection_docId: { formId, collection: name, docId } },
    create: { formId, collection: name, docId, data: json, updatedByName: byName },
    update: { data: json, updatedByName: byName },
  });
  return docOut(r);
}

export async function collectionRemove(formId: string, name: string, id: string) {
  checkName(name);
  await prisma.formRecord.deleteMany({ where: { formId, collection: name, docId: id } });
}

// ── Server code ──────────────────────────────────────────────────────────

interface ServerQuery {
  siteId?: string;
  tenantId?: string;
  from?: string;
  to?: string;
  status?: "active" | "voided" | "all";
  where?: Record<string, unknown>;
  fields?: string[];
  order?: "newest" | "oldest";
  limit?: number;
}

function pick(data: Record<string, unknown>, fields?: string[]) {
  if (!fields?.length) return data;
  return Object.fromEntries(fields.filter((f) => f in data).map((f) => [f, data[f]]));
}

function serverEntry(e: FormEntry, fields?: string[]) {
  return {
    id: e.id,
    data: pick(JSON.parse(e.data), fields),
    siteId: e.siteId,
    tenantId: e.tenantId,
    occurredAt: e.occurredAt.toISOString(),
    createdAt: e.createdAt.toISOString(),
    createdById: e.createdById,
    createdByName: e.createdByName,
    status: e.status,
    overrideReason: e.overrideReason,
    updatedAt: e.updatedAt.toISOString(),
  };
}

/**
 * Server code replacing one of its own form's entries' data (ctx.db.entries.update), e.g. to record
 * an approval. The server is the authority, so entries.edit roles and beforeUpdate don't apply; the
 * change is kept in the entry's history like any edit. `ifUpdatedAt` refuses it if someone saved the
 * entry since it was read, so two approvers at once can't overwrite each other.
 */
async function serverUpdate(app: LoadedApp, user: CurrentUser | null, args: { id?: unknown; data?: unknown; opts?: { reason?: unknown; ifUpdatedAt?: unknown } }) {
  const e = await prisma.formEntry.findFirst({ where: { id: String(args.id), formId: app.form.id } });
  if (!e) throw new Error("No such entry.");
  if (e.status !== "active") throw new Error("That entry is voided; restore it before changing it.");
  if (!app.draft && e.source === "preview") throw new Error("That entry was made in the preview.");
  const data = args.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("data must be an object.");
  const json = JSON.stringify(data);
  if (json.length > 1_000_000) throw new Error("That entry is too big (1 MB max).");
  const changes = changesBetween(JSON.parse(e.data), data as Record<string, unknown>);
  if (!changes.length) return serverEntry(e);
  const by = user?.name ?? app.manifest.title;
  const attach = await filesToAttach(app, user, data, e.id);
  const since = typeof args.opts?.ifUpdatedAt === "string" ? new Date(args.opts.ifUpdatedAt) : null;
  const res = await prisma.formEntry.updateMany({
    where: { id: e.id, ...(since && !Number.isNaN(since.getTime()) ? { updatedAt: since } : {}) },
    data: { data: json, updatedByName: by },
  });
  if (!res.count) throw new Error("CONFLICT: someone else changed this entry a moment ago. Read it again and retry.");
  await attachFiles(e.id, attach);
  const reason = typeof args.opts?.reason === "string" ? args.opts.reason.trim().slice(0, 500) || null : null;
  await historyNote(e.id, by, { kind: "edit", reason, changes });
  return serverEntry((await prisma.formEntry.findUnique({ where: { id: e.id } }))!);
}

async function queryForServer(formId: string, q: ServerQuery, includePreview: boolean, mode: "find" | "count") {
  const where: Prisma.FormEntryWhereInput = { formId };
  if (!includePreview) where.source = { not: "preview" };
  if (q.siteId) where.siteId = q.siteId;
  if (q.tenantId) where.tenantId = q.tenantId;
  const occurred = dateWhere(q.from, q.to);
  if (occurred) where.occurredAt = occurred;
  if (q.status !== "all") where.status = q.status ?? "active";
  const filters = Object.entries(q.where ?? {});
  const matches = (e: FormEntry) => {
    if (!filters.length) return true;
    const d = JSON.parse(e.data) as Record<string, unknown>;
    return filters.every(([k, v]) => d[k] === v);
  };
  if (mode === "count" && !filters.length) return prisma.formEntry.count({ where });
  // Up to 20,000 when the caller asks only for some fields (the reply stays small); 5,000 otherwise.
  const limit = Math.min(q.fields ? 20_000 : 5000, Math.max(1, Number(q.limit) || 500));
  const rows = await prisma.formEntry.findMany({ where, orderBy: { occurredAt: q.order === "oldest" ? "asc" : "desc" }, take: filters.length ? 20_000 : limit });
  const hits = rows.filter(matches);
  return mode === "count" ? hits.length : hits.slice(0, limit).map((e) => serverEntry(e, q.fields));
}

/**
 * ctx.calendar.form: the form's own calendar events (form.json "calendar": { "ownEvents": true }).
 * In the draft nothing reaches the real calendar: creates hand back a "preview:" id and the rest
 * do nothing, so a whole approval can be tried out in the preview.
 */
async function formCalendar(app: LoadedApp, user: CurrentUser | null, op: string, args: any) {
  if (!app.manifest.calendar?.ownEvents) throw new Error(`Add "calendar": { "ownEvents": true } to form.json to use ctx.calendar.form.`);
  const req = { user: user ?? undefined } as unknown as Request;
  const owner = (extra: Partial<FormOwner> = {}): FormOwner => ({ formId: app.form.id, ...extra });
  const preview = (id: unknown) => typeof id === "string" && id.startsWith("preview:");
  const scope = scopeSchema.parse(args.change?.scope ?? args.opts?.scope ?? "all");
  const pendingOpt = (v: unknown) => (typeof v === "boolean" ? v : undefined);
  switch (op) {
    case "list":
      return app.draft ? [] : formEvents(app.form.id, typeof args.ref === "string" ? args.ref : null);
    case "create": {
      const input = eventInput.parse(args.event ?? {});
      const ref = typeof args.opts?.ref === "string" ? args.opts.ref.slice(0, 200) : null;
      if (app.draft) return { id: `preview:${crypto.randomUUID()}`, preview: true };
      return { id: await createEvent(req, input, owner({ ref, pending: pendingOpt(args.opts?.pending) ?? false })) };
    }
    case "update": {
      if (preview(args.id) || app.draft) return { id: String(args.id), preview: true };
      const change = args.change ?? {};
      const pending = pendingOpt(change.pending);
      if (!change.event) {
        if (pending === undefined) throw new Error("Give the event (and scope/date), or pending.");
        await setEventPending(req, String(args.id), pending, owner());
        return { id: String(args.id) };
      }
      const id = await updateEvent(req, String(args.id), scope, change.date, eventInput.parse(change.event), owner({ pending }));
      if (pending !== undefined) await noteCalendarChange([id]);
      return { id };
    }
    case "setPending":
      if (preview(args.id) || app.draft) return null;
      await setEventPending(req, String(args.id), Boolean(args.pending), owner());
      return null;
    case "remove":
      if (preview(args.id) || app.draft) return null;
      await deleteEvent(req, String(args.id), scope, args.opts?.date, owner());
      return null;
  }
  throw new Error(`Unknown call calendar.form.${op}.`);
}

/** ctx.directory: active staff, for choosing approvers and emailing them. Names, emails, roles and sites only. */
async function directory(q: { search?: unknown; roles?: unknown; site?: unknown; ids?: unknown; limit?: unknown }) {
  const and: Prisma.UserWhereInput[] = [{ status: "active" }];
  if (typeof q.search === "string" && q.search.trim()) {
    const s = q.search.trim();
    and.push({ OR: [{ name: { contains: s } }, { email: { contains: s } }] });
  }
  if (Array.isArray(q.roles) && q.roles.length) and.push({ roleKey: { in: q.roles.map(String) } });
  if (Array.isArray(q.ids)) and.push({ id: { in: q.ids.map(String).slice(0, 500) } });
  let siteId: string | null = null;
  if (typeof q.site === "string" && q.site) {
    const site = await prisma.site.findFirst({ where: { OR: [{ id: q.site }, { code: q.site }] }, select: { id: true } });
    if (!site) return [];
    siteId = site.id;
  }
  const rows = await prisma.user.findMany({
    where: { AND: and },
    select: { id: true, name: true, email: true, roleKey: true, avatarColor: true, sites: { select: { site: { select: { id: true, code: true } } } } },
    orderBy: { name: "asc" },
    take: 2000,
  });
  const out = rows
    .map((u) => {
      const role = roleFor(u.roleKey);
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        roleKey: role.key,
        roleName: role.name,
        avatarColor: u.avatarColor ?? null,
        /** Null = every site (their role sees them all). */
        sites: role.allSites ? null : u.sites.map((s) => s.site.code),
        siteIds: role.allSites ? null : u.sites.map((s) => s.site.id),
      };
    })
    .filter((u) => !siteId || u.siteIds === null || u.siteIds.includes(siteId))
    .map(({ siteIds: _s, ...u }) => u);
  return out.slice(0, Math.min(500, Math.max(1, Number(q.limit) || 200)));
}

/** Answers the server code's ctx.* calls, on behalf of `user` (null = an API key / MCP). */
function hostFor(app: LoadedApp, user: CurrentUser | null) {
  const canSite = (siteId: string) => !user || user.siteIds === null || user.siteIds.includes(siteId);
  const siteOut = (s: Site) => ({ id: s.id, code: s.code, name: s.name, siteType: s.siteType });
  const residentOut = (t: Tenant) => ({
    id: t.id, siteId: t.siteId, name: displayName(t), firstName: t.firstName, lastName: t.lastName, preferredName: t.preferredName, unit: t.unit, status: t.status,
    moveInDate: t.moveInDate?.toISOString().slice(0, 10) ?? null, lastActivityAt: t.lastActivityAt?.toISOString() ?? null,
  });

  async function otherForm(slug: string) {
    if (!(app.manifest.reads ?? []).includes(slug)) throw new Error(`Add "${slug}" to "reads" in form.json to read its entries.`);
    const other = await prisma.builtForm.findUnique({ where: { slug } });
    if (!other) throw new Error(`No form "${slug}".`);
    const loaded = other.kind === "code" ? await loadApp(other, false).catch(() => null) : null;
    // A code form that shares with this one ("share": { "forms": [...] }) is readable whoever is asking:
    // this form's server code decides what of it to show (e.g. only the person's own sites).
    if (loaded?.manifest.share?.forms?.includes(app.form.slug)) return other.id;
    if (!user) throw new Error("Reading other forms needs a signed-in person.");
    let allowed = false;
    if (other.kind === "code") {
      allowed = Boolean(loaded && access(loaded, user).readAll);
    } else allowed = canReadBasicEntries(readDoc(other.liveSchema ?? other.draftSchema), user);
    if (!allowed) throw new Error(`${user.name} can't read the entries of "${slug}".`);
    return other.id;
  }

  /** Another form's collections, read-only: only a code form that shares with this one. */
  async function sharedForm(slug: string) {
    if (!(app.manifest.reads ?? []).includes(slug)) throw new Error(`Add "${slug}" to "reads" in form.json to read its collections.`);
    const other = await prisma.builtForm.findUnique({ where: { slug } });
    const loaded = other?.kind === "code" ? await loadApp(other, false).catch(() => null) : null;
    if (!other || !loaded?.manifest.share?.forms?.includes(app.form.slug)) throw new Error(`"${slug}" doesn't share with this form ("share": { "forms": ["${app.form.slug}"] }).`);
    return other.id;
  }
  // Counts entries queued for other forms in one call.
  const callKey = {};

  return async (name: string, args: any): Promise<unknown> => {
    switch (name) {
      case "entries.find":
      case "entries.count": {
        const formId = args.form ? await otherForm(args.form) : app.form.id;
        return queryForServer(formId, args.q ?? {}, app.draft, name === "entries.count" ? "count" : "find");
      }
      case "entries.get": {
        const formId = args.form ? await otherForm(args.form) : app.form.id;
        const e = await prisma.formEntry.findFirst({ where: { id: String(args.id), formId } });
        return e ? serverEntry(e) : null;
      }
      case "collections.list":
        return (await collectionList(args.form ? await sharedForm(args.form) : app.form.id, args.name)).map((d) => ({ id: d.id, data: d.data }));
      case "collections.get": {
        const d = await collectionGet(args.form ? await sharedForm(args.form) : app.form.id, args.name, args.id);
        return d && { id: d.id, data: d.data };
      }
      case "collections.put": {
        const d = await collectionPut(app.form.id, args.name, args.id, args.data, user?.name ?? "Server code");
        return { id: d.id, data: d.data };
      }
      case "collections.remove":
        await collectionRemove(app.form.id, args.name, args.id);
        return null;
      case "roster.site": {
        const s = await prisma.site.findFirst({ where: { OR: [{ id: String(args.x) }, { code: String(args.x) }] } });
        return s && canSite(s.id) ? siteOut(s) : null;
      }
      case "roster.sites": {
        // all: every active site's name and code (to choose where something happens), not just the person's own.
        const rows = await prisma.site.findMany({ where: { active: true, ...(user?.siteIds && !args?.all ? { id: { in: user.siteIds } } : {}) }, orderBy: { name: "asc" } });
        return rows.map(siteOut);
      }
      case "roster.resident": {
        const t = await prisma.tenant.findUnique({ where: { id: String(args.id) } });
        return t && canSite(t.siteId) ? residentOut(t) : null;
      }
      case "roster.residents": {
        const s = await prisma.site.findFirst({ where: { OR: [{ id: String(args.x) }, { code: String(args.x) }] } });
        if (!s || !canSite(s.id)) return [];
        const status = args.opts?.includeArchived ? {} : { status: "active" };
        return (await prisma.tenant.findMany({ where: { siteId: s.id, ...status }, orderBy: [{ lastName: "asc" }, { firstName: "asc" }] })).map(residentOut);
      }
      case "roster.logActivity": {
        // Counts as the resident being seen (resets their review clock), like an entry about them does.
        const t = await prisma.tenant.findUnique({ where: { id: String(args.tenantId) } });
        if (!t || !canSite(t.siteId)) throw new Error("That resident isn't at one of your sites.");
        if (app.draft) return { logged: false, reason: "The draft (preview) doesn't log roster activity." };
        const label = typeof args.label === "string" && args.label.trim() ? args.label.trim().slice(0, 120) : app.manifest.title;
        const occurredAt = args.occurredAt ? new Date(String(args.occurredAt)) : new Date();
        if (Number.isNaN(occurredAt.getTime())) throw new Error("occurredAt isn't a time.");
        await recordActivity({ tenantId: t.id, source: "form", label, occurredAt: occurredAt > new Date() ? new Date() : occurredAt, recordedBy: user?.name ?? "Server code" });
        return { logged: true };
      }
      case "calendar.events": {
        // The calendar service speaks Express requests; it only reads req.user.
        const asker = (user ?? { userId: "", name: "Server code", permissions: [], siteIds: null }) as CurrentUser;
        const q = args?.q ?? {};
        const site = q.site ? (Array.isArray(q.site) ? q.site.join(",") : String(q.site)) : undefined;
        return (await loadOccurrences({ user: asker } as unknown as Request, { from: q.from, to: q.to, site })).items.map(({ canEdit: _c, ...o }) => o);
      }
      case "people": {
        // Staff names and profile colors, for charts and lists that show who did what.
        // Only people who exist; nothing else about them.
        const ids = [...new Set<string>((Array.isArray(args?.ids) ? (args.ids as unknown[]) : []).map(String))].slice(0, 500);
        if (!ids.length) return [];
        const rows = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, avatarColor: true } });
        return rows.map((u) => ({ id: u.id, name: u.name, avatarColor: u.avatarColor ?? null }));
      }
      case "email.send":
        return queueEmail(app, user, args ?? {});
      case "calendar.categories":
        return prisma.calendarCategory.findMany({ orderBy: { sortOrder: "asc" }, select: { id: true, name: true, colorSlot: true } });
      case "calendar.create": {
        if (!user) throw new Error("Adding a calendar event needs a signed-in person (not an API key).");
        if (app.draft) throw new Error("The draft (preview) doesn't add calendar events — publish to try it for real.");
        return { id: await createEvent({ user } as unknown as Request, eventInput.parse(args?.event ?? {})) };
      }
      case "entries.update":
        return serverUpdate(app, user, args ?? {});
      case "entries.create":
        return enqueueJob(app, user, { form: args?.form, entry: args?.entry, sourceEntryId: args?.entry?.sourceEntryId, callKey });
      case "jobs.list":
        return jobsFor(app.form.id, String(args?.entryId ?? ""));
      case "jobs.retry":
        return retryJob(app.form.id, String(args?.id ?? ""), typeof args?.override === "string" ? args.override : null);
      case "files.read": {
        // One of this form's own files, as a data: URL (e.g. a signature another form wants inline).
        const id = String(args?.fileId ?? args?.ref?.fileId ?? "");
        const f = await prisma.formFile.findFirst({ where: { id, formId: app.form.id } });
        if (!f) throw new Error("No such file on this form.");
        if (f.size > 600_000) throw new Error("That file is too big to read here (600 KB max).");
        return `data:${f.mime};base64,${Buffer.from(f.data).toString("base64")}`;
      }
      case "calendar.form.list":
      case "calendar.form.create":
      case "calendar.form.update":
      case "calendar.form.remove":
      case "calendar.form.setPending":
        return formCalendar(app, user, name.slice("calendar.form.".length), args ?? {});
      case "directory":
        return directory(args?.q ?? {});
      case "time.dayOf":
        return time.dayOf(String(args.iso));
      case "time.startOfDay":
        return time.startOfDay(String(args.day)).toISOString();
      case "time.partsOf":
        return time.partsOf(String(args.iso));
      case "time.addDays":
        return time.addDays(String(args.day), Number(args.n));
      default:
        throw new Error(`Unknown call ${name}.`);
    }
  };
}

function baseCtx(app: LoadedApp, user: CurrentUser | null) {
  return {
    user: user && { id: user.userId, name: user.name, email: user.email, roleKey: user.roleKey, permissions: user.permissions, siteIds: user.siteIds },
    now: new Date().toISOString(),
    today: time.today(),
    draft: app.draft,
    url: `${appBaseUrl}/apps/${app.form.slug}`,
  };
}

function friendly(r: SandboxResult): SandboxResult {
  if (!r.ok && r.error && /^interrupted$/i.test(r.error)) return { ...r, error: "The server code ran too long (3 s) and was stopped." };
  return r;
}

async function runHook(app: LoadedApp, user: CurrentUser | null, hook: "beforeCreate" | "afterCreate" | "beforeUpdate", arg: unknown) {
  const call = `__settle((async () => { const d = globalThis.__serverDef; if (!d || typeof d.${hook} !== "function") return null; return d.${hook}(${JSON.stringify(arg)}, __makeCtx(${JSON.stringify(baseCtx(app, user))})); })())`;
  return friendly(await runInSandbox({ bundle: app.build.server!, call, onHost: hostFor(app, user) }));
}

/** Run a server action for a page (or the MCP server). */
export async function runAction(app: LoadedApp, user: CurrentUser | null, name: string, args: unknown) {
  if (user) requireOpen(app, user);
  if (!app.build.server) throw notFound("This form has no server code.");
  if (!/^[A-Za-z_$][\w$]{0,63}$/.test(name)) throw badRequest("Bad action name.");
  const call = `__settle((async () => { const d = globalThis.__serverDef; const a = d && d.actions && d.actions[${JSON.stringify(name)}]; if (typeof a !== "function") throw new Error("No action named ${name}."); return a(${JSON.stringify(args ?? null)}, __makeCtx(${JSON.stringify(baseCtx(app, user))})); })())`;
  return friendly(await runInSandbox({ bundle: app.build.server, call, onHost: hostFor(app, user) }));
}
