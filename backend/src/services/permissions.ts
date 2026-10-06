import { prisma } from "../prisma.js";

/**
 * Roles are defined in code. Five match how Lantern is organised: the central
 * admin, main office staff who look across every site, and three levels of
 * staff at a site. If Lantern later needs editable roles, this table becomes a
 * Role model the way the AP app did it, and nothing that calls `can()` changes.
 */
export const PERMISSIONS = [
  "roster.view",
  "roster.edit",
  "roster.archive",
  "roster.restore",
  "audit.view",
  /** Form submissions (Hot Foods entries and reports). Site Staff record forms but can't read them back. */
  "entries.view",
  /** Void a form entry recorded in error (with a reason). The entry stays, marked void. */
  "entries.void",
  "sites.manage",
  /** Each assigned site's own roster rules (review threshold) — not the org-wide default. */
  "sites.manageRules",
  "users.manage",
  /** People & roles, limited to the caller's sites and the site roles. */
  "users.manageSite",
  "integrations.manage",
  "settings.manage",
  "forms.manage",
  /** Build code forms: their files, server logic and data (Admin and Developer). */
  "apps.develop",
  /**
   * Add, change and remove calendar events and their categories. Deliberately
   * Admin only: no other role gets it, Site Admin included. Everyone signed in
   * can read the calendar.
   */
  "calendar.manage",
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

const SITE_ROSTER: PermissionKey[] = ["roster.view", "roster.edit", "roster.archive", "roster.restore", "audit.view"];

/** Most privileged first — the order People & roles lists them in. */
export const ROLES: RoleDef[] = [
  {
    key: "admin",
    name: "Admin",
    description: "Full control on every site — the forms catalog, people, sites, integrations and settings.",
    permissions: [...PERMISSIONS],
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
    key: "main_office",
    name: "Main Office Staff",
    description: "Can look up residents on every site's roster. Cannot change anything.",
    permissions: ["roster.view", "entries.view"],
    allSites: true,
  },
  {
    key: "site_admin",
    name: "Site Admin",
    description: "Everything a Site Manager can do, plus people, roles and roster rules for their sites.",
    permissions: [...SITE_ROSTER, "entries.view", "entries.void", "users.manageSite", "sites.manageRules"],
    allSites: false,
  },
  {
    key: "site_manager",
    name: "Site Manager",
    description: "Adds, updates and removes residents at their sites; restores removed residents and sees the audit history.",
    permissions: [...SITE_ROSTER, "entries.view", "entries.void"],
    allSites: false,
  },
  {
    // What a new Lantern sign-in starts as, with no sites until someone
    // assigns them — so the forms work on day one and rosters come later.
    key: "site_staff",
    name: "Site Staff",
    description: "Adds, updates and removes residents at their sites. Cannot see form entries.",
    permissions: ["roster.view", "roster.edit", "roster.archive"],
    allSites: false,
  },
];

export const DEFAULT_ROLE_KEY = "site_staff";

/** Roles from before the five above, and what each became (see migrateLegacyRoles). */
export const LEGACY_ROLES: Record<string, string> = {
  member: "site_staff",
  viewer: "site_staff",
  staff: "site_staff",
};

/** Roles a Site Admin may hand out: the ones bounded by site assignment. */
export const SITE_ROLE_KEYS = ROLES.filter((r) => !r.allSites).map((r) => r.key);

export function roleFor(key: string): RoleDef {
  const k = LEGACY_ROLES[key] ?? key;
  return ROLES.find((r) => r.key === k) ?? ROLES.find((r) => r.key === DEFAULT_ROLE_KEY)!;
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
