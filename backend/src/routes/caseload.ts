import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler, badRequest, forbidden, HttpError, notFound } from "../http.js";
import { canAccessSite, requireAuth, requirePermission } from "../auth/middleware.js";
import { actorOf, audit } from "../services/audit.js";
import { sitesInScope } from "../services/siteScope.js";
import { caseManagementEnabled } from "../services/settings.js";
import { displayName } from "../services/roster.js";
import { fieldWords, saveProfile } from "../services/clientProfile.js";
import { caseloadResidents, caseloadTasks, caseloadTotals, leadChoices, unassigned } from "../services/caseload.js";
import { todayNY } from "../services/checklist.js";

/**
 * The caseload screen (services/caseload.ts): a case lead's residents, their
 * open checklist as a to-do list, and the residents nobody leads yet. Case
 * management only: with it off every route answers 404.
 *
 * Who: anyone with client information (clients.view) sees their own caseload,
 * and so do the people who manage a site's roster (roster.archive). Site
 * Managers and Admins may look at another case lead's (only residents at their
 * own sites), see who nobody leads, and assign a case lead to those. Ticking a
 * task off goes through the checklist's own route (routes/residency.ts).
 */
export const caseloadRouter = Router();
caseloadRouter.use(requireAuth);
caseloadRouter.use(
  asyncHandler(async (_req, _res, next) => {
    if (!(await caseManagementEnabled())) throw notFound("The caseload is part of case management, which is turned off.");
    next();
  })
);

const can = (req: Request, p: string) => req.user!.permissions.includes(p as never);

/** Manages a site's roster: Site Managers and Admins (and anyone given roster management). */
const managesRoster = (req: Request) => can(req, "roster.archive");

/**
 * May look at someone else's caseload: Site Managers and Admins, and an Admin's
 * API key that reads client information (it sees every site's case leads anyway).
 */
const picksLead = (req: Request) => managesRoster(req) || (can(req, "clients.view") && req.user!.siteIds === null);

function requireCaseload(req: Request) {
  if (!can(req, "clients.view") && !managesRoster(req)) throw forbidden("The caseload is for people with client information or who manage a site's roster.");
}

/** Whose caseload: ?lead=<user id> for a manager, otherwise the person asking. */
async function leadFor(req: Request) {
  const raw = typeof req.query.lead === "string" ? req.query.lead.trim() : "";
  const self = req.user!.userId;
  if (!raw || raw === self) return { id: self, name: req.user!.name, self: true };
  if (!picksLead(req)) throw forbidden("Only Site Managers and Admins see other case leads' caseloads.");
  const u = await prisma.user.findUnique({ where: { id: raw }, select: { id: true, name: true } });
  if (!u) throw notFound("No such person.");
  return { ...u, self: false };
}

caseloadRouter.get(
  "/",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    requireCaseload(req);
    const lead = await leadFor(req);
    const residents = await caseloadResidents(lead.id, req.user!.siteIds);
    res.json({
      lead,
      today: todayNY(),
      totals: caseloadTotals(residents),
      residents,
      can: {
        pickLead: picksLead(req),
        assign: managesRoster(req),
        tick: can(req, "roster.edit") || can(req, "clients.edit"),
      },
    });
  })
);

caseloadRouter.get(
  "/tasks",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    requireCaseload(req);
    const lead = await leadFor(req);
    res.json({ lead, ...(await caseloadTasks(lead.id, req.user!.siteIds)) });
  })
);

/** Who a manager can pick to look at: staff at their sites, with how many residents each leads. */
caseloadRouter.get(
  "/leads",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    if (!picksLead(req)) throw forbidden("Only Site Managers and Admins see other case leads' caseloads.");
    res.json(await leadChoices(req.user!.siteIds));
  })
);

/** Residents at the manager's (selected) supportive sites with no case lead, and who can lead them, per site. */
caseloadRouter.get(
  "/unassigned",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    if (!managesRoster(req)) throw forbidden("Only Site Managers and Admins assign case leads.");
    res.json({ sites: await unassigned(await sitesInScope(req, req.query.site)) });
  })
);

/**
 * Make someone case lead for residents nobody leads yet: one or several at once,
 * each saved as a client information change (services/clientProfile.ts) and
 * audited like one. Someone who already has a case lead is skipped; changing it
 * is done on their client information.
 */
caseloadRouter.post(
  "/assign",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    if (!managesRoster(req)) throw forbidden("Only Site Managers and Admins assign case leads.");
    const body = z.object({ leadId: z.string().min(1).max(64), tenantIds: z.array(z.string().min(1).max(64)).min(1).max(200) }).parse(req.body);
    const lead = await prisma.user.findUnique({ where: { id: body.leadId }, select: { id: true, name: true } });
    if (!lead) throw badRequest("Pick a case lead.");
    const ids = [...new Set(body.tenantIds)];
    const tenants = new Map(
      (await prisma.tenant.findMany({ where: { id: { in: ids } }, include: { site: { select: { id: true, code: true, name: true } }, profile: true } })).map((t) => [t.id, t])
    );
    const assigned: { tenantId: string; name: string }[] = [];
    const skipped: { tenantId: string; name: string | null; reason: string }[] = [];
    for (const id of ids) {
      const t = tenants.get(id);
      if (!t || !canAccessSite(req, t.siteId)) {
        skipped.push({ tenantId: id, name: null, reason: "Resident not found." });
        continue;
      }
      const name = displayName(t);
      if (t.status !== "active") {
        skipped.push({ tenantId: id, name, reason: "No longer on the roster." });
        continue;
      }
      if (t.profile?.caseLeadId) {
        skipped.push({ tenantId: id, name, reason: t.profile.caseLeadId === lead.id ? `${lead.name} is already their case lead.` : "Already has a case lead." });
        continue;
      }
      try {
        const saved = await saveProfile({ tenant: t, before: t.profile, version: t.profile?.version ?? 0, changes: { caseLead: lead.id }, userId: req.user!.userId });
        if (!saved) continue;
        await audit({
          actor: actorOf(req),
          action: "tenant.profile_updated",
          tenantId: t.id,
          siteId: t.siteId,
          summary: `Updated client information for ${name} (${fieldWords(saved.changed)})`,
          changes: saved.diff,
        });
        assigned.push({ tenantId: t.id, name });
      } catch (e) {
        // One that can't be saved (the lead doesn't work there, someone saved meanwhile) doesn't stop the rest.
        if (!(e instanceof HttpError)) throw e;
        skipped.push({ tenantId: id, name, reason: e.message });
      }
    }
    res.json({ lead, assigned, skipped });
  })
);
