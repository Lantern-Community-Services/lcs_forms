import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler, badRequest, forbidden, notFound } from "../http.js";
import { canAccessSite, requireAuth, requirePermission } from "../auth/middleware.js";
import { actorOf, audit } from "../services/audit.js";
import { sitesInScope } from "../services/siteScope.js";
import { caseManagementEnabled } from "../services/settings.js";
import { displayName } from "../services/roster.js";
import {
  assertResidency,
  bulkUnits,
  createUnit,
  makeHead,
  markAway,
  markReturned,
  moveIn,
  moveOut,
  residencyMeta,
  residencyReport,
  residencyView,
  seedUnits,
  setRelation,
  transfer,
  unitsAt,
  updateUnit,
} from "../services/residency.js";
import { addDays, listTasks, settleTask, taskOut, todayNY, type TaskView } from "../services/checklist.js";

/**
 * Units, moving in and out, being away, the move-in checklist and its reports
 * (services/residency.ts, services/checklist.ts). Case management only: with it
 * off every route answers 404. Each acts at the caller's own sites.
 *
 * Who does what: anyone who sees the roster reads; roster editors move people in,
 * transfer them, mark them away or back, and tick the checklist (so do people
 * with client information); moving out needs what Remove needs (roster.archive);
 * units are managed by Site Managers and Admins.
 */
export const residencyRouter = Router();
residencyRouter.use(requireAuth);
residencyRouter.use(
  asyncHandler(async (_req, _res, next) => {
    if (!(await caseManagementEnabled())) throw notFound("Units and move-ins are part of case management, which is turned off.");
    next();
  })
);

const SITE_SELECT = { id: true, code: true, name: true, siteType: true, households: true } as const;
const can = (req: Request, p: string) => req.user!.permissions.includes(p as never);
const ctxOf = (req: Request) => ({ actor: actorOf(req), userId: req.user?.userId ?? null, byName: req.user?.name ?? "Someone" });
const siteOk = (req: Request) => (siteId: string) => canAccessSite(req, siteId);

function requireUnitManager(req: Request) {
  if (!can(req, "roster.archive") && !can(req, "sites.manage")) throw forbidden("Only Site Managers and Admins manage units.");
}

async function siteFor(req: Request, raw: unknown) {
  if (typeof raw !== "string" || !raw) throw badRequest("Choose a site.");
  const site = await prisma.site.findFirst({ where: { OR: [{ code: raw }, { id: raw }] }, select: SITE_SELECT });
  if (!site || !canAccessSite(req, site.id)) throw notFound("Site not found.");
  await assertResidency(site);
  return site;
}

async function tenantFor(req: Request, id: string) {
  const t = await prisma.tenant.findUnique({ where: { id }, include: { site: { select: SITE_SELECT } } });
  if (!t || !canAccessSite(req, t.siteId)) throw notFound("Resident not found.");
  return t;
}

async function unitFor(req: Request, id: string) {
  const u = await prisma.unit.findUnique({ where: { id }, include: { site: { select: SITE_SELECT } } });
  if (!u || !canAccessSite(req, u.siteId)) throw notFound("Unit not found.");
  return u;
}

// ── Lists for the screens ────────────────────────────────────────────────

residencyRouter.get(
  "/meta",
  requirePermission("roster.view"),
  asyncHandler(async (_req, res) => res.json(residencyMeta()))
);

/** Units at the selected sites (supportive ones only), with who lives in each. */
residencyRouter.get(
  "/units",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    const sites = (await sitesInScope(req, req.query.site)).filter((s) => s.siteType === "supportive");
    const full = await prisma.site.findMany({ where: { id: { in: sites.map((s) => s.id) } }, select: SITE_SELECT });
    const units = await unitsAt(full.map((s) => s.id), { includeRetired: req.query.retired === "1" });
    res.json({ sites: full.map((s) => ({ ...s, unitCount: units.filter((u) => u.siteId === s.id).length })), units });
  })
);

// ── Units ────────────────────────────────────────────────────────────────

const unitBody = z.object({
  label: z.string().max(60).optional(),
  unitType: z.string().max(40).nullable().optional(),
  program: z.string().max(255).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  active: z.boolean().optional(),
});

residencyRouter.post(
  "/units",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    requireUnitManager(req);
    const body = unitBody.extend({ site: z.string() }).parse(req.body);
    const site = await siteFor(req, body.site);
    res.status(201).json(await createUnit(ctxOf(req), site, { ...body, label: body.label }));
  })
);

