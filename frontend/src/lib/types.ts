export type PermissionKey =
  | "roster.view"
  | "roster.edit"
  | "roster.archive"
  | "roster.restore"
  | "audit.view"
  | "entries.view"
  | "entries.void"
  | "sites.manage"
  | "sites.manageRules"
  | "users.manage"
  | "users.manageSite"
  | "integrations.manage"
  | "settings.manage"
  | "forms.manage"
  | "apps.develop";

export type UserStatus = "active" | "invited" | "requested" | "denied" | "deactivated";
export type LandingPage = "/forms" | "/roster" | "/roster/review" | "/roster/overview";

export interface SiteRef {
  id: string;
  code: string;
  name: string;
}

export interface RoleSummary {
  key: string;
  name: string;
  description?: string;
  allSites: boolean;
}

export interface User {
  id: string;
  name: string;
  email: string;
  title?: string | null;
  avatarColor?: string | null;
  status: UserStatus;
  roleKey: string;
  role: RoleSummary;
  permissions: PermissionKey[];
  identityProvider?: string | null;
  defaultLandingPage: LandingPage;
  defaultSiteCode?: string | null;
  sites: SiteRef[];
  allSites: boolean;
  lastSignInAt?: string | null;
}

export interface Site extends SiteRef {
  entityName?: string | null;
  siteType: "supportive" | "shelter" | "other";
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  /** "At this site" radius in metres; null = the default (200). */
  geofenceMeters?: number | null;
  active: boolean;
  attentionHours?: number | null;
  activeCount: number;
  attentionCount: number;
  effectiveAttentionHours: number;
}

