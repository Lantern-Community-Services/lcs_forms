import type { Request } from "express";
import { prisma } from "../prisma.js";
import { emitEvent, type RosterEvent } from "./webhooks.js";
import { cleanIp, deviceFrom, locate } from "./geoip.js";

/**
 * An audit event as an API sends it: where it was done from (IP, device,
 * place) only for people with audit.view (Admins). Everyone else who can see
 * roster activity sees who and when, not their colleagues' addresses.
 */
export function auditView<T extends { ip: string | null; userAgent: string | null; location: string | null; changes: string | null }>(row: T, canSeeWhere: boolean) {
  const { ip, userAgent, location, changes, ...rest } = row;
  return {
    ...rest,
    changes: changes ? JSON.parse(changes) : null,
    ...(canSeeWhere ? { ip, location, device: deviceFrom(userAgent) } : {}),
  };
}

export interface Actor {
  id: string | null;
  name: string;
  /** Where the request came from (req.ip, past TRUST_PROXY) and the browser's description: kept on the audit event. */
  ip?: string | null;
  userAgent?: string | null;
}

export function actorOf(req: Request): Actor {
  const from = fromRequest(req);
  // Someone viewing (or acting) as another person: it's them who did it.
  if (req.user?.viewAs) return { id: req.user.viewAs.userId, name: `${req.user.viewAs.name} (${req.user.viewAs.act ? "acting" : "viewing"} as ${req.user.name})`, ...from };
  if (req.user) return { id: req.user.userId, name: req.user.name, ...from };
  if (req.apiKey) return { id: null, name: `API key: ${req.apiKey.name}`, ...from };
  return { id: null, name: "System", ...from };
}

/**
 * The request's address and browser, for an Actor built by hand (sign-in).
 * Code forms' server code calls the calendar with a stand-in request that has
 * only `user` (no headers, no ip), so neither may be assumed.
 */
export function fromRequest(req: Request): Pick<Actor, "ip" | "userAgent"> {
  return { ip: cleanIp(req.ip), userAgent: String(req.headers?.["user-agent"] ?? "").slice(0, 300) || null };
}

/** { field: [before, after] } for the fields that actually changed. */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>, fields: (keyof T)[]) {
  const out: Record<string, [unknown, unknown]> = {};
  for (const f of fields) {
    if (!(f in after)) continue;
    const a = normalise(before[f]);
    const b = normalise(after[f]);
    if (a !== b) out[f as string] = [a, b];
  }
  return out;
}

function normalise(v: unknown) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (v === undefined || v === "") return null;
  return v;
}

/**
 * Record an audit event and, when it is a roster event, fan it out to
 * webhooks. The audit write is awaited; delivery is fire-and-forget so a slow
 * WordPress endpoint never slows a swipe.
 */
export async function audit(opts: {
  actor: Actor;
  action: string;
  summary: string;
  tenantId?: string | null;
  siteId?: string | null;
  changes?: unknown;
  /** Payload for outbound webhooks. Omit for non-roster events. */
  webhook?: { event: RosterEvent; data: unknown };
}) {
  await prisma.auditEvent.create({
    data: {
      actorId: opts.actor.id,
      actorName: opts.actor.name,
      action: opts.action,
      summary: opts.summary,
      tenantId: opts.tenantId ?? null,
      siteId: opts.siteId ?? null,
      changes: opts.changes === undefined ? null : JSON.stringify(opts.changes),
      // Where it was done from: looked up on this server (services/geoip.ts), never sent anywhere.
      ip: opts.actor.ip ?? null,
      userAgent: opts.actor.userAgent ?? null,
      location: locate(opts.actor.ip),
    },
  });
  if (opts.webhook) emitEvent(opts.webhook.event, opts.webhook.data);
}
