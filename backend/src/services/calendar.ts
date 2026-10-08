import type { Request } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { badRequest, forbidden, notFound } from "../http.js";
import { canAccessSite } from "../auth/middleware.js";
import { sitesInScope } from "./siteScope.js";
import { actorOf, audit } from "./audit.js";
import { getSetting, setSetting } from "./settings.js";
import { noteCalendarChange, queueOutlookCancel } from "./outlookSync.js";
import {
  addDays, canonicalRule, countBefore, daysApart, daysBetween, describeRule, firstDay, isDay, isOccurrence, lastDay, ruleProblem,
  type Recurrence,
} from "../calendar/recurrence.js";

/**
 * The calendar: events for every site or for chosen ones, one-off or repeating,
 * with single days of a series cancelled, moved or reworded on their own.
 *
 * Everyone signed in reads it and sees the events for every site plus those for
 * the sites they're assigned to (admins: all). Two kinds of people change it:
 *   - `calendar.manage` (the Admin role only): everything, categories included;
 *   - `calendar.edit` (the per-person "Can edit the calendar" switch, which only
 *     an Admin turns on): events whose sites are all their own. Never an event
 *     for every site, never one that also reaches a site they aren't at, never
 *     the categories.
 * A third: a code form's server code (ctx.calendar.form), for the events that
 * form owns, e.g. an event request put on the calendar while it waits for
 * approval (`pending`). Nobody changes those on the calendar itself; they
 * change with the form.
 * Days and times are New York wall-clock text; see schema.prisma.
 */

export const COLOR_SLOTS = 8;
/** The furthest apart `from` and `to` may be in one read: a little over a year. */
const MAX_RANGE_DAYS = 400;
/** A single occurrence can't last longer than this. */
const MAX_SPAN_DAYS = 366;

// ── Categories ───────────────────────────────────────────────────────────

const DEFAULT_CATEGORIES = [
  { name: "Meeting", colorSlot: 0 },
  { name: "Training", colorSlot: 2 },
  { name: "Resident event", colorSlot: 1 },
  { name: "Inspection", colorSlot: 3 },
  { name: "Deadline", colorSlot: 7 },
  { name: "Holiday", colorSlot: 6 },
];

/** A fresh database opens with a few categories. Once only, so deleting them all sticks. */
export async function ensureDefaultCalendarCategories(): Promise<boolean> {
  if (await getSetting("calendarCategoriesSeeded")) return false;
  const wrote = (await prisma.calendarCategory.count()) === 0;
  if (wrote) await prisma.calendarCategory.createMany({ data: DEFAULT_CATEGORIES.map((c, i) => ({ ...c, sortOrder: i })) });
  await setSetting("calendarCategoriesSeeded", new Date().toISOString());
  return wrote;
}

export const categoryBody = z.object({
  name: z.string().trim().min(1, "Give the category a name.").max(60),
  colorSlot: z.number().int().min(0).max(COLOR_SLOTS - 1),
});

// ── What an admin sends ──────────────────────────────────────────────────

const weekday = z.number().int().min(0).max(6);
const recurrenceSchema = z.object({
  freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int(),
  weekdays: z.array(weekday).max(7).optional(),
  monthDay: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("day"), day: z.number().int() }),
      z.object({
        kind: z.literal("nth"),
        nth: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(-1), z.literal(-2)]),
        of: z.union([weekday, z.enum(["day", "weekday", "weekend"])]),
      }),
    ])
    .optional(),
  months: z.array(z.number().int().min(1).max(12)).max(12).optional(),
  end: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("never") }),
    z.object({ kind: z.literal("count"), count: z.number().int() }),
    z.object({ kind: z.literal("until"), date: z.string() }),
  ]),
});

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Times are HH:MM.");
const optionalText = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);

