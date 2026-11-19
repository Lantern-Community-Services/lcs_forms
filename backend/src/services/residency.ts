import type { Prisma, Site, Stay, Tenant, TenantAbsence, Unit } from "@prisma/client";
import { CASE_TX, prisma } from "../prisma.js";
import { badRequest, HttpError } from "../http.js";
import { audit, type Actor } from "./audit.js";
import { caseManagementEnabled } from "./settings.js";
import { clockAfterHold, displayName, HOLD_CLOCK, isOnHold, publicTenant } from "./roster.js";
import { MOVE_OUT_REASONS, programs, US_STATES } from "./clientFields.js";
import { addExitTask, cancelOpenTasks, day, SCHEDULE, tasksForStay, todayNY, ymd } from "./checklist.js";
import { notifyQuietly } from "./notifications.js";

/**
 * Where residents live (case management): units, moving in and out, being away.
 *
 * Adding someone to the roster and moving them into a unit are separate steps.
 * At a supportive site with case management on, someone added without a unit is
 * on the roster but "not moved in" (an applicant): kept out of form pickers and
 * the review queue until the move-in. People are assigned to units, not the other
 * way round, so a unit nobody lives in shows on the roster as vacant.
 *
 * A unit holds one person, except at household sites (Admin → Sites), where it
 * holds a household: a head of household and members, each with their relation
 * to the head. Each time someone lives somewhere is a Stay (HMIS's enrollment);
 * a transfer ends one and starts the next. Away (PlanStreet's Out of Building
 * Status) is a TenantAbsence. Shelters and offices keep today's roster.
 */

// ── Option lists ─────────────────────────────────────────────────────────

export const HEAD = "Self (head of household)";
export const HOUSEHOLD_RELATIONS = [
  HEAD,
  "Head of household's child",
  "Head of household's spouse or partner",
  "Head of household's other relation member",
  "Other: non-relation member",
] as const;
const MEMBER_RELATIONS: readonly string[] = HOUSEHOLD_RELATIONS.filter((r) => r !== HEAD);

export const INTERNAL_TRANSFER = "Internal Permanent Supportive Housing Transfer";
/** Move-out reasons for an actual move-out: an internal transfer is a transfer instead. */
export const LEAVING_REASONS: readonly string[] = MOVE_OUT_REASONS.filter((r) => r !== INTERNAL_TRANSFER);

/** PlanStreet's Out of Building Status reasons. */
export const AWAY_REASONS = [
  "Detox/Rehab",
  "Domestic Violence/Intimate Partner Violence",
  "Family/Friends/Partner",
  "Hospital",
  "Nursing Home",
  "Jail/Prison/Order of Protection",
  "No Contact",
  "Vacation/Trip",
  "Other",
] as const;

/** HUD exit destinations (FY2024), as PlanStreet's HMIS Project Exit lists them. */
export const EXIT_DESTINATIONS = [
  "Place not meant for habitation (e.g., a vehicle, an abandoned building, bus/train/subway station/airport or anywhere outside)",
  "Emergency shelter, including hotel or motel paid for with emergency shelter voucher, Host Home shelter",
  "Safe Haven",
  "Foster care home or foster care group home",
  "Hospital or other residential non-psychiatric medical facility",
  "Jail, prison or juvenile detention facility",
  "Long-term care facility or nursing home",
  "Psychiatric hospital or other psychiatric facility",
  "Substance abuse treatment facility or detox center",
  "Transitional housing for homeless persons (including homeless youth)",
  "Residential project or halfway house with no homeless criteria",
  "Hotel or motel paid for without emergency shelter voucher",
  "Host Home (non-crisis)",
  "Staying or living with family, temporary tenure (e.g., room, apartment, or house)",
  "Staying or living with friends, temporary tenure (e.g., room, apartment, or house)",
  "Moved from one HOPWA funded project to HOPWA TH",
  "Staying or living with family, permanent tenure",
  "Staying or living with friends, permanent tenure",
  "Moved from one HOPWA funded project to HOPWA PH",
  "Rental by client, no ongoing housing subsidy",
  "Rental by client, with ongoing housing subsidy",
  "Rental by client, with HCV voucher (tenant or project based)",
  "Rental by client in a public housing unit",
  "Rental by client, with VASH housing subsidy",
  "Rental by client, with GPD TIP housing subsidy",
  "Rental by client, with RRH or equivalent subsidy",
  "Owned by client, with ongoing housing subsidy",
  "Owned by client, no ongoing housing subsidy",
  "Permanent housing (other than RRH) for formerly homeless persons",
  "Deceased",
  "Other",
  "Client doesn't know",
  "Client prefers not to answer",
  "No exit interview completed",
  "Data not collected",
  "Worker unable to determine",
] as const;

export const UNIT_TYPES = ["Studio", "1-Bedroom", "2-Bedrooms", "3-Bedrooms", "SRO"] as const;

export function residencyMeta() {
  return {
    relations: HOUSEHOLD_RELATIONS,
    head: HEAD,
    moveOutReasons: LEAVING_REASONS,
    internalTransfer: INTERNAL_TRANSFER,
    awayReasons: AWAY_REASONS,
    exitDestinations: EXIT_DESTINATIONS,
    unitTypes: UNIT_TYPES,
    states: US_STATES,
    programs: programs(),
    schedule: SCHEDULE.map(({ key, label, afterMoveIn, every, afterMoveOut }) => ({ key, label, afterMoveIn, every, afterMoveOut })),
  };
}

// ── When it applies ──────────────────────────────────────────────────────

/** Units and move-in/move-out apply at a supportive site while case management is on. */
export async function residencyOnFor(site: Pick<Site, "siteType">): Promise<boolean> {
  return site.siteType === "supportive" && (await caseManagementEnabled());
}

export async function assertResidency(site: Pick<Site, "siteType" | "name">) {
  if (!(await caseManagementEnabled())) throw new HttpError(404, "Units and move-ins are part of case management, which is turned off.");
  if (site.siteType !== "supportive") throw badRequest(`${site.name} isn't a supportive site, so it has no units.`);
}

type Ctx = { actor: Actor; userId: string | null; byName: string };
type SiteRow = Pick<Site, "id" | "code" | "name" | "siteType" | "households">;
const SITE_SELECT = { id: true, code: true, name: true, siteType: true, households: true } as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A move date: a real day, not in the future, not before 1990. */
export function moveDate(raw: unknown, what = "Date"): string {
  if (typeof raw !== "string" || !DATE_RE.test(raw) || Number.isNaN(day(raw).getTime())) throw badRequest(`${what}: pick a date.`);
  if (raw > todayNY()) throw badRequest(`${what} can't be in the future.`);
  if (raw < "1990-01-01") throw badRequest(`${what} is too long ago.`);
  return raw;
}

