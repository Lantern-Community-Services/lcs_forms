import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { HttpError } from "../http.js";
import type { CurrentUser } from "../auth/middleware.js";
import { findAnyForm, readDoc } from "../forms/service.js";
import { entryReachOf, entryWhere, liveDoc, visibleWhere } from "../forms/entries.js";
import { formatValue } from "../forms/engine.js";
import { canUseBuiltForm } from "./staffGroups.js";
import { access, dateWhere, loadLiveApp } from "../apps/runtime.js";

/**
 * Counts of a form's entries, grouped — for Claude's reports ("incidents by site and month",
 * "Hot Foods meals by weekday"), so it needn't page through thousands of entries to count them.
 * Only the entries this person can read, by the same rules as the entries lists: a basic form's
 * "Who sees entries"; a code form's entries.read (everyone's) or else their own.
 */

export const GROUPS = ["site", "month", "week", "day", "weekday", "hour", "submittedBy", "status"] as const;
const MAX_SCAN = 50_000;
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export interface CountQuery {
  form: string;
  /** One or two of GROUPS, or "field:<id>" (basic) / "field:<data.path>" (code). */
  by: string[];
  from?: string;
  to?: string;
  site?: string;
  search?: string;
  includeVoided?: boolean;
}

type Row = { occurredAt: Date; siteId: string | null; createdByName: string | null; status: string; data?: string };

function ny(d: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "long", hourCycle: "h23" })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  );
  return { day: `${p.year}-${p.month}-${p.day}`, month: `${p.year}-${p.month}`, hour: Number(p.hour), weekday: p.weekday as string };
}