export const eventInput = z.object({
  title: z.string().trim().min(1, "Give the event a title.").max(160),
  description: optionalText(4000),
  location: optionalText(200),
  categoryId: z.string().nullish().transform((v) => v || null),
  allSites: z.boolean(),
  siteIds: z.array(z.string()).max(500).default([]),
  allDay: z.boolean(),
  startDate: z.string().refine(isDay, "Choose the day it starts."),
  startTime: time.nullish(),
  endDate: z.string().refine(isDay, "Choose the day it ends."),
  endTime: time.nullish(),
  // The shapes match recurrence.ts; ruleProblem() checks the values.
  recurrence: recurrenceSchema.nullish().transform((r) => (r ?? null) as Recurrence | null),
  /** Give it a Teams meeting link in Outlook. */
  teamsMeeting: z.boolean().default(false),
});
export type EventInput = z.infer<typeof eventInput>;

export const scopeSchema = z.enum(["all", "this", "following"]);
export type Scope = z.infer<typeof scopeSchema>;

interface When {
  allDay: boolean;
  startDate: string;
  startTime: string | null;
  endDate: string;
  endTime: string | null;
}

/** The when-fields, checked: times only when not all day, and it ends after it starts. */
function checkWhen(input: Pick<EventInput, "allDay" | "startDate" | "startTime" | "endDate" | "endTime">): When {
  const when: When = {
    allDay: input.allDay,
    startDate: input.startDate,
    startTime: input.allDay ? null : input.startTime ?? null,
    endDate: input.endDate,
    endTime: input.allDay ? null : input.endTime ?? null,
  };
  if (!when.allDay && (!when.startTime || !when.endTime)) throw badRequest("Choose a start and end time, or make it all day.");
  const startKey = `${when.startDate} ${when.startTime ?? ""}`;
  const endKey = `${when.endDate} ${when.endTime ?? ""}`;
  if (endKey < startKey) throw badRequest("It can't end before it starts.");
  if (daysApart(when.startDate, when.endDate) > MAX_SPAN_DAYS) throw badRequest("An event can last up to a year.");
  return when;
}

/** Everything a series row holds, from an admin's input. */
async function seriesFields(input: EventInput) {
  const when = checkWhen(input);
  let rule: Recurrence | null = null;
  if (input.recurrence) {
    const problem = ruleProblem(when.startDate, input.recurrence);
    if (problem) throw badRequest(problem);
    rule = canonicalRule(when.startDate, input.recurrence);
  }
  // The start moves to the first day the rule picks (a weekly-on-Monday event
  // entered on a Thursday starts the next Monday), keeping its length.
  const span = daysApart(when.startDate, when.endDate);
  const first = firstDay(when.startDate, rule)!;
  const last = lastDay(when.startDate, rule);
  if (first !== when.startDate) {
    when.startDate = first;
    when.endDate = addDays(first, span);
  }

  if (input.categoryId && !(await prisma.calendarCategory.findUnique({ where: { id: input.categoryId }, select: { id: true } }))) {
    throw badRequest("That category no longer exists.");
  }
  const siteIds = input.allSites ? [] : [...new Set(input.siteIds)];
  if (!input.allSites) {
    if (siteIds.length === 0) throw badRequest("Choose at least one site, or make it for every site.");
    if ((await prisma.site.count({ where: { id: { in: siteIds } } })) !== siteIds.length) throw badRequest("One of those sites no longer exists.");
  }
  return {
    data: {
      title: input.title,
      description: input.description,
      location: input.location,
      categoryId: input.categoryId,
      allSites: input.allSites,
      ...when,
      recurrence: rule ? JSON.stringify(rule) : null,
      teamsMeeting: input.teamsMeeting,
      firstDate: first,
      lastDate: last === null ? null : addDays(last, span),
    },
    rule,
    siteIds,
  };
}

// ── Reading ──────────────────────────────────────────────────────────────

