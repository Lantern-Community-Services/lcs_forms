import crypto from "node:crypto";
import { prisma } from "../prisma.js";
import { LIVE_HOST, testSite } from "../env.js";
import { HttpError } from "../http.js";
import { audit, type Actor } from "./audit.js";
import { deleteFiles } from "./fileStore.js";
import { forgetRosterNames, namesIn, rosterNames } from "./rosterNames.js";

/**
 * Made-up data for test sites (env.ts testSite): the Azure dev app and copies
 * running on a computer.
 *
 * A test site is reached by more people, on a cheaper footing, and its forms
 * go to the shared form backup, so it holds no real residents. Its roster is
 * made up, nothing real may come in (assertRealDataAllowed: tenant lists,
 * imported entries), and a Super Admin can wipe what's there and start again
 * with made-up residents (replaceWithMadeUpData, Admin → Roster rules).
 */

/** Refuses on a test site: `what` would bring real residents or entries in. */
export function assertRealDataAllowed(what: string) {
  if (testSite) {
    throw new HttpError(403, `This is a test site: its residents and entries are made up, and ${what} would bring in real ones. Do it on the live site (${LIVE_HOST}).`);
  }
}

// ── Made-up residents ────────────────────────────────────────────────────

const FIRST = [
  "Avery", "Bianca", "Calvin", "Dalia", "Emeka", "Farah", "Gideon", "Hana", "Ignacio", "Jada", "Kofi", "Lena", "Marcus", "Nadia", "Oscar",
  "Priya", "Quentin", "Rosa", "Samir", "Tamsin", "Ulises", "Vera", "Wendell", "Ximena", "Yusuf", "Zora", "Abel", "Brenda", "Cyrus", "Delphine",
  "Elias", "Fiona", "Gustavo", "Hollis", "Ines", "Jerome", "Keisha", "Lionel", "Mirela", "Nestor", "Odette", "Pascal", "Renata", "Silas", "Tobias",
];
const LAST = [
  "Abernathy", "Bellweather", "Castellano", "Dunmore", "Ekwueme", "Fairbanks", "Galloway", "Hartigan", "Ibarra-Vance", "Jessup", "Kowalczyk",
  "Lindqvist", "Marchetti", "Nakashima", "Okonkwo", "Pemberton", "Quintero", "Rasmussen", "Szabo", "Thistlewood", "Underhill", "Valderrama",
  "Whitcombe", "Yarborough", "Zielinski", "Ashdown", "Brightwater", "Coldbrook", "Delacroix", "Esterhazy", "Fenwick", "Grantham", "Hollister",
];
const NICKNAMES: Record<string, string> = { Ignacio: "Nacho", Gustavo: "Gus", Tobias: "Toby", Wendell: "Dell", Delphine: "Del" };

const pick = <T>(list: T[]) => list[crypto.randomInt(list.length)];
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