// ── Units ────────────────────────────────────────────────────────────────

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const OCCUPANT_SELECT = {
  id: true, firstName: true, lastName: true, preferredName: true, unitId: true, householdHeadId: true, householdRelation: true, awaySince: true, highAcuity: true,
} as const;
type OccupantRow = Prisma.TenantGetPayload<{ select: typeof OCCUPANT_SELECT }>;

/** Head first, then the members by name. */
function occupantsOut(rows: OccupantRow[]) {
  return rows
    .map((t) => ({
      id: t.id,
      displayName: displayName(t),
      head: !t.householdHeadId,
      relation: t.householdHeadId ? t.householdRelation : rows.length > 1 ? HEAD : t.householdRelation,
      away: Boolean(t.awaySince),
      highAcuity: t.highAcuity,
    }))
    .sort((a, b) => Number(b.head) - Number(a.head) || a.displayName.localeCompare(b.displayName));
}

/** Units at these sites, each with who lives there now. Vacant = nobody. */
export async function unitsAt(siteIds: string[], opts: { includeRetired?: boolean } = {}) {
  if (!siteIds.length) return [];
  const units = await prisma.unit.findMany({ where: { siteId: { in: siteIds }, ...(opts.includeRetired ? {} : { active: true }) } });
  const occupants = units.length
    ? await prisma.tenant.findMany({ where: { unitId: { in: units.map((u) => u.id) }, status: "active" }, select: OCCUPANT_SELECT })
    : [];
  const byUnit = new Map<string, OccupantRow[]>();
  for (const o of occupants) byUnit.set(o.unitId!, [...(byUnit.get(o.unitId!) ?? []), o]);
  return units
    .map((u) => unitOut(u, byUnit.get(u.id) ?? []))
    .sort((a, b) => a.siteId.localeCompare(b.siteId) || collator.compare(a.label, b.label));
}

export function unitOut(u: Unit, occupants: OccupantRow[]) {
  return {
    id: u.id,
    siteId: u.siteId,
    label: u.label,
    unitType: u.unitType,
    program: u.program,
    notes: u.notes,
    active: u.active,
    vacant: occupants.length === 0,
    vacantSince: occupants.length === 0 && u.vacantSince ? ymd(u.vacantSince) : null,
    occupants: occupantsOut(occupants),
  };
}

const unitLabel = (raw: unknown) => {
  if (typeof raw !== "string" || !raw.trim()) throw badRequest("Give the unit a number or name.");
  const label = raw.trim().replace(/\s+/g, " ");
  if (label.length > 40) throw badRequest("A unit's name can be at most 40 characters.");
  return label;
};