const SERIES_INCLUDE = {
  category: true,
  sourceForm: { select: { slug: true, title: true } },
  sites: { include: { site: { select: { id: true, code: true, name: true } } } },
  exceptions: true,
} satisfies Prisma.CalendarEventInclude;
type SeriesRow = Prisma.CalendarEventGetPayload<{ include: typeof SERIES_INCLUDE }>;

export function ruleOf(ev: { recurrence: string | null }): Recurrence | null {
  if (!ev.recurrence) return null;
  try {
    return JSON.parse(ev.recurrence) as Recurrence;
  } catch {
    return null;
  }
}

// ── Who may change what ──────────────────────────────────────────────────

const managesAll = (req: Request) => Boolean(req.user?.permissions.includes("calendar.manage"));

/**
 * May this person change an event that's for these sites (or create one)?
 * Admins: any. A calendar editor: only one for chosen sites, every one of
 * them theirs, so they can't touch what other sites see. Nobody, for an event
 * a code form owns: it changes with the form (see FormOwner).
 */
export function canChangeEvent(req: Request, ev: { allSites: boolean; siteIds: string[]; sourceFormId?: string | null }): boolean {
  if (ev.sourceFormId) return false;
  if (managesAll(req)) return true;
  if (!req.user?.permissions.includes("calendar.edit")) return false;
  return !ev.allSites && ev.siteIds.length > 0 && ev.siteIds.every((id) => canAccessSite(req, id));
}

function assertCanChange(req: Request, ev: { allSites: boolean; siteIds: string[]; sourceFormId?: string | null }) {
  if (canChangeEvent(req, ev)) return;
  if (ev.sourceFormId) throw forbidden("This event belongs to a form: change it there.");
  if (ev.allSites) throw forbidden("Only an Admin can add or change events for every site.");
  throw forbidden("You can only add or change events for your own sites.");
}

const sitesOf = (ev: { allSites: boolean; sites: { siteId: string }[]; sourceFormId?: string | null }) => ({
  allSites: ev.allSites,
  siteIds: ev.sites.map((s) => s.siteId),
  sourceFormId: ev.sourceFormId ?? null,
});

/**
 * A code form acting on its own events (its server code's ctx.calendar.form),
 * on behalf of whoever is using it. It needs no calendar rights of theirs, but
 * it touches only events it made, and never ones for every site.
 */
export interface FormOwner {
  formId: string;
  /** The form's reference (an entry id); kept on the event. */
  ref?: string | null;
  /** Mark it waiting on approval (true) or approved (false); omit to leave it. */
  pending?: boolean;
}

function assertOwns(owner: FormOwner, ev: { sourceFormId: string | null }) {
  if (ev.sourceFormId !== owner.formId) throw forbidden("That calendar event doesn't belong to this form.");
}

function assertFormSites(input: { allSites: boolean }) {
  if (input.allSites) throw forbidden("A form's own events are for chosen sites, not every site.");
}

/** Can this person see this event: it's for every site, or for one of theirs. */
function canSee(req: Request, ev: { allSites: boolean; sites: { siteId: string }[] }): boolean {
  const mine = req.user?.siteIds;
  return ev.allSites || mine === null || mine === undefined || ev.sites.some((s) => mine.includes(s.siteId));
}

export interface Occurrence extends When {
  /** Unique per occurrence: the series id and the day the series puts it on. */
  key: string;
  eventId: string;
  /** The day the series puts it on, which is how to address this one occurrence. */
  date: string;
  title: string;
  description: string | null;
  location: string | null;
  categoryId: string | null;
  allSites: boolean;
  sites: { code: string; name: string }[];
  repeats: boolean;
  repeatText: string | null;
  /** This day was changed on its own. */
  changed: boolean;
  /** The person asking may edit or delete it (see canChangeEvent). */
  canEdit: boolean;
  /** The Teams link Outlook made for it, when it has one. */
  teamsJoinUrl: string | null;
  /** Waiting on approval in the form that made it; not in Outlook yet. */
  pending: boolean;
  /** The code form that owns it (open /apps/<slug>), with its reference. */
  source: { slug: string; title: string; ref: string | null } | null;
}
type Occ = Omit<Occurrence, "canEdit">;

