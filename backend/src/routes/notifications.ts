import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler, badRequest, notFound } from "../http.js";
import { requireAuth } from "../auth/middleware.js";
import { EMAIL_MODES, notify, prefsFor, savePrefs, shapeNotification, unreadCount } from "../services/notifications.js";

/**
 * The signed-in person's notifications (the bell, /notifications) and their
 * preferences (Profile → Notifications). Everyone sees only their own.
 * Notifications are made by services/notifications.ts, never through here.
 */
export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

const mine = (req: { user?: { userId: string } }) => ({ userId: req.user!.userId, inApp: true });

/** Newest first, a page at a time: ?before=<createdAt of the last one>&unread=1. */
notificationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        before: z.string().datetime().optional(),
        unread: z.enum(["1", "true"]).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(req.query);
    const rows = await prisma.notification.findMany({
      where: { ...mine(req), ...(q.unread ? { readAt: null } : {}), ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
    });
    const more = rows.length > q.limit;
    const items = rows.slice(0, q.limit).map(shapeNotification);
    res.json({ items, nextBefore: more ? items[items.length - 1].createdAt : null, unread: await unreadCount(req.user!.userId) });
  })
);

/** Polled by the bell: how many are unread, and the newest (for a "new notification" toast). */
notificationsRouter.get(
  "/unread",
  asyncHandler(async (req, res) => {
    const [unread, latest] = await Promise.all([
      unreadCount(req.user!.userId),
      prisma.notification.findFirst({ where: { ...mine(req), readAt: null }, orderBy: { createdAt: "desc" } }),
    ]);
    res.json({ unread, latest: latest ? shapeNotification(latest) : null });
  })
);

notificationsRouter.get(
  "/prefs",
  asyncHandler(async (req, res) => {
    res.json(await prefsFor(req.user!));
  })
);

notificationsRouter.put(
  "/prefs",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        emailMode: z.enum(EMAIL_MODES).optional(),
        prefs: z.array(z.object({ key: z.string().max(255), inApp: z.boolean(), email: z.boolean() }).strict()).max(500).optional(),
        reset: z.array(z.string().max(255)).max(500).optional(),
      })
      .strict()
      .parse(req.body);
    try {
      await savePrefs(req.user!.userId, body);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
    res.json(await prefsFor(req.user!));
  })
);

/** Send yourself one, to see how they look and that email reaches you. */
notificationsRouter.post(
  "/test",
  asyncHandler(async (req, res) => {
    const out = await notify({
      to: { users: [req.user!.userId] },
      type: "account",
      title: "This is a test notification",
      body: "You sent this to yourself from Profile → Notifications. If it reached you, notifications are working.",
      link: "/profile",
      sourceLabel: "Lantern Forms",
    });
    res.json(out);
  })
);

notificationsRouter.post(
  "/read-all",
  asyncHandler(async (req, res) => {
    const { count } = await prisma.notification.updateMany({ where: { ...mine(req), readAt: null }, data: { readAt: new Date() } });
    res.json({ ok: true, count });
  })
);

/** Clear out the ones already read. */
notificationsRouter.delete(
  "/read",
  asyncHandler(async (req, res) => {
    const { count } = await prisma.notification.deleteMany({ where: { ...mine(req), readAt: { not: null } } });
    res.json({ ok: true, count });
  })
);

/** One notification, for /notifications/:id (an email's link), which marks it read and opens its page. */
notificationsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const n = await prisma.notification.findFirst({ where: { id: req.params.id, userId: req.user!.userId } });
    if (!n) throw notFound("That notification isn't yours, or it's been cleared.");
    res.json(shapeNotification(n));
  })
);

notificationsRouter.post(
  "/:id/read",
  asyncHandler(async (req, res) => {
    const read = z.object({ read: z.boolean().default(true) }).parse(req.body ?? {}).read;
    const { count } = await prisma.notification.updateMany({ where: { id: req.params.id, userId: req.user!.userId }, data: { readAt: read ? new Date() : null } });
    if (!count) throw notFound();
    res.json({ ok: true });
  })
);

notificationsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const { count } = await prisma.notification.deleteMany({ where: { id: req.params.id, userId: req.user!.userId } });
    if (!count) throw notFound();
    res.json({ ok: true });
  })
);
