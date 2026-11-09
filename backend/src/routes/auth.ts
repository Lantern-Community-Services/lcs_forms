import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler, badRequest, forbidden, notFound, unauthorized } from "../http.js";
import { AUTH_COOKIE, ONBOARDING_COOKIE, VIEW_AS_COOKIE, VIEW_AS_TTL_MS, signOnboarding, signSession, signViewAs, type OnboardingPass } from "../auth/auth.js";
import { OIDC_TX_COOKIE, beginSignIn, completeSignIn, isAllowedDomain, safeReturnTo } from "../auth/entra.js";
import { canViewAs, currentUserById, mayViewAs, requireAuth } from "../auth/middleware.js";
import { appBaseUrl, devAuthEnabled, env, isProd, ssoConfigured, testSite } from "../env.js";
import { guestDomains } from "../services/settings.js";
import { audit, fromRequest } from "../services/audit.js";
import { locate } from "../services/geoip.js";
import { notifyQuietly } from "../services/notifications.js";
import { ROLES, SITE_ROLE_KEYS, roleFor, roleNameFor } from "../services/permissions.js";
import { dropGraphToken, saveGraphToken } from "../services/graphTokens.js";
import { noteGraphTokenArrived } from "../services/outlookSync.js";
import { randomAvatarColor } from "../services/avatars.js";

export const authRouter = Router();

/**
 * Sign-in is Microsoft Entra ID. Google Workspace (and any other partner IdP)
 * users come through the same Entra flow as B2B guests — Entra federates to
 * Google, so this server only ever redeems Entra tokens.
 *
 * Most people have an account made for them ahead of time (People & roles →
 * Add person), and their first sign-in simply activates it; that also admits
 * an address whose domain isn't on the allow-list (a partner's Google
 * Workspace staff). Anyone else lands on /welcome, where they can ask for
 * access with one button, and an Admin lets them in from People & roles →
 * Requests (routes/users.ts).
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
/** The pass to /welcome (auth/auth.ts). */
export function setOnboardingCookie(res: Response, pass: OnboardingPass) {
  res.cookie(ONBOARDING_COOKIE, signOnboarding(pass), { ...COOKIE_ATTRS, maxAge: 2 * 60 * 60 * 1000 });
}
/** No account yet, or a request still waiting: to /welcome, to ask for access or see that they have. */
function toWelcome(res: Response, pass: OnboardingPass) {
  setOnboardingCookie(res, pass);
  res.redirect(`${appBaseUrl}/welcome`);
}

/** What the sign-in screen should offer, and whether this is a test site (made-up residents only). Public. */
authRouter.get("/config", (_req, res) => {
  res.json({ microsoft: ssoConfigured, dev: devAuthEnabled, testSite });
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

/**
 * A sign-in in the audit log, with where it came from: the IP, the device and
 * the place (looked up on this server, services/geoip.ts). Admins see them in
 * Activity, Super Admins in the person's Records. Never holds up a sign-in.
 */
async function noteSignIn(req: Request, user: { id: string; name: string; email: string }, how: string) {
  const from = fromRequest(req);
  const place = locate(from.ip);
  await audit({
    actor: { id: user.id, name: user.name, ...from },
    action: "user.signed_in",
    summary: `${user.name} signed in${place ? ` from ${place}` : ""} (${how})`,
  }).catch((err) => console.error("[auth] couldn't record a sign-in:", err));
}

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

      // No account made for them: nothing is saved until they ask for access (routes/onboarding.ts).
      if (!user) return toWelcome(res, { newcomer: fromDirectory });

      user = await prisma.user.update({ where: { id: user.id }, data: fromDirectory });
      if (user.status === "requested") return toWelcome(res, { userId: user.id });
      if (user.status === "denied" || user.status === "deactivated") {
        await dropGraphToken(user.id);
        return noticeTo(res, "You don't have access to Lantern Forms. If you think that's a mistake, contact the IT Team.");
      }
      if (user.status === "invited") {
        user = await prisma.user.update({ where: { id: user.id }, data: { status: "active" } });
      }
      await prisma.user.update({ where: { id: user.id }, data: { lastSignInAt: new Date() } });
      await noteSignIn(req, user, "Microsoft");
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
      setOnboardingCookie(res, { userId: user.id });
      return res.json({ ok: true, onboarding: true });
    }
    if (!user || user.status !== "active") throw unauthorized();
    await prisma.user.update({ where: { id: user.id }, data: { lastSignInAt: new Date() } });
    await noteSignIn(req, user, "dev sign-in");
    setSessionCookie(res, signSession({ userId: user.id, name: user.name, email: user.email }));
    res.json({ ok: true });
  })
);

/** Lets the dev screen try a first sign-in by someone nobody made an account for. */
authRouter.post(
  "/dev-newcomer",
  asyncHandler(async (_req, res) => {
    if (!devAuthEnabled) throw forbidden("Dev sign-in is disabled.");
    const n = Date.now().toString(36).slice(-5);
    setOnboardingCookie(res, { newcomer: { name: `New Person ${n}`, email: `new.person.${n}@example.org`, entraObjectId: null, identityProvider: "microsoft", title: "Case Manager" } });
    res.json({ ok: true });
  })
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    // Clears this app's session only — not the person's Microsoft 365 session —
    // and forgets their Outlook sign-in: nothing writes to their calendar until
    // they sign in again.
    // Viewing as someone, it's the person really signed in who leaves, not the one viewed.
    if (req.user) await dropGraphToken(req.user.viewAs?.userId ?? req.user.userId).catch((err) => console.error("[auth] couldn't drop the Outlook sign-in:", err));
    res.clearCookie(AUTH_COOKIE, COOKIE_ATTRS);
    res.clearCookie(VIEW_AS_COOKIE, COOKIE_ATTRS);
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
      // A Super Admin seeing the site as this person: who they are (the bar along the top).
      viewAs: req.user!.viewAs
        ? {
            id: req.user!.viewAs.userId,
            name: req.user!.viewAs.name,
            act: req.user!.viewAs.act,
            // They build forms: the bar lists every form, drafts included (GET /view-as/forms).
            drafts: req.user!.viewAs.permissions.some((p) => p === "forms.manage" || p === "apps.develop"),
          }
        : null,
      canViewAs: canViewAs(req.user!) || Boolean(req.user!.viewAs),
    });
  })
);