residencyRouter.post(
  "/units/bulk",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    requireUnitManager(req);
    const body = z
      .object({ site: z.string(), labels: z.array(z.string().max(60)).min(1).max(1000), unitType: z.string().max(40).nullable().optional(), program: z.string().max(255).nullable().optional() })
      .parse(req.body);
    const site = await siteFor(req, body.site);
    res.json(await bulkUnits(ctxOf(req), site, body.labels, body));
  })
);

/** Create a site's units from the unit numbers on its roster, and link everyone to theirs. */
residencyRouter.post(
  "/units/seed",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    requireUnitManager(req);
    const body = z.object({ site: z.string() }).parse(req.body);
    const site = await siteFor(req, body.site);
    res.json(await seedUnits(ctxOf(req), site));
  })
);

residencyRouter.patch(
  "/units/:id",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    requireUnitManager(req);
    const unit = await unitFor(req, req.params.id);
    await assertResidency(unit.site);
    res.json(await updateUnit(ctxOf(req), unit, unitBody.parse(req.body)));
  })
);

const person = z.object({ tenantId: z.string().max(64), relation: z.string().max(80).nullable().optional() });

residencyRouter.post(
  "/units/:id/move-in",
  requirePermission("roster.edit"),
  asyncHandler(async (req, res) => {
    const body = z.object({ date: z.string(), people: z.array(person).min(1).max(20), program: z.string().max(255).nullable().optional() }).parse(req.body);
    await unitFor(req, req.params.id);
    res.json(await moveIn(ctxOf(req), { unitId: req.params.id, date: body.date, people: body.people, program: body.program, canAccessSite: siteOk(req) }));
  })
);

// ── One resident ─────────────────────────────────────────────────────────

residencyRouter.get(
  "/tenants/:id",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    const t = await tenantFor(req, req.params.id);
    const [view, tasks] = await Promise.all([
      residencyView(t),
      prisma.tenantTask.findMany({
        where: { tenantId: t.id, OR: [{ status: "open" }, { status: { in: ["done", "skipped"] }, doneOn: { gte: new Date(`${addDays(todayNY(), -400)}T00:00:00Z`) } }] },
        orderBy: { dueOn: "asc" },
        take: 200,
      }),
    ]);
    res.json({
      ...view,
      tasks: tasks.map((x) => taskOut(x)),
      can: {
        move: can(req, "roster.edit"),
        moveOut: can(req, "roster.archive"),
        tick: can(req, "roster.edit") || can(req, "clients.edit"),
      },
    });
  })
);

/** Everyone in the person's household (they're head) or just them. */
async function householdIds(t: { id: string; householdHeadId: string | null }) {
  if (t.householdHeadId) return [t.id];
  const members = await prisma.tenant.findMany({ where: { householdHeadId: t.id, status: "active" }, select: { id: true } });
  return [t.id, ...members.map((m) => m.id)];
}

residencyRouter.post(
  "/tenants/:id/transfer",
  requirePermission("roster.edit"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        toUnitId: z.string().max(64),
        date: z.string(),
        reason: z.string().max(120).nullable().optional(),
        withHousehold: z.boolean().optional(),
        relations: z.record(z.string().max(80)).optional(),
      })
      .parse(req.body);
    const t = await tenantFor(req, req.params.id);
    await unitFor(req, body.toUnitId);
    const ids = body.withHousehold ? await householdIds(t) : [t.id];
    res.json(await transfer(ctxOf(req), { tenantIds: ids, toUnitId: body.toUnitId, date: body.date, reason: body.reason, relations: body.relations, canAccessSite: siteOk(req) }));
  })
);

residencyRouter.post(
  "/tenants/:id/move-out",
  requirePermission("roster.archive"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        date: z.string(),
        reason: z.string().max(120),
        destination: z.string().max(200).nullable().optional(),
        forwardingAddress: z.record(z.string().max(200)).nullable().optional(),
        note: z.string().max(2000).nullable().optional(),
        /** Household members leaving with them. */
        alsoIds: z.array(z.string().max(64)).max(20).optional(),
        /** A head leaving a household behind: who takes over. */
        newHeadId: z.string().max(64).nullable().optional(),
      })
      .parse(req.body);
    const t = await tenantFor(req, req.params.id);
    const household = new Set(await householdIds(t.householdHeadId ? { id: t.householdHeadId, householdHeadId: null } : t));
    const also = (body.alsoIds ?? []).filter((id) => id !== t.id);
    if (also.some((id) => !household.has(id))) throw badRequest("Only members of the same household can move out together.");
    res.json(
      await moveOut(ctxOf(req), {
        tenantIds: [t.id, ...also],
        date: body.date,
        reason: body.reason,
        destination: body.destination,
        forwardingAddress: body.forwardingAddress,
        note: body.note,
        newHeadId: body.newHeadId,
        canAccessSite: siteOk(req),
      })
    );
  })
);

