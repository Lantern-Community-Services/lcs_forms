import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler, badRequest, notFound } from "../http.js";
import { canAccessSite, requireAuth, requirePermission } from "../auth/middleware.js";
import { actorOf, fromRequest } from "../services/audit.js";
import { sitesInScope } from "../services/siteScope.js";
import { caseManagementEnabled } from "../services/settings.js";
import type { TenantDTO } from "../services/roster.js";
import { callRouteOk } from "../ops/callRoute.js";
import { tenantsRouter } from "./tenants.js";
import {
  acceptApplicant,
  applicantMeta,
  applicantReport,
  createApplicant,
  isStage,
  listApplicants,
  moveApplicant,
  updateApplicant,
  type AddResident,
} from "../services/applicants.js";

/**
 * Applicants (services/applicants.ts): people referred for a unit at a
 * supportive site, up to the day they're accepted onto the roster. Case
 * management only: with it off every route answers 404.
 *
 * Who: people who manage a site's roster (roster.edit: Site Managers, anyone
 * with the "Can manage the roster" switch) add and move applicants at their
 * sites; people with client information (clients.view) see them; Admins both,
 * everywhere. Anyone else at the site doesn't see them at all.
 */
export const applicantsRouter = Router();
applicantsRouter.use(requireAuth);
applicantsRouter.use(
  asyncHandler(async (_req, _res, next) => {
    if (!(await caseManagementEnabled())) throw notFound("Applicants are part of case management, which is turned off.");
    next();
  })
);

const SEE = requirePermission("roster.edit", "clients.view");
const MANAGE = requirePermission("roster.edit");
const SITE_SELECT = { id: true, code: true, name: true, siteType: true } as const;
const ctxOf = (req: Request) => ({ actor: actorOf(req), userId: req.user?.userId ?? null, byName: req.user?.name ?? "Someone" });

/** Applicants are for supportive housing: shelters and offices have none. */
async function siteFor(req: Request, raw: unknown) {
  if (typeof raw !== "string" || !raw) throw badRequest("Choose a site.");
  const site = await prisma.site.findFirst({ where: { OR: [{ code: raw }, { id: raw }] }, select: SITE_SELECT });
  if (!site || !canAccessSite(req, site.id)) throw notFound("Site not found.");
  if (site.siteType !== "supportive") throw badRequest(`${site.name} isn't a supportive site, so it takes no applicants.`);
  return site;
}

async function applicantFor(req: Request, id: string) {
  const a = await prisma.applicant.findUnique({ where: { id } });
  if (!a || !canAccessSite(req, a.siteId)) throw notFound("Applicant not found.");
  const site = await prisma.site.findUniqueOrThrow({ where: { id: a.siteId }, select: SITE_SELECT });
  return { ...a, site };
}

const optional = (max: number) => z.string().max(max).nullable().optional();
const details = {
  firstName: z.string().max(80),
  middleName: optional(80),
  lastName: z.string().max(80).optional(),
  preferredName: optional(80),
  dateOfBirth: optional(10),
  phone: optional(40),
  email: optional(200),
  program: optional(255),
  referralSource: optional(80),
  referralAgency: optional(255),
  referralDate: optional(10),
  eligibilityNotes: optional(4000),
};

// ── Lists ────────────────────────────────────────────────────────────────

applicantsRouter.get(
  "/meta",
  SEE,
  asyncHandler(async (_req, res) => res.json(applicantMeta()))
);

/** ?site= (codes), ?status=open|closed|all (open by default), ?stage=, ?program=. */
applicantsRouter.get(
  "/",
  SEE,
  asyncHandler(async (req, res) => {
    const sites = (await sitesInScope(req, req.query.site)).filter((s) => s.siteType === "supportive");
    const status = req.query.status === "closed" || req.query.status === "all" ? req.query.status : "open";
    const stage = typeof req.query.stage === "string" && req.query.stage ? req.query.stage : null;
    if (stage && !isStage(stage)) throw badRequest("That isn't a stage.");
    const program = typeof req.query.program === "string" && req.query.program ? req.query.program : null;
    const { items, truncated } = await listApplicants(sites, { status, stage: stage as never, program });
    res.json({
      status,
      sites: sites.map((s) => ({ id: s.id, code: s.code, name: s.name })),
      items,
      truncated,
      can: { manage: req.user!.permissions.includes("roster.edit") },
    });
  })
);

applicantsRouter.get(
  "/report",
  SEE,
  asyncHandler(async (req, res) => {
    const sites = (await sitesInScope(req, req.query.site)).filter((s) => s.siteType === "supportive");
    res.json({ ...(await applicantReport(sites)), sites: sites.map((s) => ({ id: s.id, code: s.code, name: s.name })) });
  })
);

// ── Changes ──────────────────────────────────────────────────────────────

applicantsRouter.post(
  "/",
  MANAGE,
  asyncHandler(async (req, res) => {
    const body = z.object({ site: z.string(), ...details }).parse(req.body);
    const site = await siteFor(req, body.site);
    res.status(201).json(await createApplicant(ctxOf(req), site, body));
  })
);

applicantsRouter.patch(
  "/:id",
  MANAGE,
  asyncHandler(async (req, res) => {
    const body = z
      .object({ version: z.number().int(), site: z.string().optional(), ...details, firstName: details.firstName.optional() })
      .parse(req.body);
    const a = await applicantFor(req, req.params.id);
    const { version, site, ...input } = body;
    const toSite = site ? await siteFor(req, site) : undefined;
    res.json(await updateApplicant(ctxOf(req), a, version, input, toSite));
  })
);

/** Move to a stage: { stage, date, viewingDate (viewing scheduled), reason (closed), note }. */
applicantsRouter.post(
  "/:id/stage",
  MANAGE,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        version: z.number().int(),
        stage: z.string().max(30),
        date: optional(10),
        viewingDate: optional(10),
        reason: optional(120),
        note: optional(2000),
      })
      .parse(req.body);
    const a = await applicantFor(req, req.params.id);
    res.json(await moveApplicant(ctxOf(req), a, body));
  })
);

/**
 * Accept: onto the roster, not moved in yet. The resident is added through the
 * roster's own Add resident route, as this person, so it checks and records
 * exactly what adding them by hand would.
 */
applicantsRouter.post(
  "/:id/accept",
  MANAGE,
  asyncHandler(async (req, res) => {
    const body = z.object({ version: z.number().int(), date: optional(10), note: optional(2000) }).parse(req.body);
    const a = await applicantFor(req, req.params.id);
    // Only a supportive site's roster has "not moved in": anywhere else they'd count as living there.
    if (a.site.siteType !== "supportive") throw badRequest(`${a.site.name} isn't a supportive site any more. Move the applicant to one first.`);
    const addResident: AddResident = async (resident) =>
      (await callRouteOk(tenantsRouter, { method: "POST", path: "/", body: resident }, { user: req.user!, apiKey: req.apiKey, from: fromRequest(req) })) as TenantDTO;
    res.json(await acceptApplicant(ctxOf(req), a, body, addResident));
  })
);