function weekOf(day: string) {
  const d = new Date(`${day}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

const pathGet = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);

const scalar = (v: unknown): string[] => {
  if (v === null || v === undefined || v === "") return ["(blank)"];
  if (Array.isArray(v)) return v.length ? v.flatMap((x) => scalar(x)) : ["(blank)"];
  if (typeof v === "object") return [JSON.stringify(v).slice(0, 80)];
  if (typeof v === "boolean") return [v ? "Yes" : "No"];
  return [String(v).slice(0, 120)];
};

export async function countEntries(user: CurrentUser, q: CountQuery) {
  if (!q.by.length || q.by.length > 2) throw new HttpError(400, "Group by one or two things.");
  for (const b of q.by) if (!(GROUPS as readonly string[]).includes(b) && !/^field:[\w.-]{1,120}$/.test(b)) throw new HttpError(400, `Can't group by "${b}". Use ${GROUPS.join(", ")} or field:<id>.`);
  const form = await findAnyForm(q.form);
  const siteIds = q.site ? (await prisma.site.findMany({ where: { code: { in: q.site.split(",").map((s) => s.trim()) } }, select: { id: true } })).map((s) => s.id) : null;
  const needData = q.by.some((b) => b.startsWith("field:"));

  let where: Prisma.FormEntryWhereInput;
  let valuesOf: (field: string, data: unknown) => string[] = (field, data) => scalar(pathGet(data, field));
  let scope = "everyone's entries you can see";
  if (form.kind === "code") {
    const app = await loadLiveApp(form.id);
    const a = access(app, user);
    if (!a.canOpen || user.guest) throw new HttpError(403, "This form isn't open to you.");
    const and: Prisma.FormEntryWhereInput[] = [{ formId: form.id }, { source: { not: "preview" } }];
    if (!q.includeVoided) and.push({ status: "active" });
    if (user.siteIds) and.push({ OR: [{ siteId: null }, { siteId: { in: user.siteIds } }] });
    if (!a.readAll) {
      and.push({ createdById: user.userId });
      scope = "only the entries you filed (this form doesn't let you read everyone's)";
    }
    if (siteIds) and.push({ siteId: { in: siteIds } });
    const occurred = dateWhere(q.from, q.to);
    if (occurred) and.push({ occurredAt: occurred });
    if (q.search) and.push({ data: { contains: q.search } });
    where = { AND: and };
  } else {
    const doc = liveDoc(form) ?? readDoc(form.draftSchema);
    if (!canUseBuiltForm(user, form.id)) throw new HttpError(403, "You can't see this form's entries.");
    const reach = entryReachOf(form, doc, user);
    if (!reach) throw new HttpError(403, "You can't see this form's entries.");
    if (reach !== "all") scope = reach === "site" ? "entries at your sites and your own" : "your own entries and the ones you were told about";
    const base = entryWhere(form, user, { from: q.from, to: q.to, q: q.search, status: q.includeVoided ? "all" : "active", archived: "all" });
    where = { AND: [base, await visibleWhere(form, user, reach), ...(siteIds ? [{ siteId: { in: siteIds } }] : [])] };
    valuesOf = (fieldId, data) => {
      const f = doc.fields.find((x) => x.id === fieldId);
      if (!f) throw new HttpError(400, `The form has no field "${fieldId}" (get_form lists them).`);
      const v = (data as Record<string, unknown> | null)?.[fieldId];
      if (Array.isArray(v)) return v.length ? v.map((x) => formatValue(f, x) || "(blank)") : ["(blank)"];
      return [formatValue(f, v) || "(blank)"];
    };
  }

  const total = await prisma.formEntry.count({ where });
  if (total > MAX_SCAN) throw new HttpError(413, `${total.toLocaleString("en-US")} entries match; counts work on up to ${MAX_SCAN.toLocaleString("en-US")}. Narrow the dates.`);
  const rows = (await prisma.formEntry.findMany({
    where,
    select: { occurredAt: true, siteId: true, createdByName: true, status: true, ...(needData ? { data: true } : {}) },
  })) as Row[];
  const sites = new Map((await prisma.site.findMany({ select: { id: true, name: true } })).map((s) => [s.id, s.name]));

  const keysOf = (r: Row, by: string, data: unknown): string[] => {
    const t = ny(r.occurredAt);
    switch (by) {
      case "site": return [r.siteId ? sites.get(r.siteId) ?? "(unknown site)" : "(no site)"];
      case "month": return [t.month];
      case "week": return [`week of ${weekOf(t.day)}`];
      case "day": return [t.day];
      case "weekday": return [t.weekday];
      case "hour": return [`${String(t.hour).padStart(2, "0")}:00`];
      case "submittedBy": return [r.createdByName ?? "(unknown)"];
      case "status": return [r.status];
      default: return valuesOf(by.slice(6), data);
    }
  };

  const counts = new Map<string, { key: Record<string, string>; count: number }>();
  for (const r of rows) {
    let data: unknown = null;
    if (needData) {
      try {
        data = JSON.parse(r.data ?? "null");
      } catch {
        data = null;
      }
    }
    const a = keysOf(r, q.by[0], data);
    const b = q.by[1] ? keysOf(r, q.by[1], data) : [""];
    for (const x of a)
      for (const y of b) {
        const k = `${x}\u0000${y}`;
        const hit = counts.get(k) ?? { key: { [q.by[0]]: x, ...(q.by[1] ? { [q.by[1]]: y } : {}) }, count: 0 };
        hit.count++;
        counts.set(k, hit);
      }
  }
  const time = (b: string) => ["month", "week", "day", "hour"].includes(b);
  const groups = [...counts.values()].sort((x, y) => {
    if (time(q.by[0]) && x.key[q.by[0]] !== y.key[q.by[0]]) return x.key[q.by[0]].localeCompare(y.key[q.by[0]]);
    if (q.by[0] === "weekday" && x.key.weekday !== y.key.weekday) return WEEKDAYS.indexOf(x.key.weekday) - WEEKDAYS.indexOf(y.key.weekday);
    return y.count - x.count;
  });
  return {
    form: form.title,
    total,
    filters: { from: q.from, to: q.to, site: q.site, search: q.search, includeVoided: q.includeVoided || undefined },
    counted: scope,
    note: q.by.some((b) => b.startsWith("field:")) ? "A field with several answers (checkboxes, lists) counts each answer, so the groups can add up to more than the total." : undefined,
    groups: groups.slice(0, 500),
    ...(groups.length > 500 ? { truncated: `${groups.length} groups; the 500 shown are the first.` } : {}),
  };
}