/** Made-up residents for one site: a believable roster, a few High Acuity, a few moved out. */
function madeUpRoster(site: { id: string; siteType: string }) {
  const shelter = site.siteType === "shelter";
  const count = shelter ? 20 : 30;
  const used = new Set<string>();
  const rows = [];
  for (let i = 0; i < count; i++) {
    let first = pick(FIRST);
    let last = pick(LAST);
    for (let tries = 0; used.has(`${first} ${last}`) && tries < 20; tries++) [first, last] = [pick(FIRST), pick(LAST)];
    used.add(`${first} ${last}`);
    const archived = i >= count - 3;
    rows.push({
      siteId: site.id,
      firstName: first,
      lastName: last,
      preferredName: NICKNAMES[first] && crypto.randomInt(2) ? NICKNAMES[first] : null,
      unit: shelter ? `Bed ${i + 1}` : `${1 + crypto.randomInt(8)}${"ABCDEFGH"[crypto.randomInt(8)]}`,
      moveInDate: daysAgo(shelter ? 5 + crypto.randomInt(120) : 30 + crypto.randomInt(2000)),
      highAcuity: !shelter && crypto.randomInt(10) === 0,
      externalId: `TEST-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
      notes: "Made-up resident (test site).",
      status: archived ? "archived" : "active",
      archivedAt: archived ? daysAgo(crypto.randomInt(30)) : null,
      archiveReason: archived ? "Moved out" : null,
      moveOutDate: archived ? daysAgo(crypto.randomInt(30)) : null,
    });
  }
  return rows;
}

/** Made-up residents at every active site. Used by replaceWithMadeUpData and the seed. */
export async function addMadeUpResidents(): Promise<number> {
  const sites = await prisma.site.findMany({ where: { active: true }, select: { id: true, siteType: true } });
  let n = 0;
  for (const site of sites) n += (await prisma.tenant.createMany({ data: madeUpRoster(site) })).count;
  forgetRosterNames();
  return n;
}

// ── Taking real names out of form definitions ───────────────────────────

const ACCENTED: Record<string, string> = { a: "aàáâãäå", e: "eèéêë", i: "iìíîï", o: "oòóôõöø", u: "uùúûü", n: "nñ", c: "cç", y: "yýÿ" };

/** A roster name ("maria lopez", as rosterNames writes it) as it may appear in text: any case or accents, _ - . , or spaces between words. */
function namePattern(key: string): RegExp {
  const word = (w: string) => [...w].map((ch) => `[${ACCENTED[ch] ?? ch}]`).join("['’]?");
  return new RegExp(`(?<![\\p{L}])${key.split(" ").map(word).join("[\\s_.,-]+")}(?![\\p{L}])`, "giu");
}

/** Every real name in `text` swapped for "Resident N" ("resident_N" where it was a value like maria_lopez). */
function redact(text: string, found: string[], numberOf: (key: string) => number): string {
  let out = text;
  for (const key of found) {
    const n = numberOf(key);
    out = out.replace(namePattern(key), (m) => (m.includes("_") ? `resident_${n}` : `Resident ${n}`));
  }
  return out;
}

// ── Replacing everything ─────────────────────────────────────────────────

export interface ReplaceSummary {
  residents: { removed: number; added: number };
  entries: number;
  files: number;
  attendance: number;
  audit: number;
  notifications: number;
  emails: number;
  devEvents: number;
  jobs: number;
  routingLog: number;
  /** Form definitions, versions, components, collections and calendar events that named real residents, now "Resident N". */
  redacted: string[];
  /** Anything that still names someone from the old roster after redaction: fix it by hand. */
  stillNamed: string[];
}

/**
 * Wipe every resident and everything made from them — entries, their notes and
 * files, attendance, the audit log, notifications, the email log, the dev log,
 * form jobs and the routing log — take the old residents' names out of forms,
 * versions, components, collections and the calendar, and fill the roster with
 * made-up residents. Forms, sites, people, groups and settings stay.
 *
 * Test sites only. Re-running is safe: whatever is there is replaced again.
 */
export async function replaceWithMadeUpData(actor: Actor): Promise<ReplaceSummary> {
  if (!testSite) throw new HttpError(403, "This is the live site: its residents and entries are real, and they stay.");

  // 1. The real names, read fresh (not the five-minute cache), to take out of everything that stays.
  forgetRosterNames();
  const names = await rosterNames();
  const numbers = new Map<string, number>();
  const numberOf = (key: string) => {
    if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
    return numbers.get(key)!;
  };
  const redacted: string[] = [];
  const stillNamed: string[] = [];
  /** Redact one stored text; returns the new text, or null when it named nobody. */
  const clean = (label: string, text: string | null): string | null => {
    if (!text) return null;
    const found = namesIn(text, names, 10_000);
    if (!found.length) return null;
    const out = redact(text, found, numberOf);
    redacted.push(label);
    if (namesIn(out, names, 1).length) stillNamed.push(label);
    return out;
  };

  for (const f of await prisma.builtForm.findMany({ select: { id: true, slug: true, draftSchema: true, liveSchema: true } })) {
    const draft = clean(`form ${f.slug} (draft)`, f.draftSchema);
    const live = clean(`form ${f.slug} (live)`, f.liveSchema);
    if (draft || live) await prisma.builtForm.update({ where: { id: f.id }, data: { ...(draft ? { draftSchema: draft } : {}), ...(live ? { liveSchema: live } : {}) } });
  }
  for (const v of await prisma.builtFormVersion.findMany({ select: { id: true, version: true, schema: true, form: { select: { slug: true } } } })) {
    const schema = clean(`form ${v.form.slug} v${v.version}`, v.schema);
    if (schema) await prisma.builtFormVersion.update({ where: { id: v.id }, data: { schema } });
  }
  for (const c of await prisma.uiComponent.findMany({ select: { id: true, name: true, files: true } })) {
    const files = clean(`component ${c.name}`, c.files);
    if (files) await prisma.uiComponent.update({ where: { id: c.id }, data: { files } });
  }
  for (const c of await prisma.uiComponentVersion.findMany({ select: { id: true, files: true, component: { select: { name: true } } } })) {
    const files = clean(`component ${c.component.name} (old version)`, c.files);
    if (files) await prisma.uiComponentVersion.update({ where: { id: c.id }, data: { files } });
  }
  for (const r of await prisma.formRecord.findMany({ where: { collection: { not: "__routing_log" } }, select: { id: true, collection: true, data: true, form: { select: { slug: true } } } })) {
    const data = clean(`collection ${r.form.slug}/${r.collection}`, r.data);
    if (data) await prisma.formRecord.update({ where: { id: r.id }, data: { data } });
  }
  for (const e of await prisma.calendarEvent.findMany({ select: { id: true, title: true, description: true, location: true } })) {
    const [title, description, location] = [clean(`calendar event ${e.id}`, e.title), clean(`calendar event ${e.id}`, e.description), clean(`calendar event ${e.id}`, e.location)];
    if (title || description || location) await prisma.calendarEvent.update({ where: { id: e.id }, data: { ...(title ? { title } : {}), ...(description ? { description } : {}), ...(location ? { location } : {}) } });
  }
  for (const e of await prisma.calendarException.findMany({ select: { id: true, title: true, description: true, location: true } })) {
    const [title, description, location] = [clean(`calendar change ${e.id}`, e.title), clean(`calendar change ${e.id}`, e.description), clean(`calendar change ${e.id}`, e.location)];
    if (title || description || location) await prisma.calendarException.update({ where: { id: e.id }, data: { ...(title ? { title } : {}), ...(description ? { description } : {}), ...(location ? { location } : {}) } });
  }

  // 2. Everything made from residents. Files before entries (no cascade), attendance before residents.
  const files = await deleteFiles({});
  const entries = (await prisma.formEntry.deleteMany({})).count; // notes go with them
  const jobs = (await prisma.formJob.deleteMany({})).count;
  const routingLog = (await prisma.formRecord.deleteMany({ where: { collection: "__routing_log" } })).count;
  await prisma.attendanceEntry.deleteMany({});
  const attendance = (await prisma.attendanceEvent.deleteMany({})).count;
  const notifications = (await prisma.notification.deleteMany({})).count;
  const emails = (await prisma.emailLog.deleteMany({})).count;
  const devEvents = (await prisma.devEvent.deleteMany({})).count;
  const auditRows = (await prisma.auditEvent.deleteMany({})).count;
  const removed = (await prisma.tenant.deleteMany({})).count; // activity goes with them

  // 3. A made-up roster.
  const added = await addMadeUpResidents();

  const summary: ReplaceSummary = {
    residents: { removed, added },
    entries,
    files,
    attendance,
    audit: auditRows,
    notifications,
    emails,
    devEvents,
    jobs,
    routingLog,
    redacted: [...new Set(redacted)],
    stillNamed: [...new Set(stillNamed)],
  };
  await audit({
    actor,
    action: "testdata.replaced",
    summary: `Replaced this test site's data with made-up data: ${removed} residents and ${entries} entries removed, ${added} made-up residents added${summary.redacted.length ? `, names taken out of ${summary.redacted.length} forms and records` : ""}`,
  });
  return summary;
}
