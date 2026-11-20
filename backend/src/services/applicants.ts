import type { Applicant, ApplicantStep, Prisma, Site } from "@prisma/client";
import { prisma } from "../prisma.js";
import { badRequest, HttpError } from "../http.js";
import { audit, diff, type Actor } from "./audit.js";
import { clientField, ClientFieldError, parseClientValue, programs } from "./clientFields.js";
import { ageOn, fieldWords, saveProfile } from "./clientProfile.js";
import { displayName, type TenantDTO } from "./roster.js";
import { moveDate } from "./residency.js";
import { addDays, day, todayNY, ymd } from "./checklist.js";

/**
 * Applicants (case management): people referred for a unit at a supportive
 * site, from the referral to the day they're accepted — PlanStreet's Applicants
 * tab and its intake form's Applicant section. Each is at one stage; every move
 * is kept as a step (stage, day, note, who). Accepting puts them on the roster
 * as not moved in yet, through the same route as Add resident, and starts their
 * client information from what the referral said; moving in is then the
 * residency move-in. The routes (routes/applicants.ts) check the switch, the
 * permission and the site.
 */

// ── Stages ───────────────────────────────────────────────────────────────

export const OPEN_STAGES = ["referred", "eligibility_review", "eligible", "viewing_scheduled"] as const;
export const CLOSED_STAGES = ["ineligible", "rejected", "declined", "withdrawn"] as const;
export const STAGES = [...OPEN_STAGES, "accepted", ...CLOSED_STAGES] as const;
/** The stages a move can go to: accepting is its own step (acceptApplicant). */
export const MOVE_STAGES = [...OPEN_STAGES, ...CLOSED_STAGES] as const;

export type OpenStage = (typeof OPEN_STAGES)[number];
export type ClosedStage = (typeof CLOSED_STAGES)[number];
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  referred: "Referred",
  eligibility_review: "Eligibility review",
  eligible: "Eligible",
  viewing_scheduled: "Viewing scheduled",
  accepted: "Accepted",
  ineligible: "Ineligible",
  rejected: "Rejected",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

const STAGE_HINTS: Record<Stage, string> = {
  referred: "A referral came in.",
  eligibility_review: "Checking their documents and eligibility.",
  eligible: "Eligible for the program.",
  viewing_scheduled: "Seeing the unit on a set day.",
  accepted: "On the roster, waiting to move in.",
  ineligible: "Doesn't meet the program's criteria.",
  rejected: "We turned the application down.",
  declined: "They turned the unit down.",
  withdrawn: "They stopped the application.",
};

/** Accepting needs them found eligible first (a viewing is optional). */
export const ACCEPT_FROM: readonly Stage[] = ["eligible", "viewing_scheduled"];

const OTHER = "Other";
/** PlanStreet's reasons (the intake form's, as client information lists them), and Other. */
const reasonsFrom = (key: string) => [...(clientField(key)?.options ?? []), OTHER];
export const CLOSE_REASONS: Record<ClosedStage, readonly string[]> = {
  ineligible: reasonsFrom("ineligibleReason"),
  rejected: reasonsFrom("rejectedReason"),
  declined: reasonsFrom("declinedReason"),
  withdrawn: ["Found other housing", "No longer interested", "Moved away", OTHER],
};

const isOpen = (s: string): s is OpenStage => (OPEN_STAGES as readonly string[]).includes(s);
const isClosed = (s: string): s is ClosedStage => (CLOSED_STAGES as readonly string[]).includes(s);
export const isStage = (s: unknown): s is Stage => typeof s === "string" && (STAGES as readonly string[]).includes(s);

export function applicantMeta() {
  return {
    stages: STAGES.map((key) => ({ key, label: STAGE_LABELS[key], hint: STAGE_HINTS[key], group: isOpen(key) ? "open" : key === "accepted" ? "accepted" : "closed" })),
    closeReasons: CLOSE_REASONS,
    acceptFrom: ACCEPT_FROM,
    referralSources: clientField("referralSource")?.options ?? [],
    programs: programs(),
  };
}

