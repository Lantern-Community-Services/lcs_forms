import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler, badRequest, forbidden, notFound } from "../http.js";
import { env } from "../env.js";
import { markUpcomingDirty, outlookConfigured, runQueue } from "../services/outlookSync.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { actorOf, audit } from "../services/audit.js";
import { isDay } from "../calendar/recurrence.js";
import {
  categoryBody, createEvent, deleteEvent, eventInput, loadOccurrences, loadSeries, restoreOccurrence, scopeSchema, updateEvent,
} from "../services/calendar.js";

/**
 * The calendar. Reading is for everyone signed in (each sees the events for
 * every site and for their own sites). Categories need `calendar.manage`
 * (Admin). Events need that or `calendar.edit` (the per-person switch), and
 * services/calendar.ts then holds a calendar editor to their own sites.
 */
export const calendarRouter = Router();
calendarRouter.use(requireAuth);
const MANAGE = requirePermission("calendar.manage");
const EDIT = requirePermission("calendar.manage", "calendar.edit");

// ── Categories ───────────────────────────────────────────────────────────

calendarRouter.get(
  "/categories",
  asyncHandler(async (_req, res) => {
    const rows = await prisma.calendarCategory.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: { _count: { select: { events: true } } },
    });
    res.json(rows.map(({ _count, ...c }) => ({ ...c, eventCount: _count.events })));
  })
);

calendarRouter.post(
  "/categories",
  MANAGE,
  asyncHandler(async (req, res) => {
    const body = categoryBody.parse(req.body);
    const last = await prisma.calendarCategory.findFirst({ orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
    const row = await prisma.calendarCategory.create({ data: { ...body, sortOrder: (last?.sortOrder ?? -1) + 1 } });
    await audit({ actor: actorOf(req), action: "calendar.category_created", summary: `Added the calendar category "${row.name}"` });
    res.status(201).json(row);
  })
);

calendarRouter.put(
  "/categories/order",
  MANAGE,
  asyncHandler(async (req, res) => {
    const { ids } = z.object({ ids: z.array(z.string()).max(200) }).parse(req.body);
    await prisma.$transaction(ids.map((id, i) => prisma.calendarCategory.update({ where: { id }, data: { sortOrder: i } })));
    res.json({ ok: true });
  })
);

calendarRouter.patch(
  "/categories/:id",
  MANAGE,
  asyncHandler(async (req, res) => {
    const body = categoryBody.partial().parse(req.body);
    const before = await prisma.calendarCategory.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound("That category no longer exists.");
    const row = await prisma.calendarCategory.update({ where: { id: before.id }, data: body });
    await audit({ actor: actorOf(req), action: "calendar.category_updated", summary: `Changed the calendar category "${before.name}"${row.name !== before.name ? ` to "${row.name}"` : ""}` });
    res.json(row);
  })
);

calendarRouter.delete(
  "/categories/:id",
  MANAGE,
  asyncHandler(async (req, res) => {
    const row = await prisma.calendarCategory.findUnique({ where: { id: req.params.id } });
    if (!row) throw notFound("That category no longer exists.");
    // Its events stay on the calendar, uncategorized (onDelete: SetNull).
    await prisma.calendarCategory.delete({ where: { id: row.id } });
    await audit({ actor: actorOf(req), action: "calendar.category_deleted", summary: `Removed the calendar category "${row.name}"` });
    res.json({ ok: true });
  })
);

// ── Events ───────────────────────────────────────────────────────────────

/** Occurrences from `from` to `to` (days, inclusive), for `?site=` (codes; none = all of mine). */
calendarRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await loadOccurrences(req, req.query));
  })
);

calendarRouter.get(
  "/events/:id",
  asyncHandler(async (req, res) => {
    res.json(await loadSeries(req, req.params.id));
  })
);

calendarRouter.post(
  "/events",
  EDIT,
  asyncHandler(async (req, res) => {
    const id = await createEvent(req, eventInput.parse(req.body));
    res.status(201).json({ id });
  })
);

const changeBody = z.object({
  scope: scopeSchema.default("all"),
  /** Which occurrence, for "this" and "following": the day the series puts it on. */
  date: z.string().refine(isDay).optional(),
  event: eventInput,
});

/** Returns the id of the series that now holds the change: a new one after "this and following". */
calendarRouter.patch(
  "/events/:id",
  EDIT,
  asyncHandler(async (req, res) => {
    const body = changeBody.parse(req.body);
    res.json({ id: await updateEvent(req, req.params.id, body.scope, body.date, body.event) });
  })
);