async function labelTaken(siteId: string, label: string, exceptId?: string) {
  // The database compares without case, like the unique index.
  const hit = await prisma.unit.findFirst({ where: { siteId, label, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
  return Boolean(hit);
}

export async function createUnit(ctx: Ctx, site: SiteRow, body: { label: unknown; unitType?: string | null; program?: string | null; notes?: string | null }) {
  const label = unitLabel(body.label);
  if (await labelTaken(site.id, label)) throw badRequest(`${site.name} already has a unit ${label}.`);
  const unit = await prisma.unit.create({ data: { siteId: site.id, label, unitType: body.unitType || null, program: body.program || null, notes: body.notes || null } });
  await audit({ actor: ctx.actor, action: "unit.created", siteId: site.id, summary: `Added unit ${label} at ${site.name}` });
  return unitOut(unit, []);
}

export async function updateUnit(ctx: Ctx, unit: Unit & { site: SiteRow }, body: { label?: unknown; unitType?: string | null; program?: string | null; notes?: string | null; active?: boolean }) {
  const data: Prisma.UnitUpdateInput = {};
  if (body.label !== undefined) {
    const label = unitLabel(body.label);
    if (label !== unit.label && (await labelTaken(unit.siteId, label, unit.id))) throw badRequest(`${unit.site.name} already has a unit ${label}.`);
    data.label = label;
  }
  if (body.unitType !== undefined) data.unitType = body.unitType || null;
  if (body.program !== undefined) data.program = body.program || null;
  if (body.notes !== undefined) data.notes = body.notes || null;
  if (body.active !== undefined && body.active !== unit.active) {
    if (!body.active && (await prisma.tenant.count({ where: { unitId: unit.id, status: "active" } }))) {
      throw badRequest(`Someone lives in ${unit.label}. Move them out or to another unit before retiring it.`);
    }
    data.active = body.active;
  }
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.unit.update({ where: { id: unit.id }, data });
    // Renamed: the people living there carry its new name.
    if (data.label) await tx.tenant.updateMany({ where: { unitId: unit.id, status: "active" }, data: { unit: data.label as string } });
    return u;
  }, CASE_TX);
  await audit({
    actor: ctx.actor,
    action: "unit.updated",
    siteId: unit.siteId,
    summary: body.active === false ? `Retired unit ${unit.label} at ${unit.site.name}` : body.active === true && !unit.active ? `Brought back unit ${unit.label} at ${unit.site.name}` : `Updated unit ${updated.label} at ${unit.site.name}`,
  });
  const occupants = await prisma.tenant.findMany({ where: { unitId: unit.id, status: "active" }, select: OCCUPANT_SELECT });
  return unitOut(updated, occupants);
}

/** Many units at once (a pasted list). Ones the site already has are skipped. */
export async function bulkUnits(ctx: Ctx, site: SiteRow, labels: unknown[], defaults: { unitType?: string | null; program?: string | null }) {
  const wanted = [...new Map(labels.map((l) => unitLabel(l)).map((l) => [l.toLowerCase(), l])).values()];
  if (wanted.length > 1000) throw badRequest("At most 1,000 units at a time.");
  const existing = new Set((await prisma.unit.findMany({ where: { siteId: site.id }, select: { label: true } })).map((u) => u.label.toLowerCase()));
  const fresh = wanted.filter((l) => !existing.has(l.toLowerCase()));
  if (fresh.length) {
    await prisma.unit.createMany({ data: fresh.map((label) => ({ siteId: site.id, label, unitType: defaults.unitType || null, program: defaults.program || null })) });
    await audit({ actor: ctx.actor, action: "unit.created", siteId: site.id, summary: `Added ${fresh.length} ${fresh.length === 1 ? "unit" : "units"} at ${site.name}` });
  }
  return { added: fresh.length, skipped: wanted.length - fresh.length };
}

/**
 * Set a site up from its roster: a unit for every unit number on it, and each
 * person there linked to theirs, with a stay from their move-in date and the
 * recurring checklist from the next one due. Safe to run again: it only adds
 * what's missing. At a household site, people sharing a unit become a household
 * (the earliest to move in is its head); their relations are left to fill in.
 */
export async function seedUnits(ctx: Ctx, site: SiteRow) {
  await assertResidency(site);
  const people = await prisma.tenant.findMany({ where: { siteId: site.id, status: "active", unitId: null, unit: { not: null } } });
  const withUnit = people.filter((p) => p.unit && p.unit.trim());
  const labels = [...new Map(withUnit.map((p) => [p.unit!.trim().toLowerCase(), p.unit!.trim()])).values()];
  const { added } = labels.length ? await bulkUnits(ctx, site, labels, {}) : { added: 0 };
  const units = await prisma.unit.findMany({ where: { siteId: site.id } });
  const unitBy = new Map(units.map((u) => [u.label.toLowerCase(), u]));
  const today = todayNY();
  let linked = 0;

  const groups = new Map<string, Tenant[]>();
  for (const p of withUnit) {
    const key = p.unit!.trim().toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  for (const [key, members] of groups) {
    const unit = unitBy.get(key);
    if (!unit) continue;
    // Someone may already be linked there (an earlier run, or a move-in since).
    const already = await prisma.tenant.findFirst({ where: { unitId: unit.id, status: "active" }, select: { id: true, householdHeadId: true } });
    members.sort((a, b) => (a.moveInDate?.getTime() ?? a.createdAt.getTime()) - (b.moveInDate?.getTime() ?? b.createdAt.getTime()));
    const head = site.households ? (already ? already.householdHeadId ?? already.id : members[0].id) : null;
    await prisma.$transaction(async (tx) => {
      for (const p of members) {
        const isHead = site.households && p.id === head;
        const moveIn = ymd(p.moveInDate ?? p.createdAt);
        const stay = await tx.stay.create({
          data: {
            tenantId: p.id, siteId: site.id, unitId: unit.id, unitLabel: unit.label, program: unit.program, moveInDate: day(moveIn),
            householdHeadId: site.households && !isHead ? head : null, householdRelation: site.households ? (isHead ? HEAD : null) : null,
            createdById: ctx.userId,
          },
        });
        await tx.tenant.update({
          where: { id: p.id },
          data: {
            unitId: unit.id, unit: unit.label, movedIn: true,
            householdHeadId: site.households && !isHead ? head : null,
            householdRelation: site.households ? (isHead ? HEAD : p.householdRelation) : null,
          },
        });
        await tasksForStay(tx, { tenantId: p.id, siteId: site.id, stayId: stay.id, moveIn, fresh: false, today });
        linked++;
      }
      await tx.unit.update({ where: { id: unit.id }, data: { vacantSince: null } });
    }, CASE_TX);
  }
  await audit({ actor: ctx.actor, action: "units.seeded", siteId: site.id, summary: `Set up units at ${site.name} from the roster: ${added} new ${added === 1 ? "unit" : "units"}, ${linked} ${linked === 1 ? "person" : "people"} linked` });
  return { unitsAdded: added, residentsLinked: linked, unitsTotal: units.length };
}

// ── Moving in ────────────────────────────────────────────────────────────

type Person = { tenantId: string; relation?: string | null };

async function loadUnit(id: string) {
  const unit = await prisma.unit.findUnique({ where: { id }, include: { site: { select: SITE_SELECT } } });
  if (!unit) throw new HttpError(404, "Unit not found.");
  return unit;
}

/** Who lives in a unit now, and its head. */
async function occupancy(unitId: string) {
  const rows = await prisma.tenant.findMany({ where: { unitId, status: "active" } });
  const head = rows.find((r) => !r.householdHeadId) ?? rows[0] ?? null;
  return { rows, head };
}

/**
 * Who goes where in a unit: one person in a vacant unit; at a household site,
 * the first person into a vacant unit is its head and everyone else needs their
 * relation to the head (joining a household that's already there included).
 */
function placements(site: SiteRow, unit: Unit, people: Person[], current: { rows: Tenant[]; head: Tenant | null }) {
  if (!people.length) throw badRequest("Pick who is moving in.");
  if (new Set(people.map((p) => p.tenantId)).size !== people.length) throw badRequest("Someone is listed twice.");
  if (!site.households) {
    if (people.length > 1) throw badRequest(`Units at ${site.name} hold one person. Mark ${site.name} as a household site (Admin → Sites) to move a household in together.`);
    if (current.rows.length) throw badRequest(`${displayName(current.rows[0])} lives in ${unit.label}. Move them out or to another unit first.`);
    return [{ tenantId: people[0].tenantId, headId: null as string | null, relation: null as string | null }];
  }
  const headId = current.head?.id ?? people[0].tenantId;
  return people.map((p) => {
    if (p.tenantId === headId) return { tenantId: p.tenantId, headId: null as string | null, relation: HEAD as string | null };
    const relation = p.relation ?? "";
    if (!MEMBER_RELATIONS.includes(relation)) throw badRequest("Say how each household member is related to the head of household.");
    return { tenantId: p.tenantId, headId, relation };
  });
}

/** Move people into a unit: their stays begin, the unit is taken, their checklist starts. */
export async function moveIn(ctx: Ctx, opts: { unitId: string; date: unknown; people: Person[]; program?: string | null; canAccessSite: (siteId: string) => boolean }) {
  const unit = await loadUnit(opts.unitId);
  await assertResidency(unit.site);
  if (!opts.canAccessSite(unit.siteId)) throw new HttpError(404, "Unit not found.");
  if (!unit.active) throw badRequest(`Unit ${unit.label} is retired. Bring it back on the Units page first.`);
  const date = moveDate(opts.date, "Move-in date");
  if (opts.program && !programs().some((p) => p.value === opts.program)) throw badRequest(`"${opts.program}" isn't a program.`);
  const tenants = await prisma.tenant.findMany({ where: { id: { in: opts.people.map((p) => p.tenantId) } } });
  const byId = new Map(tenants.map((t) => [t.id, t]));
  for (const p of opts.people) {
    const t = byId.get(p.tenantId);
    if (!t || t.siteId !== unit.siteId) throw badRequest(`Everyone moving in must be on ${unit.site.name}'s roster. Use Transfer for someone at another site.`);
    if (t.status !== "active") throw badRequest(`${displayName(t)} isn't on the roster. Restore them first.`);
    if (t.unitId) throw badRequest(`${displayName(t)} already lives in a unit. Use Transfer to move them.`);
  }
  const current = await occupancy(unit.id);
  const plan = placements(unit.site, unit, opts.people, current);
  const program = opts.program || unit.program || null;

  await prisma.$transaction(async (tx) => {
    for (const p of plan) {
      const t = byId.get(p.tenantId)!;
      const stay = await tx.stay.create({
        data: {
          tenantId: t.id, siteId: unit.siteId, unitId: unit.id, unitLabel: unit.label, program, moveInDate: day(date),
          householdHeadId: p.headId, householdRelation: p.relation, createdById: ctx.userId,
        },
      });
      await tx.tenant.update({
        where: { id: t.id },
        data: {
          unitId: unit.id, unit: unit.label, movedIn: true, moveInDate: day(date), householdHeadId: p.headId, householdRelation: p.relation,
          ...(isOnHold(t) && !t.awaySince ? { attentionClockAt: clockAfterHold() } : {}),
          version: { increment: 1 },
        },
      });
      await tasksForStay(tx, { tenantId: t.id, siteId: unit.siteId, stayId: stay.id, moveIn: date, fresh: true });
    }
    await tx.unit.update({ where: { id: unit.id }, data: { vacantSince: null } });
  }, CASE_TX);

  const names = plan.map((p) => displayName(byId.get(p.tenantId)!));
  for (const p of plan) {
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: p.tenantId }, include: { site: { select: { code: true } } } });
    await audit({
      actor: ctx.actor,
      action: "tenant.moved_in",
      tenantId: t.id,
      siteId: unit.siteId,
      summary: `Moved ${displayName(t)} into unit ${unit.label} at ${unit.site.name} on ${date}${p.relation && p.relation !== HEAD ? ` (${p.relation.replace(/^Head of household's /, "")})` : ""}`,
      changes: { unit: unit.label, moveInDate: date, program, relation: p.relation },
      webhook: { event: "tenant.updated", data: { ...publicTenant(t), changed: ["unit", "moveInDate"] } },
    });
  }
  notifyQuietly({
    to: { roles: ["site_manager"], sites: [unit.siteId] },
    type: "residents.moves",
    title: `${names.join(", ")} moved into ${unit.label} at ${unit.site.name}`,
    link: `/tenants/${plan[0].tenantId}`,
    source: "residency",
    sourceLabel: "Move-in",
    onlySiteId: unit.siteId,
    exclude: ctx.userId ? [ctx.userId] : [],
  });
  return { moved: plan.length };
}

// ── Transfers ────────────────────────────────────────────────────────────

/**
 * Move people who live in a unit to another one — in the same building or another
 * site (an internal transfer). Their stay ends as "transferred" and a new one
 * begins; they stay on the roster, with their checklist. A head of household
 * moves with their household, or someone else is made head first.
 */
export async function transfer(ctx: Ctx, opts: { tenantIds: string[]; toUnitId: string; date: unknown; reason?: string | null; relations?: Record<string, string>; canAccessSite: (siteId: string) => boolean }) {
  const unit = await loadUnit(opts.toUnitId);
  await assertResidency(unit.site);
  if (!opts.canAccessSite(unit.siteId)) throw new HttpError(404, "Unit not found.");
  if (!unit.active) throw badRequest(`Unit ${unit.label} is retired.`);
  const date = moveDate(opts.date, "Transfer date");
  const tenants = await prisma.tenant.findMany({ where: { id: { in: opts.tenantIds } }, include: { site: { select: SITE_SELECT } } });
  if (tenants.length !== opts.tenantIds.length) throw badRequest("Someone moving isn't on the roster.");
  for (const t of tenants) {
    if (t.status !== "active" || !t.unitId) throw badRequest(`${displayName(t)} doesn't live in a unit now. Use Move in instead.`);
    if (t.unitId === unit.id) throw badRequest(`${displayName(t)} already lives in ${unit.label}.`);
    if (!opts.canAccessSite(t.siteId)) throw new HttpError(404, "Resident not found.");
  }
  // A head leaving behind members who aren't moving too.
  for (const t of tenants.filter((x) => !x.householdHeadId)) {
    const left = await prisma.tenant.count({ where: { householdHeadId: t.id, status: "active", id: { notIn: opts.tenantIds } } });
    if (left) throw badRequest(`${displayName(t)} is head of a household that isn't moving with them. Move the whole household, or make someone else head first.`);
  }
  const current = await occupancy(unit.id);
  // The household's own head goes first, so a household moving together keeps its head.
  const ordered = [...tenants].sort((a, b) => Number(Boolean(a.householdHeadId)) - Number(Boolean(b.householdHeadId)));
  const plan = placements(
    unit.site,
    unit,
    ordered.map((t) => ({ tenantId: t.id, relation: opts.relations?.[t.id] ?? (t.householdHeadId ? t.householdRelation : null) })),
    current
  );
  const fromUnits = [...new Set(tenants.map((t) => t.unitId!))];

  await prisma.$transaction(async (tx) => {
    for (const p of plan) {
      const t = tenants.find((x) => x.id === p.tenantId)!;
      await tx.stay.updateMany({
        where: { tenantId: t.id, moveOutDate: null, endKind: null },
        data: { moveOutDate: day(date), endKind: "transferred", endReason: opts.reason || INTERNAL_TRANSFER, endedById: ctx.userId },
      });
      const prior = await tx.stay.findFirst({ where: { tenantId: t.id }, orderBy: { moveInDate: "desc" }, select: { program: true } });
      await tx.stay.create({
        data: {
          tenantId: t.id, siteId: unit.siteId, unitId: unit.id, unitLabel: unit.label, program: unit.program ?? prior?.program ?? null,
          startKind: "transferred", moveInDate: day(date), householdHeadId: p.headId, householdRelation: p.relation, createdById: ctx.userId,
        },
      });
      await tx.tenant.update({
        where: { id: t.id },
        data: { siteId: unit.siteId, unitId: unit.id, unit: unit.label, householdHeadId: p.headId, householdRelation: p.relation, version: { increment: 1 } },
      });
      if (t.siteId !== unit.siteId) await tx.tenantTask.updateMany({ where: { tenantId: t.id, status: "open" }, data: { siteId: unit.siteId } });
    }
    await tx.unit.update({ where: { id: unit.id }, data: { vacantSince: null } });
    for (const u of fromUnits) {
      if (!(await tx.tenant.count({ where: { unitId: u, status: "active" } }))) await tx.unit.update({ where: { id: u }, data: { vacantSince: day(date) } });
    }
  }, CASE_TX);
  for (const t of tenants) {
    const after = await prisma.tenant.findUniqueOrThrow({ where: { id: t.id }, include: { site: { select: { code: true } } } });
    await audit({
      actor: ctx.actor,
      action: "tenant.transferred",
      tenantId: t.id,
      siteId: unit.siteId,
      summary: `Moved ${displayName(t)} from ${t.site.name} ${t.unit ?? ""} to ${unit.site.name} ${unit.label} on ${date}`.replace(/\s+/g, " "),
      changes: { from: { site: t.site.name, unit: t.unit }, to: { site: unit.site.name, unit: unit.label }, date, reason: opts.reason || null },
      webhook: { event: "tenant.updated", data: { ...publicTenant(after), changed: t.siteId !== unit.siteId ? ["site", "unit"] : ["unit"] } },
    });
  }
  return { moved: plan.length };
}

// ── Moving out ───────────────────────────────────────────────────────────

const forwardingSchema = (raw: unknown) => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw badRequest("Forwarding address: expected an address.");
  const a = raw as Record<string, unknown>;
  const s = (k: string, max: number) => (typeof a[k] === "string" && (a[k] as string).trim() ? (a[k] as string).trim().slice(0, max) : undefined);
  const out = { line1: s("line1", 200), line2: s("line2", 200), city: s("city", 100), state: s("state", 40), zip: s("zip", 20) };
  if (out.state && !(US_STATES as readonly string[]).includes(out.state)) throw badRequest("Forwarding address: pick a state from the list.");
  return Object.values(out).some(Boolean) ? JSON.stringify(out) : null;
};

/**
 * Move people out: their stay ends, they leave the roster (Removed, with the
 * reason), the unit empties if nobody's left, anything away is closed, open
 * checklist items are cancelled and the HMIS exit assessment is due. A head
 * leaving members behind names the new head.
 */
export async function moveOut(
  ctx: Ctx,
  opts: {
    tenantIds: string[];
    date: unknown;
    reason: unknown;
    destination?: unknown;
    forwardingAddress?: unknown;
    note?: unknown;
    newHeadId?: string | null;
    canAccessSite: (siteId: string) => boolean;
  }
) {
  const date = moveDate(opts.date, "Move-out date");
  const reason = typeof opts.reason === "string" ? opts.reason : "";
  if (reason === INTERNAL_TRANSFER) throw badRequest("An internal transfer moves them to another unit: use Transfer.");
  if (!LEAVING_REASONS.includes(reason)) throw badRequest("Pick why they're moving out.");
  const destination = typeof opts.destination === "string" && opts.destination ? opts.destination : null;
  if (destination && !(EXIT_DESTINATIONS as readonly string[]).includes(destination)) throw badRequest("Pick where they went from the list.");
  const forwarding = forwardingSchema(opts.forwardingAddress);
  const note = typeof opts.note === "string" && opts.note.trim() ? opts.note.trim().slice(0, 2000) : null;

  const tenants = await prisma.tenant.findMany({ where: { id: { in: opts.tenantIds } }, include: { site: { select: SITE_SELECT } } });
  if (!tenants.length || tenants.length !== opts.tenantIds.length) throw badRequest("Pick who is moving out.");
  for (const t of tenants) {
    if (!opts.canAccessSite(t.siteId)) throw new HttpError(404, "Resident not found.");
    if (t.status !== "active") throw badRequest(`${displayName(t)} isn't on the roster.`);
    await assertResidency(t.site);
  }
  // A head leaving members behind: someone takes over.
  const heads = tenants.filter((t) => t.unitId && !t.householdHeadId);
  let promote: { newHead: Tenant; members: Tenant[] } | null = null;
  for (const h of heads) {
    const staying = await prisma.tenant.findMany({ where: { householdHeadId: h.id, status: "active", id: { notIn: opts.tenantIds } } });
    if (!staying.length) continue;
    const newHead = staying.find((s) => s.id === opts.newHeadId);
    if (!newHead) throw badRequest(`${displayName(h)} is head of a household that's staying. Choose who becomes head of household.`);
    promote = { newHead, members: staying.filter((s) => s.id !== newHead.id) };
  }
  const units = [...new Set(tenants.map((t) => t.unitId).filter((u): u is string => Boolean(u)))];
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    for (const t of tenants) {
      const open = await tx.stay.findFirst({ where: { tenantId: t.id, moveOutDate: null, endKind: null }, orderBy: { moveInDate: "desc" } });
      const end = { moveOutDate: day(date), endKind: "moved_out", endReason: reason, exitDestination: destination, forwardingAddress: forwarding, endNote: note, endedById: ctx.userId };
      let stayId: string | null = open?.id ?? null;
      if (open) await tx.stay.update({ where: { id: open.id }, data: end });
      else if (t.movedIn) {
        // Lived here before units: keep the stay on record anyway.
        const made = await tx.stay.create({
          data: { tenantId: t.id, siteId: t.siteId, unitId: t.unitId, unitLabel: t.unit, moveInDate: t.moveInDate ?? t.createdAt, createdById: ctx.userId, ...end },
        });
        stayId = made.id;
      }
      await tx.tenant.update({
        where: { id: t.id },
        data: {
          status: "archived", archivedAt: now, archivedById: ctx.userId, archiveReason: `Moved out — ${reason}`, moveOutDate: day(date),
          unitId: null, householdHeadId: null, awaySince: null, awayReason: null, version: { increment: 1 },
        },
      });
      await tx.tenantAbsence.updateMany({ where: { tenantId: t.id, outcome: null }, data: { outcome: "moved_out", endedById: ctx.userId } });
      await cancelOpenTasks(tx, t.id);
      if (t.movedIn) await addExitTask(tx, { tenantId: t.id, siteId: t.siteId, stayId, moveOut: date });
    }
    if (promote) {
      await tx.tenant.update({ where: { id: promote.newHead.id }, data: { householdHeadId: null, householdRelation: HEAD, version: { increment: 1 } } });
      await tx.tenant.updateMany({ where: { id: { in: promote.members.map((m) => m.id) } }, data: { householdHeadId: promote.newHead.id } });
    }
    for (const u of units) {
      if (!(await tx.tenant.count({ where: { unitId: u, status: "active" } }))) await tx.unit.update({ where: { id: u }, data: { vacantSince: day(date) } });
    }
  }, CASE_TX);

  for (const t of tenants) {
    const after = await prisma.tenant.findUniqueOrThrow({ where: { id: t.id }, include: { site: { select: { code: true } } } });
    await audit({
      actor: ctx.actor,
      action: "tenant.moved_out",
      tenantId: t.id,
      siteId: t.siteId,
      summary: `Moved ${displayName(t)} out of ${t.unit ? `unit ${t.unit} at ` : ""}${t.site.name} on ${date} — ${reason}`,
      changes: { date, reason, destination, unit: t.unit },
      webhook: { event: "tenant.archived", data: { ...publicTenant(after), reason: "Moved out" } },
    });
  }
  if (promote) {
    await audit({
      actor: ctx.actor,
      action: "tenant.household_head",
      tenantId: promote.newHead.id,
      siteId: promote.newHead.siteId,
      summary: `${displayName(promote.newHead)} is now head of household`,
    });
  }
  notifyQuietly({
    to: { roles: ["site_manager"], sites: [tenants[0].siteId] },
    type: "residents.moves",
    title: `${tenants.map((t) => displayName(t)).join(", ")} moved out of ${tenants[0].site.name}`,
    body: reason,
    link: `/tenants/${tenants[0].id}`,
    source: "residency",
    sourceLabel: "Move-out",
    onlySiteId: tenants[0].siteId,
    exclude: ctx.userId ? [ctx.userId] : [],
  });
  return { movedOut: tenants.length };
}

