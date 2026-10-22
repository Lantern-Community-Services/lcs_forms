import crypto from "node:crypto";
import type { Response } from "express";
import jwt from "jsonwebtoken";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { prisma } from "../prisma.js";
import { appBaseUrl, env } from "../env.js";
import { hashKey } from "../services/apiKeys.js";
import { currentUserById } from "../auth/middleware.js";

/**
 * The site as an OAuth 2.1 authorization server for MCP clients (Claude).
 *
 * Someone adds the site to Claude as a connector. Claude registers itself
 * (dynamic client registration), sends the person here, they sign in with
 * Microsoft as usual and allow it on /connect/claude, and Claude gets tokens
 * that let /api/mcp read the site as that person (forms/mcp.ts,
 * buildPersonServer), never more than they can see on the site's own screens.
 *
 * The SDK's handlers (oauth/router.ts) do the protocol: request validation,
 * PKCE, client authentication. This file stores clients, codes and grants.
 * Codes and tokens are stored only as SHA-256 hashes, like API keys. A
 * client's secret is kept as registered, because the SDK compares it as is;
 * it guards little here, since codes only ever go to an allowed redirect
 * (env.oauthRedirectUris), PKCE binds them to the client that asked, and the
 * person approves each connection.
 */

export const ACCESS_PREFIX = "lfo_";
const REFRESH_PREFIX = "lfr_";
const CODE_PREFIX = "lfc_";

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_S = 10 * 60;
/** How long the Allow screen stays valid. */
const REQUEST_TTL = "15m";

/** What a connection can do. Only reading, for now. */
export const OAUTH_SCOPES = ["read"] as const;

