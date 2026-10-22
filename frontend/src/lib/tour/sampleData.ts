import type { FormCatalog, HomeData, Tenant } from "@/lib/types";

/**
 * Made-up forms and residents the welcome tour shows in place of real ones
 * (TourDef.sample), so the steps that ask for a tap — pin a form, keep a
 * resident — have something to tap that changes nothing real.
 *
 * Every id starts with SAMPLE_ID. The writes those taps would make (a pin, a
 * keep, a removal, an undo) check isSample() and stay on this device.
 */
export const SAMPLE_ID = "sample-";
export const isSample = (id: string) => id.startsWith(SAMPLE_ID);

/** The search the tour asks for, and the form it finds. */
export const SAMPLE_SEARCH = "check";
export const SAMPLE_FORM_TITLE = "Daily check-in";

const SITE = { id: `${SAMPLE_ID}site`, code: `${SAMPLE_ID}house`, name: "Sample House" };

export function sampleCatalog(): FormCatalog {
  const form = (id: string, categoryId: string, title: string, description: string, icon: string | null, sortOrder: number) => ({
    id: `${SAMPLE_ID}${id}`,
    categoryId,
    title,
    description,
    // Somewhere harmless: the tour keeps every tap but its own off the cards.
    url: "/forms",
    roles: [],
    keywords: null,
    badge: "Sample",
    icon,
    sortOrder,
    active: true,
  });
  const daily = `${SAMPLE_ID}daily`;
  const requests = `${SAMPLE_ID}requests`;
  return {
    categories: [
      {
        id: daily,
        name: "Daily work",
        icon: "clipboard",
        sortOrder: 0,
        forms: [
          form("check-in", daily, SAMPLE_FORM_TITLE, "Who you saw today, and anything to follow up on.", null, 0),
          form("meals", daily, "Meal count", "How many meals went out at each serving.", null, 1),
        ],
      },
      {
        id: requests,
        name: "Requests",
        icon: "hard-hat",
        sortOrder: 1,
        forms: [
          form("repair", requests, "Repair request", "Something broken in a unit or a shared space.", null, 0),
          form("supplies", requests, "Supply order", "Cleaning, office and kitchen supplies.", null, 1),
        ],
      },
    ],
    favorites: [],
  };
}

export function sampleHome(roster: boolean): HomeData {
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  return {
    attention: [
      ...(roster
        ? [{ id: `${SAMPLE_ID}review`, kind: "roster" as const, tone: "warn" as const, title: "3 residents to review", detail: "Sample House · not seen in 48+ hours", action: "Review", href: "/roster/review" }]
        : []),
      { id: `${SAMPLE_ID}draft`, kind: "draft" as const, tone: "info" as const, title: "Finish your Repair request", detail: "Saved on this device yesterday", action: "Continue", href: "/forms" },
    ],
    activity: [
      { id: `${SAMPLE_ID}a1`, actorName: "You", mine: true, verb: "You submitted", subject: SAMPLE_FORM_TITLE, detail: "Sample House", at: ago(2), href: null },
      { id: `${SAMPLE_ID}a2`, actorName: "Sam", mine: false, verb: "Sam submitted", subject: "Meal count", detail: "Sample House", at: ago(5), href: null },
      { id: `${SAMPLE_ID}a3`, actorName: "Riley", mine: false, verb: "Riley added", subject: "Jordan Example", detail: "to the roster", at: ago(26), href: null },
    ],
    recentForms: [
      { id: `${SAMPLE_ID}check-in`, title: SAMPLE_FORM_TITLE, href: "/forms", lastAt: ago(2), uses: 9 },
      { id: `${SAMPLE_ID}meals`, title: "Meal count", href: "/forms", lastAt: ago(30), uses: 3 },
    ],
    stats: { attention: roster ? 2 : 1, urgent: roster ? 1 : 0, submissionsWeek: 12, residents: roster ? 3 : null, sites: [SITE.name] },
  };
}

function resident(n: number, first: string, last: string, unit: string, hoursQuiet: number): Tenant {
  const at = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  return {
    id: `${SAMPLE_ID}resident-${n}`,
    siteId: SITE.id,
    site: SITE,
    unit,
    firstName: first,
    lastName: last,
    preferredName: null,
    displayName: `${first} ${last}`,
    status: "active",
    moveInDate: at(24 * 120).slice(0, 10),
    moveOutDate: null,
    notes: null,
    externalId: null,
    lastActivityAt: at(hoursQuiet),
    lastActivitySource: "Meal count",
    lastKeptAt: null,
    attentionClockAt: at(hoursQuiet),
    hoursQuiet,
    needsAttention: hoursQuiet >= 48,
    archivedAt: null,
    archiveReason: null,
    version: 1,
    createdAt: at(24 * 120),
    updatedAt: at(hoursQuiet),
  };
}

/** Sample House's roster, as GET /tenants answers it: everyone, those due for review, or nobody removed. */
export function sampleRoster(status: "active" | "archived" | "attention") {
  const items = status === "archived" ? [] : sampleResidents().filter((t) => status === "active" || t.needsAttention);
  return { items, attentionHours: 48, truncated: false };
}

/** Everyone at Sample House; the first three are due for review. */
function sampleResidents(): Tenant[] {
  return [
    resident(1, "Jordan", "Example", "2B", 75),
    resident(2, "Alex", "Sample", "4A", 60),
    resident(3, "Casey", "Demo", "1C", 52),
    resident(4, "Morgan", "Placeholder", "3D", 6),
    resident(5, "Taylor", "Testcase", "5A", 20),
  ];
}