/**
 * Removed from the roster through Remove (a duplicate, a mistake): their stay ends
 * as "removed", the unit frees up, open checklist items are cancelled, and a head
 * leaving a household behind hands it to a spouse or partner (else anyone).
 */
export async function releaseForRemoval(ctx: Ctx, t: Tenant, reason: string) {
  const site = await prisma.site.findUnique({ where: { id: t.siteId }, select: SITE_SELECT });
  if (!site || !(await residencyOnFor(site))) return;
  const date = todayNY();
  await prisma.$transaction(async (tx) => {
    await tx.stay.updateMany({ where: { tenantId: t.id, moveOutDate: null, endKind: null }, data: { moveOutDate: day(date), endKind: "removed", endReason: reason, endedById: ctx.userId } });
    await tx.tenantAbsence.updateMany({ where: { tenantId: t.id, outcome: null }, data: { outcome: "moved_out", endedById: ctx.userId } });
    await cancelOpenTasks(tx, t.id);
    if (!t.householdHeadId) {
      const staying = await tx.tenant.findMany({ where: { householdHeadId: t.id, status: "active" } });
      if (staying.length) {
        const next = staying.find((s) => s.householdRelation === "Head of household's spouse or partner") ?? staying[0];
        await tx.tenant.update({ where: { id: next.id }, data: { householdHeadId: null, householdRelation: HEAD } });
        await tx.tenant.updateMany({ where: { id: { in: staying.filter((s) => s.id !== next.id).map((s) => s.id) } }, data: { householdHeadId: next.id } });
      }
    }
    await tx.tenant.update({ where: { id: t.id }, data: { unitId: null, householdHeadId: null, awaySince: null, awayReason: null } });
    if (t.unitId && !(await tx.tenant.count({ where: { unitId: t.unitId, status: "active" } }))) {
      await tx.unit.update({ where: { id: t.unitId }, data: { vacantSince: day(date) } });
    }
  }, CASE_TX);
}

