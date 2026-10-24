import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler, badRequest, forbidden, notFound } from "../http.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { actorOf, audit } from "../services/audit.js";
import { SITE_ROLE_KEYS, isRoleKey, roleFor, roleNameFor } from "../services/permissions.js";
import { markUpcomingDirty } from "../services/outlookSync.js";
import { dropGraphToken } from "../services/graphTokens.js";
import { notifyQuietly } from "../services/notifications.js";
import { randomAvatarColor } from "../services/avatars.js";
import { MAIN_OFFICE_LOCATION, parseLocations } from "./onboarding.js";

export const usersRouter = Router();
usersRouter.use(requireAuth);

// "/forms" was Home's address before /home; still accepted, and read as Home.
const LANDING = ["/home", "/forms", "/roster", "/roster/review", "/roster/overview"] as const;

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

type SiteRow = { siteId: string; approved: boolean; site: { id: string; code: string; name: string } };

/**
 * A person as People & roles shows them. `sites` are the ones they have;
 * `requestedSites` are still waiting for that site's manager or an Admin.
 */
function shape(u: { roleKey: string; globalAdmin: boolean; locations?: string | null; sites: SiteRow[] } & Record<string, unknown>) {
  const role = roleFor(u.roleKey);
  return {
    ...u,
    locations: parseLocations(u.locations),
    sites: u.sites.filter((s) => s.approved).map((s) => s.site),
    requestedSites: u.sites.filter((s) => !s.approved).map((s) => s.site),
    role: { key: role.key, name: roleNameFor(role, u), allSites: role.allSites },
  };
}

const SITES_INCLUDE = { sites: { include: { site: { select: { id: true, code: true, name: true } } } } } as const;
const ROSTER_SWITCH_NOT_YOURS = "You can't change your own roster access.";

/*
 * Two ways into People & roles. users.manage (Admin) sees and changes anyone.
 * users.manageSite (a Site Manager, in "Site settings") works inside their own sites:
 *   - sees people with a site role who have, or are asking for, one of their sites;
 *   - approves or declines requests for their own sites only (per site: a
 *     request for two sites is two managers' decision);
 *   - hands out only the site roles, and only their own sites;
 *   - may change a person's role, status, name or roster switch only when every
 *     site that person has is one of theirs — a role applies everywhere, so one
 *     site's manager must not demote someone another site relies on. Otherwise
 *     they can still add or remove that person at their own sites.
 * Admin and Developer accounts are never theirs to touch. Nor is the "Can edit
 * the calendar" switch: only an Admin turns that on or off.
 */
const managesEveryone = (req: Request) => req.user!.permissions.includes("users.manage");

/**
 * Admins are a Super Admin's business (admins.manage): making someone an Admin,
 * and changing an Admin's role or status. An Admin manages everyone else.
 *
 * Super Admins themselves are nobody's here: they come only from the
 * SUPER_ADMINS setting (services/superAdmins.ts). The API never makes one and
 * refuses any change to one, whoever asks.
 */
const managesAdmins = (req: Request) => req.user!.permissions.includes("admins.manage");
const SUPER_ONLY = "Only a Super Admin can make someone an Admin, or change or remove an Admin.";
const SUPER_LOCKED = "Super Admins are set on the server (SUPER_ADMINS) and can't be changed here.";

/** Null = everyone (Admin). Otherwise the sites the caller administers. */
function managedSiteIds(req: Request): string[] | null {
  return managesEveryone(req) ? null : req.user!.siteIds ?? [];
}

function siteScopedWhere(mine: string[]) {
  return { roleKey: { in: SITE_ROLE_KEYS }, sites: { some: { siteId: { in: mine } } } };
}

