import { Router, type Request } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { asyncHandler, badRequest, forbidden, HttpError, notFound } from "../http.js";
import { canAccessSite, requireAuth, requirePermission } from "../auth/middleware.js";
import { resolveSite, sitesInScope } from "../services/siteScope.js";
import { loadRoster } from "../services/rosterQuery.js";
import { exportFilename, scopeLabel, toCsv, toPdf, toXlsx, type ExportContext } from "../services/rosterExport.js";
import { actorOf, audit, diff } from "../services/audit.js";
import { attentionHours } from "../services/settings.js";
import { clockFrom, cutoff, displayName, publicTenant, serializeTenant } from "../services/roster.js";

export const tenantsRouter = Router();
tenantsRouter.use(requireAuth);

const SITE_SELECT = { id: true, code: true, name: true, attentionHours: true } as const;

async function loadTenant(req: Request, id: string) {
  const t = await prisma.tenant.findUnique({ where: { id }, include: { site: { select: SITE_SELECT } } });
  if (!t || !canAccessSite(req, t.siteId)) throw notFound("Resident not found.");
  return t;
}

/** Natural sort for units: "2B" < "10A", "B404-C" groups by building. */
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

// ── List ─────────────────────────────────────────────────────────────────

tenantsRouter.get(
  "/",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    // Sent whole so the phone filters instantly. Every Lantern site together
    // is ~2,000 people; the cap is a backstop, reported as `truncated`.
    const { sites, items, hours, truncated } = await loadRoster(req, req.query);
    res.json({ items, truncated, attentionHours: sites.length === 1 ? sites[0].attentionHours ?? hours : hours });
  })
);

// ── Sync (the device's own copy) ─────────────────────────────────────────

const SYNC_PAGE = 2000;

/**
 * GET /api/tenants/sync?site=a,b[&since=ISO]
 *
 * Feeds the roster copy an iPad keeps for its sites (frontend lib/rosterStore.ts),
 * so the list opens instantly and offline, and then only changes travel.
 *
 * Without `since`: every active resident at those sites (all of mine when
 * `site` is empty), exactly as the list endpoint returns them.
 *
 * With `since`: everyone at ANY of my sites changed since then — archived
 * included, so the device drops people who left, and regardless of `site`, so
 * someone moved away from a site the device keeps is dropped there too.
 *
 * `next` goes back as `since`. It is taken before reading, a couple of seconds
 * early, so a write landing mid-read is fetched again rather than missed
 * (applying a row twice is harmless). Every write to a Tenant row moves its
 * updatedAt — activity, keep, archive, a move, an edit — and nothing in the
 * app hard-deletes one.
 */
tenantsRouter.get(
  "/sync",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    const startedAt = new Date(Date.now() - 2000).toISOString();
    const hours = await attentionHours();
    const raw = typeof req.query.since === "string" ? new Date(req.query.since) : null;
    if (raw && Number.isNaN(raw.getTime())) throw badRequest("since must be an ISO time.");

    if (!raw) {
      const { sites, items, truncated } = await loadRoster(req, { site: req.query.site, status: "active" });
      res.json({
        full: true,
        items,
        truncated,
        next: startedAt,
        hasMore: false,
        sites: sites.map((s) => ({ id: s.id, code: s.code, name: s.name, attentionHours: s.attentionHours })),
        attentionHours: hours,
      });
      return;
    }

    const mine = await sitesInScope(req, undefined);
    const siteById = new Map(mine.map((s) => [s.id, s]));
    const rows = mine.length
      ? await prisma.tenant.findMany({ where: { siteId: { in: mine.map((s) => s.id) }, updatedAt: { gt: raw } }, orderBy: { updatedAt: "asc" }, take: SYNC_PAGE })
      : [];
    const hasMore = rows.length === SYNC_PAGE;
    res.json({
      full: false,
      // Staff notes stay on the resident's own page, as in the list.
      items: rows.map((t) => ({ ...serializeTenant({ ...t, site: siteById.get(t.siteId) }, hours), notes: undefined })),
      // A full page: resume just before its last row, so rows sharing that
      // timestamp aren't skipped.
      next: hasMore ? new Date(rows[rows.length - 1].updatedAt.getTime() - 1).toISOString() : startedAt,
      hasMore,
      sites: mine.map((s) => ({ id: s.id, code: s.code, name: s.name, attentionHours: s.attentionHours })),
      attentionHours: hours,
    });
  })
);

// ── Export ───────────────────────────────────────────────────────────────

/**
 * GET /api/tenants/export?format=csv|xlsx|pdf&site=…&status=…&q=…[&inline=1]
 *
 * Same selection, tab and search as the roster screen, so the file matches what
 * was on it. `inline=1` serves the PDF for the browser to display/print rather
 * than download. Every export is audited: it's resident data leaving the app.
 */
