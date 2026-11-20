import type { BuiltForm, Prisma, Tenant } from "@prisma/client";
import { prisma } from "../prisma.js";
import { badRequest, HttpError } from "../http.js";
import type { CurrentUser } from "../auth/middleware.js";
import { entryReachOf, entryWhere, liveDoc, visibleWhere } from "../forms/entries.js";
import { entryTenantId } from "../forms/entryTenant.js";
import { readDoc } from "../forms/service.js";
import type { FormDoc, Values } from "../forms/engine.js";
import { access, listEntries, loadLiveApp, type LoadedApp } from "../apps/runtime.js";
import { canUseBuiltForm } from "./staffGroups.js";
import { parseSigned } from "./signOff.js";
import { INTERNAL_TRANSFER } from "./residency.js";
import { getSetting, setSetting } from "./settings.js";
import { DOCUMENT_META, documentOut } from "./clientDocuments.js";

/**
 * One resident's whole record, newest first (PlanStreet's case activity list):
 * the form entries about them, interleaved with their moves (moved in, moved to
 * another unit, moved out, away and back), the checklist items done and the
 * documents added.
 *
 * Entries come from the forms' own access rules, never copied here: a basic
 * form's through forms/entries.ts (whom it's open to, "Who sees entries",
 * visibleWhere, the person's sites), a code form's through apps/runtime.ts
 * (access, listEntries). So an entry shows only to someone who could open it from
 * the form's own Entries, and any rule added there applies here too. The rest is
 * the resident's own record, which the route already limits to their site and to
 * people with client information (clients.view).
 *
 * Paged with a cursor: the time of the last item shown and the items shown at
 * exactly that time, so items sharing a time (imported entries often do) are
 * neither skipped nor shown twice.
 */

const TZ = "America/New_York";
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export type TimelineKind = "entry" | "moved_in" | "transferred" | "moved_out" | "removed" | "away" | "back" | "task_done" | "task_skipped" | "document";

export interface TimelineEntry {
  id: string;
  form: { id: string; slug: string; title: string; kind: "basic" | "code" };
  archived: boolean;
  followUp: { status: string; doneAt: Date | null; doneByName: string | null } | null;
  signOff: { status: string; signed: string[] } | null;
  noteCount: number;
  /** Where the app opens it: a basic form's entry page, or the code form (it shows its own entries). */
  link: string;
}

export interface TimelineItem {
  key: string;
  kind: TimelineKind;
  at: string;
  /** Only the day is known (a move, a checklist item): "YYYY-MM-DD", shown without a time. Null for entries and documents. */
  day: string | null;
  title: string;
  detail: string | null;
  by: string | null;
  site: string | null;
  entry?: TimelineEntry;
  document?: ReturnType<typeof documentOut>;
}

type Item = TimelineItem & { ms: number };

/** One source's items up to the cursor. `truncated`: it had more than it returned, the oldest returned at `horizon`. */
interface Source {
  items: Item[];
  truncated: boolean;
  horizon: number;
}

interface Cursor {
  ms: number;
  seen: Set<string>;
}

// ── Cursor ───────────────────────────────────────────────────────────────

function encodeCursor(ms: number, seen: string[]): string {
  return Buffer.from(JSON.stringify({ t: ms, s: seen })).toString("base64url");
}

function decodeCursor(raw: unknown): Cursor | null {
  if (raw === undefined || raw === null || raw === "") return null;
  try {
    const v = JSON.parse(Buffer.from(String(raw), "base64url").toString("utf8")) as { t?: unknown; s?: unknown };
    if (typeof v.t !== "number" || !Number.isFinite(v.t) || !Array.isArray(v.s) || v.s.length > 5000 || !v.s.every((k) => typeof k === "string" && k.length <= 120)) throw new Error();
    return { ms: v.t, seen: new Set(v.s as string[]) };
  } catch {
    throw badRequest("That page link isn't valid. Start from the top.");
  }
}

