import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler, badRequest, forbidden, notFound } from "../http.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { actorOf, audit } from "../services/audit.js";
import { SITE_ROLE_KEYS, isRoleKey, roleFor, roleNameFor } from "../services/permissions.js";
import { markUpcomingDirty } from "../services/outlookSync.js";
import { dropGraphToken } from "../services/graphTokens.js";

export const usersRouter = Router();
usersRouter.use(requireAuth);

const LANDING = ["/forms", "/roster", "/roster/review", "/roster/overview"] as const;

/** The signed-in person's own preferences — the Profile screen. */
usersRouter.patch(
  "/me/profile",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        avatarColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
        defaultLandingPage: z.enum(LANDING).optional(),
        defaultSiteCode: z.string().nullable().optional(),
      })
      .parse(req.body);
    const user = await prisma.user.update({ where: { id: req.user!.userId }, data: body });
    res.json({ ok: true, id: user.id });
  })
);

function shape(u: { roleKey: string; globalAdmin: boolean; sites: { site: { id: string; code: string; name: string } }[] } & Record<string, unknown>) {
  const role = roleFor(u.roleKey);
  return { ...u, sites: u.sites.map((s) => s.site), role: { key: role.key, name: roleNameFor(role, u), allSites: role.allSites } };
}

const SITES_INCLUDE = { sites: { include: { site: { select: { id: true, code: true, name: true } } } } } as const;

/*
 * Two ways into People & roles. users.manage (Admin) sees and changes anyone.
 * users.manageSite (Site Admin) works inside their own sites:
 *   - sees people assigned to one of their sites, plus site-role people with no
 *     site yet (a new sign-in waiting to be placed);
 *   - hands out only the site roles, and only their own sites;
 *   - may change a person's role, status or name only when every site that
 *     person holds is one of theirs — a role applies everywhere, so one site's
 *     admin must not demote someone another site relies on. Otherwise they can
 *     still add or remove that person at their own sites.
 * Admin and Main Office Staff accounts are never theirs to touch. Nor is the
 * "Can edit the calendar" switch: only an Admin turns that on or off.
 */
const managesEveryone = (req: Request) => req.user!.permissions.includes("users.manage");

/**
 * Admins are a Global Admin's business (admins.manage): making someone an Admin
 * or a Global Admin, and changing an Admin's role or status. An Admin manages
 * everyone else.
 */
const managesAdmins = (req: Request) => req.user!.permissions.includes("admins.manage");
const GLOBAL_ONLY = "Only a Global Admin can make someone an Admin, or change or remove an Admin.";

/** Null = everyone (Admin). Otherwise the sites the caller administers. */
function managedSiteIds(req: Request): string[] | null {
  return managesEveryone(req) ? null : req.user!.siteIds ?? [];
}

function siteScopedWhere(mine: string[]) {
  return {
    roleKey: { in: SITE_ROLE_KEYS },
    OR: [{ sites: { some: { siteId: { in: mine } } } }, { sites: { none: {} } }],
  };
}

usersRouter.get(
  "/",
  requirePermission("users.manage", "users.manageSite"),
  asyncHandler(async (req, res) => {
    const mine = managedSiteIds(req);
    const users = await prisma.user.findMany({
      where: mine ? siteScopedWhere(mine) : {},
      include: SITES_INCLUDE,
      orderBy: [{ status: "asc" }, { name: "asc" }],
    });
    res.json(
      users.map((u) => ({
        ...shape(u),
        // What this caller may do to the row, so the editor can say so up front.
        canEditRole: !mine || u.sites.every((s) => mine.includes(s.siteId)),
      }))
    );
  })
);

function assertAssignable(req: Request, roleKey: string | undefined, siteIds: string[] | undefined) {
  const mine = managedSiteIds(req);
  if (!mine) return;
  if (roleKey && !SITE_ROLE_KEYS.includes(roleKey)) throw forbidden("Only an Admin can give out that role.");
  if (siteIds?.some((id) => !mine.includes(id))) throw forbidden("You can only assign people to your own sites.");
}

