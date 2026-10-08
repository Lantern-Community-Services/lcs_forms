import { Router, type Response } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler, forbidden, notFound, unauthorized } from "../http.js";
import { AUTH_COOKIE, signSession } from "../auth/auth.js";
import { OIDC_TX_COOKIE, beginSignIn, completeSignIn, isAllowedDomain, isStaffDomain, safeReturnTo } from "../auth/entra.js";
import { requireAuth } from "../auth/middleware.js";
import { appBaseUrl, devAuthEnabled, env, isProd, ssoConfigured } from "../env.js";
import { autoApproveStaff, guestDomains } from "../services/settings.js";
import { audit } from "../services/audit.js";
import { DEFAULT_ROLE_KEY, ROLES, SITE_ROLE_KEYS, roleFor, roleNameFor } from "../services/permissions.js";
import { dropGraphToken, saveGraphToken } from "../services/graphTokens.js";
import { noteGraphTokenArrived } from "../services/outlookSync.js";

export const authRouter = Router();

/**
 * Sign-in is Microsoft Entra ID. Google Workspace (and any other partner IdP)
 * users come through the same Entra flow as B2B guests — Entra federates to
 * Google, so this server only ever redeems Entra tokens.
 *
 * Lantern staff (an address on SSO_ALLOWED_DOMAINS) are let in on first
 * sign-in as a Staff member — forms only, no roster — unless an admin has
 * turned that off in Sign-in access. Everyone else files an access request and
 * an admin decides. An admin can also pre-invite an address (for a partner's
 * Google Workspace staff); that address is then admitted even if its domain is
 * not on the allow-list.
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

      // Listed in GLOBAL_ADMINS: an active Global Admin whatever else is true,
      // which is how a new environment gets its first Admins.
      const listedGlobal = env.globalAdmins.includes(identity.email);

      // Domain gate — skipped for an address an admin has already put in the
      // system (invited partner staff), which is the whole point of inviting.
      if (!user && !listedGlobal && !isAllowedDomain(identity.email, await guestDomains())) {
        return failTo(res, `${identity.email} is not from an organisation that uses Lantern Forms.`);
      }

      const fromDirectory = {
        name: identity.name,
        email: identity.email,
        entraObjectId: identity.oid || null,
        identityProvider: identity.idp ?? "microsoft",
        ...(identity.profileLoaded ? { title: identity.jobTitle } : {}),
      };

      if (listedGlobal && (!user || !user.globalAdmin || user.roleKey !== "admin" || user.status !== "active")) {
        const data = { roleKey: "admin", globalAdmin: true, status: "active" };
        user = user ? await prisma.user.update({ where: { id: user.id }, data }) : await prisma.user.create({ data: { ...fromDirectory, ...data } });
        await audit({ actor: { id: user.id, name: user.name }, action: "user.global_admin", summary: `${user.name} (${user.email}) signed in as a Global Admin (GLOBAL_ADMINS)` });
      }

      if (!user && isStaffDomain(identity.email) && (await autoApproveStaff())) {
        user = await prisma.user.create({ data: { ...fromDirectory, roleKey: DEFAULT_ROLE_KEY, status: "active" } });
        await audit({
          actor: { id: user.id, name: user.name },
          action: "user.auto_approved",
          summary: `${user.name} (${user.email}) signed in for the first time as ${roleFor(DEFAULT_ROLE_KEY).name}`,
        });
      }

      if (!user) {
        const requester = await prisma.user.create({ data: { ...fromDirectory, roleKey: DEFAULT_ROLE_KEY, status: "requested" } });
        await audit({
          actor: { id: requester.id, name: requester.name },
          action: "user.access_requested",
          summary: `${requester.name} (${requester.email}) requested access`,
        });
        return noticeTo(res, "Your account needs to be approved by an admin. We've let them know — you'll be able to sign in once it's approved.");
      }

      user = await prisma.user.update({ where: { id: user.id }, data: fromDirectory });
      if (user.status === "requested") return noticeTo(res, "Your account is still waiting for an admin to approve it.");
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
      where: { status: "active" },
      select: { id: true, name: true, email: true, roleKey: true, avatarColor: true },
      orderBy: { name: "asc" },
      take: 20,
    });
    res.json(users.map((u) => ({ ...u, roleName: roleFor(u.roleKey).name })));
  })
);

authRouter.post(
  "/dev-login",
  asyncHandler(async (req, res) => {
    if (!devAuthEnabled) throw forbidden("Dev sign-in is disabled.");
    const { userId } = z.object({ userId: z.string() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: userId } });
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
      include: { sites: { include: { site: { select: { id: true, code: true, name: true } } } } },
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
      // Admin is a Global Admin's to give.
      assignable: r.key === "admin" ? perms.includes("admins.manage") : perms.includes("users.manage") || (perms.includes("users.manageSite") && SITE_ROLE_KEYS.includes(r.key)),
    }))
  );
});
