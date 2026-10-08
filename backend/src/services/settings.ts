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
   * "true": a first sign-in from Lantern's own domain (SSO_ALLOWED_DOMAINS) is
   * let straight in as a Staff member, so the forms work for everyone on day
   * one. Partner domains still file an access request either way.
   */
  autoApproveStaff: "true",
  /** Set when a build that wrote a default forms catalog had written it; see formCatalog.ts. */
  formCatalogSeeded: "",
  /** Set once the old default catalog has been taken out; see formCatalog.ts retireLegacyCatalog. */
  legacyCatalogRetired: "",
  /** Set once site addresses and coordinates have been filled from the site map; see siteLocations.ts. */
  siteLocationsSeeded: "",
  /** Set once the default calendar categories have been written; see calendar.ts. */
  calendarCategoriesSeeded: "",
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

export async function getSetting(key: SettingKey): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? SETTING_DEFAULTS[key];
}

export async function getAllSettings(): Promise<Record<SettingKey, string>> {
  const rows = await prisma.setting.findMany();
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

export async function autoApproveStaff(): Promise<boolean> {
  try {
    return (await getSetting("autoApproveStaff")) === "true";
  } catch {
    return false;
  }
}