function occurrenceOf(ev: SeriesRow, rule: Recurrence | null, date: string, ex: SeriesRow["exceptions"][number] | undefined): Occ {
  const span = daysApart(ev.startDate, ev.endDate);
  const moved = ex?.startDate && ex.endDate;
  return {
    key: `${ev.id}:${date}`,
    eventId: ev.id,
    date,
    title: ex?.title ?? ev.title,
    description: ex?.description ?? ev.description,
    location: ex?.location ?? ev.location,
    allDay: moved ? Boolean(ex!.allDay) : ev.allDay,
    startDate: moved ? ex!.startDate! : date,
    startTime: moved ? ex!.startTime : ev.startTime,
    endDate: moved ? ex!.endDate! : addDays(date, span),
    endTime: moved ? ex!.endTime : ev.endTime,
    categoryId: ev.categoryId,
    allSites: ev.allSites,
    sites: ev.sites.map((s) => ({ code: s.site.code, name: s.site.name })).sort((a, b) => a.name.localeCompare(b.name)),
    repeats: Boolean(rule),
    repeatText: rule ? describeRule(ev.startDate, rule) : null,
    changed: Boolean(ex),
    teamsJoinUrl: ev.teamsJoinUrl,
    pending: ev.pending,
    source: sourceOf(ev),
  };
}

const sourceOf = (ev: Pick<SeriesRow, "sourceForm" | "sourceRef">) =>
  ev.sourceForm ? { slug: ev.sourceForm.slug, title: ev.sourceForm.title, ref: ev.sourceRef } : null;

/** Every occurrence of one series that touches `from`–`to`. */
function expand(ev: SeriesRow, from: string, to: string): Occ[] {
  const rule = ruleOf(ev);
  const span = daysApart(ev.startDate, ev.endDate);
  const exceptions = new Map(ev.exceptions.map((x) => [x.originalDate, x]));
  const out: Occ[] = [];
  // Starting up to `span` days early: a multi-day occurrence that began before
  // `from` is still on screen.
  for (const day of daysBetween(ev.startDate, rule, addDays(from, -span), to)) {
    if (!exceptions.has(day)) out.push(occurrenceOf(ev, rule, day, undefined));
  }
  for (const ex of ev.exceptions) {
    if (ex.cancelled || !isOccurrence(ev.startDate, rule, ex.originalDate)) continue;
    const occ = occurrenceOf(ev, rule, ex.originalDate, ex);
    if (occ.startDate <= to && occ.endDate >= from) out.push(occ);
  }
  return out;
}

const sortKey = (o: Occ) => `${o.startDate} ${o.allDay ? "" : o.startTime} ${o.title.toLowerCase()}`;

/**
 * The occurrences from `from` to `to` (inclusive days) for the sites asked
 * about (`?site=`, codes; none = all of mine), plus the events for every site.
 */
export async function loadOccurrences(req: Request, query: Record<string, unknown>) {
  const from = String(query.from ?? "");
  const to = String(query.to ?? "");
  if (!isDay(from) || !isDay(to)) throw badRequest("from and to are days, YYYY-MM-DD.");
  if (to < from) throw badRequest("to is before from.");
  if (daysApart(from, to) > MAX_RANGE_DAYS) throw badRequest(`Ask for ${MAX_RANGE_DAYS} days or fewer at a time.`);

  // An admin looking at all sites sees everything, including events for sites
  // since closed. Anyone else: the sites in view.
  const asked = typeof query.site === "string" && query.site.trim() !== "";
  const siteFilter: Prisma.CalendarEventWhereInput =
    req.user!.siteIds === null && !asked
      ? {}
      : { OR: [{ allSites: true }, { sites: { some: { siteId: { in: (await sitesInScope(req, query.site)).map((s) => s.id) } } } }] };

  const rows = await prisma.calendarEvent.findMany({
    where: {
      AND: [
        siteFilter,
        {
          OR: [
            { firstDate: { lte: to }, OR: [{ lastDate: null }, { lastDate: { gte: from } }] },
            // A single day moved out of the series' own range.
            { exceptions: { some: { startDate: { lte: to }, endDate: { gte: from } } } },
          ],
        },
      ],
    },
    include: SERIES_INCLUDE,
  });
  const items = rows.flatMap((ev) => {
    const canEdit = canChangeEvent(req, sitesOf(ev));
    return expand(ev, from, to).map((o): Occurrence => ({ ...o, canEdit }));
  });
  items.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return { from, to, items };
}

