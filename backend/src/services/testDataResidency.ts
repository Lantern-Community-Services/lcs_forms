import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { CASE_TX, prisma } from "../prisma.js";
import type { Actor } from "./audit.js";
import { addDays, addExitTask, todayNY } from "./checklist.js";
import { programs as programList } from "./clientFields.js";
import { caseLeadChoices } from "./clientProfile.js";
import { AWAY_REASONS, EXIT_DESTINATIONS, LEAVING_REASONS, markAway, moveIn, residencyOnFor, seedUnits } from "./residency.js";
import { HOLD_CLOCK } from "./roster.js";
import { makeUpPrograms } from "./testDataSites.js";

/**
 * Made-up case management for a test site (services/testData.ts), after its
 * made-up roster is in: units at every supportive site set up from the roster,
 * a few vacant (the people who moved out left them, with their stays), a recent
 * move-in with its first-month checklist, someone away, people waiting to move
 * in, families at two household sites, last month's housing assessments done,
 * and client information for most residents. Nothing when case management is off.
 */

type Ctx = { actor: Actor; userId: string | null; byName: string };

const pick = <T>(list: readonly T[]) => list[crypto.randomInt(list.length)];
const chance = (p: number) => crypto.randomInt(1000) < p * 1000;
const ymdOf = (d: Date) => d.toISOString().slice(0, 10);

const KIDS = ["Amara", "Bodhi", "Cleo", "Dante", "Esme", "Felix", "Gia", "Hugo", "Iris", "Jonah", "Kira", "Leo", "Mila", "Nico", "Opal", "Remy"];
const PARTNERS = ["Adrian", "Beatriz", "Colette", "Desmond", "Eliza", "Frank", "Greta", "Harold", "Imani", "Julian"];
const WAITING = ["Anselm", "Bettina", "Corwin", "Dagny", "Ezra", "Fenna", "Garrick", "Honora", "Isidore", "Juno", "Kasimir", "Linnea"];
const LAST = ["Applewood", "Birchall", "Crestmoor", "Dovecote", "Elderberry", "Fernsby", "Glenhollow", "Hazelton", "Ivydale", "Juniperton"];

/** Made-up client information: never an SSN (any nine digits could be someone's). */
function clientInfo(t: { firstName: string; lastName: string | null }, opts: { program: string | null; caseLeadId: string | null; family: boolean }) {
  const age = 22 + crypto.randomInt(50);
  const dob = new Date(Date.UTC(new Date().getUTCFullYear() - age, crypto.randomInt(12), 1 + crypto.randomInt(28)));
  const sex = pick(["Female", "Male"] as const);
  const veteran = chance(0.08) ? "Yes" : "No";
  const data: Record<string, unknown> = {
    nameDataQuality: "Full name reported",
    dobDataQuality: "Full DOB reported",
    sex,
    genderIdentity: chance(0.9) ? "Cisgender" : pick(["Transgender", "Non-Binary"]),
    pronouns: sex === "Female" ? "She/Her/Hers" : "He/Him/His",
    raceEthnicity: [pick(["Black, African American, or African", "Hispanic/Latina/e/o", "White", "Asian or Asian American"])],
    preferredLanguage: chance(0.8) ? "English" : "Spanish",
    veteranStatus: veteran,
    ...(veteran === "Yes" ? { militaryBranch: pick(["Army", "Navy", "Marines", "Air Force"]), militaryEntryYear: 1985 + crypto.randomInt(20) } : {}),
    phone: `(555) 01${crypto.randomInt(10)}-${String(crypto.randomInt(10000)).padStart(4, "0")}`,
    email: `${t.firstName}.${t.lastName ?? "resident"}`.toLowerCase().replace(/[^a-z.]/g, "") + "@example.com",
    emergencyContacts: [{ name: `${pick(PARTNERS)} ${pick(LAST)}`, relationship: pick(["Sister", "Brother", "Friend", "Cousin", "Parent"]), phone: `(555) 01${crypto.randomInt(10)}-${String(crypto.randomInt(10000)).padStart(4, "0")}` }],
    population: opts.family ? pick(["HASA Families", "Gen Pop Families"]) : pick(["HASA", "Community", "Gen Pop", "SMI", "15/15"]),
    unitType: opts.family ? pick(["2-Bedrooms", "3-Bedrooms"]) : pick(["Studio", "1-Bedroom", "SRO"]),
    supportiveServicesFunder: [pick(["HASA", "DOHMH", "OMH", "HRA"])],
  };
  return { dateOfBirth: dob, program: opts.program, caseLeadId: opts.caseLeadId, data: JSON.stringify(data) };
}

