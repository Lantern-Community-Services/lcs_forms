import { Router, type Request } from "express";
import { z } from "zod";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import type { OAuthMetadata, OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { prisma } from "../prisma.js";
import { appBaseUrl } from "../env.js";
import { asyncHandler, badRequest, forbidden, notFound } from "../http.js";
import { requireAuth } from "../auth/middleware.js";
import { audit, actorOf } from "../services/audit.js";
import { OAUTH_SCOPES, clientsStore, issueCode, provider, readConnectRequest, redirectWith } from "./provider.js";

/**
 * The OAuth endpoints behind the Claude connector (see oauth/provider.ts).
 *
 * Everything lives under /api/oauth, which the web app already forwards to
 * this server; only the two discovery documents sit at the site root
 * (/.well-known/…, forwarded by next.config.mjs). The issuer is the public
 * site address (APP_BASE_URL), since that is the address Claude talks to.
 */

/** The MCP endpoint these tokens are for. */
export const mcpResourceUrl = () => `${appBaseUrl}/api/mcp`;
/** Where Claude finds out how to sign in (sent with a 401 from /api/mcp). */
export const resourceMetadataUrl = () => `${appBaseUrl}/.well-known/oauth-protected-resource/api/mcp`;

function authServerMetadata(): OAuthMetadata {
  const at = (path: string) => `${appBaseUrl}/api/oauth/${path}`;
  return {
    issuer: `${appBaseUrl}/`,
    authorization_endpoint: at("authorize"),
    token_endpoint: at("token"),
    registration_endpoint: at("register"),
    revocation_endpoint: at("revoke"),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    revocation_endpoint_auth_methods_supported: ["client_secret_post"],
    scopes_supported: [...OAUTH_SCOPES],
  };
}

function resourceMetadata(): OAuthProtectedResourceMetadata {
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [`${appBaseUrl}/`],
    scopes_supported: [...OAUTH_SCOPES],
    resource_name: "Lantern Forms",
  };
}

/** /.well-known/… — mounted at the app root. */
export const oauthDiscoveryRouter = Router();
oauthDiscoveryRouter.use("/.well-known/oauth-authorization-server", metadataHandler(authServerMetadata()));
// The path-specific document (RFC 9728), and the bare one for clients that only look there.
oauthDiscoveryRouter.use(["/.well-known/oauth-protected-resource/api/mcp", "/.well-known/oauth-protected-resource"], metadataHandler(resourceMetadata()));

/** /api/oauth/… */
export const oauthRouter = Router();

// The protocol: the SDK's handlers, with the site's provider behind them.
oauthRouter.use("/authorize", authorizationHandler({ provider }));
oauthRouter.use("/token", tokenHandler({ provider }));
// Registered clients keep their secret: an expiring one would quietly break
// every connection made with it a month later.
oauthRouter.use("/register", clientRegistrationHandler({ clientsStore, clientSecretExpirySeconds: 0 }));
oauthRouter.use("/revoke", revocationHandler({ provider }));

// ── The Allow screen (/connect/claude) ───────────────────────────────────

const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//;

async function connectRequestOf(raw: unknown) {
  const request = readConnectRequest(raw);
  if (!request) throw badRequest("This connection link has expired. Start again from Claude.");
  const client = await prisma.oAuthClient.findUnique({ where: { id: request.clientId }, select: { name: true } });
  if (!client) throw badRequest("Claude's registration wasn't found. Start again from Claude.");
  return { request, client };
}

/** What the Allow screen shows: who is asking, and where the answer goes. */
oauthRouter.get(
  "/request",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { request, client } = await connectRequestOf(req.query.req);
    res.json({
      client: client.name,
      // "this computer" for Claude Desktop / Claude Code, otherwise the site (claude.ai).
      returnsTo: LOOPBACK.test(request.redirectUri) ? "this computer" : new URL(request.redirectUri).host,
      scope: request.scope,
      user: { name: req.user!.name, email: req.user!.email, role: req.user!.roleName },
    });
  })
);

/** Allow or cancel. Answers with where to send the browser next. */
oauthRouter.post(
  "/consent",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = z.object({ req: z.string().min(1), allow: z.boolean() }).parse(req.body);
    const { request, client } = await connectRequestOf(body.req);
    if (!body.allow) {
      res.json({ redirect: redirectWith(request.redirectUri, { error: "access_denied", error_description: "The person cancelled.", state: request.state }) });
      return;
    }
    const code = await issueCode(request, req.user!.userId);
    await audit({ actor: actorOf(req), action: "oauth.connected", summary: `Connected ${client.name} (read only)` });
    res.json({ redirect: redirectWith(request.redirectUri, { code, state: request.state }) });
  })
);

// ── Connections: Profile (your own) and Admin → API keys (everyone's) ────

const canSeeAll = (req: Request) => req.user!.permissions.includes("integrations.manage") || req.user!.permissions.includes("users.manage");

const grantSelect = {
  id: true,
  scope: true,
  createdAt: true,
  lastUsedAt: true,
  client: { select: { name: true } },
  user: { select: { id: true, name: true, email: true } },
} as const;

const live = () => ({ revokedAt: null, refreshExpiresAt: { gt: new Date() } });

oauthRouter.get(
  "/grants",
  requireAuth,
  asyncHandler(async (req, res) => {
    const everyone = req.query.all === "1";
    if (everyone && !canSeeAll(req)) throw forbidden();
    const rows = await prisma.oAuthGrant.findMany({
      where: { ...live(), ...(everyone ? {} : { userId: req.user!.userId }) },
      orderBy: { createdAt: "desc" },
      select: grantSelect,
    });
    res.json(rows.map((g) => ({ id: g.id, client: g.client.name, scope: g.scope, createdAt: g.createdAt, lastUsedAt: g.lastUsedAt, user: g.user })));
  })
);

oauthRouter.delete(
  "/grants/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const grant = await prisma.oAuthGrant.findUnique({ where: { id: req.params.id }, select: grantSelect });
    if (!grant) throw notFound("No such connection.");
    const own = grant.user.id === req.user!.userId;
    if (!own && !canSeeAll(req)) throw forbidden();
    await prisma.oAuthGrant.updateMany({ where: { id: grant.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit({
      actor: actorOf(req),
      action: "oauth.disconnected",
      summary: own ? `Disconnected ${grant.client.name}` : `Disconnected ${grant.client.name} for ${grant.user.name}`,
    });
    res.json({ ok: true });
  })
);