/**
 * Back on the roster (Restore). Undoing one's own removal or move-out within ten
 * minutes puts them back in their unit if nothing else changed there: it's still
 * empty, or (household sites) the household they left is still there as it was.
 * A head comes back as head. Anything else brings them back as not moved in:
 * they need a move-in.
 */
export async function afterRestore(ctx: Ctx, t: Tenant, undo: boolean) {
  const site = await prisma.site.findUnique({ where: { id: t.siteId }, select: SITE_SELECT });
  if (!site || !(await residencyOnFor(site))) return;
  const last = await prisma.stay.findFirst({ where: { tenantId: t.id }, orderBy: { updatedAt: "desc" } });
  const recent = last && last.endKind && last.endedById === ctx.userId && Date.now() - last.updatedAt.getTime() < 10 * 60_000;
  // Everyone in the unit now, with the household their current stay started in
  // (a stay keeps its head and relation when someone else is made head).
  const others = last?.unitId
    ? await prisma.tenant.findMany({
        where: { unitId: last.unitId, status: "active", id: { not: t.id } },
        select: { id: true, householdHeadId: true, householdRelation: true, stays: { where: { moveOutDate: null, endKind: null }, select: { householdHeadId: true, householdRelation: true }, take: 1 } },
      })
    : [];
  const wasHead = !last?.householdHeadId;
  const rejoin =
    Boolean(site.households && last && others.length) &&
    (wasHead
      ? others.every((o) => o.stays[0]?.householdHeadId === t.id)
      : others.some((o) => o.id === last!.householdHeadId && !o.householdHeadId));
  const unit = last?.unitId ? await prisma.unit.findUnique({ where: { id: last.unitId } }) : null;
  if (undo && recent && last && unit?.active && (others.length === 0 || rejoin)) {
    await prisma.$transaction(async (tx) => {
      await tx.stay.update({ where: { id: last.id }, data: { moveOutDate: null, endKind: null, endReason: null, exitDestination: null, forwardingAddress: null, endNote: null, endedById: null } });
      await tx.tenant.update({ where: { id: t.id }, data: { unitId: unit.id, unit: unit.label, movedIn: true, householdHeadId: last.householdHeadId, householdRelation: last.householdRelation } });
      // A head back at the head of the household they left: the others go back
      // to being their members, with the relation they moved in with.
      if (rejoin && wasHead) {
        for (const o of others) {
          await tx.tenant.update({
            where: { id: o.id },
            data: { householdHeadId: t.id, householdRelation: o.stays[0]?.householdRelation ?? o.householdRelation, version: { increment: 1 } },
          });
        }
      }
      await tx.unit.update({ where: { id: unit.id }, data: { vacantSince: null } });
      await tx.tenantTask.deleteMany({ where: { tenantId: t.id, key: "hmis_project_exit", status: "open", stayId: last.id } });
      await tx.tenantTask.updateMany({ where: { tenantId: t.id, status: "cancelled", updatedAt: { gte: new Date(last.updatedAt.getTime() - 60_000) } }, data: { status: "open" } });
    }, CASE_TX);
    return;
  }
  await prisma.tenant.update({
    where: { id: t.id },
    data: { movedIn: false, unitId: null, unit: null, householdHeadId: null, householdRelation: null, awaySince: null, awayReason: null, attentionClockAt: HOLD_CLOCK },
  });
}

