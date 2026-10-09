import { Router, type Request } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { asyncHandler, badRequest, forbidden, HttpError, notFound } from "../http.js";
import { requireApiScope } from "../auth/middleware.js";
import { displayName, publicTenant, recordActivity } from "../services/roster.js";
import { emitEvent } from "../services/webhooks.js";
import { parseName } from "../services/tenantImport.js";
import { apiNotifyBody, sendFromKey } from "../services/notifyApi.js";

/**
 * Public, versioned API for WordPress, Power Automate and anything else.
 * Authenticated by API key only (Authorization: Bearer lrk_… or X-Api-Key).
 * Keys carry scopes; a key may also be pinned to one site.
 *
 *   GET  /api/v1/sites
 *   GET  /api/v1/sites/:code/roster            active roster for a site
 *   GET  /api/v1/sites/:code/choices           Gravity Forms-ready [{text,value}]
 *   GET  /api/v1/roster/changes?since=ISO      delta sync (includes archived)
 *   GET  /api/v1/tenants/:id
 *   POST /api/v1/activity                      "this person was on a form"
 *   POST /api/v1/notifications                 tell people something (bell + email)
 */
export const publicApiRouter = Router();

async function siteByCode(req: Request, code: string) {
  const site = await prisma.site.findUnique({ where: { code } });
  if (!site || !site.active) throw notFound(`No active site with code “${code}”.`);
  if (req.apiKey!.siteId && req.apiKey!.siteId !== site.id) throw forbidden("This API key is limited to a different site.");
  return site;
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

publicApiRouter.get(
  "/sites",
  requireApiScope("roster:read"),
  asyncHandler(async (req, res) => {
    const sites = await prisma.site.findMany({
      where: { active: true, ...(req.apiKey!.siteId ? { id: req.apiKey!.siteId } : {}) },
      select: { code: true, name: true, siteType: true, address: true },
      orderBy: { name: "asc" },
    });
    res.json(sites);
  })
);

publicApiRouter.get(
  "/sites/:code/roster",
  requireApiScope("roster:read"),
  asyncHandler(async (req, res) => {
    const site = await siteByCode(req, req.params.code);
    const rows = await prisma.tenant.findMany({ where: { siteId: site.id, status: "active" }, include: { site: { select: { code: true } } } });
    const items = rows.map(publicTenant).sort((a, b) => collator.compare(a.unit ?? "~", b.unit ?? "~") || collator.compare(a.displayName, b.displayName));
    res.set("Cache-Control", "private, max-age=60");
    res.json({ site: { code: site.code, name: site.name }, generatedAt: new Date().toISOString(), count: items.length, items });
  })
);

/**
 * Shaped for a Gravity Forms dropdown/checkbox `choices` array, so the
 * WordPress side is a straight assignment. value = roster id, which is what
 * comes back in the entry and what /activity expects.
 */
publicApiRouter.get(
  "/sites/:code/choices",
  requireApiScope("roster:read"),
  asyncHandler(async (req, res) => {
    const site = await siteByCode(req, req.params.code);
    const rows = await prisma.tenant.findMany({ where: { siteId: site.id, status: "active" } });
    const choices = rows
      .map((t) => ({ unit: t.unit, text: `${displayName(t)}${t.unit ? ` — ${t.unit}` : ""}`, value: t.id }))
      .sort((a, b) => collator.compare(a.unit ?? "~", b.unit ?? "~") || collator.compare(a.text, b.text))
      .map(({ text, value }) => ({ text, value }));
    res.set("Cache-Control", "private, max-age=60");
    res.json(choices);
  })
);

publicApiRouter.get(
  "/roster/changes",
  requireApiScope("roster:read"),
  asyncHandler(async (req, res) => {
    const since = typeof req.query.since === "string" ? new Date(req.query.since) : null;
    if (!since || Number.isNaN(since.getTime())) throw badRequest("Pass ?since=<ISO timestamp>.");
    const where: Prisma.TenantWhereInput = { updatedAt: { gt: since } };
    if (req.apiKey!.siteId) where.siteId = req.apiKey!.siteId;
    if (typeof req.query.site === "string") where.site = { code: req.query.site };
    const rows = await prisma.tenant.findMany({
      where,
      include: { site: { select: { code: true } } },
      orderBy: { updatedAt: "asc" },
      take: 1000,
    });
    res.json({
      items: rows.map(publicTenant),
      // Feed this back as ?since= next time. Equal to the last row's updatedAt
      // when the page was full, so nothing is skipped.
      next: rows.length ? rows[rows.length - 1].updatedAt.toISOString() : since.toISOString(),
      hasMore: rows.length === 1000,
    });
  })
);

publicApiRouter.get(
  "/tenants/:id",
  requireApiScope("roster:read"),
  asyncHandler(async (req, res) => {
    const t = await prisma.tenant.findUnique({ where: { id: req.params.id }, include: { site: { select: { code: true } } } });
    if (!t || (req.apiKey!.siteId && t.siteId !== req.apiKey!.siteId)) throw notFound();
    res.json(publicTenant(t));
  })
);

/**
 * Mark people as active because a form mentioned them.
 *
 * Preferred: send roster ids (what the GF dropdown populated). Fallback for
 * forms that only collected free text: site + unit + name, matched strictly —
 * an ambiguous or missing match is reported, never guessed, because a wrong
 * match would keep the wrong person off the review queue.
 */
const activityBody = z.object({
  source: z.string().trim().min(1).max(40).default("gravity_forms"),
  label: z.string().trim().max(120).optional(),
  externalRef: z.string().trim().max(120).optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  tenantIds: z.array(z.string()).max(200).optional(),
  match: z
    .array(z.object({ site: z.string(), unit: z.string().optional(), name: z.string().min(1) }))
    .max(200)
    .optional(),
});

publicApiRouter.post(
  "/activity",
  requireApiScope("activity:write"),
  asyncHandler(async (req, res) => {
    const body = activityBody.parse(req.body);
    if (!body.tenantIds?.length && !body.match?.length) throw badRequest("Send tenantIds or match.");
    const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date();
    if (occurredAt.getTime() > Date.now() + 5 * 60_000) throw badRequest("occurredAt is in the future.");

    const results: { input: string; tenantId?: string; status: "recorded" | "duplicate" | "not_found" | "ambiguous" }[] = [];
    const record = async (tenantId: string, input: string) => {
      const created = await recordActivity({
        tenantId,
        source: body.source,
        label: body.label,
        externalRef: body.externalRef,
        occurredAt,
        recordedBy: `API key: ${req.apiKey!.name}`,
      });
      results.push({ input, tenantId, status: created ? "recorded" : "duplicate" });
      if (created) emitEvent("tenant.activity", { id: tenantId, source: body.source, label: body.label, occurredAt });
    };

    for (const id of body.tenantIds ?? []) {
      const t = await prisma.tenant.findUnique({ where: { id }, select: { id: true, siteId: true } });
      if (!t || (req.apiKey!.siteId && t.siteId !== req.apiKey!.siteId)) results.push({ input: id, status: "not_found" });
      else await record(t.id, id);
    }

    for (const m of body.match ?? []) {
      const input = `${m.site}/${m.unit ?? "?"}/${m.name}`;
      const site = await prisma.site.findUnique({ where: { code: m.site } });
      if (!site || (req.apiKey!.siteId && site.id !== req.apiKey!.siteId)) {
        results.push({ input, status: "not_found" });
        continue;
      }
      const n = parseName(m.name);
      const candidates = await prisma.tenant.findMany({
        where: {
          siteId: site.id,
          status: "active",
          ...(m.unit ? { unit: m.unit } : {}),
          OR: [{ firstName: n.firstName }, { preferredName: n.firstName }],
          lastName: n.lastName,
        },
        select: { id: true },
      });
      if (candidates.length === 1) await record(candidates[0].id, input);
      else results.push({ input, status: candidates.length ? "ambiguous" : "not_found" });
    }

    const failed = results.filter((r) => r.status === "not_found" || r.status === "ambiguous").length;
    if (failed === results.length) throw new HttpError(422, "No residents matched.", { results });
    res.status(failed ? 207 : 200).json({ results });
  })
);

/**
 * A notification for people with an account: in the app, and by email for
 * whoever wants that kind by email. Same body as the MCP's send_notification
 * (services/notifyApi.ts). Answers { sent, recipients, emailed, muted, unknown? }.
 */
publicApiRouter.post(
  "/notifications",
  requireApiScope("notifications:send"),
  asyncHandler(async (req, res) => {
    const body = apiNotifyBody.parse(req.body);
    try {
      res.json(await sendFromKey(req.apiKey!, body, "API"));
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
  })
);