// ── Details ──────────────────────────────────────────────────────────────

type Ctx = { actor: Actor; userId: string | null; byName: string };
type SiteRow = Pick<Site, "id" | "code" | "name">;
type WithSteps = Applicant & { steps: ApplicantStep[] };

const conflict = () => new HttpError(409, "Someone else changed this applicant while you were working on it. Reload and try again.");

/** The fields people fill in, as the API takes them. */
export interface ApplicantDetails {
  firstName?: unknown;
  middleName?: unknown;
  lastName?: unknown;
  preferredName?: unknown;
  dateOfBirth?: unknown;
  phone?: unknown;
  email?: unknown;
  program?: unknown;
  referralSource?: unknown;
  referralAgency?: unknown;
  referralDate?: unknown;
  eligibilityNotes?: unknown;
}

const DETAIL_KEYS = [
  "firstName", "middleName", "lastName", "preferredName", "dateOfBirth", "phone", "email", "program",
  "referralSource", "referralAgency", "referralDate", "eligibilityNotes",
] as const satisfies readonly (keyof ApplicantDetails)[];

/** How an edit's summary names each field. */
const FIELD_WORDS: Record<string, string> = {
  firstName: "first name", middleName: "middle name", lastName: "last name", preferredName: "preferred name", dateOfBirth: "date of birth",
  phone: "phone", email: "email", program: "program", referralSource: "referral source", referralAgency: "referred by",
  referralDate: "referral date", eligibilityNotes: "eligibility notes", siteId: "site",
};

const text = (raw: unknown, max: number) => (typeof raw === "string" && raw.trim() ? raw.trim().slice(0, max) : null);

/** A program at this site, or null. */
const programAt = (site: Pick<Site, "code">, value: string | null | undefined) =>
  Boolean(value && programs().some((p) => p.value === value && p.site === site.code));

/**
 * Check what was sent. Contact, date of birth, program and referral source are
 * checked as client information checks them, so accepting can copy them over
 * as they are. `partial`: only the fields sent change; null or "" clears one.
 */
function cleanDetails(input: ApplicantDetails, site: SiteRow, partial: boolean): Prisma.ApplicantUncheckedUpdateInput {
  const out: Prisma.ApplicantUncheckedUpdateInput = {};
  const has = (k: keyof ApplicantDetails) => !partial || input[k] !== undefined;
  const asClient = (key: string, raw: unknown) => {
    try {
      return parseClientValue(clientField(key)!, raw);
    } catch (e) {
      if (e instanceof ClientFieldError) throw badRequest(e.message);
      throw e;
    }
  };
  if (has("firstName")) {
    const v = text(input.firstName, 80);
    if (!v) throw badRequest("First name is required.");
    out.firstName = v;
  }
  if (has("lastName")) out.lastName = text(input.lastName, 80) ?? "";
  if (has("middleName")) out.middleName = text(input.middleName, 80);
  if (has("preferredName")) out.preferredName = text(input.preferredName, 80);
  if (has("dateOfBirth")) {
    const v = asClient("dateOfBirth", input.dateOfBirth) as string | null;
    if (v && v > todayNY()) throw badRequest("Date of birth can't be in the future.");
    out.dateOfBirth = v ? day(v) : null;
  }
  if (has("phone")) out.phone = asClient("phone", input.phone) as string | null;
  if (has("email")) out.email = asClient("email", input.email) as string | null;
  if (has("program")) {
    const v = asClient("program", input.program) as string | null;
    if (v && !programAt(site, v)) throw badRequest(`"${v}" isn't one of ${site.name}'s programs.`);
    out.program = v;
  }
  if (has("referralSource")) out.referralSource = asClient("referralSource", input.referralSource) as string | null;
  if (has("referralAgency")) out.referralAgency = text(input.referralAgency, 255);
  if (has("referralDate")) {
    const raw = input.referralDate;
    out.referralDate = raw === null || raw === undefined || raw === "" ? null : day(moveDate(raw, "Referral date"));
  }
  if (has("eligibilityNotes")) out.eligibilityNotes = text(input.eligibilityNotes, 4000);
  return out;
}

