import type { Prisma, TenantTask } from "@prisma/client";
import { CASE_TX, prisma } from "../prisma.js";
import { badRequest } from "../http.js";
import { displayName } from "./roster.js";
import { caseManagementEnabled } from "./settings.js";
import { notifyQuietly } from "./notifications.js";

/**
 * The move-in checklist: the paperwork each resident is owed, with a due date —
 * PlanStreet's case template ("Lantern Sample 1") made automatic. PlanStreet only
 * labels its board columns "Within 3 days of Move In", "Monthly"…; staff create
 * every activity by hand and nothing reminds anyone. Here moving in makes the
 * tasks, each recurring one makes its next when it's done, the case lead is
 * reminded, and a rebuilt form filed for the resident ticks its task off.
 *
 * Dates are calendar days ("YYYY-MM-DD", stored as @db.Date), counted in New York.
 */

export type Every = "month" | "year";
export interface ScheduleItem {
  key: string;
  label: string;
  /** Code forms (slugs) whose entry for the resident does this task. */
  forms: string[];
  /** Due this many days after moving in. */
  afterMoveIn?: number;
  /** Due every month / year from moving in (the first one a month / year in). */
  every?: Every;
  /** Due this many days after moving out (made by the move-out). */
  afterMoveOut?: number;
}

export const SCHEDULE: readonly ScheduleItem[] = [
  { key: "initial_assessment", label: "Initial Assessment", forms: ["initial-assessment"], afterMoveIn: 3 },
  { key: "face_sheet", label: "Face Sheet", forms: ["face-sheet"], afterMoveIn: 3 },
  { key: "hmis_project_start", label: "HMIS Project Start Assessment", forms: ["hmis-assessment"], afterMoveIn: 30 },
  { key: "psychosocial", label: "Psychosocial", forms: ["psychosocial"], afterMoveIn: 30 },
  { key: "housing_assessment", label: "Housing Assessment", forms: ["housing-assessment"], every: "month" },
  { key: "hmis_annual", label: "HMIS Annual Assessment", forms: ["hmis-assessment"], every: "year" },
  { key: "psychosocial_annual", label: "Annual Psychosocial", forms: ["psychosocial"], every: "year" },
  { key: "face_sheet_annual", label: "Annual Face Sheet", forms: ["face-sheet"], every: "year" },
  { key: "hmis_project_exit", label: "HMIS Project Exit Assessment", forms: ["hmis-assessment"], afterMoveOut: 7 },
];
const BY_KEY = new Map(SCHEDULE.map((s) => [s.key, s]));

// ── Days ─────────────────────────────────────────────────────────────────

const NY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

/** Today in New York, "YYYY-MM-DD". */
export function todayNY(now = new Date()): string {
  return NY.format(now);
}

/** "YYYY-MM-DD" → the Date a @db.Date column holds (UTC midnight). */
export function day(ymd: string): Date {
  return new Date(`${ymd}T00:00:00Z`);
}

