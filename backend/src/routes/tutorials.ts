import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler, badRequest, notFound } from "../http.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { getSetting } from "../services/settings.js";
import { PROGRESS_KEY_RE, formTutorialProgress } from "../tutorials/progress.js";

/**
 * Guided tutorials (frontend lib/tour): which ones the signed-in person has
 * finished or skipped, so none starts twice on any of their devices. The
 * tutorials themselves live elsewhere: the welcome tour in the frontend's code,
 * a form's in its document or form.json.
 */
export const tutorialsRouter = Router();
tutorialsRouter.use(requireAuth);

/** Everything they've seen, and whether the welcome tour is on (Admin → Sign-in access). */
tutorialsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const [rows, welcomeTour] = await Promise.all([
      prisma.tutorialProgress.findMany({ where: { userId: req.user!.userId }, select: { key: true, version: true, status: true, step: true, steps: true, updatedAt: true } }),
      getSetting("welcomeTour"),
    ]);
    res.json({ welcomeTour: welcomeTour !== "false", items: rows });
  })
);

/** Finished or skipped one. Recording an older version than the one kept is ignored. */
tutorialsRouter.put(
  "/:key",
  asyncHandler(async (req, res) => {
    const key = req.params.key;
    if (!PROGRESS_KEY_RE.test(key)) throw badRequest("Not a tutorial.");
    const body = z
      .object({
        version: z.number().int().min(1).max(10_000).default(1),
        status: z.enum(["completed", "skipped"]),
        step: z.number().int().min(0).max(100).nullable().optional(),
        steps: z.number().int().min(0).max(100).nullable().optional(),
      })
      .strict()
      .parse(req.body);
    if (key.startsWith("form:") && !(await prisma.builtForm.findUnique({ where: { id: key.slice(5) }, select: { id: true } }))) throw notFound("No such form.");
    const userId = req.user!.userId;
    const was = await prisma.tutorialProgress.findUnique({ where: { userId_key: { userId, key } } });
    if (was && was.version > body.version) return res.json(was);
    const data = { version: body.version, status: body.status, step: body.status === "skipped" ? (body.step ?? null) : null, steps: body.steps ?? null };
    res.json(await prisma.tutorialProgress.upsert({ where: { userId_key: { userId, key } }, create: { userId, key, ...data }, update: data }));
  })
);

/**
 * Forget some, so they start again: ?key=<one key>, or ?scope=forms (every
 * form's tutorial) / all. The welcome tour replays from Profile without this.
 */
tutorialsRouter.delete(
  "/",
  asyncHandler(async (req, res) => {
    const q = z.object({ key: z.string().regex(PROGRESS_KEY_RE).optional(), scope: z.enum(["forms", "all"]).optional() }).parse(req.query);
    if (!q.key && !q.scope) throw badRequest("Say which: ?key= or ?scope=forms|all.");
    const where = { userId: req.user!.userId, ...(q.key ? { key: q.key } : q.scope === "forms" ? { key: { startsWith: "form:" } } : {}) };
    const { count } = await prisma.tutorialProgress.deleteMany({ where });
    res.json({ reset: count });
  })
);

/** Who has been through a form's tutorial (for whoever builds forms). */
tutorialsRouter.get(
  "/forms/:id",
  requirePermission("forms.manage", "apps.develop"),
  asyncHandler(async (req, res) => {
    const form = await prisma.builtForm.findFirst({ where: { OR: [{ id: req.params.id }, { slug: req.params.id }] }, select: { id: true } });
    if (!form) throw notFound("No such form.");
    res.json(await formTutorialProgress(form.id));
  })
);