// ── What the screens get ─────────────────────────────────────────────────

type ResidentRow = { id: string; firstName: string; lastName: string; preferredName: string | null; status: string; movedIn: boolean; moveInDate: Date | null };

const daysBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 86_400_000);

/**
 * Where they stand: still in the pipeline, or done. Someone accepted stays open
 * until they move in (PlanStreet's outcome "Moved In"), or leaves the roster first.
 */
function outcomeOf(a: Applicant, resident: ResidentRow | null): { open: boolean; outcome: string | null } {
  if (isOpen(a.stage)) return { open: true, outcome: null };
  if (a.stage !== "accepted") return { open: false, outcome: STAGE_LABELS[a.stage as Stage] ?? a.stage };
  if (!resident || resident.status !== "active") return { open: false, outcome: "Removed from the roster" };
  return resident.movedIn ? { open: false, outcome: "Moved in" } : { open: true, outcome: "Waiting to move in" };
}

export function applicantOut(a: WithSteps, extra: { siteName?: string; resident?: ResidentRow | null } = {}) {
  const today = day(todayNY());
  const resident = extra.resident ?? null;
  const dob = a.dateOfBirth ? ymd(a.dateOfBirth) : null;
  return {
    id: a.id,
    siteId: a.siteId,
    siteName: extra.siteName ?? null,
    program: a.program,
    firstName: a.firstName,
    middleName: a.middleName,
    lastName: a.lastName,
    preferredName: a.preferredName,
    displayName: displayName(a),
    dateOfBirth: dob,
    age: ageOn(dob),
    phone: a.phone,
    email: a.email,
    referralSource: a.referralSource,
    referralAgency: a.referralAgency,
    referralDate: a.referralDate ? ymd(a.referralDate) : null,
    eligibilityNotes: a.eligibilityNotes,
    stage: a.stage,
    stageLabel: STAGE_LABELS[a.stage as Stage] ?? a.stage,
    stageDate: ymd(a.stageDate),
    daysInStage: Math.max(0, daysBetween(a.stageDate, today)),
    viewingDate: a.viewingDate ? ymd(a.viewingDate) : null,
    outcomeReason: a.outcomeReason,
    ...outcomeOf(a, resident),
    tenantId: a.tenantId,
    resident: resident
      ? { id: resident.id, displayName: displayName(resident), status: resident.status, movedIn: resident.movedIn, moveInDate: resident.moveInDate ? ymd(resident.moveInDate) : null }
      : null,
    history: [...a.steps]
      .sort((x, y) => y.date.getTime() - x.date.getTime() || y.createdAt.getTime() - x.createdAt.getTime())
      .map((s) => ({
        id: s.id,
        stage: s.stage,
        label: STAGE_LABELS[s.stage as Stage] ?? s.stage,
        date: ymd(s.date),
        viewingDate: s.viewingDate ? ymd(s.viewingDate) : null,
        reason: s.reason,
        note: s.note,
        byName: s.byName,
        at: s.createdAt,
      })),
    version: a.version,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

export type ApplicantView = ReturnType<typeof applicantOut>;

const RESIDENT_SELECT = { id: true, firstName: true, lastName: true, preferredName: true, status: true, movedIn: true, moveInDate: true } as const;

async function residentsFor(rows: Applicant[]) {
  const ids = [...new Set(rows.map((r) => r.tenantId).filter((x): x is string => Boolean(x)))];
  const found = ids.length ? await prisma.tenant.findMany({ where: { id: { in: ids } }, select: RESIDENT_SELECT }) : [];
  return new Map(found.map((t) => [t.id, t]));
}

/** One applicant as the screens get it. */
export async function viewOf(id: string) {
  const a = await prisma.applicant.findUniqueOrThrow({ where: { id }, include: { steps: true } });
  const [site, residents] = await Promise.all([prisma.site.findUnique({ where: { id: a.siteId }, select: { name: true } }), residentsFor([a])]);
  return applicantOut(a, { siteName: site?.name, resident: a.tenantId ? residents.get(a.tenantId) ?? null : null });
}

/** The most listed at once: far more than all of Lantern's (84 in PlanStreet when it moved). */
const LIST_CAP = 1000;

/** Applicants at these sites: open (still in the pipeline, or accepted and not moved in yet), closed, or all. */
export async function listApplicants(sites: SiteRow[], filters: { stage?: Stage | null; program?: string | null; status: "open" | "closed" | "all" }) {
  if (!sites.length) return { items: [], truncated: false };
  const where: Prisma.ApplicantWhereInput = { siteId: { in: sites.map((s) => s.id) } };
  if (filters.stage) where.stage = filters.stage;
  if (filters.program) where.program = filters.program;
  // Closed ones only ever grow: leave them out of the query when they aren't wanted.
  if (filters.status === "open" && !filters.stage) where.stage = { in: [...OPEN_STAGES, "accepted"] };
  const rows = await prisma.applicant.findMany({ where, include: { steps: true }, orderBy: [{ stageDate: "asc" }, { createdAt: "asc" }], take: LIST_CAP + 1 });
  const truncated = rows.length > LIST_CAP;
  const residents = await residentsFor(rows);
  const names = new Map(sites.map((s) => [s.id, s.name]));
  const items = rows
    .slice(0, LIST_CAP)
    .map((a) => applicantOut(a, { siteName: names.get(a.siteId), resident: a.tenantId ? residents.get(a.tenantId) ?? null : null }))
    .filter((a) => filters.status === "all" || a.open === (filters.status === "open"));
  return { items, truncated };
}

// ── Changes ──────────────────────────────────────────────────────────────

export async function createApplicant(ctx: Ctx, site: SiteRow, input: ApplicantDetails) {
  const data = cleanDetails(input, site, false) as Prisma.ApplicantUncheckedCreateInput;
  // The referral's day is the day they were referred; without one, today.
  const on = data.referralDate instanceof Date ? data.referralDate : day(todayNY());
  const a = await prisma.applicant.create({
    data: {
      ...data,
      siteId: site.id,
      stage: "referred",
      stageDate: on,
      createdById: ctx.userId,
      updatedById: ctx.userId,
      steps: { create: { stage: "referred", date: on, byId: ctx.userId, byName: ctx.byName } },
    },
  });
  await audit({
    actor: ctx.actor,
    action: "applicant.created",
    siteId: site.id,
    summary: `Added applicant ${displayName(a)} at ${site.name}${a.referralSource ? `, referred by ${a.referralSource}` : ""}`,
  });
  return viewOf(a.id);
}

/** Change their details, or the site they're applying to. */
export async function updateApplicant(ctx: Ctx, a: Applicant & { site: SiteRow }, version: number, input: ApplicantDetails, toSite?: SiteRow) {
  if (a.version !== version) throw conflict();
  const moving = Boolean(toSite && toSite.id !== a.siteId);
  if (moving && a.stage === "accepted") throw badRequest(`${displayName(a)} is on ${a.site.name}'s roster already. Use Transfer on their page to move them.`);
  const site = moving ? toSite! : a.site;
  const data = cleanDetails(input, site, true);
  if (moving) {
    data.siteId = site.id;
    // A program belongs to a building: one that isn't the new site's goes.
    if (data.program === undefined && a.program && !programAt(site, a.program)) data.program = null;
  }
  const changes = diff(a as unknown as Record<string, unknown>, data as Record<string, unknown>, [...DETAIL_KEYS, "siteId"]);
  if (!Object.keys(changes).length) return viewOf(a.id);
  const saved = await prisma.applicant.updateMany({ where: { id: a.id, version }, data: { ...data, updatedById: ctx.userId, version: { increment: 1 } } });
  if (!saved.count) throw conflict();
  const name = displayName({ firstName: (data.firstName as string | undefined) ?? a.firstName, lastName: (data.lastName as string | undefined) ?? a.lastName, preferredName: data.preferredName !== undefined ? (data.preferredName as string | null) : a.preferredName });
  // Not on the resident's History (no tenantId): the changes hold client
  // information, which that page shows only to people with clients.view.
  await audit({
    actor: ctx.actor,
    action: "applicant.updated",
    siteId: site.id,
    summary: moving ? `Moved applicant ${name} from ${a.site.name} to ${site.name}` : `Updated applicant ${name} (${Object.keys(changes).map((k) => FIELD_WORDS[k] ?? k).join(", ")})`,
    changes,
  });
  return viewOf(a.id);
}

/** A day the viewing can be on: not long past, not more than a year ahead. */
function viewingDay(raw: unknown): string {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(day(raw).getTime())) throw badRequest("Viewing: pick the day they're seeing the unit.");
  const today = todayNY();
  if (raw < addDays(today, -365) || raw > addDays(today, 365)) throw badRequest("Viewing: pick a day within a year of today.");
  return raw;
}

/**
 * Move them to another stage: forward, back (a mistake), closed with a reason,
 * or reopened from closed. Once accepted they're a resident, and their page is
 * where things change.
 */
export async function moveApplicant(
  ctx: Ctx,
  a: Applicant & { site: SiteRow },
  input: { version: number; stage: unknown; date?: unknown; viewingDate?: unknown; reason?: unknown; note?: unknown }
) {
  if (a.version !== input.version) throw conflict();
  const name = displayName(a);
  if (a.stage === "accepted") throw badRequest(`${name} was accepted and is on the roster. Anything else happens on their resident page.`);
  const stage = input.stage;
  if (stage === "accepted") throw badRequest("Use Accept to put them on the roster.");
  if (!isStage(stage)) throw badRequest("Pick a stage.");
  // Rescheduling a viewing is a move to the same stage; nothing else is.
  if (stage === a.stage && stage !== "viewing_scheduled") throw badRequest(`${name} is already at ${STAGE_LABELS[stage]}.`);
  const date = moveDate(input.date === undefined || input.date === null || input.date === "" ? todayNY() : input.date, "Date");
  const viewing = stage === "viewing_scheduled" ? viewingDay(input.viewingDate) : null;
  const note = text(input.note, 2000);
  let reason: string | null = null;
  if (isClosed(stage)) {
    reason = typeof input.reason === "string" ? input.reason : "";
    if (!CLOSE_REASONS[stage].includes(reason)) throw badRequest(`Pick why they're ${STAGE_LABELS[stage].toLowerCase()}.`);
    if (reason === OTHER && !note) throw badRequest("Say why in the note.");
  }

  await prisma.$transaction(async (tx) => {
    const saved = await tx.applicant.updateMany({
      where: { id: a.id, version: input.version },
      data: {
        stage,
        stageDate: day(date),
        viewingDate: viewing ? day(viewing) : null,
        outcomeReason: reason,
        updatedById: ctx.userId,
        version: { increment: 1 },
      },
    });
    if (!saved.count) throw conflict();
    await tx.applicantStep.create({
      data: { applicantId: a.id, stage, date: day(date), viewingDate: viewing ? day(viewing) : null, reason, note, byId: ctx.userId, byName: ctx.byName },
    });
  });

  const reopened = isClosed(a.stage) && isOpen(stage);
  await audit({
    actor: ctx.actor,
    action: isClosed(stage) ? "applicant.closed" : reopened ? "applicant.reopened" : "applicant.moved",
    siteId: a.siteId,
    summary: `${reopened ? "Reopened" : "Moved"} applicant ${name} at ${a.site.name}: ${STAGE_LABELS[a.stage as Stage] ?? a.stage} → ${STAGE_LABELS[stage]}${viewing ? ` (viewing ${viewing})` : ""}${reason ? ` — ${reason}` : ""}`,
    changes: { stage: [a.stage, stage], date, ...(viewing ? { viewingDate: viewing } : {}), ...(reason ? { reason } : {}), ...(note ? { note } : {}) },
  });
  return viewOf(a.id);
}

/**
 * What their client information starts with: date of birth, middle name,
 * contact, program and the referral (services/clientFields.ts keys). A value
 * that no longer passes (a program renamed since) is left out rather than
 * stopping the accept.
 */
function clientInfoFrom(a: Applicant): Record<string, unknown> {
  const wanted: Record<string, unknown> = {
    dateOfBirth: a.dateOfBirth ? ymd(a.dateOfBirth) : null,
    middleName: a.middleName,
    phone: a.phone,
    email: a.email,
    program: a.program,
    referralDate: a.referralDate ? ymd(a.referralDate) : null,
    referralSource: a.referralSource,
    referralProgram: a.program,
    eligible: "Yes",
  };
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(wanted)) {
    if (raw === null || raw === undefined || raw === "") continue;
    try {
      if (parseClientValue(clientField(key)!, raw) !== null) out[key] = raw;
    } catch {
      // Left out: see above.
    }
  }
  return out;
}

