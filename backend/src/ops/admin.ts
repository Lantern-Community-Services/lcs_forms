import { z } from "zod";
import { HttpError } from "../http.js";
import { activityRouter } from "../routes/activity.js";
import { sitesRouter } from "../routes/sites.js";
import { usersRouter } from "../routes/users.js";
import { authRouter } from "../routes/auth.js";
import { adminRouter } from "../routes/admin.js";
import { devlogRouter } from "../routes/devlog.js";
import { defineOp, int, flag } from "./registry.js";

/**
 * The admin screens: the audit log, sites, People & roles, org settings and the
 * dev log, through the routes those screens use. All act as the key's creator.
 *
 * Deliberately not here: API keys and webhooks (a key that can mint keys, or
 * point roster webhooks at any URL, could outgrow its creator), and making,
 * changing or removing Admins (admins.manage is never delegated).
 */

const enc = (v: string) => encodeURIComponent(v);
const RANGE = z.enum(["1h", "6h", "24h", "7d", "30d"]).optional();

export const adminOps = [
  defineOp({
    name: "list_audit",
    description: "The audit log, newest first: who changed what (residents, sites, people, settings, forms…). Filter by site and exact action (e.g. tenant.archived). Page with before = the last row's createdAt.",
    scope: "audit:read",
    as: "creator",
    http: { method: "GET", path: "/audit" },
    shape: {
      site: z.string().optional().describe("Site code or id (comma-separate several)"),
      action: z.string().max(80).optional(),
      before: z.string().optional().describe("ISO time"),
      limit: int(1, 200).optional(),
    },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => {
      // Without audit.view the log shows roster (tenant.*) events only; don't
      // let an action filter reach past that.
      if (a.action && !a.action.startsWith("tenant.") && !ctx.user!.permissions.includes("audit.view")) {
        throw new HttpError(403, "Only roster (tenant.*) events can be read without audit.view.");
      }
      return ctx.route(activityRouter, { method: "GET", path: "/audit", query: { site: a.site, action: a.action, before: a.before, limit: a.limit?.toString() } });
    },
  }),

  // ── Sites ──
  defineOp({
    name: "list_sites",
    description: "Sites the key can reach, with their details, active resident and attention counts, and review threshold. includeInactive adds deactivated sites.",
    scope: "sites:manage",
    as: "creator",
    http: { method: "GET", path: "/sites/all" },
    shape: { includeInactive: flag().optional() },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.route(sitesRouter, { method: "GET", path: "/", query: { all: a.includeInactive ? "1" : undefined } }),
  }),

  defineOp({
    name: "create_site",
    description: "Add a site. code is its short URL name (lowercase-with-dashes). Coordinates and a geofence are both-or-neither.",
    scope: "sites:manage",
    as: "creator",
    http: { method: "POST", path: "/sites" },
    shape: {
      name: z.string().max(120),
      code: z.string().max(60),
      entityName: z.string().max(160).nullable().optional().describe("The owning entity's name, as it appears in the property-management export"),
      siteType: z.enum(["supportive", "shelter", "other"]).optional(),
      address: z.string().max(240).nullable().optional(),
      latitude: z.number().nullable().optional(),
      longitude: z.number().nullable().optional(),
      geofenceMeters: z.number().int().nullable().optional(),
      attentionHours: z.number().int().nullable().optional().describe("Review threshold in hours; null = the org default"),
    },
    run: (ctx, a) => ctx.route(sitesRouter, { method: "POST", path: "/", body: a }),
  }),

  defineOp({
    name: "update_site",
    description: "Change a site's details. active: false deactivates it (it disappears from rosters and pickers).",
    scope: "sites:manage",
    as: "creator",
    http: { method: "PATCH", path: "/sites/:id" },
    shape: {
      id: z.string().describe("The site's id (list_sites)"),
      name: z.string().max(120).optional(),
      code: z.string().max(60).optional(),
      entityName: z.string().max(160).nullable().optional(),
      siteType: z.enum(["supportive", "shelter", "other"]).optional(),
      address: z.string().max(240).nullable().optional(),
      latitude: z.number().nullable().optional(),
      longitude: z.number().nullable().optional(),
      geofenceMeters: z.number().int().nullable().optional(),
      attentionHours: z.number().int().nullable().optional(),
      active: z.boolean().optional(),
    },
    confirm: (a) => a.active === false || a.code !== undefined,
    run: (ctx, { id, ...body }) => ctx.route(sitesRouter, { method: "PATCH", path: `/${enc(id)}`, body }),
  }),

  defineOp({
    name: "set_site_rules",
    description: "Set one site's review threshold (hours before an unconfirmed resident needs attention); null = the org default. Admin keys only (Site Managers no longer set roster rules).",
    scope: "sites:manage",
    as: "creator",
    http: { method: "PATCH", path: "/sites/:id/rules" },
    shape: { id: z.string(), attentionHours: z.number().int().min(1).max(24 * 60).nullable() },
    annotations: { idempotentHint: true },
    run: (ctx, { id, ...body }) => ctx.route(sitesRouter, { method: "PATCH", path: `/${enc(id)}/rules`, body }),
  }),

  // ── People & roles ──
  defineOp({
    name: "list_people",
    description: "People with an account (active, pending, requests, deactivated), with role, sites and whether this key may change their role. A Site Manager's key sees their sites' people and the requests for them (requestedSites, canApproveSiteIds).",
    scope: "people:manage",
    as: "creator",
    http: { method: "GET", path: "/people" },
    shape: {},
    annotations: { readOnlyHint: true },
    run: (ctx) => ctx.route(usersRouter, { method: "GET", path: "/" }),
  }),

  defineOp({
    name: "list_roles",
    description: "The roles, what each can do, and which ones this key may give out (never Admin).",
    scope: "people:manage",
    as: "creator",
    http: { method: "GET", path: "/people/roles" },
    shape: {},
    annotations: { readOnlyHint: true },
    run: (ctx) => ctx.route(authRouter, { method: "GET", path: "/roles" }),
  }),

  defineOp({
    name: "invite_person",
    description: "Make a pending account for someone by email, with a role and sites, before they sign in. Their first Microsoft sign-in fills in their name and activates it.",
    scope: "people:manage",
    as: "creator",
    http: { method: "POST", path: "/people" },
    shape: {
      email: z.string().email(),
      roleKey: z.string().describe("A role key from list_roles"),
      siteIds: z.array(z.string()).optional(),
      name: z.string().max(120).optional(),
      title: z.string().max(120).nullable().optional(),
      calendarEditor: z.boolean().optional().describe("The \"Can edit the calendar\" switch (Admin keys only)"),
    },
    run: (ctx, a) => ctx.route(usersRouter, { method: "POST", path: "/", body: a }),
  }),

  defineOp({
    name: "update_person",
    description: "Change someone's role, sites, status (active, invited, denied, deactivated), name, calendar switch (Admin keys only) or roster switch (\"Can manage the roster\"). Admins and Super Admins can't be changed through a key. Requests are approved with approve_person, not here.",
    scope: "people:manage",
    as: "creator",
    http: { method: "PATCH", path: "/people/:id" },
    shape: {
      id: z.string().describe("The person's id (list_people)"),
      roleKey: z.string().optional(),
      status: z.enum(["active", "invited", "denied", "deactivated"]).optional(),
      siteIds: z.array(z.string()).optional().describe("The sites they have (replaces them); giving a requested site settles that request"),
      name: z.string().max(120).optional(),
      calendarEditor: z.boolean().optional(),
      rosterEditor: z.boolean().optional().describe("Can manage the roster (add, edit, keep, remove, restore residents) whatever their role"),
    },
    confirm: (a) => a.roleKey !== undefined || a.status !== undefined || a.siteIds !== undefined || a.calendarEditor !== undefined || a.rosterEditor !== undefined,
    run: (ctx, { id, ...body }) => ctx.route(usersRouter, { method: "PATCH", path: `/${enc(id)}`, body }),
  }),

  defineOp({
    name: "approve_person",
    description:
      "Approve sites someone asked for at their first sign-in (list_people: requestedSites). A Site Manager's key approves only its own sites; the rest wait for their own managers. The first approval lets the person in with roleKey (Site Staff if left out).",
    scope: "people:manage",
    as: "creator",
    http: { method: "POST", path: "/people/:id/approve" },
    shape: {
      id: z.string().describe("The person's id (list_people)"),
      siteIds: z.array(z.string()).min(1).describe("Requested site ids to approve"),
      roleKey: z.string().optional().describe("A role key from list_roles"),
    },
    confirm: true,
    run: (ctx, { id, ...body }) => ctx.route(usersRouter, { method: "POST", path: `/${enc(id)}/approve`, body }),
  }),

  defineOp({
    name: "decline_person",
    description: "Decline sites someone asked for (a Site Manager's key: its own). A request left with no sites at all is removed.",
    scope: "people:manage",
    as: "creator",
    http: { method: "POST", path: "/people/:id/decline" },
    shape: {
      id: z.string().describe("The person's id (list_people)"),
      siteIds: z.array(z.string()).min(1).describe("Requested site ids to decline"),
    },
    confirm: true,
    annotations: { destructiveHint: true },
    run: (ctx, { id, ...body }) => ctx.route(usersRouter, { method: "POST", path: `/${enc(id)}/decline`, body }),
  }),

  defineOp({
    name: "delete_person",
    description: "Delete a pending account (invited, never signed in) or a request. Anyone who has been let in can only be deactivated (update_person status).",
    scope: "people:manage",
    as: "creator",
    http: { method: "DELETE", path: "/people/:id" },
    shape: { id: z.string().describe("The person's id (list_people)") },
    confirm: true,
    annotations: { destructiveHint: true },
    run: (ctx, a) => ctx.route(usersRouter, { method: "DELETE", path: `/${enc(a.id)}` }),
  }),

  // ── Settings ──
  defineOp({
    name: "get_settings",
    description: "Org settings: the default review threshold (attentionHours), guest sign-in domains, and undo window. (Every first sign-in is a request now; there is no automatic approval.)",
    scope: "settings:manage",
    as: "creator",
    http: { method: "GET", path: "/settings" },
    shape: {},
    annotations: { readOnlyHint: true },
    run: (ctx) => ctx.route(adminRouter, { method: "GET", path: "/settings" }),
  }),

  defineOp({
    name: "update_settings",
    description: "Change org settings. guestDomains decides who can get in, so it needs confirm: true.",
    scope: "settings:manage",
    as: "creator",
    http: { method: "PATCH", path: "/settings" },
    shape: {
      attentionHours: z.number().int().min(1).max(24 * 60).optional(),
      guestDomains: z.array(z.string()).optional().describe("Replaces the whole list"),
      undoSeconds: z.number().int().min(3).max(60).optional(),
    },
    confirm: (a) => a.guestDomains !== undefined,
    run: (ctx, a) => ctx.route(adminRouter, { method: "PATCH", path: "/settings", body: a }),
  }),

  // ── Dev log ──
  defineOp({
    name: "devlog_summary",
    description: "Admin → Dev log summary for a time range: response times, slowest and failing routes, errors, memory.",
    scope: "devlog:read",
    as: "creator",
    http: { method: "GET", path: "/devlog/summary" },
    shape: { range: RANGE },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.route(devlogRouter, { method: "GET", path: "/summary", query: { range: a.range } }),
  }),

  defineOp({
    name: "devlog_events",
    description: "Dev log events (server errors, slow requests, browser errors, log lines), newest first. Page with after.",
    scope: "devlog:read",
    as: "creator",
    http: { method: "GET", path: "/devlog/events" },
    shape: {
      kinds: z.string().optional().describe("Comma-separated event kinds"),
      level: z.enum(["error", "warn", "info"]).optional(),
      q: z.string().max(200).optional(),
      after: z.string().max(64).optional(),
      range: RANGE,
      limit: int(1, 200).optional(),
    },
    annotations: { readOnlyHint: true },
    run: (ctx, a) =>
      ctx.route(devlogRouter, { method: "GET", path: "/events", query: { kinds: a.kinds, level: a.level, q: a.q, after: a.after, range: a.range, limit: a.limit?.toString() } }),
  }),
];