/** Pending and requested accounts that were never used can be deleted outright; anyone else is deactivated. */
function canDelete(req: Request, u: { status: string; roleKey: string; globalAdmin: boolean; sites: { siteId: string }[] }) {
  if (u.globalAdmin || !["invited", "requested"].includes(u.status)) return false;
  const mine = managedSiteIds(req);
  if (!mine) return u.roleKey !== "admin" || managesAdmins(req);
  return SITE_ROLE_KEYS.includes(roleFor(u.roleKey).key) && u.sites.length > 0 && u.sites.every((s) => mine.includes(s.siteId));
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
    // "Where do you work?" answers, as names (any site, not only the caller's).
    const siteNames = new Map((await prisma.site.findMany({ select: { id: true, name: true } })).map((s) => [s.id, s.name]));
    const locationName = (l: string) => (l === MAIN_OFFICE_LOCATION ? "Main Office" : siteNames.get(l) ?? "A site that's gone");
    res.json(
      users.map((u) => ({
        ...shape(u),
        locationNames: parseLocations(u.locations).map(locationName),
        // What this caller may do to the row, so the editor can say so up front.
        canEditRole: !u.globalAdmin && (!mine || u.sites.filter((s) => s.approved).every((s) => mine.includes(s.siteId))),
        canApproveSiteIds: u.sites.filter((s) => !s.approved && (!mine || mine.includes(s.siteId))).map((s) => s.siteId),
        canDelete: canDelete(req, u),
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
    if (body.roleKey === "admin" && !managesAdmins(req)) throw forbidden(SUPER_ONLY);
    if (await prisma.user.findUnique({ where: { email: body.email } })) throw badRequest("Someone with that email already exists.");
    const user = await prisma.user.create({
      data: {
        name: body.name || body.email,
        email: body.email,
        roleKey: body.roleKey,
        title: body.title ?? null,
        calendarEditor: body.calendarEditor ?? false,
        avatarColor: randomAvatarColor(),
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
        rosterEditor: z.boolean().optional(),
      })
      .parse(req.body);
    const found = await prisma.user.findUnique({ where: { id: req.params.id }, include: { sites: { select: { siteId: true, approved: true } } } });
    if (!found) throw notFound();
    // `sites` here are the ones they have; requested ones are approve/decline's business.
    const before = { ...found, sites: found.sites.filter((s) => s.approved), requested: found.sites.filter((s) => !s.approved).map((s) => s.siteId) };
    // A Super Admin is changed only through SUPER_ADMINS, never here.
    if (before.globalAdmin) throw forbidden(SUPER_LOCKED);
    const roleChange = body.roleKey !== undefined && body.roleKey !== before.roleKey;
    const statusChange = body.status !== undefined && body.status !== before.status;
    const touchesAdmin = (roleChange && (body.roleKey === "admin" || before.roleKey === "admin")) || (statusChange && before.roleKey === "admin");
    if (touchesAdmin && !managesAdmins(req)) throw forbidden(SUPER_ONLY);
    // Nobody changes their own role or status: that's someone else's call, and
    // it means nobody locks themselves out by accident.
    if (before.id === req.user!.userId && (roleChange || statusChange)) {
      throw forbidden("You can't change your own role or status.");
    }
    const calendarChange = body.calendarEditor !== undefined && body.calendarEditor !== before.calendarEditor;
    if (calendarChange && !managesEveryone(req)) throw forbidden(CALENDAR_SWITCH_ADMIN_ONLY);
    const rosterChange = body.rosterEditor !== undefined && body.rosterEditor !== before.rosterEditor;
    if (rosterChange && before.id === req.user!.userId) throw forbidden(ROSTER_SWITCH_NOT_YOURS);

    const mine = managedSiteIds(req);
    if (mine) {
      const theirs = before.sites.map((s) => s.siteId);
      const inScope = SITE_ROLE_KEYS.includes(roleFor(before.roleKey).key) && [...theirs, ...before.requested].some((id) => mine.includes(id));
      if (!inScope) throw notFound();
      assertAssignable(req, body.roleKey, body.siteIds);
      const touchesPerson =
        (body.roleKey && body.roleKey !== before.roleKey) ||
        (body.status && body.status !== before.status) ||
        (body.name && body.name !== before.name) ||
        rosterChange;
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

    const user = await prisma.$transaction(async (tx) => {
      if (body.siteIds) {
        // Giving someone a site they'd asked for settles that request too.
        await tx.userSite.deleteMany({ where: { userId: before.id, OR: [{ approved: true }, { siteId: { in: body.siteIds } }] } });
        if (body.siteIds.length) await tx.userSite.createMany({ data: body.siteIds.map((siteId) => ({ userId: before.id, siteId })) });
      }
      return tx.user.update({
        where: { id: before.id },
        data: {
          roleKey: body.roleKey,
          status: body.status,
          name: body.name,
          calendarEditor: calendarChange ? body.calendarEditor : undefined,
          rosterEditor: rosterChange ? body.rosterEditor : undefined,
        },
        include: SITES_INCLUDE,
      });
    });
    const bits = [
      body.roleKey && body.roleKey !== before.roleKey ? `role → ${roleFor(body.roleKey).name}` : null,
      body.status && body.status !== before.status ? `status → ${body.status}` : null,
      body.siteIds ? `sites → ${body.siteIds.length || "none"}` : null,
      calendarChange ? `calendar editing ${body.calendarEditor ? "on" : "off"}` : null,
      rosterChange ? `roster management ${body.rosterEditor ? "on" : "off"}` : null,
    ].filter(Boolean);
    await audit({ actor: actorOf(req), action: "user.updated", summary: `Updated ${user.name}${bits.length ? `: ${bits.join(", ")}` : ""}` });
    // Tell them, if they can sign in: let in, or given a different role or sites.
    if (user.status === "active" && user.id !== req.user!.userId) {
      const letIn = before.status !== "active";
      const sitesChanged = body.siteIds && [...body.siteIds].sort().join() !== before.sites.map((s) => s.siteId).sort().join();
      const roleChanged = body.roleKey !== undefined && roleFor(body.roleKey).key !== roleFor(before.roleKey).key;
      if (letIn || roleChanged || sitesChanged) {
        const role = roleNameFor(roleFor(user.roleKey), user);
        const where = whereText(user);
        notifyQuietly({
          to: { users: [user.id] },
          type: "account",
          title: letIn ? "You can now sign in to Lantern Forms" : "Your access in Lantern Forms changed",
          body: `${req.user!.name} ${letIn ? "let you in" : "changed your access"}. You're ${/^[aeiou]/i.test(role) ? "an" : "a"} ${role}, at ${where}.`,
          link: "/home",
          sourceLabel: "People & roles",
        });
      }
    }
    // No access, no acting as them in Outlook either.
    if (body.status === "denied" || body.status === "deactivated") await dropGraphToken(before.id);
    // Their sites, role or status decide which Outlook invites they get.
    if (body.siteIds || body.roleKey || body.status) await markUpcomingDirty();
    res.json(shape(user));
  })
);

function whereText(user: { roleKey: string; sites: SiteRow[] }) {
  const have = user.sites.filter((s) => s.approved).map((s) => s.site.name);
  return have.length ? have.join(", ") : roleFor(user.roleKey).allSites ? "every site" : "no sites yet";
}

/** The person, or a 404 when a Site Manager has no site of theirs on the row (had or asked for). */
async function personInScope(req: Request, id: string) {
  const u = await prisma.user.findUnique({ where: { id }, include: SITES_INCLUDE });
  if (!u) throw notFound();
  if (u.globalAdmin) throw forbidden(SUPER_LOCKED);
  const mine = managedSiteIds(req);
  if (mine && !(SITE_ROLE_KEYS.includes(roleFor(u.roleKey).key) && u.sites.some((s) => mine.includes(s.siteId)))) throw notFound();
  return { u, mine };
}

/**
 * Approve requested sites. A Site Manager approves only their own sites; the
 * rest of the request stays for those sites' managers. The first approval
 * lets the person in, with the role chosen here (Site Staff unless said).
 */
usersRouter.post(
  "/:id/approve",
  requirePermission("users.manage", "users.manageSite"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        siteIds: z.array(z.string()).min(1, "Choose at least one site to approve."),
        roleKey: z.string().refine(isRoleKey, "Unknown role").optional(),
      })
      .parse(req.body);
    const { u, mine } = await personInScope(req, req.params.id);
    if (u.id === req.user!.userId) throw forbidden("You can't approve your own request.");
    if (!["requested", "active"].includes(u.status)) throw badRequest("Only a request, or an active person asking for more sites, can be approved.");
    const waiting = u.sites.filter((s) => !s.approved).map((s) => s.siteId);
    if (body.siteIds.some((id) => !waiting.includes(id))) throw badRequest("They didn't ask for one of those sites, or it's already been decided.");
    if (mine && body.siteIds.some((id) => !mine.includes(id))) throw forbidden("You can only approve your own sites. The others are for their own site's manager.");

    const letIn = u.status === "requested";
    let roleKey = body.roleKey;
    if (letIn) roleKey ??= u.roleKey;
    else if (roleKey && roleFor(roleKey).key === roleFor(u.roleKey).key) roleKey = undefined;
    if (roleKey) {
      assertAssignable(req, roleKey, undefined);
      if (roleKey === "admin" && !managesAdmins(req)) throw forbidden(SUPER_ONLY);
      // Changing an active person's role is for whoever has all their sites.
      if (!letIn && mine && !u.sites.filter((s) => s.approved).every((s) => mine.includes(s.siteId))) {
        throw forbidden("This person also works at a site you don't manage. Approve the site; an Admin has to change their role.");
      }
    }

    const user = await prisma.$transaction(async (tx) => {
      await tx.userSite.updateMany({ where: { userId: u.id, siteId: { in: body.siteIds } }, data: { approved: true } });
      return tx.user.update({ where: { id: u.id }, data: { roleKey, status: letIn ? "active" : undefined }, include: SITES_INCLUDE });
    });
    const names = user.sites.filter((s) => body.siteIds.includes(s.siteId)).map((s) => s.site.name);
    const role = roleNameFor(roleFor(user.roleKey), user);
    await audit({
      actor: actorOf(req),
      action: "user.approved",
      summary: `Approved ${user.name} for ${names.join(", ")}${letIn || roleKey ? ` as ${role}` : ""}`,
    });
    notifyQuietly({
      to: { users: [user.id] },
      type: "account",
      title: letIn ? "You can now sign in to Lantern Forms" : "You've been given more sites in Lantern Forms",
      body: `${req.user!.name} approved ${names.join(", ")}. You're ${/^[aeiou]/i.test(role) ? "an" : "a"} ${role}, at ${whereText(user)}.`,
      link: "/home",
      sourceLabel: "People & roles",
    });
    await markUpcomingDirty();
    res.json(shape(user));
  })
);

/**
 * Turn down requested sites (a Site Manager: their own). When a request is
 * left with no sites at all, had or asked for, the request itself goes.
 */
usersRouter.post(
  "/:id/decline",
  requirePermission("users.manage", "users.manageSite"),
  asyncHandler(async (req, res) => {
    const body = z.object({ siteIds: z.array(z.string()).min(1, "Choose at least one site to decline.") }).parse(req.body);
    const { u, mine } = await personInScope(req, req.params.id);
    const waiting = u.sites.filter((s) => !s.approved).map((s) => s.siteId);
    if (body.siteIds.some((id) => !waiting.includes(id))) throw badRequest("They didn't ask for one of those sites, or it's already been decided.");
    if (mine && body.siteIds.some((id) => !mine.includes(id))) throw forbidden("You can only decline your own sites.");
    await prisma.userSite.deleteMany({ where: { userId: u.id, approved: false, siteId: { in: body.siteIds } } });
    const names = u.sites.filter((s) => body.siteIds.includes(s.siteId)).map((s) => s.site.name);
    const removed = u.status === "requested" && (await prisma.userSite.count({ where: { userId: u.id } })) === 0;
    if (removed) await prisma.user.delete({ where: { id: u.id } });
    await audit({
      actor: actorOf(req),
      action: removed ? "user.request_removed" : "user.declined",
      summary: `Declined ${u.name} (${u.email}) for ${names.join(", ")}${removed ? "; nothing was left, so the request was removed" : ""}`,
    });
    const person = removed ? null : await prisma.user.findUnique({ where: { id: u.id }, include: SITES_INCLUDE });
    res.json({ removed, person: person ? shape(person) : null });
  })
);

// ── Their guided tutorials (frontend lib/tour, routes/tutorials.ts) ─────────

const TOUR_NAMES: Record<string, string> = { "site:desktop": "Welcome tour on a computer", "site:touch": "Welcome tour on a phone or iPad" };

/** What they've finished or skipped: the welcome tour per kind of device, and each form's tutorial by name. */
async function tutorialsOf(userId: string) {
  const rows = await prisma.tutorialProgress.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } });
  const formIds = rows.filter((r) => r.key.startsWith("form:")).map((r) => r.key.slice(5));
  const forms = new Map((await prisma.builtForm.findMany({ where: { id: { in: formIds } }, select: { id: true, title: true } })).map((f) => [f.id, f.title]));
  return rows.map((r) => ({
    key: r.key,
    name: TOUR_NAMES[r.key] ?? forms.get(r.key.slice(5)) ?? "A form that's been deleted",
    kind: r.key.startsWith("site:") ? "site" : "form",
    status: r.status,
    version: r.version,
    step: r.step,
    steps: r.steps,
    updatedAt: r.updatedAt,
  }));
}