// ── Away ─────────────────────────────────────────────────────────────────

export async function markAway(ctx: Ctx, t: Tenant & { site: SiteRow }, body: { lastSeen: unknown; reason: unknown; detail?: unknown; expectedReturn?: unknown }) {
  await assertResidency(t.site);
  if (t.status !== "active" || !t.movedIn) throw badRequest(`${displayName(t)} isn't living here now.`);
  if (t.awaySince) throw badRequest(`${displayName(t)} is already marked away.`);
  const lastSeen = moveDate(body.lastSeen, "Last seen");
  const reason = typeof body.reason === "string" ? body.reason : "";
  if (!(AWAY_REASONS as readonly string[]).includes(reason)) throw badRequest("Pick why they're away.");
  const detail = typeof body.detail === "string" && body.detail.trim() ? body.detail.trim().slice(0, 1000) : null;
  if (reason === "Other" && !detail) throw badRequest("Say where they are.");
  let expectedReturn: string | null = null;
  if (typeof body.expectedReturn === "string" && body.expectedReturn) {
    if (!DATE_RE.test(body.expectedReturn) || body.expectedReturn < lastSeen) throw badRequest("Expected back: pick a day after they were last seen.");
    expectedReturn = body.expectedReturn;
  }
  await prisma.$transaction([
    prisma.tenantAbsence.create({
      data: { tenantId: t.id, siteId: t.siteId, lastSeen: day(lastSeen), reason, detail, expectedReturn: expectedReturn ? day(expectedReturn) : null, createdById: ctx.userId },
    }),
    prisma.tenant.update({ where: { id: t.id }, data: { awaySince: day(lastSeen), awayReason: reason, attentionClockAt: HOLD_CLOCK } }),
  ]);
  await audit({
    actor: ctx.actor,
    action: "tenant.away",
    tenantId: t.id,
    siteId: t.siteId,
    summary: `Marked ${displayName(t)} away since ${lastSeen} — ${reason}`,
    changes: { lastSeen, reason, expectedReturn },
  });
}