/** How Accept adds the resident: the Add resident route, as the person accepting (routes/applicants.ts). */
export type AddResident = (body: { site: string; firstName: string; lastName: string; preferredName: string | null }) => Promise<TenantDTO>;

/**
 * Accept them: they go on the site's roster as not moved in yet (Add resident,
 * so the roster's own checks, audit and webhooks apply), their client
 * information is filled from the application, and the applicant points at the
 * resident. Moving in is next, on the roster.
 */
export async function acceptApplicant(ctx: Ctx, a: Applicant & { site: SiteRow }, input: { version: number; date?: unknown; note?: unknown }, addResident: AddResident) {
  if (a.version !== input.version) throw conflict();
  const name = displayName(a);
  if (a.stage === "accepted") throw badRequest(`${name} was accepted already.`);
  if (!ACCEPT_FROM.includes(a.stage as Stage)) throw badRequest(`Mark ${name} eligible first: only eligible applicants, or ones who've seen the unit, can be accepted.`);
  const date = moveDate(input.date === undefined || input.date === null || input.date === "" ? todayNY() : input.date, "Accepted on");
  const note = text(input.note, 2000);
  const copy = clientInfoFrom(a);

  // Claimed first, so two people accepting at once don't put them on the roster twice.
  const claimed = await prisma.applicant.updateMany({
    where: { id: a.id, version: input.version, stage: { in: [...ACCEPT_FROM] }, tenantId: null },
    data: { version: { increment: 1 } },
  });
  if (!claimed.count) throw conflict();
  let resident: TenantDTO;
  try {
    resident = await addResident({ site: a.siteId, firstName: a.firstName, lastName: a.lastName, preferredName: a.preferredName });
  } catch (err) {
    // Nothing was made: hand the applicant back as it was.
    await prisma.applicant.updateMany({ where: { id: a.id, version: input.version + 1 }, data: { version: input.version } });
    throw err;
  }

  await prisma.$transaction([
    prisma.applicant.update({
      where: { id: a.id },
      data: { stage: "accepted", stageDate: day(date), outcomeReason: null, tenantId: resident.id, updatedById: ctx.userId, version: { increment: 1 } },
    }),
    prisma.applicantStep.create({ data: { applicantId: a.id, stage: "accepted", date: day(date), note, byId: ctx.userId, byName: ctx.byName } }),
  ]);

  let copied: string[] = [];
  if (Object.keys(copy).length) {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: resident.id }, include: { site: { select: { id: true, code: true, name: true } } } });
    const before = await prisma.tenantProfile.findUnique({ where: { tenantId: tenant.id } });
    const saved = await saveProfile({ tenant, before, version: before?.version ?? 0, changes: copy, userId: ctx.userId });
    if (saved) {
      copied = saved.changed;
      await audit({
        actor: ctx.actor,
        action: "tenant.profile_updated",
        tenantId: tenant.id,
        siteId: tenant.siteId,
        summary: `Filled in client information for ${displayName(tenant)} from their application (${fieldWords(saved.changed)})`,
        changes: saved.diff,
      });
    }
  }
  await audit({
    actor: ctx.actor,
    action: "applicant.accepted",
    tenantId: resident.id,
    siteId: a.siteId,
    summary: `Accepted applicant ${name} at ${a.site.name}: on the roster, not moved in yet`,
    // On the resident's History, which everyone at the site reads: the day, not the note.
    changes: { date },
  });
  return { applicant: await viewOf(a.id), resident, copied };
}

