import { Router } from "express";
import type { BuiltForm } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler, badRequest } from "../http.js";
import { requirePermission } from "../auth/middleware.js";
import { actorOf } from "../services/audit.js";
import { ROLES } from "../services/permissions.js";
import {
  eventsOf, loadRouting, planRoutes, rerouteEntry, resetRouting, routingForm, routingLog, saveRouting,
} from "../services/routing.js";
import { routeSchema } from "../forms/routingSchema.js";

/**
 * Admin → Notification routing: each form's routes (who's told about what),
 * what they'd reach, and what they've sent. Admins (forms.manage) only; the
 * MCP has the same through forms/routingTools.ts. See services/routing.ts.
 */
export const routingRouter = Router();
routingRouter.use(requirePermission("forms.manage"));

/** Every form, with how many routes it has and whether they're its defaults. */
routingRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const forms = await prisma.builtForm.findMany({
      where: { status: { not: "archived" } },
      orderBy: { title: "asc" },
      select: { id: true, slug: true, title: true, kind: true, status: true, liveSchema: true, draftSchema: true },
    });
    const saved = await prisma.formRecord.findMany({ where: { collection: "__routing", docId: "routes" }, select: { formId: true, data: true, updatedAt: true, updatedByName: true } });
    const byForm = new Map(saved.map((s) => [s.formId, s]));
    const items = await Promise.all(
      forms.map(async (f) => {
        const doc = byForm.has(f.id) ? null : await loadRouting(f as BuiltForm);
        const s = byForm.get(f.id);
        const routes = s ? ((JSON.parse(s.data) as { routes?: { enabled?: boolean }[] }).routes ?? []) : doc!.routes;
        return {
          id: f.id, slug: f.slug, title: f.title, kind: f.kind, status: f.status,
          routes: routes.length, enabled: routes.filter((r) => r.enabled !== false).length,
          usingDefaults: !s, updatedAt: s?.updatedAt ?? null, updatedByName: s?.updatedByName ?? null,
        };
      })
    );
    res.json({ items });
  })
);

/** Staff to put on a route: active and invited people, by name or address. */
routingRouter.get(
  "/people",
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? "").trim().slice(0, 80);
    const rows = await prisma.user.findMany({
      where: { status: { in: ["active", "invited"] }, ...(q ? { OR: [{ name: { contains: q } }, { email: { contains: q } }] } : {}) },
      orderBy: { name: "asc" },
      take: 25,
      select: { id: true, name: true, email: true, roleKey: true, status: true },
    });
    res.json(rows.map((u) => ({ ...u, roleName: ROLES.find((r) => r.key === u.roleKey)?.name ?? u.roleKey })));
  })
);

routingRouter.get(
  "/:form",
  asyncHandler(async (req, res) => {
    const form = await routingForm(req.params.form);
    res.json({
      form: { id: form.id, slug: form.slug, title: form.title, kind: form.kind, status: form.status, url: form.kind === "code" ? `/apps/${form.slug}` : `/f/${form.slug}` },
      events: eventsOf(form),
      roles: ROLES.map((r) => ({ key: r.key, name: r.name, everySite: r.allSites })),
      ...(await loadRouting(form)),
      log: await routingLog(form.id, { limit: 30 }),
    });
  })
);

routingRouter.put(
  "/:form",
  asyncHandler(async (req, res) => {
    const body = z.object({ routes: z.array(z.unknown()).max(100), revision: z.number().int().optional() }).parse(req.body);
    const form = await routingForm(req.params.form);
    res.json(await saveRouting(form, body.routes, actorOf(req), body.revision));
  })
);

routingRouter.post(
  "/:form/reset",
  asyncHandler(async (req, res) => {
    res.json(await resetRouting(await routingForm(req.params.form), actorOf(req)));
  })
);

/**
 * Who a route would tell for a site (and values), before saving it. People the
 * event names and the person who filed it are shown as placeholders.
 */
routingRouter.post(
  "/:form/preview",
  asyncHandler(async (req, res) => {
    const body = z.object({ route: z.unknown(), site: z.string().optional(), data: z.record(z.unknown()).optional() }).parse(req.body);
    const form = await routingForm(req.params.form);
    const parsed = routeSchema.safeParse(body.route);
    if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => `${i.path.join(".") || "route"}: ${i.message}`).join("; "));
    const site = body.site ? await prisma.site.findFirst({ where: { OR: [{ id: body.site }, { code: body.site }] }, select: { id: true, code: true, name: true } }) : null;
    // Preview who's on it: the route's own conditions are left out (there are no answers yet).
    const route = { ...parsed.data, enabled: true, when: undefined };
    const [plan] = await planRoutes(form, [route], { event: route.event, title: "Preview", site });
    res.json(plan ?? { people: [], emails: [], notes: ["This route doesn't apply at that site."] });
  })
);

routingRouter.get(
  "/:form/log",
  asyncHandler(async (req, res) => {
    const form = await routingForm(req.params.form);
    res.json({ items: await routingLog(form.id, { limit: Number(req.query.limit) || 50, entryId: typeof req.query.entry === "string" ? req.query.entry : undefined }) });
  })
);

/** Send an entry's new-entry routes again (all, or one route). */
routingRouter.post(
  "/:form/entries/:entry/reroute",
  asyncHandler(async (req, res) => {
    const body = z.object({ route: z.string().optional(), dryRun: z.boolean().optional() }).parse(req.body ?? {});
    const form = await routingForm(req.params.form);
    res.json(await rerouteEntry(form, req.params.entry, actorOf(req), body));
  })
);