const userBody = z.object({
  /** Optional: a pending account is just its email until Microsoft fills in the name. */
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().toLowerCase().email(),
  roleKey: z.string().refine(isRoleKey, "Unknown role"),
  siteIds: z.array(z.string()).default([]),
  title: z.string().trim().max(120).nullable().optional(),
  calendarEditor: z.boolean().optional(),
  globalAdmin: z.boolean().optional(),
});

const CALENDAR_SWITCH_ADMIN_ONLY = "Only an Admin can change who edits the calendar.";

/**
 * Pre-create (invite) a person: a pending account, so they can be given a role
 * and sites, and picked as an approver, before they ever sign in. It holds only
 * the email (stored as the name too, until there's a real one). Their first
 * sign-in — Microsoft or a Google Workspace account federated through Entra —
 * fills in their name and job title from the directory and activates the
 * account. This is also how partner-org staff get in without their whole
 * domain being admitted.
 */
usersRouter.post(
  "/",
  requirePermission("users.manage", "users.manageSite"),
  asyncHandler(async (req, res) => {
    const body = userBody.parse(req.body);
    assertAssignable(req, body.roleKey, body.siteIds);
    if (!managesEveryone(req) && body.siteIds.length === 0) throw badRequest("Pick at least one of your sites.");
    if (body.calendarEditor && !managesEveryone(req)) throw forbidden(CALENDAR_SWITCH_ADMIN_ONLY);
    if ((body.roleKey === "admin" || body.globalAdmin) && !managesAdmins(req)) throw forbidden(GLOBAL_ONLY);
    if (await prisma.user.findUnique({ where: { email: body.email } })) throw badRequest("Someone with that email already exists.");
    const user = await prisma.user.create({
      data: {
        name: body.name || body.email,
        email: body.email,
        roleKey: body.roleKey,
        title: body.title ?? null,
        calendarEditor: body.calendarEditor ?? false,
        globalAdmin: body.roleKey === "admin" && Boolean(body.globalAdmin),
        status: "invited",
        sites: { create: body.siteIds.map((siteId) => ({ siteId })) },
      },
      include: SITES_INCLUDE,
    });
    await audit({ actor: actorOf(req), action: "user.invited", summary: `Invited ${user.name === user.email ? user.email : `${user.name} (${user.email})`} as ${roleNameFor(roleFor(user.roleKey), user)}${user.calendarEditor ? ", with calendar editing" : ""}` });
    res.status(201).json(shape(user));
  })
);

