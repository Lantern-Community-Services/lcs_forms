import { prisma } from "../prisma.js";
import { setTestPrograms, type Program } from "./clientFields.js";
import { getSetting, setSetting } from "./settings.js";
import { codeAliases } from "./siteLocations.js";

/**
 * Made-up sites for a test site (services/testData.ts). Each real building is
 * renamed in place — name, code, owner, address, no location — so everything
 * that points at a site by its id (staff, units, routing, the calendar) keeps
 * working, now with a made-up building. Demo and test sites, offices and sites
 * already made up are left as they are. The programs follow: a test site's
 * programs are made up for its made-up sites (setTestPrograms).
 */

const SUPPORTIVE = [
  "Alder Court", "Bramble House", "Copperleaf Hall", "Driftwood Commons", "Elmstead Hall", "Foxglove House", "Garnet Terrace", "Heron Point",
  "Ironwood Hall", "Juniper Commons", "Kestrel House", "Larkspur Hall", "Marigold Court", "Nettlefield Hall", "Oriole House", "Primrose Hall",
  "Quillfeather Hall", "Rosemallow House", "Sorrel Commons", "Thornbury Hall", "Umberwood Hall", "Verbena House", "Willowmere Hall", "Yarrowfield Court",
];
const SHELTERS = [
  "Quarry Street Shelter", "Riverbend Shelter", "Sandpiper Shelter", "Tidewater Shelter", "Upland Shelter", "Wren Street Shelter", "Yewtree Shelter", "Zephyr Shelter",
];
const STREETS = ["Maple", "Cedar", "Linden", "Hawthorn", "Chestnut", "Sycamore", "Poplar", "Magnolia", "Laurel", "Spruce", "Aspen", "Hickory"];

/** Program kinds for made-up programs: "<site> - <kind>". */
const SINGLE_KINDS = ["HASA/CoC Single Adults", "DOHMH/CoC Single Adults", "Community Single Adults", "OMH Young Adults", "HRA Gen Pop Single Adults"];
const FAMILY_KINDS = ["DOHMH/CoC Families", "Community Families"];

const codeOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const MADE_UP = new Set([...SUPPORTIVE, ...SHELTERS].map(codeOf));

/** Sites a test site keeps as they are: demo and test sites, offices, and ones already made up. */
function keep(s: { code: string; siteType: string }) {
  return MADE_UP.has(s.code) || /-demo$|^test-|^zz-/.test(s.code) || s.siteType === "office";
}

export interface SiteRename {
  id: string;
  from: { code: string; name: string; entityName: string | null };
  to: { code: string; name: string; entityName: string };
}