export async function markReturned(ctx: Ctx, t: Tenant & { site: SiteRow }, body: { date: unknown }) {
  await assertResidency(t.site);
  if (!t.awaySince) throw badRequest(`${displayName(t)} isn't marked away.`);
  const date = moveDate(body.date, "Back on");
  if (date < ymd(t.awaySince)) throw badRequest("Back on: pick a day after they were last seen.");
  await prisma.$transaction([
    prisma.tenantAbsence.updateMany({ where: { tenantId: t.id, outcome: null }, data: { returnedOn: day(date), outcome: "returned", endedById: ctx.userId } }),
    prisma.tenant.update({ where: { id: t.id }, data: { awaySince: null, awayReason: null, attentionClockAt: clockAfterHold() } }),
  ]);
  await audit({ actor: ctx.actor, action: "tenant.returned", tenantId: t.id, siteId: t.siteId, summary: `${displayName(t)} is back (${date})` });
}

// ── Households ───────────────────────────────────────────────────────────

/** Change a member's relation to their head of household. */
export async function setRelation(ctx: Ctx, t: Tenant, relation: unknown) {
  if (!t.householdHeadId) throw badRequest(`${displayName(t)} is the head of household.`);
  if (typeof relation !== "string" || !MEMBER_RELATIONS.includes(relation)) throw badRequest("Pick how they're related to the head of household.");
  await prisma.$transaction([
    prisma.tenant.update({ where: { id: t.id }, data: { householdRelation: relation, version: { increment: 1 } } }),
    prisma.stay.updateMany({ where: { tenantId: t.id, moveOutDate: null, endKind: null }, data: { householdRelation: relation } }),
  ]);
  await audit({ actor: ctx.actor, action: "tenant.household", tenantId: t.id, siteId: t.siteId, summary: `${displayName(t)}: ${relation}` });
}

/** Make a member head of household; the old head becomes a member, with the relation given. */
export async function makeHead(ctx: Ctx, t: Tenant, formerHeadRelation: unknown) {
  if (!t.householdHeadId) throw badRequest(`${displayName(t)} is already the head of household.`);
  if (typeof formerHeadRelation !== "string" || !MEMBER_RELATIONS.includes(formerHeadRelation)) throw badRequest("Say how the current head is related to the new one.");
  const oldHead = await prisma.tenant.findUnique({ where: { id: t.householdHeadId } });
  const members = await prisma.tenant.findMany({ where: { householdHeadId: t.householdHeadId, status: "active", id: { not: t.id } } });
  await prisma.$transaction(async (tx) => {
    await tx.tenant.update({ where: { id: t.id }, data: { householdHeadId: null, householdRelation: HEAD, version: { increment: 1 } } });
    if (oldHead) await tx.tenant.update({ where: { id: oldHead.id }, data: { householdHeadId: t.id, householdRelation: formerHeadRelation, version: { increment: 1 } } });
    if (members.length) await tx.tenant.updateMany({ where: { id: { in: members.map((m) => m.id) } }, data: { householdHeadId: t.id } });
  }, CASE_TX);
  await audit({ actor: ctx.actor, action: "tenant.household_head", tenantId: t.id, siteId: t.siteId, summary: `${displayName(t)} is now head of household${oldHead ? ` (was ${displayName(oldHead)})` : ""}` });
}

// ── One resident ─────────────────────────────────────────────────────────

const stayOut = (s: Stay & { unit?: Unit | null }) => ({
  id: s.id,
  siteId: s.siteId,
  unitId: s.unitId,
  unitLabel: s.unitLabel,
  program: s.program,
  startKind: s.startKind,
  moveInDate: ymd(s.moveInDate),
  moveOutDate: s.moveOutDate ? ymd(s.moveOutDate) : null,
  endKind: s.endKind,
  endReason: s.endReason,
  exitDestination: s.exitDestination,
  forwardingAddress: s.forwardingAddress ? (JSON.parse(s.forwardingAddress) as Record<string, string>) : null,
  endNote: s.endNote,
  householdRelation: s.householdRelation,
  days: Math.max(0, Math.round(((s.moveOutDate ?? day(todayNY())).getTime() - s.moveInDate.getTime()) / 86_400_000)),
});

const absenceOut = (a: TenantAbsence) => ({
  id: a.id,
  lastSeen: ymd(a.lastSeen),
  reason: a.reason,
  detail: a.detail,
  expectedReturn: a.expectedReturn ? ymd(a.expectedReturn) : null,
  returnedOn: a.returnedOn ? ymd(a.returnedOn) : null,
  outcome: a.outcome,
  days: Math.max(0, Math.round(((a.returnedOn ?? day(todayNY())).getTime() - a.lastSeen.getTime()) / 86_400_000)),
});