usersRouter.patch(
  "/:id",
  requirePermission("users.manage", "users.manageSite"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        roleKey: z.string().refine(isRoleKey, "Unknown role").optional(),
        status: z.enum(["active", "invited", "denied", "deactivated"]).optional(),
        siteIds: z.array(z.string()).optional(),
        name: z.string().trim().min(1).max(120).optional(),
        calendarEditor: z.boolean().optional(),
        globalAdmin: z.boolean().optional(),
      })
      .parse(req.body);
    const before = await prisma.user.findUnique({ where: { id: req.params.id }, include: { sites: { select: { siteId: true } } } });
    if (!before) throw notFound();
    // Global Admin goes with the Admin role: off whenever the role isn't Admin.
    const nextRole = body.roleKey ?? before.roleKey;
    const nextGlobal = nextRole === "admin" && (body.globalAdmin ?? before.globalAdmin);
    const globalChange = nextGlobal !== before.globalAdmin;
    const touchesAdmin =
      (nextRole === "admin" && before.roleKey !== "admin") ||
      (before.roleKey === "admin" && ((body.roleKey !== undefined && body.roleKey !== before.roleKey) || (body.status !== undefined && body.status !== before.status))) ||
      globalChange;
    if (touchesAdmin && !managesAdmins(req)) throw forbidden(GLOBAL_ONLY);
    const roleChange = (body.roleKey !== undefined && body.roleKey !== before.roleKey) || globalChange;
    const statusChange = body.status !== undefined && body.status !== before.status;
    // Nobody changes their own role or status: that's someone else's call, and
    // it means nobody locks themselves out by accident.
    if (before.id === req.user!.userId && (roleChange || statusChange)) {
      throw forbidden("You can't change your own role or status. Ask another Global Admin.");
    }
    // A Global Admin can't be deactivated or denied outright. Another Global
    // Admin demotes them first, and then deactivates them as a separate step.
    if (before.globalAdmin && statusChange) {
      throw badRequest("A Global Admin can't be deactivated. Change their role first and save, then deactivate them.");
    }
    const calendarChange = body.calendarEditor !== undefined && body.calendarEditor !== before.calendarEditor;
    if (calendarChange && !managesEveryone(req)) throw forbidden(CALENDAR_SWITCH_ADMIN_ONLY);

    const mine = managedSiteIds(req);
    if (mine) {
      const theirs = before.sites.map((s) => s.siteId);
      const inScope = SITE_ROLE_KEYS.includes(roleFor(before.roleKey).key) && (theirs.length === 0 || theirs.some((id) => mine.includes(id)));
      if (!inScope) throw notFound();
      assertAssignable(req, body.roleKey, body.siteIds);
      const touchesPerson =
        (body.roleKey && body.roleKey !== before.roleKey) || (body.status && body.status !== before.status) || (body.name && body.name !== before.name);
      if (touchesPerson && !theirs.every((id) => mine.includes(id))) {
        throw forbidden("This person also works at a site you don't manage. You can change which of your sites they're on, but an Admin has to change their role or status.");
      }
      // Sites outside the caller's reach are kept as they were.
      if (body.siteIds) body.siteIds = [...theirs.filter((id) => !mine.includes(id)), ...body.siteIds];
    }

    // Lockout guard: the last active admin can't be demoted or disabled. Only an
    // active Admin counts: a pending one changing role takes nobody's access away.
    const losingAdmin =
      before.roleKey === "admin" && before.status === "active" &&
      ((body.roleKey && body.roleKey !== "admin") || (body.status && body.status !== "active"));
    if (losingAdmin) {
      const admins = await prisma.user.count({ where: { roleKey: "admin", status: "active" } });
      if (admins <= 1) throw badRequest("This is the only active administrator. Make someone else an admin first.");
    }
    // …and the last active Global Admin can't stop being one.
    if (before.globalAdmin && before.status === "active" && (!nextGlobal || (body.status && body.status !== "active"))) {
      const globals = await prisma.user.count({ where: { globalAdmin: true, roleKey: "admin", status: "active" } });
      if (globals <= 1) throw badRequest("This is the only active Global Admin. Make someone else a Global Admin first.");
    }

    const user = await prisma.$transaction(async (tx) => {
      if (body.siteIds) {
        await tx.userSite.deleteMany({ where: { userId: before.id } });
        if (body.siteIds.length) await tx.userSite.createMany({ data: body.siteIds.map((siteId) => ({ userId: before.id, siteId })) });
      }
      return tx.user.update({
        where: { id: before.id },
        data: { roleKey: body.roleKey, status: body.status, name: body.name, calendarEditor: calendarChange ? body.calendarEditor : undefined, globalAdmin: globalChange ? nextGlobal : undefined },
        include: SITES_INCLUDE,
      });
    });
    const bits = [
      body.roleKey && body.roleKey !== before.roleKey ? `role → ${roleFor(body.roleKey).name}` : null,
      body.status && body.status !== before.status ? `status → ${body.status}` : null,
      body.siteIds ? `sites → ${body.siteIds.length || "none"}` : null,
      calendarChange ? `calendar editing ${body.calendarEditor ? "on" : "off"}` : null,
      globalChange ? (nextGlobal ? "now a Global Admin" : "no longer a Global Admin") : null,
    ].filter(Boolean);
    await audit({ actor: actorOf(req), action: "user.updated", summary: `Updated ${user.name}${bits.length ? `: ${bits.join(", ")}` : ""}` });
    // No access, no acting as them in Outlook either.
    if (body.status === "denied" || body.status === "deactivated") await dropGraphToken(before.id);
    // Their sites, role or status decide which Outlook invites they get.
    if (body.siteIds || body.roleKey || body.status) await markUpcomingDirty();
    res.json(shape(user));
  })
);
