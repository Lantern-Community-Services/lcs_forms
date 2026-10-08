import { prisma } from "../prisma.js";
import { env, ssoConfigured } from "../env.js";
import { encryptionAvailable, seal, unseal } from "./secretBox.js";

/**
 * People's own Microsoft Graph access, for the calendar in their Outlook.
 *
 * The app has no Graph access of its own to anyone's calendar. Each person's
 * Microsoft sign-in asks for delegated Calendars.ReadWrite + offline_access
 * (consented for the organization on the app registration), and the refresh
 * token it returns is kept, encrypted (secretBox.ts), in UserGraphToken. The
 * calendar queue (outlookSync.ts) uses it to write to that person's own
 * calendar, and only theirs, when they aren't on the site.
 *
 * The token is deleted when they sign out, when an admin takes their access
 * away, and when Microsoft stops honouring it (revoked, password reset,
 * consent withdrawn). They get a new one at their next sign-in.
 */

/** What sign-in asks for on top of the identity scopes, when this is on. */
export const CALENDAR_SCOPES = ["offline_access", "Calendars.ReadWrite"];

/** On when Microsoft sign-in is configured, tokens can be encrypted, and OUTLOOK_SYNC isn't false. */
export const graphTokensEnabled = () => ssoConfigured && env.outlookSync && encryptionAvailable();

/** The person has no usable token: they need to sign in to Lantern Forms with Microsoft again. */
export class NoGraphToken extends Error {
  constructor(public userId: string, why = "hasn't signed in with Microsoft since Outlook was set up, or signed out") {
    super(why);
  }
}

const accessCache = new Map<string, { token: string; expires: number }>();
const refreshing = new Map<string, Promise<string>>();

// Scripts that test without a tenant swap this out (outlookSync.useGraphForTests).
let override: ((userId: string) => Promise<string | null>) | null = null;
export function useTokensForTests(fn: ((userId: string) => Promise<string | null>) | null) {
  override = fn;
  accessCache.clear();
}

/** Keep the refresh token from someone's sign-in. True when they had none before. */
export async function saveGraphToken(userId: string, refreshToken: string, scopes: string[]): Promise<boolean> {
  if (!graphTokensEnabled()) return false;
  const had = await prisma.userGraphToken.count({ where: { userId } });
  const data = { refreshToken: seal(refreshToken, userId), scopes: scopes.join(" ").slice(0, 4000) };
  await prisma.userGraphToken.upsert({ where: { userId }, create: { userId, ...data }, update: data });
  accessCache.delete(userId);
  return had === 0;
}

/** Forget someone's token (sign-out, access removed, Microsoft refused it). */
export async function dropGraphToken(userId: string) {
  accessCache.delete(userId);
  await prisma.userGraphToken.deleteMany({ where: { userId } });
}

/** Which of these people have a token to use. */
export async function withGraphToken(userIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return new Set();
  if (override) {
    const out = new Set<string>();
    for (const id of ids) if (await override(id)) out.add(id);
    return out;
  }
  const rows = await prisma.userGraphToken.findMany({ where: { userId: { in: ids } }, select: { userId: true } });
  return new Set(rows.map((r) => r.userId));
}

/** A Graph access token that acts as this person (Calendars.ReadWrite). Throws NoGraphToken when there's none to be had. */
export async function graphAccessTokenFor(userId: string): Promise<string> {
  if (override) {
    const t = await override(userId);
    if (!t) throw new NoGraphToken(userId);
    return t;
  }
  const cached = accessCache.get(userId);
  if (cached && cached.expires - 5 * 60_000 > Date.now()) return cached.token;
  // One refresh per person at a time; the rest wait for it.
  let pending = refreshing.get(userId);
  if (!pending) {
    pending = refresh(userId).finally(() => refreshing.delete(userId));
    refreshing.set(userId, pending);
  }
  return pending;
}

async function refresh(userId: string): Promise<string> {
  const row = await prisma.userGraphToken.findUnique({ where: { userId } });
  if (!row) throw new NoGraphToken(userId);
  const refreshToken = unseal(row.refreshToken, userId);
  if (!refreshToken) {
    // Sealed with another key (TOKEN_ENCRYPTION_KEY changed): useless now.
    await dropGraphToken(userId);
    throw new NoGraphToken(userId, "needs to sign in again (their stored sign-in couldn't be read)");
  }
  const res = await fetch(`https://login.microsoftonline.com/${env.microsoft.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.microsoft.clientId,
      client_secret: env.microsoft.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: CALENDAR_SCOPES.map((s) => (s === "offline_access" ? s : `https://graph.microsoft.com/${s}`)).join(" "),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    // invalid_grant: expired, revoked, password changed, consent withdrawn. It
    // won't work again, so it goes; anything else (Entra having a moment) is
    // tried again later with the same token.
    if (body.error === "invalid_grant" || body.error === "interaction_required" || body.error === "consent_required") {
      await dropGraphToken(userId);
      throw new NoGraphToken(userId, `needs to sign in again (Microsoft: ${body.error})`);
    }
    throw new Error(`Microsoft didn't renew the Outlook sign-in (${res.status} ${body.error ?? ""}): ${(body.error_description ?? "").split(/[\r\n]/)[0]}`);
  }
  // Microsoft hands back a new refresh token each time; keep the newest. If they
  // signed out while this was on its way, the row is gone and stays gone.
  const kept = await prisma.userGraphToken.updateMany({
    where: { userId },
    data: {
      updatedAt: new Date(),
      ...(body.refresh_token ? { refreshToken: seal(body.refresh_token, userId) } : {}),
      ...(body.scope ? { scopes: body.scope.slice(0, 4000) } : {}),
    },
  });
  if (!kept.count) throw new NoGraphToken(userId, "signed out");
  accessCache.set(userId, { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}