/** Their unit, household, stays, time away and checklist — the resident page's Home and Checklist cards. */
export async function residencyView(t: Tenant & { site: SiteRow }) {
  const on = await residencyOnFor(t.site);
  if (!on) return { on: false as const };
  const headId = t.householdHeadId ?? (t.unitId ? t.id : null);
  const [unit, stays, absences, household, sitesById] = await Promise.all([
    t.unitId ? prisma.unit.findUnique({ where: { id: t.unitId } }) : null,
    prisma.stay.findMany({ where: { tenantId: t.id }, orderBy: { moveInDate: "desc" }, take: 20 }),
    prisma.tenantAbsence.findMany({ where: { tenantId: t.id }, orderBy: { lastSeen: "desc" }, take: 10 }),
    headId && t.site.households ? prisma.tenant.findMany({ where: { OR: [{ id: headId }, { householdHeadId: headId }], status: "active" }, select: OCCUPANT_SELECT }) : [],
    prisma.site.findMany({ select: { id: true, name: true } }).then((rows) => new Map(rows.map((r) => [r.id, r.name]))),
  ]);
  const away = absences.find((a) => !a.outcome) ?? null;
  return {
    on: true as const,
    households: t.site.households,
    movedIn: t.movedIn,
    unit: unit ? { id: unit.id, label: unit.label, unitType: unit.unitType, program: unit.program } : null,
    household: household.length > 1 || t.householdHeadId ? occupantsOut(household) : [],
    away: away ? absenceOut(away) : null,
    stays: stays.map((s) => ({ ...stayOut(s), siteName: sitesById.get(s.siteId) ?? "" })),
    absences: absences.map(absenceOut),
  };
}

// ── Reports ──────────────────────────────────────────────────────────────

/**
 * Move-ins, move-outs and vacancies at some sites between two days: by month,
 * by reason and destination, length of stay, units empty now, people waiting to
 * move in, and how much of the checklist was done on time.
 */
export async function residencyReport(sites: { id: string; name: string }[], from: string, to: string) {
  const ids = sites.map((s) => s.id);
  const range = { gte: day(from), lte: day(to) };
  const [ins, outs, units, waiting, away, tasks] = await Promise.all([
    prisma.stay.findMany({ where: { siteId: { in: ids }, moveInDate: range }, select: { siteId: true, moveInDate: true, startKind: true } }),
    prisma.stay.findMany({
      where: { siteId: { in: ids }, moveOutDate: range, endKind: { in: ["moved_out", "transferred"] } },
      select: { siteId: true, moveInDate: true, moveOutDate: true, endKind: true, endReason: true, exitDestination: true },
    }),
    unitsAt(ids),
    prisma.tenant.groupBy({ by: ["siteId"], where: { siteId: { in: ids }, status: "active", movedIn: false }, _count: { _all: true } }),
    prisma.tenant.groupBy({ by: ["siteId"], where: { siteId: { in: ids }, status: "active", awaySince: { not: null } }, _count: { _all: true } }),
    prisma.tenantTask.findMany({ where: { siteId: { in: ids }, dueOn: range, status: { not: "cancelled" } }, select: { siteId: true, key: true, label: true, dueOn: true, status: true, doneOn: true } }),
  ]);
  const name = new Map(sites.map((s) => [s.id, s.name]));
  const month = (d: Date) => ymd(d).slice(0, 7);
  const count = <T,>(rows: T[], key: (r: T) => string | null) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = key(r);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label, n]) => ({ label, count: n }));
  };
  const months = new Map<string, { moveIns: number; transfersIn: number; moveOuts: number; transfersOut: number }>();
  const bump = (k: string, f: "moveIns" | "transfersIn" | "moveOuts" | "transfersOut") => {
    const m = months.get(k) ?? { moveIns: 0, transfersIn: 0, moveOuts: 0, transfersOut: 0 };
    m[f]++;
    months.set(k, m);
  };
  for (const s of ins) bump(month(s.moveInDate), s.startKind === "transferred" ? "transfersIn" : "moveIns");
  for (const s of outs) bump(month(s.moveOutDate!), s.endKind === "transferred" ? "transfersOut" : "moveOuts");
  const movedOut = outs.filter((s) => s.endKind === "moved_out");
  const lengths = movedOut.map((s) => (s.moveOutDate!.getTime() - s.moveInDate.getTime()) / 86_400_000).sort((a, b) => a - b);
  const today = day(todayNY());
  const vacant = units.filter((u) => u.vacant);
  const due = tasks.filter((t) => t.dueOn <= today);
  const onTime = due.filter((t) => t.status === "done" && t.doneOn && t.doneOn <= t.dueOn).length;
  const late = due.filter((t) => t.status === "done" && t.doneOn && t.doneOn > t.dueOn).length;
  const missing = due.filter((t) => t.status === "open").length;
  const skipped = due.filter((t) => t.status === "skipped").length;
  const bySite = sites.map((s) => {
    const su = units.filter((u) => u.siteId === s.id);
    return {
      siteId: s.id,
      siteName: s.name,
      units: su.length,
      vacant: su.filter((u) => u.vacant).length,
      moveIns: ins.filter((x) => x.siteId === s.id && x.startKind !== "transferred").length,
      moveOuts: movedOut.filter((x) => x.siteId === s.id).length,
      waiting: waiting.find((w) => w.siteId === s.id)?._count._all ?? 0,
      away: away.find((w) => w.siteId === s.id)?._count._all ?? 0,
    };
  });
  return {
    from,
    to,
    months: [...months.entries()].sort().map(([m, v]) => ({ month: m, ...v })),
    bySite,
    reasons: count(movedOut, (s) => s.endReason),
    destinations: count(movedOut, (s) => s.exitDestination ?? "Not recorded"),
    lengthOfStay: lengths.length
      ? { count: lengths.length, medianDays: Math.round(lengths[Math.floor(lengths.length / 2)]), averageDays: Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) }
      : { count: 0, medianDays: null, averageDays: null },
    vacancies: vacant
      .map((u) => ({ unitId: u.id, siteName: name.get(u.siteId) ?? "", label: u.label, unitType: u.unitType, vacantSince: u.vacantSince, days: u.vacantSince ? Math.round((today.getTime() - day(u.vacantSince).getTime()) / 86_400_000) : null }))
      .sort((a, b) => (b.days ?? -1) - (a.days ?? -1)),
    checklist: {
      due: due.length,
      onTime,
      late,
      missing,
      skipped,
      byTask: SCHEDULE.map((s) => {
        const d = due.filter((t) => t.key === s.key);
        return { key: s.key, label: s.label, due: d.length, onTime: d.filter((t) => t.status === "done" && t.doneOn && t.doneOn <= t.dueOn).length, missing: d.filter((t) => t.status === "open").length };
      }).filter((r) => r.due > 0),
    },
  };
}