calendarRouter.delete(
  "/events/:id",
  EDIT,
  asyncHandler(async (req, res) => {
    const scope = scopeSchema.parse(req.query.scope ?? "all");
    const date = typeof req.query.date === "string" ? req.query.date : undefined;
    if (date !== undefined && !isDay(date)) throw badRequest("date is a day, YYYY-MM-DD.");
    await deleteEvent(req, req.params.id, scope, date);
    res.json({ ok: true });
  })
);

/** Put back one day of a series that was cancelled (the Undo after removing it). */
calendarRouter.post(
  "/events/:id/restore",
  EDIT,
  asyncHandler(async (req, res) => {
    const { date } = z.object({ date: z.string().refine(isDay, "date is a day, YYYY-MM-DD.") }).parse(req.body);
    await restoreOccurrence(req, req.params.id, date);
    res.json({ ok: true });
  })
);

// ── In my Outlook ────────────────────────────────────────────────────────

/** The sites this person may follow: their own (every active site for an all-sites role). */
async function followableSites(req: import("express").Request) {
  const mine = req.user!.siteIds;
  return prisma.site.findMany({
    where: { active: true, ...(mine ? { id: { in: mine } } : {}) },
    select: { id: true, code: true, name: true },
    orderBy: { name: "asc" },
  });
}

/** What the "Add to my Outlook" popup shows: the choices, and what this person picked. */
calendarRouter.get(
  "/outlook/me",
  asyncHandler(async (req, res) => {
    const me = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { email: true, calendarSyncEverySite: true, calendarSyncSetAt: true, calendarFollows: { select: { siteId: true } } },
    });
    res.json({
      /** False until the server is set up to send to Outlook; choices are kept for then. */
      enabled: outlookConfigured(),
      email: me?.email ?? "",
      answered: Boolean(me?.calendarSyncSetAt),
      everySite: Boolean(me?.calendarSyncEverySite),
      siteIds: (me?.calendarFollows ?? []).map((f) => f.siteId),
      sites: await followableSites(req),
    });
  })
);

calendarRouter.put(
  "/outlook/me",
  asyncHandler(async (req, res) => {
    const body = z.object({ everySite: z.boolean(), siteIds: z.array(z.string()).max(500) }).parse(req.body);
    const allowed = new Set((await followableSites(req)).map((s) => s.id));
    const siteIds = [...new Set(body.siteIds)];
    if (siteIds.some((id) => !allowed.has(id))) throw forbidden("You can only add your own sites.");
    await prisma.$transaction([
      prisma.calendarFollow.deleteMany({ where: { userId: req.user!.userId } }),
      prisma.calendarFollow.createMany({ data: siteIds.map((siteId) => ({ userId: req.user!.userId, siteId })) }),
      prisma.user.update({ where: { id: req.user!.userId }, data: { calendarSyncEverySite: body.everySite, calendarSyncSetAt: new Date() } }),
    ]);
    // Every upcoming event's invite list is checked again (unchanged ones aren't re-sent).
    await markUpcomingDirty();
    res.json({ ok: true });
  })
);

/** For Admins: is Outlook switched on, and is anything stuck. */
calendarRouter.get(
  "/outlook/status",
  MANAGE,
  asyncHandler(async (_req, res) => {
    const [waiting, failing, sent, people, trash] = await Promise.all([
      prisma.calendarEvent.count({ where: { outlookDirty: true } }),
      prisma.calendarEvent.findMany({ where: { outlookError: { not: null } }, select: { id: true, title: true, outlookError: true }, take: 20 }),
      prisma.calendarEvent.count({ where: { outlookEventId: { not: null } } }),
      prisma.user.count({ where: { status: "active", calendarSyncSetAt: { not: null }, OR: [{ calendarSyncEverySite: true }, { calendarFollows: { some: {} } }] } }),
      prisma.calendarOutlookTrash.count(),
    ]);
    res.json({ enabled: outlookConfigured(), organizer: env.calendarOrganizer || null, waiting, sent, people, cancelsWaiting: trash, failing });
  })
);

/** For Admins: send what's waiting now rather than in a few minutes. */
calendarRouter.post(
  "/outlook/run",
  MANAGE,
  asyncHandler(async (_req, res) => {
    res.json(await runQueue());
  })
);