const EXPORT_TYPES = {
  csv: { mime: "text/csv; charset=utf-8", ext: "csv" },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" },
  pdf: { mime: "application/pdf", ext: "pdf" },
} as const;

tenantsRouter.get(
  "/export",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? "csv") as keyof typeof EXPORT_TYPES;
    if (!(format in EXPORT_TYPES)) throw badRequest("format must be csv, xlsx or pdf.");
    const { sites, status, q, items } = await loadRoster(req, req.query);
    const ctx: ExportContext = {
      sites,
      isAll: typeof req.query.site !== "string" || req.query.site.trim() === "",
      status,
      q,
      items,
      generatedBy: req.user!.name,
      generatedAt: new Date(),
    };
    const body = format === "csv" ? toCsv(ctx) : format === "xlsx" ? await toXlsx(ctx) : await toPdf(ctx);
    const type = EXPORT_TYPES[format];
    const filename = exportFilename(ctx, type.ext);

    const printing = req.query.inline === "1";
    await audit({
      actor: actorOf(req),
      action: "roster.exported",
      siteId: sites.length === 1 ? sites[0].id : null,
      summary: `${printing ? "Printed" : `Exported ${format.toUpperCase()} of`} ${scopeLabel(ctx)} (${items.length} ${items.length === 1 ? "person" : "people"})`,
      changes: { format, status, q: q || undefined, sites: sites.map((s) => s.code), count: items.length },
    });

    res.setHeader("Content-Type", type.mime);
    res.setHeader("Content-Disposition", `${printing && format === "pdf" ? "inline" : "attachment"}; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(body);
  })
);

// ── Review queue ─────────────────────────────────────────────────────────

tenantsRouter.get(
  "/review",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    const sites = await sitesInScope(req, req.query.site);
    const orgHours = await attentionHours();
    if (sites.length === 0) return res.json({ items: [], attentionHours: orgHours });
    // Per-site thresholds, so one OR per site. Oldest silence first.
    const rows = await prisma.tenant.findMany({
      where: {
        status: "active",
        OR: sites.map((s) => ({ siteId: s.id, attentionClockAt: { lt: cutoff(s.attentionHours ?? orgHours) } })),
      },
      include: { site: { select: SITE_SELECT } },
      orderBy: { attentionClockAt: "asc" },
      take: 500,
    });
    res.json({
      items: rows.map((t) => serializeTenant(t, orgHours)),
      attentionHours: sites.length === 1 ? sites[0].attentionHours ?? orgHours : orgHours,
    });
  })
);

// ── Detail ───────────────────────────────────────────────────────────────

tenantsRouter.get(
  "/:id",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    const t = await loadTenant(req, req.params.id);
    const [activities, history] = await Promise.all([
      prisma.tenantActivity.findMany({ where: { tenantId: t.id }, orderBy: { occurredAt: "desc" }, take: 25 }),
      prisma.auditEvent.findMany({ where: { tenantId: t.id }, orderBy: { createdAt: "desc" }, take: 40 }),
    ]);
    res.json({
      ...serializeTenant(t, await attentionHours()),
      activities,
      history: history.map((h) => ({ ...h, changes: h.changes ? JSON.parse(h.changes) : null })),
    });
  })
);

// ── Create ───────────────────────────────────────────────────────────────

const dateish = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (v ? new Date(v) : v === null ? null : undefined))
  .refine((d) => d === undefined || d === null || !Number.isNaN(d.getTime()), "Invalid date");

const tenantFields = {
  unit: z.string().trim().max(40).nullable().optional(),
  firstName: z.string().trim().min(1, "First name is required").max(80),
  lastName: z.string().trim().max(80).optional().default(""),
  preferredName: z.string().trim().max(80).nullable().optional(),
  moveInDate: dateish,
  notes: z.string().max(2000).nullable().optional(),
  externalId: z.string().trim().max(80).nullable().optional(),
};

tenantsRouter.post(
  "/",
  requirePermission("roster.edit"),
  asyncHandler(async (req, res) => {
    const body = z.object({ site: z.string(), ...tenantFields }).parse(req.body);
    const site = await resolveSite(req, body.site);
    if (!site) throw badRequest("Choose a site.");
    const { site: _s, ...data } = body;
    const now = new Date();
    const t = await prisma.tenant.create({
      data: {
        ...data,
        unit: data.unit || null,
        preferredName: data.preferredName || null,
        moveInDate: data.moveInDate ?? now,
        siteId: site.id,
        createdById: req.user!.userId,
        attentionClockAt: now,
      },
      include: { site: { select: SITE_SELECT } },
    });
    await audit({
      actor: actorOf(req),
      action: "tenant.created",
      tenantId: t.id,
      siteId: site.id,
      summary: `Added ${displayName(t)}${t.unit ? ` to unit ${t.unit}` : ""} at ${site.name}`,
      webhook: { event: "tenant.created", data: publicTenant(t) },
    });
    res.status(201).json(serializeTenant(t, await attentionHours()));
  })
);

// ── Update (optimistic concurrency) ──────────────────────────────────────

const EDITABLE = ["unit", "firstName", "lastName", "preferredName", "moveInDate", "notes", "externalId", "siteId"] as const;

tenantsRouter.patch(
  "/:id",
  requirePermission("roster.edit"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        version: z.number().int(),
        ...Object.fromEntries(Object.entries(tenantFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])),
        site: z.string().optional(),
      })
      .parse(req.body) as Record<string, unknown> & { version: number; site?: string };

    const before = await loadTenant(req, req.params.id);
    const data: Record<string, unknown> = {};
    for (const k of EDITABLE) if (k in body && k !== "siteId") data[k] = body[k] === "" ? null : body[k];
    if (data.firstName === null) throw badRequest("First name is required.");
    if (data.lastName === null) data.lastName = "";

    // Moving someone between sites (a transfer) needs access to both.
    let transferTo: { id: string; name: string } | undefined;
    if (body.site) {
      const target = await resolveSite(req, body.site);
      if (target && target.id !== before.siteId) {
        data.siteId = target.id;
        transferTo = target;
      }
    }

    const changes = diff(before as unknown as Record<string, unknown>, data, [...EDITABLE]);
    if (Object.keys(changes).length === 0) {
      return res.json(serializeTenant(before, await attentionHours()));
    }

    // The WHERE on version is the lock: if someone saved since this person
    // loaded the record, zero rows match and we report the conflict instead of
    // silently overwriting their colleague.
    const result = await prisma.tenant.updateMany({
      where: { id: before.id, version: body.version },
      data: { ...data, version: { increment: 1 } },
    });
    if (result.count === 0) {
      const current = await loadTenant(req, before.id);
      throw new HttpError(409, "Someone else changed this resident while you were editing. Review their changes and try again.", {
        current: serializeTenant(current, await attentionHours()),
      });
    }

    const after = await loadTenant(req, before.id);
    await audit({
      actor: actorOf(req),
      action: "tenant.updated",
      tenantId: after.id,
      siteId: after.siteId,
      summary: transferTo
        ? `Moved ${displayName(after)} from ${before.site.name} to ${transferTo.name}`
        : `Updated ${displayName(after)} (${Object.keys(changes).join(", ")})`,
      changes,
      webhook: { event: "tenant.updated", data: { ...publicTenant(after), changed: Object.keys(changes) } },
    });
    res.json(serializeTenant(after, await attentionHours()));
  })
);

// ── Archive / restore / keep ─────────────────────────────────────────────

export const ARCHIVE_REASONS = ["Moved out", "Transferred", "Hospitalized", "Incarcerated", "Deceased", "Duplicate entry", "Other"] as const;

tenantsRouter.post(
  "/:id/archive",
  requirePermission("roster.archive"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ reason: z.enum(ARCHIVE_REASONS), note: z.string().max(500).optional(), moveOutDate: dateish })
      .parse(req.body);
    const t = await loadTenant(req, req.params.id);
    if (t.status === "archived") throw badRequest(`${displayName(t)} is already removed from the roster.`);
    const now = new Date();
    const reason = body.note ? `${body.reason} — ${body.note}` : body.reason;
    const after = await prisma.tenant.update({
      where: { id: t.id },
      data: {
        status: "archived",
        archivedAt: now,
        archivedById: req.user!.userId,
        archiveReason: reason,
        moveOutDate: body.moveOutDate ?? now,
        version: { increment: 1 },
      },
      include: { site: { select: SITE_SELECT } },
    });
    await audit({
      actor: actorOf(req),
      action: "tenant.archived",
      tenantId: t.id,
      siteId: t.siteId,
      summary: `Removed ${displayName(t)} from ${t.site.name} — ${reason}`,
      changes: { reason },
      webhook: { event: "tenant.archived", data: { ...publicTenant(after), reason: body.reason } },
    });
    res.json(serializeTenant(after, await attentionHours()));
  })
);

tenantsRouter.post(
  "/:id/restore",
  asyncHandler(async (req, res) => {
    const t = await loadTenant(req, req.params.id);
    if (t.status !== "archived") throw badRequest("This resident is already on the roster.");
    // Staff may undo their own removal for a short window (the Undo toast);
    // restoring anything older needs roster.restore.
    const recentOwn =
      t.archivedById === req.user!.userId && t.archivedAt && Date.now() - t.archivedAt.getTime() < 10 * 60_000;
    if (!recentOwn && !req.user!.permissions.includes("roster.restore")) throw forbidden();
    const now = new Date();
    const after = await prisma.tenant.update({
      where: { id: t.id },
      data: {
        status: "active",
        archivedAt: null,
        archivedById: null,
        archiveReason: null,
        moveOutDate: null,
        // Undoing your own removal puts the record back exactly as it was — if
        // they were due for review, they still are. A manager restoring an
        // older removal is a fresh look, so that counts as a confirmation.
        ...(recentOwn
          ? {}
          : { lastKeptAt: now, lastKeptById: req.user!.userId, attentionClockAt: clockFrom({ ...t, lastKeptAt: now }) }),
        version: { increment: 1 },
      },
      include: { site: { select: SITE_SELECT } },
    });
    await audit({
      actor: actorOf(req),
      // Distinct action for an undo: it isn't a confirmation, and undo-keep
      // reads "tenant.restored" as one.
      action: recentOwn ? "tenant.remove_undone" : "tenant.restored",
      tenantId: t.id,
      siteId: t.siteId,
      summary: recentOwn ? `Undid removal of ${displayName(t)}` : `Restored ${displayName(t)} to ${t.site.name}`,
      webhook: { event: "tenant.restored", data: publicTenant(after) },
    });
    res.json(serializeTenant(after, await attentionHours()));
  })
);

tenantsRouter.post(
  "/:id/keep",
  requirePermission("roster.edit"),
  asyncHandler(async (req, res) => {
    const t = await loadTenant(req, req.params.id);
    if (t.status !== "active") throw badRequest("Only people on the roster can be kept.");
    const now = new Date();
    const after = await prisma.tenant.update({
      where: { id: t.id },
      data: { lastKeptAt: now, lastKeptById: req.user!.userId, attentionClockAt: clockFrom({ ...t, lastKeptAt: now }) },
      include: { site: { select: SITE_SELECT } },
    });
    await audit({
      actor: actorOf(req),
      action: "tenant.kept",
      tenantId: t.id,
      siteId: t.siteId,
      summary: `Confirmed ${displayName(t)} is still at ${t.site.name}`,
      webhook: { event: "tenant.kept", data: publicTenant(after) },
    });
    res.json(serializeTenant(after, await attentionHours()));
  })
);

/**
 * Undo your own recent Keep — the Review screen's Undo.
 *
 * The earlier "confirmed" time is rebuilt from the audit trail (the keep or
 * restore before this one), never taken from the client, so an undo can only
 * put the record back the way it was. Limited to the person who kept, within
 * ten minutes, and only while that keep is still the latest one.
 */
const UNDO_WINDOW_MS = 10 * 60_000;

tenantsRouter.post(
  "/:id/undo-keep",
  requirePermission("roster.edit"),
  asyncHandler(async (req, res) => {
    const t = await loadTenant(req, req.params.id);
    // Walk the confirmation history newest-first, cancelling each keep that a
    // later undo already reversed, to find the live keep (the one being undone)
    // and the live confirmation before it.
    const events = await prisma.auditEvent.findMany({
      where: { tenantId: t.id, action: { in: ["tenant.kept", "tenant.restored", "tenant.keep_undone"] } },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const live: typeof events = [];
    let cancelled = 0;
    for (const e of events) {
      if (e.action === "tenant.keep_undone") cancelled++;
      else if (e.action === "tenant.kept" && cancelled > 0) cancelled--;
      else live.push(e);
      if (live.length === 2) break;
    }
    const [latest, previous] = live;
    if (
      !latest ||
      latest.action !== "tenant.kept" ||
      latest.actorId !== req.user!.userId ||
      t.lastKeptById !== req.user!.userId ||
      Date.now() - latest.createdAt.getTime() > UNDO_WINDOW_MS
    ) {
      throw badRequest("That can't be undone any more.");
    }
    const lastKeptAt = previous?.createdAt ?? null;
    const after = await prisma.tenant.update({
      where: { id: t.id },
      data: {
        lastKeptAt,
        lastKeptById: previous?.actorId ?? null,
        attentionClockAt: clockFrom({ ...t, lastKeptAt }),
      },
      include: { site: { select: SITE_SELECT } },
    });
    await audit({
      actor: actorOf(req),
      action: "tenant.keep_undone",
      tenantId: t.id,
      siteId: t.siteId,
      summary: `Undid keep of ${displayName(t)} — back in review`,
      webhook: { event: "tenant.updated", data: { ...publicTenant(after), changed: ["lastKeptAt"] } },
    });
    res.json(serializeTenant(after, await attentionHours()));
  })
);

tenantsRouter.get("/meta/archive-reasons", (_req, res) => {
  res.json(ARCHIVE_REASONS);
});