export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(ymdStr: string, n: number): string {
  const d = day(ymdStr);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

/** Months later, the same day of the month or the last day of a shorter one. */
export function addMonths(ymdStr: string, n: number): string {
  const [y, m, d] = ymdStr.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return ymd(first);
}

const step = (ymdStr: string, every: Every, n = 1) => (every === "month" ? addMonths(ymdStr, n) : addMonths(ymdStr, 12 * n));

/** The first occurrence of a recurring task on or after `from`, counting from `anchor` (their move-in). */
function nextOccurrence(anchor: string, every: Every, from: string): string {
  let n = 1;
  let due = step(anchor, every, n);
  while (due < from && n < 1200) due = step(anchor, every, ++n);
  return due;
}

type Tx = Prisma.TransactionClient;

// ── Making tasks ─────────────────────────────────────────────────────────

/**
 * The checklist for a stay that just began. `fresh`: a real move-in (or
 * transfer) — the 3- and 30-day paperwork plus the first monthly and yearly
 * ones. Not fresh: someone who already lived here when units were set up —
 * only the recurring ones, from the next one due, so nobody starts with years
 * of overdue paperwork.
 */
export async function tasksForStay(
  tx: Tx,
  opts: { tenantId: string; siteId: string; stayId: string; moveIn: string; fresh: boolean; today?: string }
) {
  const today = opts.today ?? todayNY();
  const rows: Prisma.TenantTaskCreateManyInput[] = [];
  for (const item of SCHEDULE) {
    let due: string | null = null;
    if (item.afterMoveIn !== undefined && opts.fresh) due = addDays(opts.moveIn, item.afterMoveIn);
    else if (item.every) due = opts.fresh ? step(opts.moveIn, item.every) : nextOccurrence(opts.moveIn, item.every, today);
    if (!due) continue;
    rows.push({ tenantId: opts.tenantId, siteId: opts.siteId, stayId: opts.stayId, key: item.key, label: item.label, dueOn: day(due) });
  }
  if (rows.length) await tx.tenantTask.createMany({ data: rows });
  return rows.length;
}

/** Everything still open is no longer owed (they moved out or were removed). */
export async function cancelOpenTasks(tx: Tx, tenantId: string) {
  await tx.tenantTask.updateMany({ where: { tenantId, status: "open" }, data: { status: "cancelled" } });
}

/** After a move-out: the HMIS exit assessment. */
export async function addExitTask(tx: Tx, opts: { tenantId: string; siteId: string; stayId: string | null; moveOut: string }) {
  const item = BY_KEY.get("hmis_project_exit")!;
  await tx.tenantTask.create({
    data: { tenantId: opts.tenantId, siteId: opts.siteId, stayId: opts.stayId, key: item.key, label: item.label, dueOn: day(addDays(opts.moveOut, item.afterMoveOut ?? 7)) },
  });
}

// ── Doing them ───────────────────────────────────────────────────────────

/**
 * Mark a task done or skipped (not needed this time), or open again. Done or
 * skipped, a recurring task makes its next one — unless there's already an open
 * one, or the resident has left.
 */
export async function settleTask(
  task: TenantTask,
  change: { status: "done" | "skipped" | "open"; doneOn?: string; note?: string | null; byName: string; entryRef?: string | null }
): Promise<{ task: TenantTask; next: TenantTask | null }> {
  if (task.status === "cancelled") throw badRequest("That task was cancelled when they moved out.");
  if (change.status === "open") {
    const reopened = await prisma.tenantTask.update({ where: { id: task.id }, data: { status: "open", doneOn: null, doneByName: null, note: change.note ?? task.note, entryRef: null } });
    return { task: reopened, next: null };
  }
  const doneOn = change.doneOn ?? todayNY();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.tenantTask.update({
      where: { id: task.id },
      data: { status: change.status, doneOn: day(doneOn), doneByName: change.byName, note: change.note ?? null, entryRef: change.entryRef ?? null },
    });
    const item = BY_KEY.get(task.key);
    let next: TenantTask | null = null;
    if (item?.every && task.status === "open") {
      const tenant = await tx.tenant.findUnique({ where: { id: task.tenantId }, select: { status: true, movedIn: true } });
      const already = await tx.tenantTask.count({ where: { tenantId: task.tenantId, key: task.key, status: "open" } });
      if (tenant?.status === "active" && tenant.movedIn && already === 0) {
        next = await tx.tenantTask.create({
          data: { tenantId: task.tenantId, siteId: task.siteId, stayId: task.stayId, key: task.key, label: task.label, dueOn: day(step(ymd(task.dueOn), item.every)) },
        });
      }
    }
    return { task: updated, next };
  }, CASE_TX);
}

/**
 * A form entry about a resident was filed: tick off the earliest open task that
 * form does. Quiet when there's nothing to tick (most forms) or it fails.
 */
export async function completeForForm(opts: { tenantId: string; formSlug: string; entryId: string; at: Date; byName: string }) {
  const keys = SCHEDULE.filter((s) => s.forms.includes(opts.formSlug)).map((s) => s.key);
  if (!keys.length) return null;
  try {
    const task = await prisma.tenantTask.findFirst({ where: { tenantId: opts.tenantId, status: "open", key: { in: keys } }, orderBy: { dueOn: "asc" } });
    if (!task) return null;
    return (await settleTask(task, { status: "done", doneOn: todayNY(opts.at), byName: opts.byName, entryRef: opts.entryId, note: null })).task;
  } catch (err) {
    console.error("[checklist] ticking off a task failed:", err);
    return null;
  }
}

