import crypto from "node:crypto";
import { prisma } from "../prisma.js";

/**
 * API keys for machine callers — the WordPress connector, Power Automate.
 *
 * Only a SHA-256 of the key is stored; the plaintext is shown once at creation.
 * A key authenticates as itself with explicit scopes, not as a person, so the
 * public API (routes/publicApi.ts) never has to reason about roles.
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
  };
}