/** One series as the editor needs it. */
export async function loadSeries(req: Request, id: string) {
  const ev = await prisma.calendarEvent.findUnique({ where: { id }, include: SERIES_INCLUDE });
  if (!ev || !canSee(req, ev)) throw notFound("That event is no longer on the calendar.");
  const rule = ruleOf(ev);
  return {
    id: ev.id,
    title: ev.title,
    description: ev.description,
    location: ev.location,
    categoryId: ev.categoryId,
    allSites: ev.allSites,
    siteIds: ev.sites.map((s) => s.siteId),
    sites: ev.sites.map((s) => ({ code: s.site.code, name: s.site.name })),
    allDay: ev.allDay,
    startDate: ev.startDate,
    startTime: ev.startTime,
    endDate: ev.endDate,
    endTime: ev.endTime,
    recurrence: rule,
    repeatText: rule ? describeRule(ev.startDate, rule) : null,
    lastDate: ev.lastDate,
    cancelledDates: ev.exceptions.filter((x) => x.cancelled).map((x) => x.originalDate).sort(),
    changedDates: ev.exceptions.filter((x) => !x.cancelled).map((x) => x.originalDate).sort(),
    canEdit: canChangeEvent(req, sitesOf(ev)),
    teamsMeeting: ev.teamsMeeting,
    teamsJoinUrl: ev.teamsJoinUrl,
    pending: ev.pending,
    source: sourceOf(ev),
    // How it stands in Outlook, for the people who can change it.
    outlook: canChangeEvent(req, sitesOf(ev))
      ? { sent: Boolean(ev.outlookEventId), waiting: ev.outlookDirty, error: ev.outlookError, syncedAt: ev.outlookSyncedAt }
      : null,
    createdByName: ev.createdByName,
    updatedByName: ev.updatedByName,
    createdAt: ev.createdAt,
    updatedAt: ev.updatedAt,
  };
}

// ── Writing ──────────────────────────────────────────────────────────────

async function loadForWrite(id: string) {
  const ev = await prisma.calendarEvent.findUnique({ where: { id }, include: SERIES_INCLUDE });
  if (!ev) throw notFound("That event is no longer on the calendar.");
  return ev;
}

function whereLabel(allSites: boolean, siteNames: string[]): string {
  if (allSites) return "every site";
  return siteNames.length <= 3 ? siteNames.join(", ") : `${siteNames.length} sites`;
}

async function siteNames(ids: string[]) {
  return (await prisma.site.findMany({ where: { id: { in: ids } }, select: { name: true }, orderBy: { name: "asc" } })).map((s) => s.name);
}

export async function createEvent(req: Request, input: EventInput, owner?: FormOwner) {
  if (owner) assertFormSites(input);
  else assertCanChange(req, input);
  const { data, rule, siteIds } = await seriesFields(input);
  const ev = await prisma.calendarEvent.create({
    data: {
      ...data,
      ...(owner ? { sourceFormId: owner.formId, sourceRef: owner.ref ?? null, pending: owner.pending ?? false } : {}),
      createdById: req.user?.userId ?? null,
      createdByName: req.user?.name ?? "A form",
      sites: { create: siteIds.map((siteId) => ({ siteId })) },
    },
  });
  await audit({
    actor: actorOf(req),
    action: "calendar.event_created",
    siteId: siteIds.length === 1 ? siteIds[0] : null,
    summary: `Added "${ev.title}" to the calendar for ${whereLabel(ev.allSites, await siteNames(siteIds))}${rule ? ` (${describeRule(ev.startDate, rule)})` : ` on ${ev.startDate}`}${ev.pending ? ", waiting on approval" : ""}`,
    changes: { eventId: ev.id },
  });
  await noteCalendarChange([ev.id]);
  return ev.id;
}

