import crypto from "node:crypto";
import { prisma } from "../prisma.js";

/**
 * API keys for machine callers — the WordPress connector, Power Automate.
 *
 * Only a SHA-256 of the key is stored; the plaintext is shown once at creation.
 * The original scopes (roster:read … notifications:send) authenticate the key as
 * itself, not as a person. The scopes after them are delegated: the key acts on
 * behalf of the admin who made it, never with more than that person can do now
 * (see ops/principal.ts).
 */
export const KEY_PREFIX = "lrk_";

export const API_SCOPES = [
  "roster:read",
  "activity:write",
  /** Build forms: create, edit, publish, import and export (the MCP server's main scope). */
  "forms:build",
  /** Build code forms: files, server code, publish (the MCP server's code tools). */
  "apps:build",
  /** Read built forms' entries. */
  "entries:read",
  /** Submit entries to built forms. */
  "entries:write",
  /** Send notifications to people (the bell and email): the MCP's send_notification, POST /api/v1/notifications. */
  "notifications:send",
  // ── Delegated: on behalf of the key's creator (ops/principal.ts) ──
  /** Add and edit residents, mark them still here, take attendance. */
  "roster:write",
  /** Remove residents from the roster and restore them. */
  "roster:archive",
  /** Import a property-management tenant list (CSV). */
  "roster:import",
  /** The audit log. */
  "audit:read",
  /** Sites: add, edit, deactivate, roster rules. */
  "sites:manage",
  /** People & roles: invite people, change roles, sites and status (never Admins). */
  "people:manage",
  /** Read the calendar. */
  "calendar:read",
  /** Add, change and remove calendar events (and, for an Admin's key, categories). */
  "calendar:write",
  /** Org settings (Admin → Settings). */
  "settings:manage",
  /** Void, restore, edit, annotate and delete form entries. */
  "entries:manage",
  /** Admin → Dev log. */
  "devlog:read",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export function looksLikeApiKey(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(KEY_PREFIX) && value.length > 20;
}

export function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export function generateKey(): { key: string; prefix: string; hash: string } {
  const key = `${KEY_PREFIX}${crypto.randomBytes(24).toString("base64url")}`;
  return { key, prefix: key.slice(0, 10), hash: hashKey(key) };
}

export interface ResolvedKey {
  id: string;
  name: string;
  scopes: ApiScope[];
  siteId: string | null;
  /** The admin who made it: delegated scopes act on their behalf. */
  createdById: string | null;
}

export async function resolveApiKey(key: string): Promise<ResolvedKey | null> {
  const row = await prisma.apiKey.findUnique({ where: { hash: hashKey(key) } });
  if (!row || row.revokedAt) return null;
  // Best-effort: a failed timestamp write must not fail the request.
  prisma.apiKey
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes.split(",").map((s) => s.trim()).filter(Boolean) as ApiScope[],
    siteId: row.siteId,
    createdById: row.createdById,
  };
}
