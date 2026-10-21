import { Router, type Response } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler, forbidden, notFound, unauthorized } from "../http.js";
import { AUTH_COOKIE, ONBOARDING_COOKIE, signOnboarding, signSession } from "../auth/auth.js";
import { OIDC_TX_COOKIE, beginSignIn, completeSignIn, isAllowedDomain, safeReturnTo } from "../auth/entra.js";
import { requireAuth } from "../auth/middleware.js";
import { appBaseUrl, devAuthEnabled, env, isProd, ssoConfigured } from "../env.js";
import { guestDomains } from "../services/settings.js";
import { audit } from "../services/audit.js";
import { notifyQuietly } from "../services/notifications.js";
import { DEFAULT_ROLE_KEY, ROLES, SITE_ROLE_KEYS, roleFor, roleNameFor } from "../services/permissions.js";
import { dropGraphToken, saveGraphToken } from "../services/graphTokens.js";
import { noteGraphTokenArrived } from "../services/outlookSync.js";
import { randomAvatarColor } from "../services/avatars.js";

export const authRouter = Router();

/**
 * Sign-in is Microsoft Entra ID. Google Workspace (and any other partner IdP)
 * users come through the same Entra flow as B2B guests — Entra federates to
 * Google, so this server only ever redeems Entra tokens.
 *
 * Everyone's first sign-in is a request: they go to /welcome, choose where
 * they work and which sites they want to see, and each of those sites' Site
 * Managers (or an Admin) approves it in People & roles (routes/users.ts). An
 * admin can also pre-invite an address (for a partner's Google Workspace
 * staff); that address is then admitted even if its domain is not on the
 * allow-list, and signs straight in.
 */

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_ATTRS = { httpOnly: true, sameSite: "lax", secure: isProd, path: "/" } as const;

function setSessionCookie(res: Response, token: string, stay = true) {
  res.cookie(AUTH_COOKIE, token, stay ? { ...COOKIE_ATTRS, maxAge: SESSION_MAX_AGE_MS } : COOKIE_ATTRS);
}
const failTo = (res: Response, message: string) =>
  res.redirect(`${appBaseUrl}/signin?error=${encodeURIComponent(message)}`);
const noticeTo = (res: Response, message: string) =>
  res.redirect(`${appBaseUrl}/signin?notice=${encodeURIComponent(message)}`);
/** A request still being made or waiting: back to /welcome, where they can see and change it. */
function toWelcome(res: Response, userId: string) {
  res.cookie(ONBOARDING_COOKIE, signOnboarding(userId), { ...COOKIE_ATTRS, maxAge: 2 * 60 * 60 * 1000 });
  res.redirect(`${appBaseUrl}/welcome`);
}

/** What the sign-in screen should offer. Public. */
authRouter.get("/config", (_req, res) => {
  res.json({ microsoft: ssoConfigured, dev: devAuthEnabled });
});

authRouter.get(
  "/microsoft",
  asyncHandler(async (req, res) => {
    if (!ssoConfigured) return failTo(res, "Microsoft sign-in is not configured on this server yet.");
    const { authUrl, tx } = await beginSignIn(safeReturnTo(req.query.returnTo), {
      selectAccount: req.query.prompt === "select_account",
      stay: req.query.stay !== "0",
    });
    res.cookie(OIDC_TX_COOKIE, tx, { ...COOKIE_ATTRS, maxAge: 10 * 60 * 1000 });
    res.redirect(authUrl);
  })
);