/** Change the whole series. Days changed on their own stay changed while the series still falls on them. */
async function updateSeries(req: Request, ev: SeriesRow, input: EventInput) {
  const { data, rule, siteIds } = await seriesFields(input);
  // Outlook can't take a Teams link away once it's made one.
  if (ev.teamsJoinUrl) data.teamsMeeting = true;
  const stale = ev.exceptions.filter((x) => !rule || !isOccurrence(data.startDate, rule, x.originalDate)).map((x) => x.id);
  await prisma.$transaction([
    prisma.calendarEvent.update({ where: { id: ev.id }, data: { ...data, updatedById: req.user?.userId ?? null, updatedByName: req.user?.name ?? "A form" } }),
    prisma.calendarEventSite.deleteMany({ where: { eventId: ev.id } }),
    prisma.calendarEventSite.createMany({ data: siteIds.map((siteId) => ({ eventId: ev.id, siteId })) }),
    prisma.calendarException.deleteMany({ where: { id: { in: stale } } }),
  ]);
  return ev.id;
}

/** Change one day of a series. Only what differs from the series is kept, so a later change to the series still reaches it. */
async function updateOne(req: Request, ev: SeriesRow, date: string, input: EventInput) {
  const when = checkWhen(input);
  const span = daysApart(ev.startDate, ev.endDate);
  const usual: When = { allDay: ev.allDay, startDate: date, startTime: ev.startTime, endDate: addDays(date, span), endTime: ev.endTime };
  const moved = (Object.keys(usual) as (keyof When)[]).some((k) => usual[k] !== when[k]);
  const differs = (a: string | null, b: string | null) => ((a ?? "") !== (b ?? "") ? a ?? "" : null);
  const fields = {
    cancelled: false,
    title: input.title !== ev.title ? input.title : null,
    description: differs(input.description, ev.description),
    location: differs(input.location, ev.location),
    allDay: moved ? when.allDay : null,
    startDate: moved ? when.startDate : null,
    startTime: moved ? when.startTime : null,
    endDate: moved ? when.endDate : null,
    endTime: moved ? when.endTime : null,
    updatedByName: req.user?.name ?? "A form",
  };
  const same = !moved && fields.title === null && fields.description === null && fields.location === null;
  if (same) {
    await prisma.calendarException.deleteMany({ where: { eventId: ev.id, originalDate: date } });
  } else {
    await prisma.calendarException.upsert({
      where: { eventId_originalDate: { eventId: ev.id, originalDate: date } },
      create: { eventId: ev.id, originalDate: date, ...fields },
      update: fields,
    });
  }
  await prisma.calendarEvent.update({ where: { id: ev.id }, data: { updatedById: req.user?.userId ?? null, updatedByName: req.user?.name ?? "A form" } });
  return ev.id;
}

/** End a series the day before `date`, and drop its changes from then on. */
function truncate(ev: SeriesRow, rule: Recurrence, date: string) {
  const ended: Recurrence = { ...rule, end: { kind: "until", date: addDays(date, -1) } };
  const span = daysApart(ev.startDate, ev.endDate);
  const last = lastDay(ev.startDate, ended)!;
  return { recurrence: JSON.stringify(ended), lastDate: addDays(last, span) };
}