// ── Days ─────────────────────────────────────────────────────────────────

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const nyDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const dayWords = (day: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${day}T00:00:00Z`));

function noonNY(day: string): number {
  const probe = new Date(`${day}T12:00:00Z`);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(probe));
  return probe.getTime() + (12 - hour) * 3_600_000;
}

/**
 * Where a day-only event sorts: when it was recorded, if that was the same day
 * (so a move-in at 9 sits under the 10 o'clock form about it), else noon that day.
 */
const sortTime = (day: Date, recorded: Date | null) => (recorded && nyDay(recorded) === ymd(day) ? recorded.getTime() : noonNY(ymd(day)));

// ── The resident's own record ────────────────────────────────────────────

async function recordEvents(t: Tenant, siteName: (id: string | null) => string | null): Promise<Item[]> {
  const [stays, absences, tasks, documents] = await Promise.all([
    prisma.stay.findMany({ where: { tenantId: t.id }, orderBy: [{ moveInDate: "asc" }, { createdAt: "asc" }] }),
    prisma.tenantAbsence.findMany({ where: { tenantId: t.id } }),
    prisma.tenantTask.findMany({ where: { tenantId: t.id, status: { in: ["done", "skipped"] }, doneOn: { not: null } }, take: 2000 }),
    prisma.clientDocument.findMany({ where: { tenantId: t.id, removedAt: null }, select: DOCUMENT_META, take: 500 }),
  ]);
  const userIds = [...stays.flatMap((s) => [s.createdById, s.endedById]), ...absences.flatMap((a) => [a.createdById, a.endedById])].filter((x): x is string => Boolean(x));
  const names = new Map((userIds.length ? await prisma.user.findMany({ where: { id: { in: [...new Set(userIds)] } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u.name]));
  const who = (id: string | null) => (id ? names.get(id) ?? "A removed account" : null);
  const where = (unitLabel: string | null, siteId: string | null) => [unitLabel ? `Unit ${unitLabel}` : null, siteName(siteId)].filter(Boolean).join(" at ") || null;

  const out: Item[] = [];
  const add = (x: Omit<Item, "at" | "ms"> & { ms: number }) => out.push({ ...x, at: new Date(x.ms).toISOString() });

  stays.forEach((s, i) => {
    const from = s.startKind === "transferred" ? stays.slice(0, i).reverse().find((p) => p.endKind === "transferred") ?? null : null;
    add({
      key: `stay:${s.id}:start`,
      kind: s.startKind === "transferred" ? "transferred" : "moved_in",
      ms: sortTime(s.moveInDate, s.createdAt),
      day: ymd(s.moveInDate),
      title: s.startKind === "transferred" ? "Moved to another unit" : "Moved in",
      detail:
        [
          where(s.unitLabel, s.siteId),
          from ? `from ${where(from.unitLabel, from.siteId === s.siteId ? null : from.siteId) ?? "no unit"}` : null,
          from?.endReason && from.endReason !== INTERNAL_TRANSFER ? from.endReason : null,
          s.program,
        ]
          .filter(Boolean)
          .join(" · ") || null,
      by: who(s.createdById),
      site: siteName(s.siteId),
    });
    // A transfer's end is the next stay's start, shown there.
    if (s.moveOutDate && (s.endKind === "moved_out" || s.endKind === "removed")) {
      add({
        key: `stay:${s.id}:end`,
        kind: s.endKind,
        ms: sortTime(s.moveOutDate, s.updatedAt),
        day: ymd(s.moveOutDate),
        title: s.endKind === "moved_out" ? "Moved out" : "Taken off the roster",
        detail: [where(s.unitLabel, s.siteId), s.endReason, s.exitDestination ? `went to ${s.exitDestination}` : null].filter(Boolean).join(" · ") || null,
        by: who(s.endedById),
        site: siteName(s.siteId),
      });
    }
  });

  for (const a of absences) {
    add({
      key: `away:${a.id}:start`,
      kind: "away",
      ms: sortTime(a.lastSeen, a.createdAt),
      day: ymd(a.lastSeen),
      title: "Away",
      detail: [a.detail ? `${a.reason} — ${a.detail}` : a.reason, a.expectedReturn ? `expected back ${dayWords(ymd(a.expectedReturn))}` : null].filter(Boolean).join(" · "),
      by: who(a.createdById),
      site: siteName(a.siteId),
    });
    if (a.returnedOn) {
      const days = Math.max(0, Math.round((a.returnedOn.getTime() - a.lastSeen.getTime()) / 86_400_000));
      add({
        key: `away:${a.id}:end`,
        kind: "back",
        ms: sortTime(a.returnedOn, a.updatedAt),
        day: ymd(a.returnedOn),
        title: "Back",
        detail: `Away ${days} ${days === 1 ? "day" : "days"} (${a.reason})`,
        by: who(a.endedById),
        site: siteName(a.siteId),
      });
    }
  }

  for (const k of tasks) {
    add({
      key: `task:${k.id}`,
      kind: k.status === "done" ? "task_done" : "task_skipped",
      ms: sortTime(k.doneOn!, k.updatedAt),
      day: ymd(k.doneOn!),
      title: k.label,
      detail: [k.status === "done" ? (k.entryRef ? "Checklist: done on a form" : "Checklist: done") : "Checklist: not needed", k.note].filter(Boolean).join(" · "),
      by: k.doneByName,
      site: siteName(k.siteId),
    });
  }

  for (const d of documents) {
    const doc = documentOut(d);
    add({
      key: `doc:${d.id}`,
      kind: "document",
      ms: d.createdAt.getTime(),
      day: null,
      title: `Document added: ${doc.label ?? doc.name}`,
      detail: doc.kindLabel,
      by: d.createdByName,
      site: siteName(d.siteId),
      document: doc,
    });
  }
  return out;
}

// ── Form entries, by each form's own rules ───────────────────────────────

const ENTRY_COLUMNS = {
  id: true, createdAt: true, occurredAt: true, createdByName: true, siteId: true, archivedAt: true,
  followUp: true, followUpDoneAt: true, followUpDoneByName: true, signOff: true, signOffs: true,
  _count: { select: { notes: true } },
} satisfies Prisma.FormEntrySelect;
type EntryColumns = Prisma.FormEntryGetPayload<{ select: typeof ENTRY_COLUMNS }>;

function entryItem(form: Pick<BuiltForm, "id" | "slug" | "title" | "kind">, e: EntryColumns, at: Date, siteName: (id: string | null) => string | null): Item {
  const kind = form.kind === "code" ? "code" : "basic";
  return {
    key: `entry:${e.id}`,
    kind: "entry",
    ms: at.getTime(),
    at: at.toISOString(),
    day: null,
    title: form.title,
    detail: null,
    by: e.createdByName,
    site: siteName(e.siteId),
    entry: {
      id: e.id,
      form: { id: form.id, slug: form.slug, title: form.title, kind },
      archived: Boolean(e.archivedAt),
      followUp: e.followUp ? { status: e.followUp, doneAt: e.followUpDoneAt, doneByName: e.followUpDoneByName } : null,
      signOff: e.signOff ? { status: e.signOff, signed: Object.values(parseSigned(e.signOffs)).map((s) => s.byName) } : null,
      noteCount: e._count.notes,
      link: kind === "code" ? `/apps/${form.slug}` : `/f/${form.slug}/entries/${e.id}`,
    },
  };
}

/** A basic form's entries about them that this person sees on the form's Entries: whom it's open to, then "Who sees entries". */
async function basicEntries(form: BuiltForm, user: CurrentUser, tenantId: string, cursor: Cursor | null, take: number, siteName: (id: string | null) => string | null): Promise<Source | null> {
  if (!canUseBuiltForm(user, form.id)) return null;
  const doc = liveDoc(form) ?? readDoc(form.draftSchema);
  const reach = entryReachOf(form, doc, user);
  if (!reach) return null;
  const where: Prisma.FormEntryWhereInput = {
    AND: [entryWhere(form, user, { status: "active", archived: "all" }), await visibleWhere(form, user, reach), { tenantId }, ...(cursor ? [{ createdAt: { lte: new Date(cursor.ms) } }] : [])],
  };
  const rows = await prisma.formEntry.findMany({ where, orderBy: { createdAt: "desc" }, take, select: ENTRY_COLUMNS });
  return { items: rows.map((e) => entryItem(form, e, e.createdAt, siteName)), truncated: rows.length === take, horizon: rows.length ? rows[rows.length - 1].createdAt.getTime() : 0 };
}

/** A code form's entries about them, as its own pages may list them (apps/runtime.ts listEntries: everyone's, or only their own). */
async function codeEntries(formId: string, user: CurrentUser, tenantId: string, cursor: Cursor | null, take: number, siteName: (id: string | null) => string | null): Promise<Source | null> {
  let app: LoadedApp;
  try {
    app = await loadLiveApp(formId);
  } catch (err) {
    // Never published, or gone: nothing of it to show.
    if (err instanceof HttpError) return null;
    throw err;
  }
  const a = access(app, user);
  if (!a.canOpen) return null;
  const limit = Math.min(take, 2000);
  let listed: Awaited<ReturnType<typeof listEntries>>;
  try {
    listed = await listEntries(app, user, { tenantId, status: "active", fields: [], mine: !a.readAll, order: "newest", limit, ...(cursor ? { to: new Date(cursor.ms).toISOString() } : {}) });
  } catch (err) {
    if (err instanceof HttpError && (err.status === 403 || err.status === 404)) return null;
    throw err;
  }
  const ids = listed.items.map((e) => e.id);
  const extra = new Map((ids.length ? await prisma.formEntry.findMany({ where: { id: { in: ids } }, select: ENTRY_COLUMNS }) : []).map((e) => [e.id, e]));
  const items = listed.items
    .map((e) => extra.get(e.id))
    .filter((e): e is EntryColumns => Boolean(e))
    .map((e) => entryItem(app.form, e, e.occurredAt, siteName));
  const oldest = listed.items.length ? Date.parse(listed.items[listed.items.length - 1].occurredAt) : 0;
  return { items, truncated: listed.items.length === limit, horizon: oldest };
}

// ── The timeline ─────────────────────────────────────────────────────────

export async function clientTimeline(t: Tenant, user: CurrentUser, opts: { before?: unknown; limit?: unknown } = {}) {
  const cursor = decodeCursor(opts.before);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(opts.limit) || DEFAULT_LIMIT));
  // Enough from each source to fill the page after dropping what the last page showed.
  const take = limit + (cursor?.seen.size ?? 0) + 1;
  const upTo = (i: Item) => !cursor || (i.ms <= cursor.ms && !cursor.seen.has(i.key));

  const sites = new Map((await prisma.site.findMany({ select: { id: true, name: true } })).map((s) => [s.id, s.name]));
  const siteName = (id: string | null) => (id ? sites.get(id) ?? null : null);

  // The forms with an active entry about them.
  const formIds = (await prisma.formEntry.groupBy({ by: ["formId"], where: { tenantId: t.id, status: "active" } })).map((g) => g.formId);
  const forms = formIds.length ? await prisma.builtForm.findMany({ where: { id: { in: formIds } }, select: { id: true, kind: true } }) : [];
  const basicForms = forms.some((f) => f.kind === "basic") ? await prisma.builtForm.findMany({ where: { id: { in: forms.filter((f) => f.kind === "basic").map((f) => f.id) } } }) : [];

  const [record, ...entrySources] = await Promise.all([
    recordEvents(t, siteName),
    ...basicForms.map((f) => basicEntries(f, user, t.id, cursor, take, siteName)),
    ...forms.filter((f) => f.kind === "code").map((f) => codeEntries(f.id, user, t.id, cursor, take, siteName)),
  ]);
  const sources = (entrySources as (Source | null)[]).filter((s): s is Source => Boolean(s));

  const items = [...(record as Item[]), ...sources.flatMap((s) => s.items)].filter(upTo);
  items.sort((a, b) => b.ms - a.ms || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // A source that had more than it sent: nothing older than its oldest is certain yet.
  const truncated = sources.filter((s) => s.truncated);
  const cutoff = truncated.length ? Math.max(...truncated.map((s) => s.horizon)) : -Infinity;
  const safe = items.filter((i) => i.ms >= cutoff);
  const page = safe.slice(0, limit);
  const more = page.length > 0 && (safe.length > page.length || truncated.length > 0);

  let next: string | null = null;
  if (more) {
    const last = page[page.length - 1].ms;
    const seen = page.filter((i) => i.ms === last).map((i) => i.key);
    if (cursor && cursor.ms === last) seen.push(...cursor.seen);
    next = encodeCursor(last, [...new Set(seen)]);
  }
  return { items: page.map(({ ms: _ms, ...i }) => i), next };
}

// ── Entries saved before they kept their resident ───────────────────────

/**
 * Once: a basic form's entries saved before FormEntry.tenantId was kept for them
 * (2026-11-20) get it from their answers, read against the version each was
 * filled in. Written with plain SQL so the entries' updatedAt doesn't move (it
 * isn't an edit). The entryTenantsFilled setting marks it done.
 */
export async function backfillEntryTenants(): Promise<number> {
  if (await getSetting("entryTenantsFilled")) return 0;
  const forms = await prisma.builtForm.findMany({ where: { kind: "basic" }, select: { id: true, liveSchema: true, draftSchema: true } });
  let n = 0;
  for (const form of forms) {
    const parse = (json: string | null): FormDoc | null => {
      try {
        return json ? readDoc(json) : null;
      } catch {
        return null;
      }
    };
    const docs = new Map<number, FormDoc>();
    for (const v of await prisma.builtFormVersion.findMany({ where: { formId: form.id }, select: { version: true, schema: true } })) {
      const d = parse(v.schema);
      if (d) docs.set(v.version, d);
    }
    const fallback = parse(form.liveSchema) ?? parse(form.draftSchema);
    const hasResident = (d: FormDoc | null | undefined) => Boolean(d?.fields?.some((f) => f.type === "resident"));
    if (![...docs.values(), fallback].some(hasResident)) continue;

    let after = "";
    for (;;) {
      const rows = await prisma.formEntry.findMany({
        where: { formId: form.id, tenantId: null, id: { gt: after } },
        orderBy: { id: "asc" },
        take: 500,
        select: { id: true, formVersion: true, data: true },
      });
      if (!rows.length) break;
      after = rows[rows.length - 1].id;
      const found: { id: string; tenantId: string }[] = [];
      for (const r of rows) {
        const doc = docs.get(r.formVersion) ?? fallback;
        if (!doc?.fields) continue;
        let values: Values;
        try {
          values = JSON.parse(r.data) as Values;
        } catch {
          continue;
        }
        const tenantId = values && typeof values === "object" ? entryTenantId(doc, values) : null;
        if (tenantId) found.push({ id: r.id, tenantId });
      }
      if (!found.length) continue;
      const real = new Set((await prisma.tenant.findMany({ where: { id: { in: [...new Set(found.map((f) => f.tenantId))] } }, select: { id: true } })).map((x) => x.id));
      for (const f of found) {
        if (real.has(f.tenantId)) n += await prisma.$executeRaw`UPDATE FormEntry SET tenantId = ${f.tenantId} WHERE id = ${f.id} AND tenantId IS NULL`;
      }
    }
  }
  await setSetting("entryTenantsFilled", new Date().toISOString());
  return n;
}
