import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { asyncHandler } from "../http.js";
import { requirePermission } from "../auth/middleware.js";
import { CLIENT_KINDS, EVENT_KINDS, devEvent, type EventKind } from "../services/devlog.js";
import { RANGES, devlogEvents, devlogSummary, type RangeKey } from "../services/devlogReport.js";

export const devlogRouter = Router();

/**
 * Browsers' reports: page-load timings, errors, slow taps, slow requests as
 * the device saw them (lib/telemetry.ts). Signed in or not — the sign-in page
 * and public forms can break too. Bounded per address; a whole site's staff
 * share one address, so the bound is generous.
 */
const clientLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 600, standardHeaders: "draft-7", legacyHeaders: false });

const clientItem = z.object({
  kind: z.enum(EVENT_KINDS).refine((k) => CLIENT_KINDS.has(k), "Not a browser event"),
  path: z.string().max(255).optional(),
  message: z.string().max(4000).optional(),
  status: z.number().int().min(0).max(999).optional(),
  durationMs: z.number().min(0).max(3_600_000).optional(),
  data: z.record(z.unknown()).optional(),
});

devlogRouter.post("/client", clientLimiter, (req, res) => {
  const parsed = z.object({ items: z.array(clientItem).max(25) }).safeParse(req.body);
  // Nothing a browser sends here is worth an error back: it can't do anything about it.
  if (parsed.success) {
    for (const item of parsed.data.items) {
      devEvent({
        ...item,
        kind: item.kind as EventKind,
        level: item.kind === "client-error" ? "error" : item.kind === "page-load" ? "info" : "warn",
        data: { ...item.data, userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300) },
        userEmail: req.user?.email,
      });
    }
  }
  res.status(204).end();
});

devlogRouter.get(
  "/summary",
  requirePermission("devlog.view"),
  asyncHandler(async (req, res) => {
    const range = z.enum(Object.keys(RANGES) as [RangeKey, ...RangeKey[]]).catch("24h").parse(req.query.range);
    res.json(await devlogSummary(range));
  })
);

devlogRouter.get(
  "/events",
  requirePermission("devlog.view"),
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        kinds: z.string().optional(),
        level: z.enum(["error", "warn", "info"]).optional(),
        q: z.string().trim().max(200).optional(),
        after: z.string().max(64).optional(),
        range: z.enum(Object.keys(RANGES) as [RangeKey, ...RangeKey[]]).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    res.json(
      await devlogEvents({
        kinds: q.kinds?.split(",").filter(Boolean),
        level: q.level,
        q: q.q || undefined,
        after: q.after,
        since: q.range ? new Date(Date.now() - RANGES[q.range].ms) : undefined,
        limit: q.limit,
      })
    );
  })
);