// ── Report ───────────────────────────────────────────────────────────────

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
};

/**
 * Open applicants by stage at each site (accepted ones waiting to move in
 * included), and how many days it took from referral to move-in for the people
 * who moved in over the last twelve months.
 */
export async function applicantReport(sites: SiteRow[]) {
  const to = todayNY();
  const from = addDays(to, -364);
  const ids = sites.map((s) => s.id);
  const rows = ids.length
    ? await prisma.applicant.findMany({
        where: { siteId: { in: ids }, stage: { in: [...OPEN_STAGES, "accepted"] } },
        select: { siteId: true, stage: true, referralDate: true, tenantId: true },
      })
    : [];
  const tenantIds = [...new Set(rows.map((r) => r.tenantId).filter((x): x is string => Boolean(x)))];
  const [tenants, stays] = tenantIds.length
    ? await Promise.all([
        prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, status: true, movedIn: true, moveInDate: true } }),
        prisma.stay.findMany({ where: { tenantId: { in: tenantIds } }, orderBy: { moveInDate: "asc" }, select: { tenantId: true, moveInDate: true } }),
      ])
    : [[], []];
  const tenantBy = new Map(tenants.map((t) => [t.id, t]));
  // Their first stay is the move-in (a later one is a transfer).
  const firstIn = new Map<string, Date>();
  for (const s of stays) if (!firstIn.has(s.tenantId)) firstIn.set(s.tenantId, s.moveInDate);

  const keys = [...OPEN_STAGES, "waiting"] as const;
  type Counts = Record<(typeof keys)[number], number>;
  const zero = (): Counts => ({ referred: 0, eligibility_review: 0, eligible: 0, viewing_scheduled: 0, waiting: 0 });
  const perSite = new Map(ids.map((id) => [id, { counts: zero(), days: [] as number[] }]));
  const all: number[] = [];
  for (const r of rows) {
    const site = perSite.get(r.siteId)!;
    if (isOpen(r.stage)) {
      site.counts[r.stage]++;
      continue;
    }
    const t = r.tenantId ? tenantBy.get(r.tenantId) : null;
    if (!t) continue;
    if (!t.movedIn) {
      // Taken off the roster before moving in: neither waiting nor moved in.
      if (t.status === "active") site.counts.waiting++;
      continue;
    }
    const movedIn = firstIn.get(t.id) ?? t.moveInDate;
    if (!movedIn || !r.referralDate) continue;
    const on = ymd(movedIn);
    if (on < from || on > to) continue;
    const days = daysBetween(r.referralDate, movedIn);
    if (days < 0) continue;
    site.days.push(days);
    all.push(days);
  }
  const bySite = sites.map((s) => {
    const x = perSite.get(s.id)!;
    return { siteId: s.id, siteName: s.name, ...x.counts, open: keys.reduce((n, k) => n + x.counts[k], 0), movedIn: x.days.length, medianDays: median(x.days) };
  });
  return {
    from,
    to,
    columns: keys.map((k) => ({ key: k, label: k === "waiting" ? "Waiting to move in" : STAGE_LABELS[k] })),
    bySite,
    open: bySite.reduce((n, s) => n + s.open, 0),
    referralToMoveIn: { count: all.length, medianDays: median(all) },
  };
}
