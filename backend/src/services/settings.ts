import { prisma } from "../prisma.js";

/**
 * Org-wide settings, stored as key/value text. Every reader has a default so a
 * fresh database behaves sensibly before an admin has touched anything.
 */
export const SETTING_DEFAULTS = {
  /** Hours without activity before someone lands in the review queue. */
  attentionHours: "48",
  /** Extra email domains admitted at sign-in (partner orgs, Google Workspace). */
  guestDomains: "",
  /** Undo window for a removal, in seconds — how long the Undo toast stays. */
  undoSeconds: "10",
  /**
   * "true": the welcome tour (frontend lib/tour/siteTour.ts) starts by itself for
   * anyone who hasn't finished or skipped it on that kind of device. "false"
   * stops it starting; Profile → Take the tour still runs it.
   */
  welcomeTour: "true",
  /**
   * Staff groups whose members see every form and every entry, like Admins
   * (services/staffGroups.ts seesEverything): comma-separated group ids. "@IT",
   * the default, is the group called IT. Only Super Admins change it.
   */
  seeEverythingGroups: "@IT",
  /** How every email looks (services/emailLook.ts): JSON, empty = the default. Only Super Admins change it. */
  emailLook: "",
  /**
   * "true": the case management rework (replacing PlanStreet) is on for this site.
   * It is being built on the Azure dev site while prod keeps the roster as it is,
   * from the same code: every part of the rework checks this switch
   * (caseManagementEnabled here, user.features.caseManagement in the app). Today
   * that is residents' client information (services/clientFields.ts): the Client
   * information card on a resident's page, its API and MCP tools. Off by default;
   * turning it off hides the rework again and deletes nothing. Was "clientInfo"
   * until 2026-11-19 (migrateSettingKeys carries the old value over).
   */
  caseManagement: "false",
  /** Set when a build that wrote a default forms catalog had written it; see formCatalog.ts. */
  formCatalogSeeded: "",
  /** Set once the old default catalog has been taken out; see formCatalog.ts retireLegacyCatalog. */
  legacyCatalogRetired: "",
  /** Set once site addresses and coordinates have been filled from the site map; see siteLocations.ts. */
  siteLocationsSeeded: "",
  /** Set once the default calendar categories have been written; see calendar.ts. */
  calendarCategoriesSeeded: "",
  /** Set once older basic-form entries were given the resident they're about (FormEntry.tenantId); see clientTimeline.ts. */
  entryTenantsFilled: "",
  /** Test sites only: the made-up programs for their made-up sites (JSON); see testDataSites.ts. */
  testPrograms: "",
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

export async function getSetting(key: SettingKey): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? SETTING_DEFAULTS[key];
}

export async function getAllSettings(): Promise<Record<SettingKey, string>> {
  // Only the known keys: the table also holds other rows (download links' files, services/exportLinks.ts).
  const rows = await prisma.setting.findMany({ where: { key: { in: Object.keys(SETTING_DEFAULTS) } } });
  const out = { ...SETTING_DEFAULTS } as Record<SettingKey, string>;
  for (const r of rows) if (r.key in out) out[r.key as SettingKey] = r.value;
  return out;
}

export async function setSetting(key: SettingKey, value: string) {
  await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

export async function attentionHours(): Promise<number> {
  const n = Number(await getSetting("attentionHours"));
  return Number.isFinite(n) && n > 0 ? n : 48;
}

/** Fails closed: an unreadable row admits nobody extra. */
export async function guestDomains(): Promise<string[]> {
  try {
    return (await getSetting("guestDomains"))
      .split(",")
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}


/** The case management rework is switched on for this site (Admin → Settings). */
export async function caseManagementEnabled(): Promise<boolean> {
  return (await getSetting("caseManagement")) === "true";
}

/** Residents' client information: part of the case management rework, so on and off with it. */
export const clientInfoEnabled = caseManagementEnabled;

/** Settings that were renamed, and what each became. */
const RENAMED_SETTINGS: Record<string, SettingKey> = { clientInfo: "caseManagement" };

/** At start-up: a renamed setting's stored value moves to its new name (unless that's already set). */
export async function migrateSettingKeys(): Promise<number> {
  let n = 0;
  for (const [from, to] of Object.entries(RENAMED_SETTINGS)) {
    const old = await prisma.setting.findUnique({ where: { key: from } });
    if (!old) continue;
    if (!(await prisma.setting.findUnique({ where: { key: to } }))) {
      await prisma.setting.create({ data: { key: to, value: old.value } });
      n++;
    }
    await prisma.setting.delete({ where: { key: from } });
  }
  return n;
}