/** Anyone this caller manages in People & roles (an Admin: everyone; a Site Manager: people at their sites). */
usersRouter.get(
  "/:id/tutorials",
  requirePermission("users.manage", "users.manageSite"),
  asyncHandler(async (req, res) => {
    const { u } = await personInScope(req, req.params.id);
    res.json(await tutorialsOf(u.id));
  })
);

/**
 * Forget what they've seen, so the tutorials start again for them: ?key=<one>
 * (site:desktop, site:touch, form:<id>), or everything without it. The welcome
 * tour starts the next time they reach their home screen, and a form's
 * tutorial the next time they open the form.
 */
usersRouter.delete(
  "/:id/tutorials",
  requirePermission("users.manage", "users.manageSite"),
  asyncHandler(async (req, res) => {
    const { u } = await personInScope(req, req.params.id);
    const { key } = z.object({ key: z.string().regex(/^(site:(desktop|touch)|form:[A-Za-z0-9_-]{1,64})$/).optional() }).parse(req.query);
    const before = key ? (await tutorialsOf(u.id)).find((t) => t.key === key) : null;
    const { count } = await prisma.tutorialProgress.deleteMany({ where: { userId: u.id, ...(key ? { key } : {}) } });
    if (count) {
      const who = u.name === u.email ? u.email : u.name;
      await audit({
        actor: actorOf(req),
        action: "user.tutorials_reset",
        summary: key ? `Reset ${who}'s tutorial: ${before?.name ?? key}` : `Reset all of ${who}'s tutorials (${count})`,
      });
    }
    res.json({ reset: count, tutorials: await tutorialsOf(u.id) });
  })
);

/**
 * Delete a pending or requested account that was never used: a mistaken
 * invite, or a request nobody will approve. Anyone who's been let in is
 * deactivated instead, so their history keeps a name.
 */
usersRouter.delete(
  "/:id",
  requirePermission("users.manage", "users.manageSite"),
  asyncHandler(async (req, res) => {
    const { u } = await personInScope(req, req.params.id);
    if (!canDelete(req, u)) {
      throw forbidden(
        ["invited", "requested"].includes(u.status)
          ? "This person also has a site you don't manage. Decline your sites instead, or ask an Admin."
          : "Only pending accounts and requests can be deleted. Deactivate this person instead."
      );
    }
    await prisma.user.delete({ where: { id: u.id } });
    await audit({
      actor: actorOf(req),
      action: "user.deleted",
      summary: `Deleted ${u.status === "invited" ? "the pending account" : "the request"} for ${u.name === u.email ? u.email : `${u.name} (${u.email})`}`,
    });
    res.json({ ok: true });
  })
);