export interface CaseManagementSummary {
  sites: number;
  units: number;
  householdSites: string[];
  families: number;
  waiting: number;
  away: number;
  movedOut: number;
  profiles: number;
}

export async function addCaseManagementData(ctx: Ctx): Promise<CaseManagementSummary | null> {
  const sites = await prisma.site.findMany({
    where: { active: true, siteType: "supportive" },
    select: { id: true, code: true, name: true, siteType: true, households: true },
    orderBy: { name: "asc" },
  });
  if (!sites.length || !(await residencyOnFor(sites[0]))) return null;

  const today = todayNY();
  const summary: CaseManagementSummary = { sites: 0, units: 0, householdSites: [], families: 0, waiting: 0, away: 0, movedOut: 0, profiles: 0 };

  // Two sites hold families; everywhere else one person per unit.
  const familySites = new Set(sites.slice(1, 3).map((s) => s.id));
  await prisma.site.updateMany({ where: { id: { in: sites.map((s) => s.id) } }, data: { households: false } });
  await prisma.site.updateMany({ where: { id: { in: [...familySites] } }, data: { households: true } });
  await makeUpPrograms();

  for (const s of sites) {
    const site = { ...s, households: familySites.has(s.id) };
    if (site.households) summary.householdSites.push(site.name);
    const programs = programList().filter((p) => p.site === site.code).map((p) => p.value);
    const leads = (await caseLeadChoices(site.id)).map((u) => u.id);
    const active = await prisma.tenant.findMany({ where: { siteId: site.id, status: "active" }, orderBy: { moveInDate: "asc" } });

    // Families: a partner and children in some units, sharing the head's unit number.
    if (site.households) {
      for (const head of active.filter((_, i) => i % 4 === 0)) {
        const headIn = head.moveInDate ? ymdOf(head.moveInDate) : addDays(today, -400);
        const members: { firstName: string; relation: string }[] = [];
        if (chance(0.6)) members.push({ firstName: pick(PARTNERS), relation: "Head of household's spouse or partner" });
        for (let k = 0, n = 1 + crypto.randomInt(3); k < n; k++) members.push({ firstName: pick(KIDS), relation: "Head of household's child" });
        await prisma.tenant.createMany({
          data: members.map((m) => ({
            siteId: site.id, firstName: m.firstName, lastName: head.lastName, unit: head.unit, householdRelation: m.relation,
            // After the head, so set-up-from-roster makes the head the head.
            moveInDate: new Date(`${addDays(headIn, 1 + crypto.randomInt(60))}T00:00:00Z`),
            externalId: `TEST-${crypto.randomBytes(3).toString("hex").toUpperCase()}`, notes: "Made-up resident (test site).",
          })),
        });
        summary.families++;
      }
    }

    // Units from the roster, then the ones the made-up move-outs left.
    const seeded = await seedUnits(ctx, site);
    summary.units += seeded.unitsAdded;
    const gone = await prisma.tenant.findMany({ where: { siteId: site.id, status: "archived", unit: { not: null } } });
    for (const t of gone) {
      const label = t.unit!.trim();
      let unit = await prisma.unit.findFirst({ where: { siteId: site.id, label } });
      if (!unit) unit = await prisma.unit.create({ data: { siteId: site.id, label } });
      else if (await prisma.tenant.count({ where: { unitId: unit.id, status: "active" } })) continue; // someone lives there now
      const out = t.moveOutDate ? ymdOf(t.moveOutDate) : addDays(today, -10);
      const inOn = t.moveInDate && ymdOf(t.moveInDate) < out ? ymdOf(t.moveInDate) : addDays(out, -365);
      await prisma.$transaction(async (tx) => {
        const stay = await tx.stay.create({
          data: {
            tenantId: t.id, siteId: site.id, unitId: unit!.id, unitLabel: label, moveInDate: new Date(`${inOn}T00:00:00Z`), moveOutDate: new Date(`${out}T00:00:00Z`),
            endKind: "moved_out", endReason: pick(LEAVING_REASONS), exitDestination: pick(EXIT_DESTINATIONS), createdById: ctx.userId, endedById: ctx.userId,
          },
        });
        await tx.tenant.update({ where: { id: t.id }, data: { archiveReason: `Moved out — ${stay.endReason}` } });
        await addExitTask(tx, { tenantId: t.id, siteId: site.id, stayId: stay.id, moveOut: out });
        await tx.unit.update({ where: { id: unit!.id }, data: { vacantSince: new Date(`${out}T00:00:00Z`) } });
      }, CASE_TX);
      summary.movedOut++;
      summary.units++;
    }

    // Three added but not moved in; one of them moved in last week, into a vacant unit.
    await prisma.tenant.createMany({
      data: [0, 1, 2].map(() => ({
        siteId: site.id, firstName: pick(WAITING), lastName: pick(LAST), movedIn: false, attentionClockAt: HOLD_CLOCK,
        externalId: `TEST-${crypto.randomBytes(3).toString("hex").toUpperCase()}`, notes: "Made-up resident (test site).",
      })),
    });
    const vacant = await prisma.unit.findFirst({ where: { siteId: site.id, active: true, tenants: { none: { status: "active" } } } });
    const newcomer = await prisma.tenant.findFirst({ where: { siteId: site.id, status: "active", movedIn: false } });
    if (vacant && newcomer) {
      await moveIn(ctx, { unitId: vacant.id, date: addDays(today, -(4 + crypto.randomInt(10))), people: [{ tenantId: newcomer.id }], program: programs[0] ?? null, canAccessSite: () => true });
      summary.waiting += 2;
    } else summary.waiting += 3;

    // Someone away: in hospital a couple of weeks, or out of contact over a month.
    const linked = await prisma.tenant.findMany({ where: { siteId: site.id, status: "active", movedIn: true, unitId: { not: null }, householdHeadId: null }, include: { site: { select: { id: true, code: true, name: true, siteType: true, households: true } } } });
    const awayOne = linked[crypto.randomInt(Math.max(1, linked.length))];
    if (awayOne) {
      const long = chance(0.5);
      await markAway(ctx, awayOne, { lastSeen: addDays(today, long ? -(31 + crypto.randomInt(20)) : -(3 + crypto.randomInt(14))), reason: long ? "No Contact" : pick(AWAY_REASONS.filter((r) => r !== "Other")) });
      summary.away++;
    }

    // Last month's housing assessments: most done, a few not.
    const lastMonth = await prisma.tenant.findMany({ where: { siteId: site.id, status: "active", movedIn: true, unitId: { not: null } }, select: { id: true, stays: { where: { moveOutDate: null }, select: { id: true }, take: 1 } } });
    const done: Prisma.TenantTaskCreateManyInput[] = [];
    for (const t of lastMonth) {
      const due = addDays(today, -(20 + crypto.randomInt(10)));
      const doneOn = chance(0.85) ? addDays(due, crypto.randomInt(9) - 4) : null;
      done.push({
        tenantId: t.id, siteId: site.id, stayId: t.stays[0]?.id ?? null, key: "housing_assessment", label: "Housing Assessment", dueOn: new Date(`${due}T00:00:00Z`),
        status: doneOn ? "done" : "skipped", doneOn: doneOn ? new Date(`${doneOn}T00:00:00Z`) : null, doneByName: doneOn ? "Made-up staff" : null, note: doneOn ? null : "Made-up: resident unavailable",
      });
    }
    if (done.length) await prisma.tenantTask.createMany({ data: done });

    // Client information for most people here, waiting list included.
    const people = await prisma.tenant.findMany({ where: { siteId: site.id, status: "active", profile: null } });
    const profiles = people
      .filter(() => chance(0.85))
      .map((t) => ({ tenantId: t.id, updatedById: ctx.userId, ...clientInfo(t, { program: programs.length ? pick(programs) : null, caseLeadId: leads.length ? pick(leads) : null, family: site.households }) }));
    if (profiles.length) await prisma.tenantProfile.createMany({ data: profiles });
    summary.profiles += profiles.length;
    summary.sites++;
  }
  return summary;
}