residencyRouter.post(
  "/tenants/:id/away",
  requirePermission("roster.edit"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ lastSeen: z.string(), reason: z.string().max(120), detail: z.string().max(1000).nullable().optional(), expectedReturn: z.string().nullable().optional() })
      .parse(req.body);
    const t = await tenantFor(req, req.params.id);
    await markAway(ctxOf(req), t, body);
    res.json({ ok: true });
  })
);

residencyRouter.post(
  "/tenants/:id/returned",
  requirePermission("roster.edit"),
  asyncHandler(async (req, res) => {
    const body = z.object({ date: z.string() }).parse(req.body);
    const t = await tenantFor(req, req.params.id);
    await markReturned(ctxOf(req), t, body);
    res.json({ ok: true });
  })
);

residencyRouter.post(
  "/tenants/:id/household",
  requirePermission("roster.edit"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ relation: z.string().max(80).optional(), makeHead: z.boolean().optional(), formerHeadRelation: z.string().max(80).optional() })
      .parse(req.body);
    const t = await tenantFor(req, req.params.id);
    await assertResidency(t.site);
    if (!t.site.households) throw badRequest(`${t.site.name} isn't a household site.`);
    if (body.makeHead) await makeHead(ctxOf(req), t, body.formerHeadRelation);
    else await setRelation(ctxOf(req), t, body.relation);
    res.json({ ok: true });
  })
);

// ── Checklist ────────────────────────────────────────────────────────────

const VIEWS: TaskView[] = ["overdue", "due", "open", "done"];

residencyRouter.get(
  "/tasks",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    const sites = (await sitesInScope(req, req.query.site)).filter((s) => s.siteType === "supportive");
    const view = (VIEWS as string[]).includes(String(req.query.view)) ? (String(req.query.view) as TaskView) : "due";
    const items = await listTasks(sites.map((s) => s.id), { view, caseLeadId: req.query.mine === "1" ? req.user!.userId : null });
    res.json({ view, sites: sites.map((s) => ({ id: s.id, code: s.code, name: s.name })), items });
  })
);

residencyRouter.post(
  "/tasks/:id",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    if (!can(req, "roster.edit") && !can(req, "clients.edit")) throw forbidden();
    const body = z
      .object({ status: z.enum(["done", "skipped", "open"]), doneOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), note: z.string().max(2000).nullable().optional() })
      .parse(req.body);
    const task = await prisma.tenantTask.findUnique({ where: { id: req.params.id }, include: { tenant: { select: { id: true, firstName: true, lastName: true, preferredName: true, siteId: true } } } });
    if (!task || !canAccessSite(req, task.siteId)) throw notFound("Task not found.");
    if (body.doneOn && body.doneOn > todayNY()) throw badRequest("Done on can't be in the future.");
    if (body.status === "skipped" && !body.note?.trim()) throw badRequest("Say why it isn't needed.");
    const result = await settleTask(task, { status: body.status, doneOn: body.doneOn, note: body.note ?? null, byName: req.user!.name });
    await audit({
      actor: actorOf(req),
      action: "tenant.task",
      tenantId: task.tenantId,
      siteId: task.siteId,
      summary: `${body.status === "open" ? "Reopened" : body.status === "done" ? "Done" : "Not needed"}: ${task.label} for ${displayName(task.tenant)}`,
      changes: body.note ? { note: body.note } : undefined,
    });
    res.json({ task: taskOut(result.task), next: result.next ? taskOut(result.next) : null });
  })
);

// ── Reports ──────────────────────────────────────────────────────────────

residencyRouter.get(
  "/report",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    const sites = (await sitesInScope(req, req.query.site)).filter((s) => s.siteType === "supportive");
    const today = todayNY();
    const to = typeof req.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : today;
    const from = typeof req.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : addDays(to, -364);
    if (from > to) throw badRequest("From must be before To.");
    res.json({ ...(await residencyReport(sites, from, to)), sites: sites.map((s) => ({ id: s.id, code: s.code, name: s.name })) });
  })
);
