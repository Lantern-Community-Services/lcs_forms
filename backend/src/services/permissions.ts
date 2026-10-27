import { prisma } from "../prisma.js";

/**
 * Roles are defined in code: the central admin, developers, and the people at
 * sites — main office staff, site managers and site staff. Everyone but an
 * Admin sees only the sites they've been approved for. If Lantern later needs editable roles, this table becomes a
 * Role model the way the AP app did it, and nothing that calls `can()` changes.
 */
export const PERMISSIONS = [
  "roster.view",
  "roster.edit",
  "roster.archive",
  "roster.restore",
  "audit.view",
  /** Form submissions (built and code forms: entries and reports) at the person's sites. */
  "entries.view",
  /** Void a form entry recorded in error (with a reason). The entry stays, marked void. */
  "entries.void",
  "sites.manage",
  /** Each assigned site's own roster rules (review threshold) — not the org-wide default. */
  "sites.manageRules",
  "users.manage",
  /** People & roles (Site settings), limited to the caller's sites and the site roles: approve, decline and remove requests. */
  "users.manageSite",
  "integrations.manage",
  "settings.manage",
  "forms.manage",
  /** Build code forms: their files, server logic and data (Admin and Developer). */
  "apps.develop",
  /**
   * The whole calendar: categories, events for every site, and any event at
   * all. Deliberately Admin only: no other role gets it, Site Manager included.
   * Everyone signed in can read the calendar.
   */
  "calendar.manage",
  /**
   * Add, change and remove calendar events for one's own sites only (never an
   * every-site event, never categories). Not part of any role but Admin's: it
   * comes from the per-person "Can edit the calendar" switch (User.calendarEditor),
   * which only an Admin can turn on. See permissionsFor().
   */
  "calendar.edit",
  /**
   * Make people Admins, and change or remove an Admin. Not part of any role: it
   * comes with User.globalAdmin (a Super Admin), which only the SUPER_ADMINS
   * setting gives. See permissionsFor().
   */
  "admins.manage",
  /**
   * People & roles → a person → Records: everything they filed, were told and
   * did. Super Admins only, like admins.manage, but a Super Admin's key with
   * people:manage may read it too (it changes nothing).
   */
  "people.records",
  /** Admin → Dev log: response times, errors, memory and the server log. Admin only. */
  "devlog.view",
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number];

export interface RoleDef {
  key: string;
  name: string;
  description: string;
  permissions: PermissionKey[];
  /** Sees and acts on every site regardless of UserSite rows. */
  allSites: boolean;
}

/**
 * Roster management: add and edit residents, the review queue's Keep and
 * Remove, attendance, and restoring removed residents. Site Managers have it;
 * anyone else gets it from the per-person "Can manage the roster" switch
 * (User.rosterEditor). See permissionsFor().
 */
export const ROSTER_MANAGEMENT: PermissionKey[] = ["roster.edit", "roster.archive", "roster.restore"];

/** Most privileged first — the order People & roles lists them in. */
export const ROLES: RoleDef[] = [
  {
    key: "admin",
    name: "Admin",
    description: "Full control on every site — the forms catalog, people, sites, integrations and settings. Only a Super Admin can make someone an Admin.",
    permissions: PERMISSIONS.filter((p) => p !== "admins.manage" && p !== "people.records"),
    allSites: true,
  },
  {
    // Builds code forms. Can't change people, sites or settings, and sees
    // rosters only at sites they're assigned (for testing with real data).
    key: "developer",
    name: "Developer",
    description: "Builds code forms — pages, server logic, dashboards — and can read entries. Sees rosters only at assigned sites.",
    permissions: ["apps.develop", "roster.view", "entries.view"],
    allSites: false,
  },
  {
    // Its own role so it can be given main-office duties later. For now it can
    // do what Site Staff can, at the sites the person is approved for.
    key: "main_office",
    name: "Main Office Staff",
    description: "Submits and reads forms, and looks up residents, at the sites they're approved for.",
    permissions: ["roster.view", "entries.view"],
    allSites: false,
  },
  {
    key: "site_manager",
    name: "Site Manager",
    description: "Everything Site Staff can do, plus managing the roster and approving people for their sites (Site settings).",
    permissions: ["roster.view", "entries.view", ...ROSTER_MANAGEMENT, "users.manageSite"],
    allSites: false,
  },
  {
    // What a new person is requested as. Approved per site in People & roles.
    key: "site_staff",
    name: "Site Staff",
    description: "Submits and reads forms, and looks up residents, at their sites. A Site Manager can let them manage the roster.",
    permissions: ["roster.view", "entries.view"],
    allSites: false,
  },
];

export const DEFAULT_ROLE_KEY = "site_staff";

/** Roles that were retired, and what each became (see migrateLegacyRoles). */
export const LEGACY_ROLES: Record<string, string> = {
  member: "site_staff",
  viewer: "site_staff",
  staff: "site_staff",
  // Site Admin's people powers moved to Site Manager (2026-10-21).
  site_admin: "site_manager",
};

/**
 * The roles a Site Manager may give out and see in Site settings. Listed, not
 * worked out from allSites: Developer is bounded by sites too but only an
 * Admin hands it out.
 */
export const SITE_ROLE_KEYS = ["site_manager", "site_staff", "main_office"];

export function roleFor(key: string): RoleDef {
  const k = LEGACY_ROLES[key] ?? key;
  return ROLES.find((r) => r.key === k) ?? ROLES.find((r) => r.key === DEFAULT_ROLE_KEY)!;
}

/**
 * What a person may do: their role's permissions, plus the ones switched on
 * for them alone. Everything that works out permissions goes through here, so
 * a switch can't be honored in one place and missed in another.
 *
 * A Super Admin is an Admin (roleKey "admin", so every "admin" role list in a
 * form or code form includes them) with User.globalAdmin on, which adds
 * admins.manage: only they make, change or remove Admins.
 */
export function permissionsFor(
  role: RoleDef,
  person: { calendarEditor?: boolean | null; rosterEditor?: boolean | null; globalAdmin?: boolean | null }
): PermissionKey[] {
  const extra: PermissionKey[] = [];
  if (person.calendarEditor && !role.permissions.includes("calendar.edit")) extra.push("calendar.edit");
  if (person.rosterEditor) for (const p of ROSTER_MANAGEMENT) if (!role.permissions.includes(p)) extra.push(p);
  if (person.globalAdmin && role.key === "admin") extra.push("admins.manage", "people.records");
  return extra.length ? [...role.permissions, ...extra] : role.permissions;
}

/** "Super Admin" for a Super Admin, otherwise the role's name. */
export function roleNameFor(role: RoleDef, person: { globalAdmin?: boolean | null }): string {
  return person.globalAdmin && role.key === "admin" ? "Super Admin" : role.name;
}

export function isRoleKey(key: string): boolean {
  return ROLES.some((r) => r.key === key);
}

/**
 * Rewrite retired role keys in the database, once per boot. roleFor() already
 * reads them as their replacement, so this only keeps the column honest for
 * People & roles filters and the lockout guard, which match on the stored key.
 */
export async function migrateLegacyRoles(): Promise<number> {
  let n = 0;
  for (const [from, to] of Object.entries(LEGACY_ROLES)) {
    n += (await prisma.user.updateMany({ where: { roleKey: from }, data: { roleKey: to } })).count;
  }
  return n;
}