/** Rename every real site to a made-up one. Returns what changed, old → new, for rewriting stored references. */
export async function renameSites(): Promise<SiteRename[]> {
  const sites = await prisma.site.findMany({ orderBy: { name: "asc" } });
  const taken = new Set(sites.map((s) => s.code));
  const pools = { shelter: SHELTERS.filter((n) => !taken.has(codeOf(n))), supportive: SUPPORTIVE.filter((n) => !taken.has(codeOf(n))) };
  const out: SiteRename[] = [];
  let i = 0;
  for (const s of sites) {
    if (keep(s)) continue;
    const pool = s.siteType === "shelter" ? pools.shelter : pools.supportive;
    const name = pool.shift() ?? `Made-up Site ${out.length + 1}`;
    const to = { code: codeOf(name), name, entityName: `${name} Housing LP` };
    await prisma.site.update({
      where: { id: s.id },
      data: {
        ...to,
        address: `${100 + i * 17} ${STREETS[i % STREETS.length]} Street, Testville, NY 00000`,
        latitude: null,
        longitude: null,
        geofenceMeters: null,
      },
    });
    out.push({ id: s.id, from: { code: s.code, name: s.name, entityName: s.entityName }, to });
    i++;
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Everything stored that names a renamed site by code or name, rewritten to the
 * made-up one: saved notification routing, email reports and follow-up settings
 * (their `sites` lists and site rules), code forms' own collections, the
 * calendar, email templates and people's default site. Entries, jobs and
 * notifications are gone by now (replaceWithMadeUpData). Returns what was
 * rewritten, and the forms and components that still name a real building.
 */
export async function rewriteSiteReferences(renames: SiteRename[]): Promise<{ rewritten: string[]; stillNaming: string[] }> {
  const pairs: { re: RegExp; to: string }[] = [];
  for (const r of renames) {
    // A code as a whole token (not part of a longer code); hyphenated aliases only, so a bare word isn't caught.
    for (const code of new Set([r.from.code, ...codeAliases(r.from.code).filter((c) => c.includes("-"))])) {
      pairs.push({ re: new RegExp(`(?<![A-Za-z0-9_-])${escape(code)}(?![A-Za-z0-9_-])`, "g"), to: r.to.code });
    }
    if (r.from.entityName && r.from.entityName !== r.from.name) {
      pairs.push({ re: new RegExp(`(?<![\\p{L}\\p{N}])${escape(r.from.entityName)}(?![\\p{L}\\p{N}])`, "gu"), to: r.to.entityName });
    }
    pairs.push({ re: new RegExp(`(?<![\\p{L}\\p{N}])${escape(r.from.name)}(?![\\p{L}\\p{N}])`, "gu"), to: r.to.name });
  }
  // Longest first: "Amber Hall LP" before "Amber Hall".
  pairs.sort((a, b) => b.re.source.length - a.re.source.length);
  const changed: string[] = [];
  /** The text rewritten, or null when it named none of them. */
  const swap = (label: string, text: string | null): string | null => {
    if (!text) return null;
    let out = text;
    for (const p of pairs) out = out.replace(p.re, p.to);
    if (out === text) return null;
    changed.push(label);
    return out;
  };

  // Form definitions and shared components stay as they are: the form backup keeps one copy of each
  // for every site, so rewriting them here would offer the made-up codes to the live site as an update.
  // Listed instead, so whoever tests on this site knows which forms still name a real building.
  const mentions: string[] = [];
  const names = (label: string, text: string | null) => {
    if (text && pairs.some((p) => new RegExp(p.re.source, p.re.flags.replace("g", "")).test(text))) mentions.push(label);
  };
  for (const f of await prisma.builtForm.findMany({ select: { slug: true, draftSchema: true, liveSchema: true } })) names(`form ${f.slug}`, `${f.draftSchema}
${f.liveSchema ?? ""}`);
  for (const c of await prisma.uiComponent.findMany({ select: { name: true, files: true } })) names(`component ${c.name}`, c.files);

  // Routing (__routing), email reports, follow-up settings and code forms' own collections.
  for (const r of await prisma.formRecord.findMany({ select: { id: true, collection: true, data: true, form: { select: { slug: true } } } })) {
    const data = swap(`${r.form.slug}/${r.collection}`, r.data);
    if (data) await prisma.formRecord.update({ where: { id: r.id }, data: { data } });
  }
  for (const e of await prisma.calendarEvent.findMany({ select: { id: true, title: true, description: true, location: true } })) {
    const [title, description, location] = [swap(`calendar event ${e.id}`, e.title), swap(`calendar event ${e.id}`, e.description), swap(`calendar event ${e.id}`, e.location)];
    if (title || description || location) await prisma.calendarEvent.update({ where: { id: e.id }, data: { ...(title ? { title } : {}), ...(description ? { description } : {}), ...(location ? { location } : {}) } });
  }
  for (const e of await prisma.calendarException.findMany({ select: { id: true, title: true, description: true, location: true } })) {
    const [title, description, location] = [swap(`calendar change ${e.id}`, e.title), swap(`calendar change ${e.id}`, e.description), swap(`calendar change ${e.id}`, e.location)];
    if (title || description || location) await prisma.calendarException.update({ where: { id: e.id }, data: { ...(title ? { title } : {}), ...(description ? { description } : {}), ...(location ? { location } : {}) } });
  }
  for (const t of await prisma.emailTemplate.findMany()) {
    const fields = ["subject", "heading", "intro", "whatToDo", "details"] as const;
    const data: Partial<Record<(typeof fields)[number], string>> = {};
    for (const k of fields) {
      const v = swap(`email template ${t.key}`, t[k]);
      if (v) data[k] = v;
    }
    if (Object.keys(data).length) await prisma.emailTemplate.update({ where: { id: t.id }, data });
  }
  for (const r of renames) {
    const { count } = await prisma.user.updateMany({ where: { defaultSiteCode: { in: [r.from.code, ...codeAliases(r.from.code)] } }, data: { defaultSiteCode: r.to.code } });
    if (count) changed.push(`${count} people's default site`);
  }
  return { rewritten: [...new Set(changed)], stillNaming: [...new Set(mentions)] };
}

const SETTING = "testPrograms";

/** Made-up programs for every supportive site (families kinds at household sites), saved and put in use. */
export async function makeUpPrograms(): Promise<number> {
  const sites = await prisma.site.findMany({ where: { active: true, siteType: "supportive" }, select: { code: true, name: true, households: true }, orderBy: { name: "asc" } });
  const list: Program[] = [];
  sites.forEach((s, n) => {
    const kinds = s.households ? [FAMILY_KINDS[n % 2], SINGLE_KINDS[n % SINGLE_KINDS.length]] : [SINGLE_KINDS[n % SINGLE_KINDS.length], SINGLE_KINDS[(n + 2) % SINGLE_KINDS.length]];
    for (const kind of kinds) list.push({ site: s.code, value: `${s.name} - ${kind}` });
  });
  await setSetting(SETTING, JSON.stringify(list));
  setTestPrograms(list);
  return list.length;
}

/** On a test site's start: its made-up programs, if it has any. */
export async function loadTestPrograms() {
  try {
    const raw = await getSetting(SETTING);
    if (raw) setTestPrograms(JSON.parse(raw) as Program[]);
  } catch {
    /* none saved, or unreadable: the real list */
  }
}