// ── View as (Super Admins, and Admins they've let: users.viewAs) ───────────

/** Who's really behind the request, whether or not they're viewing as someone right now. */
function viewerOf(req: Request) {
  const u = req.user!;
  if (u.viewAs) return u.viewAs;
  if (!canViewAs(u)) throw forbidden("You can't view the site as someone else.");
  return { userId: u.userId, name: u.name, email: u.email, permissions: u.permissions };
}

/** People the viewer may view the site as (mayViewAs): active, never a Super Admin, and an Admin only for a Super Admin. */
authRouter.get(
  "/view-as/people",
  requireAuth,
  asyncHandler(async (req, res) => {
    const me = viewerOf(req);
    const q = String(req.query.q ?? "").trim().slice(0, 100);
    const people = await prisma.user.findMany({
      where: {
        status: "active",
        globalAdmin: false,
        id: { not: me.userId },
        ...(me.permissions.includes("admins.manage") ? {} : { roleKey: { not: "admin" } }),
        ...(q ? { OR: [{ name: { contains: q } }, { email: { contains: q } }, { title: { contains: q } }] } : {}),
      },
      select: { id: true, name: true, email: true, title: true, roleKey: true, avatarColor: true, sites: { where: { approved: true }, select: { site: { select: { code: true } } } } },
      orderBy: { name: "asc" },
      take: 30,
    });
    res.json(people.map(({ sites, ...p }) => ({ ...p, roleName: roleFor(p.roleKey).name, sites: sites.map((s) => s.site.code) })));
  })
);

/**
 * Every form on the site, drafts included, for whoever is viewing as someone and builds forms: a draft isn't
 * in the catalog, so this is the way to open one as the person (it opens as it would for them, if it may).
 */
authRouter.get(
  "/view-as/forms",
  requireAuth,
  asyncHandler(async (req, res) => {
    const me = viewerOf(req);
    if (!me.permissions.some((p) => p === "forms.manage" || p === "apps.develop")) throw forbidden("Only people who build forms can open drafts.");
    const forms = await prisma.builtForm.findMany({
      where: { status: { not: "archived" } },
      select: { kind: true, slug: true, title: true, status: true, liveVersion: true },
      orderBy: { title: "asc" },
    });
    res.json(forms.map(({ liveVersion, ...f }) => ({ ...f, live: liveVersion > 0 })));
  })
);

/**
 * Start (or switch) seeing the site as someone: read only, or with `act`, acting as them, so changes go
 * through in their name (auth/middleware.ts viewAsLimits). Either way the audit log names who really did it.
 */
authRouter.post(
  "/view-as",
  requireAuth,
  asyncHandler(async (req, res) => {
    const me = viewerOf(req);
    const { userId, act } = z.object({ userId: z.string().min(1), act: z.boolean().optional() }).parse(req.body);
    if (userId === me.userId) throw badRequest("That's you.");
    const target = await currentUserById(userId);
    if (!target) throw notFound("That person isn't active on the site.");
    const refused = mayViewAs(me, target);
    if (refused) throw forbidden(refused);
    res.cookie(VIEW_AS_COOKIE, signViewAs({ by: me.userId, as: target.userId, act: act === true }), { ...COOKIE_ATTRS, maxAge: VIEW_AS_TTL_MS });
    await audit({
      actor: { id: me.userId, name: me.name, ...fromRequest(req) },
      action: act ? "user.act_as" : "user.view_as",
      summary: `${me.name} ${act ? "acted" : "viewed the site"} as ${target.name} (${target.email})`,
    });
    res.json({ ok: true });
  })
);

/** Viewing as someone already: switch between read only and acting as them. */
authRouter.patch(
  "/view-as",
  requireAuth,
  asyncHandler(async (req, res) => {
    const by = req.user!.viewAs;
    if (!by) throw badRequest("You aren't viewing the site as anyone.");
    const { act } = z.object({ act: z.boolean() }).parse(req.body);
    if (act !== by.act) {
      res.cookie(VIEW_AS_COOKIE, signViewAs({ by: by.userId, as: req.user!.userId, act }), { ...COOKIE_ATTRS, maxAge: VIEW_AS_TTL_MS });
      await audit({
        actor: { id: by.userId, name: by.name, ...fromRequest(req) },
        action: act ? "user.act_as" : "user.view_as",
        summary: act ? `${by.name} started acting as ${req.user!.name} (${req.user!.email})` : `${by.name} stopped acting as ${req.user!.name}, back to viewing only`,
      });
    }
    res.json({ ok: true });
  })
);

/** Back to seeing the site as themselves. */
authRouter.delete(
  "/view-as",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.clearCookie(VIEW_AS_COOKIE, COOKIE_ATTRS);
    const by = req.user!.viewAs;
    if (by) await audit({ actor: { id: by.userId, name: by.name, ...fromRequest(req) }, action: "user.view_as_ended", summary: `${by.name} stopped viewing the site as ${req.user!.name}` });
    res.json({ ok: true });
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
