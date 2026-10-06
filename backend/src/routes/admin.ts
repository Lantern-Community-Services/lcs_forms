import express, { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler, badRequest, notFound } from "../http.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { actorOf, audit } from "../services/audit.js";
import { getAllSettings, setSetting } from "../services/settings.js";
import { API_SCOPES, generateKey } from "../services/apiKeys.js";
import { ROSTER_EVENTS, deliver, generateSecret } from "../services/webhooks.js";
import { decodeCsv, importTenants, readRows } from "../services/tenantImport.js";
import { backupStatus, runFormBackup } from "../services/formBackup.js";

export const adminRouter = Router();
adminRouter.use(requireAuth);

// ── Settings ─────────────────────────────────────────────────────────────

adminRouter.get(
  "/settings",
  requirePermission("settings.manage", "users.manage", "sites.manageRules"),
  asyncHandler(async (_req, res) => res.json(await getAllSettings()))
);

adminRouter.patch(
  "/settings",
  requirePermission("settings.manage"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        attentionHours: z.number().int().min(1).max(24 * 60).optional(),
        guestDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Not a domain")).optional(),
        undoSeconds: z.number().int().min(3).max(60).optional(),
        autoApproveStaff: z.boolean().optional(),
      })
      .parse(req.body);
    if (body.attentionHours !== undefined) await setSetting("attentionHours", String(body.attentionHours));
    if (body.guestDomains !== undefined) await setSetting("guestDomains", [...new Set(body.guestDomains)].join(","));
    if (body.undoSeconds !== undefined) await setSetting("undoSeconds", String(body.undoSeconds));
    if (body.autoApproveStaff !== undefined) await setSetting("autoApproveStaff", String(body.autoApproveStaff));
    await audit({ actor: actorOf(req), action: "settings.updated", summary: `Updated settings: ${Object.keys(body).join(", ")}`, changes: body });
    res.json(await getAllSettings());
  })
);

// ── API keys ─────────────────────────────────────────────────────────────

adminRouter.get(
  "/api-keys",
  requirePermission("integrations.manage"),
  asyncHandler(async (_req, res) => {
    const keys = await prisma.apiKey.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, prefix: true, scopes: true, siteId: true, site: { select: { name: true } }, lastUsedAt: true, revokedAt: true, createdAt: true },
    });
    res.json(keys);
  })
);

adminRouter.post(
  "/api-keys",
  requirePermission("integrations.manage"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(80),
        scopes: z.array(z.enum(API_SCOPES)).min(1),
        siteId: z.string().nullable().optional(),
      })
      .parse(req.body);
    const { key, prefix, hash } = generateKey();
    const row = await prisma.apiKey.create({
      data: { name: body.name, prefix, hash, scopes: body.scopes.join(","), siteId: body.siteId || null, createdById: req.user!.userId },
    });
    await audit({ actor: actorOf(req), action: "apikey.created", summary: `Created API key “${row.name}” (${row.scopes})` });
    // The only time the plaintext ever leaves the server.
    res.status(201).json({ id: row.id, name: row.name, prefix, key });
  })
);

adminRouter.delete(
  "/api-keys/:id",
  requirePermission("integrations.manage"),
  asyncHandler(async (req, res) => {
    const row = await prisma.apiKey.update({ where: { id: req.params.id }, data: { revokedAt: new Date() } });
    await audit({ actor: actorOf(req), action: "apikey.revoked", summary: `Revoked API key “${row.name}”` });
    res.json({ ok: true });
  })
);

// ── Webhooks ─────────────────────────────────────────────────────────────

adminRouter.get(
  "/webhooks",
  requirePermission("integrations.manage"),
  asyncHandler(async (_req, res) => {
    const hooks = await prisma.webhook.findMany({
      orderBy: { createdAt: "desc" },
      include: { deliveries: { orderBy: { createdAt: "desc" }, take: 8 } },
    });
    // Secret is revealed on create only; after that just a hint.
    res.json({ events: ROSTER_EVENTS, items: hooks.map(({ secret, ...h }) => ({ ...h, secretHint: `${secret.slice(0, 10)}…` })) });
  })
);

const hookBody = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.string().url().refine((u) => /^https?:\/\//.test(u), "http(s) only"),
  events: z.array(z.string()).min(1),
  active: z.boolean().optional(),
});

adminRouter.post(
  "/webhooks",
  requirePermission("integrations.manage"),
  asyncHandler(async (req, res) => {
    const body = hookBody.parse(req.body);
    const secret = generateSecret();
    const hook = await prisma.webhook.create({ data: { ...body, events: body.events.join(","), secret } });
    await audit({ actor: actorOf(req), action: "webhook.created", summary: `Added webhook “${hook.name}” → ${hook.url}` });
    res.status(201).json({ ...hook, secret });
  })
);

adminRouter.patch(
  "/webhooks/:id",
  requirePermission("integrations.manage"),
  asyncHandler(async (req, res) => {
    const body = hookBody.partial().parse(req.body);
    const hook = await prisma.webhook.update({
      where: { id: req.params.id },
      data: { ...body, events: body.events ? body.events.join(",") : undefined },
    });
    res.json({ ...hook, secret: undefined });
  })
);

adminRouter.delete(
  "/webhooks/:id",
  requirePermission("integrations.manage"),
  asyncHandler(async (req, res) => {
    const hook = await prisma.webhook.delete({ where: { id: req.params.id } });
    await audit({ actor: actorOf(req), action: "webhook.deleted", summary: `Removed webhook “${hook.name}”` });
    res.json({ ok: true });
  })
);

adminRouter.post(
  "/webhooks/:id/test",
  requirePermission("integrations.manage"),
  asyncHandler(async (req, res) => {
    const hook = await prisma.webhook.findUnique({ where: { id: req.params.id } });
    if (!hook) throw notFound();
    res.json(await deliver(hook, "webhook.test", { message: "Test delivery from Lantern Forms", by: req.user!.name }));
  })
);

// ── Tenant list import ───────────────────────────────────────────────────

/**
 * Upload a property-management CSV as the raw request body (text/csv).
 * ?commit=1 writes; without it the response is a dry-run preview.
 */
adminRouter.post(
  "/import/tenants",
  requirePermission("sites.manage"),
  express.raw({ type: ["text/csv", "application/octet-stream", "text/plain"], limit: "10mb" }),
  asyncHandler(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw badRequest("Upload a CSV file.");
    const rows = readRows(decodeCsv(req.body));
    if (rows.length === 0) throw badRequest("That file has no rows. Expected columns: Property, Unit, Tenant.");
    const summary = await importTenants(rows, { commit: req.query.commit === "1", actor: actorOf(req) });
    res.json({ committed: req.query.commit === "1", ...summary });
  })
);

// ── Form backup (services/formBackup.ts) ─────────────────────────────────

const formBuilders = requirePermission("forms.manage", "apps.develop");

adminRouter.get("/form-backup", formBuilders, (_req, res) => res.json(backupStatus()));

/** Back up now (a commit only if something changed). */
adminRouter.post(
  "/form-backup",
  formBuilders,
  asyncHandler(async (req, res) => {
    if (!backupStatus().configured) throw badRequest("The form backup isn't set up on this server (FORM_BACKUP_TOKEN).");
    res.json(await runFormBackup({ by: actorOf(req).name }));
  })
);
