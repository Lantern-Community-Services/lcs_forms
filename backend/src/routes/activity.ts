import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../http.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { attentionHours } from "../services/settings.js";
import { cutoff } from "../services/roster.js";
import { sitesInScope } from "../services/siteScope.js";
import { auditView } from "../services/audit.js";

export const activityRouter = Router();
activityRouter.use(requireAuth);

/** Audit log, newest first, keyset-paged with ?before=<iso>. */
activityRouter.get(
  "/audit",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const where: Prisma.AuditEventWhereInput = {};
    const asked = typeof req.query.site === "string" && req.query.site.trim() !== "";
    // Admins with no selection also see org-level events (people, keys) that
    // belong to no site; everyone else sees only their sites' events.
    if (asked || req.user!.siteIds) where.siteId = { in: (await sitesInScope(req, req.query.site)).map((s) => s.id) };
    // Non-roster events (people, keys, settings) are admin business: asking
    // for one by name (?action=) narrows the tenant events, never widens them.
    const action = typeof req.query.action === "string" && req.query.action ? req.query.action : null;
    where.AND = [
      ...(req.user!.permissions.includes("audit.view") ? [] : [{ action: { startsWith: "tenant." } }]),
      ...(action ? [{ action }] : []),
    ];
    if (typeof req.query.before === "string") where.createdAt = { lt: new Date(req.query.before) };

    const rows = await prisma.auditEvent.findMany({ where, orderBy: { createdAt: "desc" }, take: limit });
    const where_ = req.user!.permissions.includes("audit.view");
    res.json({
      items: rows.map((r) => auditView(r, where_)),
      nextBefore: rows.length === limit ? rows[rows.length - 1].createdAt : null,
    });
  })
);

/**
 * Everything the Dashboard needs in one round trip.
 *
 * The per-site breakdown used to run 4 queries per site (active, attention,
 * added-this-week, removed-this-week) — 80+ serial round trips for an admin
 * with 20 sites before the dashboard could paint. Each is now one query
 * grouped by siteId, so the total stays fixed regardless of site count.
 */
activityRouter.get(
  "/dashboard",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    const sites = await sitesInScope(req, req.query.site);
    const siteIds = sites.map((s) => s.id);
    const siteWhere = { siteId: { in: siteIds } };
    const weekAgo = new Date(Date.now() - 7 * 86400_000);
    const orgHours = await attentionHours();

    const [active, addedWeek, removedWeek, activeBySite, attentionRows, addedBySite, removedBySite, recent] = await Promise.all([
      prisma.tenant.count({ where: { ...siteWhere, status: "active" } }),
      prisma.tenant.count({ where: { ...siteWhere, createdAt: { gte: weekAgo } } }),
      prisma.tenant.count({ where: { ...siteWhere, status: "archived", archivedAt: { gte: weekAgo } } }),
      prisma.tenant.groupBy({ by: ["siteId"], where: { ...siteWhere, status: "active" }, _count: { _all: true } }),
      // Per-site attention thresholds, so it's an OR of per-site conditions
      // rather than a single groupBy WHERE (see sites.ts for the same pattern).
      siteIds.length
        ? prisma.$queryRaw<{ siteId: string; cnt: bigint | number }[]>`
            SELECT siteId, COUNT(*) as cnt FROM Tenant
            WHERE status = 'active' AND (${Prisma.join(
              sites.map((s) => Prisma.sql`(siteId = ${s.id} AND attentionClockAt < ${cutoff(s.attentionHours ?? orgHours)})`),
              " OR "
            )})
            GROUP BY siteId`
        : Promise.resolve([] as { siteId: string; cnt: bigint | number }[]),
      prisma.tenant.groupBy({ by: ["siteId"], where: { ...siteWhere, createdAt: { gte: weekAgo } }, _count: { _all: true } }),
      prisma.tenant.groupBy({
        by: ["siteId"],
        where: { ...siteWhere, status: "archived", archivedAt: { gte: weekAgo } },
        _count: { _all: true },
      }),
      prisma.auditEvent.findMany({
        where: { siteId: { in: siteIds }, action: { startsWith: "tenant." } },
        orderBy: { createdAt: "desc" },
        take: 12,
      }),
    ]);

    const activeBy = new Map(activeBySite.map((a) => [a.siteId, a._count._all]));
    const attentionBy = new Map(attentionRows.map((a) => [a.siteId, Number(a.cnt)]));
    const addedBy = new Map(addedBySite.map((a) => [a.siteId, a._count._all]));
    const removedBy = new Map(removedBySite.map((a) => [a.siteId, a._count._all]));
    const attentionPerSite = sites.map((s) => ({
      ...s,
      activeCount: activeBy.get(s.id) ?? 0,
      attentionCount: attentionBy.get(s.id) ?? 0,
      addedWeek: addedBy.get(s.id) ?? 0,
      removedWeek: removedBy.get(s.id) ?? 0,
    }));

    res.json({
      totals: {
        active,
        attention: attentionPerSite.reduce((n, s) => n + s.attentionCount, 0),
        addedWeek,
        removedWeek,
      },
      attentionHours: orgHours,
      sites: attentionPerSite,
      recent: recent.map((r) => auditView(r, req.user!.permissions.includes("audit.view"))),
    });
  })
);