/** "This and following": the series ends before `date` and a new one, as entered, takes over from there. */
async function updateFollowing(req: Request, ev: SeriesRow, rule: Recurrence, date: string, input: EventInput) {
  // Starting earlier would put the new part on top of the old one's last days.
  if (input.startDate < date) throw badRequest(`From this one on starts on or after ${date}.`);
  // A series that ran for a number of times keeps its total: the new part gets what's left.
  if (rule.end.kind === "count" && input.recurrence?.end.kind === "count" && input.recurrence.end.count === rule.end.count) {
    input = { ...input, recurrence: { ...input.recurrence, end: { kind: "count", count: Math.max(1, rule.end.count - countBefore(ev.startDate, rule, date)) } } };
  }
  const { data, rule: nextRule, siteIds } = await seriesFields(input);
  const later = ev.exceptions.filter((x) => x.originalDate >= date);
  const carried = later.filter((x) => isOccurrence(data.startDate, nextRule, x.originalDate)).map((x) => x.id);
  const dropped = later.filter((x) => !carried.includes(x.id)).map((x) => x.id);
  const next = await prisma.$transaction(async (tx) => {
    await tx.calendarEvent.update({ where: { id: ev.id }, data: { ...truncate(ev, rule, date), updatedById: req.user?.userId ?? null, updatedByName: req.user?.name ?? "A form" } });
    const created = await tx.calendarEvent.create({
      data: { ...data, createdById: req.user?.userId ?? null, createdByName: req.user?.name ?? "A form", sites: { create: siteIds.map((siteId) => ({ siteId })) } },
    });
    await tx.calendarException.updateMany({ where: { id: { in: carried } }, data: { eventId: created.id } });
    await tx.calendarException.deleteMany({ where: { id: { in: dropped } } });
    return created;
  });
  return next.id;
}

export async function updateEvent(req: Request, id: string, scope: Scope, date: string | undefined, input: EventInput, owner?: FormOwner) {
  const ev = await loadForWrite(id);
  const rule = ruleOf(ev);
  if (owner) {
    assertOwns(owner, ev);
    assertFormSites(input);
  } else {
    assertCanChange(req, sitesOf(ev));
    // Changing one day keeps the series' sites; anything else may move it, and it must stay within reach.
    if (!rule || scope !== "this") assertCanChange(req, input);
  }
  let result: string;
  if (!rule || scope === "all") {
    result = await updateSeries(req, ev, input);
  } else {
    if (!date || !isOccurrence(ev.startDate, rule, date)) throw badRequest("That day isn't one of this event's.");
    if (scope === "this") result = await updateOne(req, ev, date, input);
    else if (date <= ev.firstDate) result = await updateSeries(req, ev, input);
    else result = await updateFollowing(req, ev, rule, date, input);
  }
  if (owner) {
    // The part that takes over "from this one on" belongs to the form as well.
    await prisma.calendarEvent.updateMany({
      where: { id: { in: [...new Set([id, result])] } },
      data: { sourceFormId: owner.formId, sourceRef: owner.ref === undefined ? ev.sourceRef : owner.ref, ...(owner.pending === undefined ? {} : { pending: owner.pending }) },
    });
  }
  const what = !rule || scope === "all" ? "" : scope === "this" ? ` on ${date}` : ` from ${date} on`;
  await audit({
    actor: actorOf(req),
    action: "calendar.event_updated",
    summary: `Changed "${input.title}" on the calendar${what}`,
    changes: { eventId: id, scope, date, newEventId: result !== id ? result : undefined },
  });
  await noteCalendarChange([...new Set([id, result])]);
  return result;
}