// ── Reading ──────────────────────────────────────────────────────────────

export type TaskView = "overdue" | "due" | "open" | "done";

/**
 * Tasks at some sites: overdue, due in the next two weeks (overdue included),
 * everything open, or done in the last 90 days. `caseLeadId`: only residents
 * they lead (client information's case lead).
 */
export async function listTasks(siteIds: string[], opts: { view: TaskView; caseLeadId?: string | null; tenantId?: string | null; take?: number }) {
  const today = todayNY();
  const where: Prisma.TenantTaskWhereInput = { siteId: { in: siteIds } };
  if (opts.tenantId) where.tenantId = opts.tenantId;
  if (opts.view === "done") {
    where.status = { in: ["done", "skipped"] };
    where.doneOn = { gte: day(addDays(today, -90)) };
  } else {
    where.status = "open";
    // Only people living here now (and the exit paperwork of people who just left).
    where.OR = [{ tenant: { status: "active", movedIn: true } }, { key: "hmis_project_exit" }];
    if (opts.view === "overdue") where.dueOn = { lt: day(today) };
    if (opts.view === "due") where.dueOn = { lte: day(addDays(today, 14)) };
  }
  if (opts.caseLeadId) where.tenant = { ...(where.tenant as object), profile: { caseLeadId: opts.caseLeadId } };
  const rows = await prisma.tenantTask.findMany({
    where,
    include: {
      tenant: {
        select: { id: true, firstName: true, lastName: true, preferredName: true, unit: true, status: true, siteId: true, profile: { select: { caseLeadId: true } } },
      },
    },
    orderBy: opts.view === "done" ? { doneOn: "desc" } : { dueOn: "asc" },
    take: Math.min(opts.take ?? 1000, 2000),
  });
  const leadIds = [...new Set(rows.map((r) => r.tenant.profile?.caseLeadId).filter((x): x is string => Boolean(x)))];
  const leads = leadIds.length ? await prisma.user.findMany({ where: { id: { in: leadIds } }, select: { id: true, name: true } }) : [];
  const leadName = new Map(leads.map((l) => [l.id, l.name]));
  return rows.map((r) => taskOut(r, today, r.tenant.profile?.caseLeadId ? { id: r.tenant.profile.caseLeadId, name: leadName.get(r.tenant.profile.caseLeadId) ?? "" } : null));
}

export function taskOut(
  t: TenantTask & { tenant?: { id: string; firstName: string; lastName: string; preferredName: string | null; unit: string | null; status: string; siteId: string } },
  today = todayNY(),
  caseLead: { id: string; name: string } | null = null
) {
  const due = ymd(t.dueOn);
  return {
    id: t.id,
    tenantId: t.tenantId,
    siteId: t.siteId,
    key: t.key,
    label: t.label,
    forms: BY_KEY.get(t.key)?.forms ?? [],
    dueOn: due,
    status: t.status,
    /** Days past due (open only); negative = days left. */
    overdueDays: t.status === "open" ? Math.round((day(today).getTime() - day(due).getTime()) / 86_400_000) : null,
    doneOn: t.doneOn ? ymd(t.doneOn) : null,
    doneByName: t.doneByName,
    note: t.note,
    entryRef: t.entryRef,
    resident: t.tenant ? { id: t.tenant.id, displayName: displayName(t.tenant), unit: t.tenant.unit, status: t.tenant.status } : undefined,
    caseLead,
  };
}

// ── Reminders ────────────────────────────────────────────────────────────

const REMINDED_KEY = "residency.remindedOn";
const REMIND_HOUR = 8;
const nyHour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });

/**
 * Once a day, after 8 a.m. New York, while case management is on:
 * - each case lead hears how many of their residents' tasks are overdue or due this week;
 * - each site's managers hear about tasks more than a week overdue;
 * - someone away 30 days (and every 30 days after) is raised with their case lead and site managers.
 */