const token = (prefix: string) => `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
const inSeconds = (s: number) => new Date(Date.now() + s * 1000);

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** May a client send people back to this address? (env.oauthRedirectUris) */
export function redirectAllowed(uri: string): boolean {
  if (env.oauthRedirectUris.includes(uri)) return true;
  try {
    const u = new URL(uri);
    return env.oauthRedirectUris.includes("loopback") && u.protocol === "http:" && LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
}

export const clientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId) {
    const row = await prisma.oAuthClient.findUnique({ where: { id: clientId } });
    return row ? (JSON.parse(row.info) as OAuthClientInformationFull) : undefined;
  },
  async registerClient(client) {
    const bad = client.redirect_uris.filter((u) => !redirectAllowed(String(u)));
    if (bad.length) throw new InvalidClientMetadataError(`This site only connects to Claude. Redirect not allowed: ${bad.join(", ")}`);
    const full = client as OAuthClientInformationFull;
    await prisma.oAuthClient.create({
      data: { id: full.client_id, name: (full.client_name || "MCP client").slice(0, 255), info: JSON.stringify(full) },
    });
    return full;
  },
};

/** A pending "Allow Claude?" request, carried in the /connect/claude link. */
export interface ConnectRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scope: string;
  resource?: string;
}

export function readConnectRequest(raw: unknown): ConnectRequest | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const p = jwt.verify(raw, env.jwtSecret) as ConnectRequest & { purpose?: string };
    if (p.purpose !== "oauth-connect") return null;
    return { clientId: p.clientId, redirectUri: p.redirectUri, codeChallenge: p.codeChallenge, state: p.state, scope: p.scope, resource: p.resource };
  } catch {
    return null;
  }
}

/** The client's redirect with these answers added (code + state, or error + state). */
export function redirectWith(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.href;
}

/** The person allowed it: a single-use code for the client to trade for tokens. */
export async function issueCode(req: ConnectRequest, userId: string): Promise<string> {
  const code = token(CODE_PREFIX);
  await prisma.oAuthCode.create({
    data: {
      hash: hashKey(code),
      clientId: req.clientId,
      userId,
      codeChallenge: req.codeChallenge,
      redirectUri: req.redirectUri,
      scope: req.scope,
      resource: req.resource ?? null,
      expiresAt: inSeconds(CODE_TTL_S),
    },
  });
  return code;
}

async function liveCode(client: OAuthClientInformationFull, code: string) {
  const row = await prisma.oAuthCode.findUnique({ where: { hash: hashKey(code) } });
  if (!row || row.clientId !== client.client_id || row.expiresAt < new Date()) throw new InvalidGrantError("This sign-in code is invalid or has expired. Connect again.");
  return row;
}

async function requireActive(userId: string) {
  if (!(await currentUserById(userId))) throw new InvalidGrantError("This account is no longer active on Lantern Forms.");
}

/** Fresh access + refresh tokens: their hashes for the grant row, the tokens for the client. */
function mint(scope: string) {
  const access = token(ACCESS_PREFIX);
  const refresh = token(REFRESH_PREFIX);
  const tokens: OAuthTokens = { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope };
  const data = { accessHash: hashKey(access), accessExpiresAt: inSeconds(ACCESS_TTL_S), refreshHash: hashKey(refresh), refreshExpiresAt: inSeconds(REFRESH_TTL_S) };
  return { tokens, data };
}

export const provider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  /** Off to the site's Allow screen; it signs the person in first if need be. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    if (!redirectAllowed(params.redirectUri)) throw new InvalidClientMetadataError("Redirect not allowed.");
    const req: ConnectRequest & { purpose: string } = {
      purpose: "oauth-connect",
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scope: "read",
      resource: params.resource?.href,
    };
    res.redirect(`${appBaseUrl}/connect/claude?req=${encodeURIComponent(jwt.sign(req, env.jwtSecret, { expiresIn: REQUEST_TTL }))}`);
  },

  async challengeForAuthorizationCode(client, code) {
    return (await liveCode(client, code)).codeChallenge;
  },

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
    const row = await liveCode(client, code);
    // Single use: whoever deletes it first gets the tokens.
    const { count } = await prisma.oAuthCode.deleteMany({ where: { hash: row.hash } });
    if (!count) throw new InvalidGrantError("This sign-in code was already used. Connect again.");
    if (redirectUri !== undefined && redirectUri !== row.redirectUri) throw new InvalidGrantError("redirect_uri doesn't match the one used to sign in.");
    await requireActive(row.userId);
    const { tokens, data } = mint(row.scope);
    await prisma.$transaction([
      // Connecting the same client again replaces the old connection.
      prisma.oAuthGrant.updateMany({ where: { userId: row.userId, clientId: client.client_id, revokedAt: null }, data: { revokedAt: new Date() } }),
      prisma.oAuthGrant.create({ data: { clientId: client.client_id, userId: row.userId, scope: row.scope, resource: row.resource, ...data } }),
    ]);
    return tokens;
  },

  async exchangeRefreshToken(client, refreshToken) {
    const grant = await prisma.oAuthGrant.findUnique({ where: { refreshHash: hashKey(refreshToken) } });
    if (!grant || grant.clientId !== client.client_id || grant.revokedAt || grant.refreshExpiresAt < new Date()) {
      throw new InvalidGrantError("This connection has ended. Connect Lantern Forms again.");
    }
    await requireActive(grant.userId);
    const { tokens, data } = mint(grant.scope);
    // Rotate: the refresh token just used stops working.
    const { count } = await prisma.oAuthGrant.updateMany({ where: { id: grant.id, refreshHash: grant.refreshHash }, data });
    if (!count) throw new InvalidGrantError("This refresh token was already used.");
    return tokens;
  },

  async verifyAccessToken(accessToken): Promise<AuthInfo> {
    const grant = await resolveAccessToken(accessToken);
    if (!grant) throw new InvalidTokenError("Invalid or expired token.");
    return { token: accessToken, clientId: grant.clientId, scopes: grant.scope.split(" "), expiresAt: Math.floor(grant.accessExpiresAt.getTime() / 1000) };
  },

  async revokeToken(client, request: OAuthTokenRevocationRequest) {
    const hash = hashKey(request.token);
    await prisma.oAuthGrant.updateMany({
      where: { clientId: client.client_id, revokedAt: null, OR: [{ accessHash: hash }, { refreshHash: hash }] },
      data: { revokedAt: new Date() },
    });
  },
};

export function looksLikeAccessToken(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ACCESS_PREFIX) && value.length > 20;
}

/** What an access token stands for, or null when it's unknown, expired or revoked. */
export interface ResolvedGrant {
  id: string;
  userId: string;
  clientId: string;
  clientName: string;
  scope: string;
  accessExpiresAt: Date;
}

export async function resolveAccessToken(accessToken: string): Promise<ResolvedGrant | null> {
  const grant = await prisma.oAuthGrant.findUnique({ where: { accessHash: hashKey(accessToken) }, include: { client: { select: { name: true } } } });
  if (!grant || grant.revokedAt || grant.accessExpiresAt < new Date()) return null;
  // Best-effort, like API keys: a failed timestamp write must not fail the request.
  prisma.oAuthGrant.update({ where: { id: grant.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return { id: grant.id, userId: grant.userId, clientId: grant.clientId, clientName: grant.client.name, scope: grant.scope, accessExpiresAt: grant.accessExpiresAt };
}