authRouter.get(
  "/microsoft/callback",
  asyncHandler(async (req, res) => {
    const clearTx = () => res.clearCookie(OIDC_TX_COOKIE, COOKIE_ATTRS);
    if (typeof req.query.error === "string") {
      clearTx();
      const d = typeof req.query.error_description === "string" ? req.query.error_description.split(/[\r\n]/)[0] : req.query.error;
      return failTo(res, d);
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!code) {
      clearTx();
      return failTo(res, "Microsoft did not return an authorization code.");
    }

    let identity, returnTo, stay, graph;
    try {
      ({ identity, returnTo, stay, graph } = await completeSignIn(code, state, req.cookies?.[OIDC_TX_COOKIE]));
    } catch (err) {
      clearTx();
      return failTo(res, err instanceof Error ? err.message : "Microsoft sign-in failed.");
    }
    clearTx();

    try {
      let user = identity.oid ? await prisma.user.findFirst({ where: { entraObjectId: identity.oid } }) : null;
      if (!user) user = await prisma.user.findUnique({ where: { email: identity.email } });

      // Listed in SUPER_ADMINS: an active Super Admin whatever else is true,
      // which is how a new environment gets its first Admins.
      const listedSuper = env.superAdmins.includes(identity.email);

      // Domain gate — skipped for an address an admin has already put in the
      // system (invited partner staff), which is the whole point of inviting.
      if (!user && !listedSuper && !isAllowedDomain(identity.email, await guestDomains())) {
        return failTo(res, `${identity.email} is not from an organisation that uses Lantern Forms.`);
      }

      const fromDirectory = {
        name: identity.name,
        email: identity.email,
        entraObjectId: identity.oid || null,
        identityProvider: identity.idp ?? "microsoft",
        ...(identity.profileLoaded ? { title: identity.jobTitle } : {}),
      };

      if (listedSuper && (!user || !user.globalAdmin || user.roleKey !== "admin" || user.status !== "active")) {
        const data = { roleKey: "admin", globalAdmin: true, status: "active" };
        user = user ? await prisma.user.update({ where: { id: user.id }, data }) : await prisma.user.create({ data: { ...fromDirectory, avatarColor: randomAvatarColor(), ...data } });
        await audit({ actor: { id: user.id, name: user.name }, action: "user.super_admin", summary: `${user.name} (${user.email}) signed in as a Super Admin (SUPER_ADMINS)` });
      }

      if (!user) {
        // Managers hear about it once they've chosen their sites (routes/onboarding.ts).
        const requester = await prisma.user.create({ data: { ...fromDirectory, avatarColor: randomAvatarColor(), roleKey: DEFAULT_ROLE_KEY, status: "requested" } });
        await audit({
          actor: { id: requester.id, name: requester.name },
          action: "user.access_requested",
          summary: `${requester.name} (${requester.email}) signed in for the first time and is choosing their sites`,
        });
        return toWelcome(res, requester.id);
      }

      user = await prisma.user.update({ where: { id: user.id }, data: fromDirectory });
      if (user.status === "requested") return toWelcome(res, user.id);
      if (user.status === "denied" || user.status === "deactivated") {
        await dropGraphToken(user.id);
        return noticeTo(res, "You don't have access to Lantern Forms. If you think that's a mistake, contact the IT Team.");
      }
      if (user.status === "invited") {
        user = await prisma.user.update({ where: { id: user.id }, data: { status: "active" } });
      }
      await prisma.user.update({ where: { id: user.id }, data: { lastSignInAt: new Date() } });
      // Their own Outlook, for the calendar (services/graphTokens.ts). Never holds up a sign-in.
      if (graph) {
        await saveGraphToken(user.id, graph.refreshToken, graph.scopes)
          .then((isNew) => noteGraphTokenArrived(user!.id, isNew))
          .catch((err) => console.error(`[auth] couldn't keep the Outlook sign-in for ${user!.email}:`, err));
      }
      setSessionCookie(res, signSession({ userId: user.id, name: user.name, email: user.email }), stay);
      res.redirect(`${appBaseUrl}${returnTo}`);
    } catch (err) {
      console.error("[auth] sign-in failed after token redemption:", err);
      return failTo(res, "Signed in with Microsoft, but Lantern Forms could not load your account. Please try again.");
    }
  })
);

// ── Dev sign-in (local prototype only) ────────────────────────────────────

/** Demo accounts the dev sign-in screen lists. */
authRouter.get(
  "/dev-users",
  asyncHandler(async (_req, res) => {
    if (!devAuthEnabled) throw notFound();
    const users = await prisma.user.findMany({
      where: { status: { in: ["active", "requested"] } },
      select: { id: true, name: true, email: true, roleKey: true, avatarColor: true, status: true },
      orderBy: { name: "asc" },
      take: 20,
    });
    res.json(users.map((u) => ({ ...u, roleName: u.status === "requested" ? "Request (first sign-in)" : roleFor(u.roleKey).name })));
  })
);

authRouter.post(
  "/dev-login",
  asyncHandler(async (req, res) => {
    if (!devAuthEnabled) throw forbidden("Dev sign-in is disabled.");
    const { userId } = z.object({ userId: z.string() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user?.status === "requested") {
      // Lets the dev screen try the first-sign-in flow.
      res.cookie(ONBOARDING_COOKIE, signOnboarding(user.id), { ...COOKIE_ATTRS, maxAge: 2 * 60 * 60 * 1000 });
      return res.json({ ok: true, onboarding: true });
    }
    if (!user || user.status !== "active") throw unauthorized();
    await prisma.user.update({ where: { id: user.id }, data: { lastSignInAt: new Date() } });
    setSessionCookie(res, signSession({ userId: user.id, name: user.name, email: user.email }));
    res.json({ ok: true });
  })
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    // Clears this app's session only — not the person's Microsoft 365 session —
    // and forgets their Outlook sign-in: nothing writes to their calendar until
    // they sign in again.
    if (req.user) await dropGraphToken(req.user.userId).catch((err) => console.error("[auth] couldn't drop the Outlook sign-in:", err));
    res.clearCookie(AUTH_COOKIE, COOKIE_ATTRS);
    res.json({ ok: true });
  })
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      include: { sites: { where: { approved: true }, include: { site: { select: { id: true, code: true, name: true } } } } },
    });
    if (!user) throw unauthorized();
    const role = roleFor(user.roleKey);
    res.json({
      ...user,
      sites: user.sites.map((s) => s.site),
      role: { key: role.key, name: roleNameFor(role, user), description: role.description, allSites: role.allSites },
      permissions: req.user!.permissions,
      allSites: req.user!.siteIds === null,
    });
  })
);

/** Every role, each marked with whether the caller may hand it out. */
authRouter.get("/roles", requireAuth, (req, res) => {
  const perms = req.user!.permissions;
  res.json(
    ROLES.map((r) => ({
      ...r,
      // Admin is a Super Admin's to give.
      assignable: r.key === "admin" ? perms.includes("admins.manage") : perms.includes("users.manage") || (perms.includes("users.manageSite") && SITE_ROLE_KEYS.includes(r.key)),
    }))
  );
});