export async function runDailyReminders(now = new Date()): Promise<{ ran: boolean; caseLeads: number; sites: number; away: number }> {
  const idle = { ran: false, caseLeads: 0, sites: 0, away: 0 };
  if (!(await caseManagementEnabled())) return idle;
  const today = todayNY(now);
  if (Number(nyHour.format(now)) < REMIND_HOUR) return idle;
  const last = await prisma.setting.findUnique({ where: { key: REMINDED_KEY } });
  if (last?.value === today) return idle;
  await prisma.setting.upsert({ where: { key: REMINDED_KEY }, create: { key: REMINDED_KEY, value: today }, update: { value: today } });

  const soon = day(addDays(today, 7));
  const open = await prisma.tenantTask.findMany({
    where: { status: "open", dueOn: { lte: soon }, tenant: { status: "active", movedIn: true } },
    select: { dueOn: true, siteId: true, tenant: { select: { profile: { select: { caseLeadId: true } } } } },
  });
  const byLead = new Map<string, { overdue: number; due: number }>();
  const lateBySite = new Map<string, number>();
  const todayDate = day(today);
  const weekAgo = day(addDays(today, -7));
  for (const t of open) {
    const lead = t.tenant.profile?.caseLeadId;
    if (lead) {
      const c = byLead.get(lead) ?? { overdue: 0, due: 0 };
      if (t.dueOn < todayDate) c.overdue++;
      else c.due++;
      byLead.set(lead, c);
    }
    if (t.dueOn < weekAgo) lateBySite.set(t.siteId, (lateBySite.get(t.siteId) ?? 0) + 1);
  }
  for (const [lead, c] of byLead) {
    const parts = [c.overdue ? `${c.overdue} overdue` : null, c.due ? `${c.due} due this week` : null].filter(Boolean);
    notifyQuietly({
      to: { users: [lead] },
      type: "residents.moves",
      title: `Checklist: ${parts.join(", ")}`,
      body: "Paperwork for the residents you're case lead for.",
      link: "/roster/checklist?mine=1",
      source: "residency",
      sourceLabel: "Checklist",
    });
  }
  const sites = lateBySite.size ? await prisma.site.findMany({ where: { id: { in: [...lateBySite.keys()] } }, select: { id: true, code: true, name: true } }) : [];
  for (const s of sites) {
    const n = lateBySite.get(s.id)!;
    notifyQuietly({
      to: { roles: ["site_manager"], sites: [s.id] },
      type: "residents.moves",
      title: `${n} checklist ${n === 1 ? "item is" : "items are"} more than a week overdue at ${s.name}`,
      link: `/roster/checklist?site=${encodeURIComponent(s.code)}&view=overdue`,
      source: "residency",
      sourceLabel: "Checklist",
      onlySiteId: s.id,
    });
  }

  // Away a long time.
  const monthAgo = day(addDays(today, -30));
  const remindBefore = new Date(now.getTime() - 30 * 86_400_000);
  const away = await prisma.tenantAbsence.findMany({
    where: { outcome: null, lastSeen: { lte: monthAgo }, OR: [{ remindedAt: null }, { remindedAt: { lte: remindBefore } }] },
    include: { tenant: { select: { id: true, firstName: true, lastName: true, preferredName: true, status: true, profile: { select: { caseLeadId: true } } } } },
    take: 500,
  });
  for (const a of away) {
    if (a.tenant.status !== "active") continue;
    const days = Math.round((todayDate.getTime() - a.lastSeen.getTime()) / 86_400_000);
    const lead = a.tenant.profile?.caseLeadId;
    notifyQuietly({
      to: { roles: ["site_manager"], sites: [a.siteId], ...(lead ? { users: [lead] } : {}) },
      type: "residents.moves",
      title: `${displayName(a.tenant)} has been away ${days} days`,
      body: `${a.reason}. Mark them back, or move them out if they won't return.`,
      link: `/tenants/${a.tenantId}`,
      source: "residency",
      sourceLabel: "Away",
      onlySiteId: a.siteId,
    });
    await prisma.tenantAbsence.update({ where: { id: a.id }, data: { remindedAt: now } });
  }
  return { ran: true, caseLeads: byLead.size, sites: sites.length, away: away.length };
}

let timer: NodeJS.Timeout | null = null;

export function startChecklistReminders() {
  if (timer) return;
  const tick = () => void runDailyReminders().catch((err) => console.error("[checklist] reminders failed:", err));
  timer = setInterval(tick, 20 * 60_000);
  timer.unref();
  setTimeout(tick, 90_000).unref();
}