export async function deleteEvent(req: Request, id: string, scope: Scope, date: string | undefined, owner?: FormOwner) {
  const ev = await loadForWrite(id);
  if (owner) assertOwns(owner, ev);
  else assertCanChange(req, sitesOf(ev));
  const rule = ruleOf(ev);
  if (rule && scope !== "all" && (!date || !isOccurrence(ev.startDate, rule, date))) throw badRequest("That day isn't one of this event's.");

  const gone = !rule || scope === "all" || (scope === "following" && date! <= ev.firstDate);
  if (gone) {
    await queueOutlookCancel(ev);
    await prisma.calendarEvent.delete({ where: { id } });
  } else if (scope === "this") {
    await prisma.calendarException.upsert({
      where: { eventId_originalDate: { eventId: id, originalDate: date! } },
      create: { eventId: id, originalDate: date!, cancelled: true, updatedByName: req.user?.name ?? "A form" },
      update: { cancelled: true, updatedByName: req.user?.name ?? "A form" },
    });
  } else {
    await prisma.$transaction([
      prisma.calendarEvent.update({ where: { id }, data: { ...truncate(ev, rule, date!), updatedById: req.user?.userId ?? null, updatedByName: req.user?.name ?? "A form" } }),
      prisma.calendarException.deleteMany({ where: { eventId: id, originalDate: { gte: date! } } }),
    ]);
  }
  const what = !rule || scope === "all" ? "" : scope === "this" ? ` on ${date}` : ` from ${date} on`;
  await audit({
    actor: actorOf(req),
    action: "calendar.event_deleted",
    summary: `Removed "${ev.title}" from the calendar${what}`,
    changes: { eventId: id, scope, date },
  });
  if (!gone) await noteCalendarChange([id]);
}

/** Undo cancelling one day of a series. */
export async function restoreOccurrence(req: Request, id: string, date: string) {
  const ev = await loadForWrite(id);
  assertCanChange(req, sitesOf(ev));
  const ex = ev.exceptions.find((x) => x.originalDate === date && x.cancelled);
  if (!ex) return;
  const reworded = ex.title !== null || ex.description !== null || ex.location !== null || ex.startDate !== null;
  if (reworded) await prisma.calendarException.update({ where: { id: ex.id }, data: { cancelled: false, updatedByName: req.user?.name ?? "A form" } });
  else await prisma.calendarException.delete({ where: { id: ex.id } });
  await audit({ actor: actorOf(req), action: "calendar.event_updated", summary: `Put "${ev.title}" back on the calendar on ${date}`, changes: { eventId: id, date } });
  await noteCalendarChange([id]);
}

/** Mark a form's own event approved (pending false) or waiting again (true). Outlook follows. */
export async function setEventPending(req: Request, id: string, pending: boolean, owner: FormOwner) {
  const ev = await loadForWrite(id);
  assertOwns(owner, ev);
  if (ev.pending === pending) return;
  await prisma.calendarEvent.update({ where: { id }, data: { pending, updatedById: req.user?.userId ?? null, updatedByName: req.user?.name ?? "A form" } });
  await audit({
    actor: actorOf(req),
    action: "calendar.event_updated",
    summary: pending ? `"${ev.title}" is waiting on approval again (taken out of Outlook)` : `"${ev.title}" was approved (goes to Outlook)`,
    changes: { eventId: id, pending },
  });
  await noteCalendarChange([id]);
}

/** A form's own events, all of them or those with one reference. */
export async function formEvents(formId: string, ref?: string | null) {
  const rows = await prisma.calendarEvent.findMany({
    where: { sourceFormId: formId, ...(ref ? { sourceRef: ref } : {}) },
    include: { sites: { include: { site: { select: { code: true, name: true } } } } },
    orderBy: { firstDate: "asc" },
    take: 2000,
  });
  return rows.map((ev) => ({
    id: ev.id,
    ref: ev.sourceRef,
    pending: ev.pending,
    title: ev.title,
    allDay: ev.allDay,
    startDate: ev.startDate,
    startTime: ev.startTime,
    endDate: ev.endDate,
    endTime: ev.endTime,
    lastDate: ev.lastDate,
    repeats: Boolean(ev.recurrence),
    sites: ev.sites.map((x) => ({ code: x.site.code, name: x.site.name })),
  }));
}