export interface Tenant {
  id: string;
  siteId: string;
  site?: SiteRef;
  unit: string | null;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  displayName: string;
  status: "active" | "archived";
  moveInDate: string | null;
  moveOutDate: string | null;
  notes: string | null;
  externalId: string | null;
  lastActivityAt: string | null;
  lastActivitySource: string | null;
  lastKeptAt: string | null;
  attentionClockAt: string;
  hoursQuiet: number;
  needsAttention: boolean;
  archivedAt: string | null;
  archiveReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TenantActivity {
  id: string;
  source: string;
  label: string | null;
  externalRef: string | null;
  occurredAt: string;
  recordedBy: string | null;
}

export interface AuditEvent {
  id: string;
  actorId: string | null;
  actorName: string;
  action: string;
  tenantId: string | null;
  siteId: string | null;
  summary: string;
  changes: Record<string, [unknown, unknown]> | Record<string, unknown> | null;
  createdAt: string;
}

export interface TenantDetail extends Tenant {
  activities: TenantActivity[];
  history: AuditEvent[];
}

export interface DashboardData {
  totals: { active: number; attention: number; addedWeek: number; removedWeek: number };
  attentionHours: number;
  sites: (SiteRef & { siteType: string; activeCount: number; attentionCount: number; addedWeek: number; removedWeek: number })[];
  recent: AuditEvent[];
}

export interface AttendanceEvent {
  id: string;
  siteId: string;
  site: SiteRef;
  title: string;
  description: string;
  occurredAt: string;
  createdByName: string;
  presentCount: number;
  signedCount: number;
}

export interface AttendanceEntry {
  id: string;
  tenantId: string;
  tenantName: string;
  signature: string | null;
  signedAt: string | null;
}

export interface AttendanceDetail {
  id: string;
  site: SiteRef;
  title: string;
  description: string;
  occurredAt: string;
  createdByName: string;
  entries: AttendanceEntry[];
}

export interface ManagedUser extends Omit<User, "permissions" | "allSites" | "role"> {
  role: RoleSummary;
  createdAt: string;
  /**
   * False when a Site Admin is looking at someone who also works at a site
   * they don't manage: they can move them between their own sites, but not
   * change the role or status.
   */
  canEditRole: boolean;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string;
  siteId: string | null;
  site: { name: string } | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface WebhookRow {
  id: string;
  name: string;
  url: string;
  events: string;
  active: boolean;
  secretHint: string;
  lastDeliveryAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
  deliveries: { id: string; event: string; statusCode: number | null; error: string | null; durationMs: number | null; createdAt: string }[];
}

export interface Settings {
  attentionHours: string;
  guestDomains: string;
  undoSeconds: string;
  autoApproveStaff: string;
}

export interface FormLink {
  id: string;
  categoryId: string;
  title: string;
  description: string | null;
  /** An absolute URL (still on WordPress) or an app path such as "/roster". */
  url: string;
  /** Role keys that may see this form. Empty = every role. */
  roles: string[];
  keywords: string | null;
  badge: string | null;
  /** Icon key (lib/formIcons.ts); null = the category's icon. */
  icon: string | null;
  sortOrder: number;
  active: boolean;
}

export interface FormCategory {
  id: string;
  name: string;
  icon: string;
  sortOrder: number;
  forms: FormLink[];
}

export interface FormCatalog {
  categories: FormCategory[];
  /** Ids of the forms the signed-in person starred, oldest first. */
  favorites: string[];
}

export interface ImportSummary {
  committed: boolean;
  rows: number;
  skippedBlank: number;
  sitesCreated: string[];
  added: number;
  alreadyPresent: number;
  bySite: { site: string; added: number; alreadyPresent: number }[];
  samples: { site: string; unit: string; raw: string; parsed: { firstName: string; lastName: string; preferredName: string | null } }[];
}

// ── Hot Foods ────────────────────────────────────────────────────────────

export interface HotFoodItem {
  id: string;
  name: string;
  imageUrl: string | null;
  active: boolean;
  sortOrder: number;
  /** Report color: slot 0-7 of the chart palette; null = "Other" gray. */
  colorSlot: number | null;
}

export interface HotFoodToday {
  /** Meals of each meal type one resident may get today before a reason is needed. */
  limit: number;
  /** Minutes between two meals of the same type (shelters); 0 = none. */
  cooldownMinutes: number;
  isShelter: boolean;
  /** tenantId → non-void entries today at this site. */
  counts: Record<string, number>;
  /** tenantId → itemId → one timestamp (ms) per meal of that type today. */
  meals: Record<string, Record<string, number[]>>;
  /** tenantId → meals at this site over the `regularsDays` days before today. */
  regulars: Record<string, number>;
  regularsDays: number;
}

/** Admin → Hot Foods. */
export interface HotFoodConfig {
  supportiveLimit: number;
  shelterLimit: number;
  cooldownMinutes: number;
}

export interface HotFoodEntryRow {
  id: string;
  site: SiteRef;
  tenantId: string;
  tenantName: string;
  unit: string | null;
  mealCount: number;
  notes: string | null;
  overrideReason: string | null;
  occurredAt: string;
  createdByName: string;
  voidedAt: string | null;
  voidReason: string | null;
  source: string;
  items: { itemName: string; quantity: number }[];
}

export interface HotFoodEntryDetail extends HotFoodEntryRow {
  signature: string;
  voidedByName: string | null;
}

export interface HotFoodReport {
  from: string;
  to: string;
  sites: SiteRef[];
  totals: { entries: number; meals: number; residents: number; overrides: number; voided: number; days: number; avgMealsPerDay: number };
  /** Meal types present in range, in fixed color-slot order. */
  series: { key: string; name: string; slot: number | null }[];
  byDay: { day: string; entries: number; meals: number; parts: Record<string, number> }[];
  bySite: { code: string; name: string; siteType: string; entries: number; meals: number; residents: number }[];
  byItem: { key: string; name: string; slot: number | null; quantity: number }[];
  heat: number[][];
  /** avatarColor = their profile color; null = none chosen (the avatar default navy). */
  byStaff: { name: string; entries: number; userId: string | null; avatarColor: string | null }[];
}
