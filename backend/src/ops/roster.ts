import { z } from "zod";
import { HttpError } from "../http.js";
import { tenantsRouter, ARCHIVE_REASONS } from "../routes/tenants.js";
import { attendanceRouter } from "../routes/attendance.js";
import { activityRouter } from "../routes/activity.js";
import { residencyRouter } from "../routes/residency.js";
import { applicantsRouter } from "../routes/applicants.js";
import { CLOSE_REASONS, MOVE_STAGES, STAGES } from "../services/applicants.js";
import { decodeCsv, importTenants, MAX_IMPORT_ROWS, readRows } from "../services/tenantImport.js";
import { defineOp, int, flag } from "./registry.js";

/**
 * Residents (the roster), attendance and the roster dashboard, through the
 * routes the Roster screens use. All act as the key's creator.
 */

const id = (v: string) => encodeURIComponent(v);
const site = z.string().optional().describe("Site code or id. Omit for every site the key can reach (comma-separate several).");
const residentId = z.string().describe("The resident's roster id.");

/** Field shapes match routes/tenants.ts; the route checks them again. */
const residentFields = {
  unit: z.string().max(40).nullable().optional(),
  firstName: z.string().max(80),
  lastName: z.string().max(80).optional(),
  preferredName: z.string().max(80).nullable().optional(),
  moveInDate: z.string().nullable().optional().describe("YYYY-MM-DD"),
  notes: z.string().max(2000).nullable().optional(),
  externalId: z.string().max(80).nullable().optional().describe("The resident's id in the property-management system"),
  highAcuity: z.boolean().optional().describe("Elevated needs: more frequent check-ins, closer case management"),
};

/** Applicants' details; routes/applicants.ts checks them again. */
const applicantFields = {
  firstName: z.string().max(80),
  middleName: z.string().max(80).nullable().optional(),
  lastName: z.string().max(80).optional(),
  preferredName: z.string().max(80).nullable().optional(),
  dateOfBirth: z.string().nullable().optional().describe("YYYY-MM-DD"),
  phone: z.string().max(40).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
  program: z.string().max(255).nullable().optional(),
  referralSource: z.string().max(80).nullable().optional(),
  referralAgency: z.string().max(255).nullable().optional().describe("Who referred them: agency, worker or contact"),
  referralDate: z.string().nullable().optional().describe("YYYY-MM-DD"),
  eligibilityNotes: z.string().max(4000).nullable().optional(),
};

/** Attendance signatures are PNG data URLs: report whether one is there, not the image. */
function withoutSignatures(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSignatures);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => (k === "signature" ? ["signed", Boolean(v)] : [k, withoutSignatures(v)]))
    );
  }
  return value;
}

/** Client information: field keys and choices come from list_client_fields. */
const clientChanges = z
  .record(z.unknown())
  .describe(
    "Only the fields to change, keyed by field key (list_client_fields): text, \"YYYY-MM-DD\" dates, one of the field's options, a list of options for multi fields, a staff id for caseLead (list from get_client_info's site), a resident id for headOfHousehold, a list of { name, relationship, phone, email } for emergencyContacts. null clears a field. ssn takes nine digits."
  );

export const rosterOps = [
  defineOp({
    name: "list_client_fields",
    description:
      "The client information fields (what PlanStreet keeps on a case): sections, each field's key, label, type, options and when it applies (showIf), plus every building's programs. Read this before update_client_info.",
    scope: "clients:read",
    as: "creator",
    http: { method: "GET", path: "/residents/client-fields" },
    shape: {},
    annotations: { readOnlyHint: true },
    run: (ctx) => ctx.route(tenantsRouter, { method: "GET", path: "/meta/client-fields" }),
  }),

  defineOp({
    name: "get_client_info",
    description:
      "A resident's client information: date of birth and age, demographics, veteran status, program and funding, case lead, referral and intake, household (head and members) and move-out. The SSN comes as its last four only. `version` is what update_client_info needs (0 = nothing saved yet). Answers { enabled: false } while client information is turned off.",
    scope: "clients:read",
    as: "creator",
    http: { method: "GET", path: "/residents/:id/client-info" },
    shape: { id: residentId },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.route(tenantsRouter, { method: "GET", path: `/${id(a.id)}/profile` }),
  }),

  defineOp({
    name: "update_client_info",
    description:
      "Change a resident's client information. Pass only the fields to change, and the version from get_client_info: if someone saved since, it's refused rather than overwritten. Answers that stop applying (e.g. veteran details when Veteran status becomes No) are cleared.",
    scope: "clients:write",
    as: "creator",
    http: { method: "PATCH", path: "/residents/:id/client-info" },
    shape: { id: residentId, version: z.number().int().min(0).describe("From get_client_info (0 = nothing saved yet)"), changes: clientChanges },
    run: (ctx, { id: tid, ...body }) => ctx.route(tenantsRouter, { method: "PATCH", path: `/${id(tid)}/profile`, body }),
  }),

  defineOp({
    name: "list_residents",
    description: "Residents on the roster at the sites the key can reach: active (default), attention (past the site's review threshold) or archived (removed). Search by name or unit with q.",
    scope: "roster:read",
    as: "creator",
    http: { method: "GET", path: "/residents" },
    shape: { site, status: z.enum(["active", "attention", "archived"]).optional(), q: z.string().max(120).optional() },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.route(tenantsRouter, { method: "GET", path: "/", query: { site: a.site, status: a.status, q: a.q } }),
  }),

  defineOp({
    name: "resident_review_queue",
    description: "Active residents nobody has confirmed lately (past each site's review threshold): who to check is still there.",
    scope: "roster:read",
    as: "creator",
    http: { method: "GET", path: "/residents/review" },
    shape: { site },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.route(tenantsRouter, { method: "GET", path: "/review", query: { site: a.site } }),
  }),

  defineOp({
    name: "get_resident",
    description: "One resident, with their recent activity and roster history. `version` is what update_resident needs.",
    scope: "roster:read",
    as: "creator",
    http: { method: "GET", path: "/residents/:id" },
    shape: { id: residentId },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.route(tenantsRouter, { method: "GET", path: `/${id(a.id)}` }),
  }),

  defineOp({
    name: "roster_dashboard",
    description: "Roster totals: active residents, added and removed this week, and who needs attention, per site, plus recent roster events.",
    scope: "roster:read",
    as: "creator",
    http: { method: "GET", path: "/roster/dashboard" },
    shape: { site },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.route(activityRouter, { method: "GET", path: "/dashboard", query: { site: a.site } }),
  }),

  defineOp({
    name: "add_resident",
    description: "Add a resident to a site's roster.",
    scope: "roster:write",
    as: "creator",
    http: { method: "POST", path: "/residents" },
    shape: { site: z.string().describe("Site code or id"), ...residentFields },
    run: (ctx, a) => ctx.route(tenantsRouter, { method: "POST", path: "/", body: a }),
  }),

  defineOp({
    name: "update_resident",
    description: "Change a resident's details, or move them to another site (site). Pass the version from get_resident: if someone changed them since, it's refused rather than overwritten.",
    scope: "roster:write",
    as: "creator",
    http: { method: "PATCH", path: "/residents/:id" },
    shape: {
      id: residentId,
      version: z.number().int().describe("From get_resident / list_residents"),
      ...residentFields,
      firstName: residentFields.firstName.optional(),
      site: z.string().optional().describe("Move to this site (code or id)"),
    },
    annotations: { idempotentHint: true },
    run: (ctx, { id: tid, ...body }) => ctx.route(tenantsRouter, { method: "PATCH", path: `/${id(tid)}`, body }),
  }),

  defineOp({
    name: "keep_resident",
    description: "Confirm a resident is still there (the roster's Keep / Still here): restarts their review clock.",
    scope: "roster:write",
    as: "creator",
    http: { method: "POST", path: "/residents/:id/keep" },
    shape: { id: residentId },
    run: (ctx, a) => ctx.route(tenantsRouter, { method: "POST", path: `/${id(a.id)}/keep` }),
  }),

  defineOp({
    name: "send_resident_to_review",
    description:
      "Put a resident back in the review queue (Needs review) even if they were confirmed recently. They stay there — form activity doesn't clear it — until someone keeps (keep_resident) or removes them.",
    scope: "roster:write",
    as: "creator",
    http: { method: "POST", path: "/residents/:id/send-to-review" },
    shape: { id: residentId },
    annotations: { idempotentHint: true },
    run: (ctx, a) => ctx.route(tenantsRouter, { method: "POST", path: `/${id(a.id)}/send-to-review` }),
  }),

  defineOp({
    name: "send_site_to_review",
    description:
      "Put EVERY active resident at one site back in the review queue (Needs review), e.g. to have staff re-check the whole roster. Each stays there until someone keeps or removes them. Returns how many were sent and how many are now waiting. Needs confirm: true.",
    scope: "roster:archive",
    as: "creator",
    http: { method: "POST", path: "/residents/send-to-review" },
    shape: { site: z.string().describe("Site code or id") },
    confirm: true,
    annotations: { idempotentHint: true },
    run: (ctx, a) => ctx.route(tenantsRouter, { method: "POST", path: "/send-to-review", body: { site: a.site } }),
  }),

  defineOp({
    name: "archive_resident",
    description: "Remove a resident from the roster (they're kept, marked removed, and can be restored).",
    scope: "roster:archive",
    as: "creator",
    http: { method: "POST", path: "/residents/:id/archive" },
    shape: {
      id: residentId,
      reason: z.enum(ARCHIVE_REASONS),
      note: z.string().max(500).optional(),
      moveOutDate: z.string().nullable().optional().describe("YYYY-MM-DD"),
    },
    confirm: true,
    annotations: { destructiveHint: true },
    run: (ctx, { id: tid, ...body }) => ctx.route(tenantsRouter, { method: "POST", path: `/${id(tid)}/archive`, body }),
  }),

  defineOp({
    name: "restore_resident",
    description: "Put a removed resident back on the roster.",
    scope: "roster:archive",
    as: "creator",
    http: { method: "POST", path: "/residents/:id/restore" },
    shape: { id: residentId },
    run: (ctx, a) => ctx.route(tenantsRouter, { method: "POST", path: `/${id(a.id)}/restore` }),
  }),

  defineOp({
    name: "import_residents",
    description:
      "Import a property-management tenant list (CSV text with Property, Unit and Tenant columns, the same file Admin → Import takes). Without commit it's a dry run that shows what would be added; commit: true (with confirm: true) adds them to every site in the file — it only adds, never removes. " +
      `Up to ${MAX_IMPORT_ROWS} rows per call; for bigger files send parts of ~1000 rows (the header row is optional after the first part) with part/parts to label them. Re-sending a part is safe: people already on the roster are skipped.`,
    scope: "roster:import",
    as: "creator",
    http: { method: "POST", path: "/residents/import" },
    shape: {
      csv: z.string().min(1).max(5 * 1024 * 1024).describe("The CSV text (up to 1 MB over REST, 5 MB over MCP)"),
      commit: flag().optional(),
      part: int(1, 1000).optional().describe("Which part of a split file this is (1-based)"),
      parts: int(1, 1000).optional().describe("How many parts the file was split into"),
    },
    confirm: (a) => a.commit === true,
    annotations: { destructiveHint: true },
    run: async (ctx, a) => {
      const rows = readRows(decodeCsv(Buffer.from(a.csv, "utf8")));
      if (rows.length === 0) throw new HttpError(400, "That file has no rows. Expected columns: Property, Unit, Tenant.");
      const part = a.part && a.parts && a.part <= a.parts ? { index: a.part, total: a.parts } : undefined;
      // importTenants writes its own audit event when it commits.
      return { committed: a.commit === true, ...(await importTenants(rows, { commit: a.commit === true, actor: ctx.actor, part })) };
    },
  }),

  defineOp({
    name: "list_attendance",
    description: "Attendance taken at events (newest first), with how many attended and signed.",
    scope: "roster:read",
    as: "creator",
    http: { method: "GET", path: "/attendance" },
    shape: { site, q: z.string().max(120).optional(), before: z.string().optional().describe("Paging: the `next` value from the last page"), limit: int(1, 200).optional() },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.route(attendanceRouter, { method: "GET", path: "/", query: { site: a.site, q: a.q, before: a.before, limit: a.limit?.toString() } }),
  }),

  defineOp({
    name: "get_attendance",
    description: "One attendance event and who attended (signatures are reported as signed: true/false, not sent).",
    scope: "roster:read",
    as: "creator",
    http: { method: "GET", path: "/attendance/:id" },
    shape: { id: z.string() },
    annotations: { readOnlyHint: true },
    run: async (ctx, a) => withoutSignatures(await ctx.route(attendanceRouter, { method: "GET", path: `/${id(a.id)}` })),
  }),

  defineOp({
    name: "take_attendance",
    description: "Record attendance at an event: the site, a title and description, and the residents (roster ids, active at that site) who came.",
    scope: "roster:write",
    as: "creator",
    http: { method: "POST", path: "/attendance" },
    shape: {
      site: z.string().describe("Site code or id"),
      title: z.string().max(160),
      description: z.string().max(2000),
      entries: z.array(z.object({ tenantId: z.string() })).max(1000).describe("[{ tenantId }] for each resident who attended"),
    },
    run: async (ctx, a) => withoutSignatures(await ctx.route(attendanceRouter, { method: "POST", path: "/", body: a })),
  }),
  // ── Units, moving in and out, away, the checklist (case management) ──
  defineOp({
    name: "residency_options",
    description:
      "Case management's lists: household relations, move-out reasons, away reasons, HUD exit destinations, unit types, programs and the move-in checklist schedule. Units and move-ins work at supportive sites while case management is on.",
    scope: "roster:read",
    as: "creator",
    http: { method: "GET", path: "/residency/options" },
    shape: {},
    annotations: { readOnlyHint: true },
    run: (ctx) => ctx.route(residencyRouter, { method: "GET", path: "/meta" }),
  }),

  defineOp({
    name: "list_units",
    description: "Units at supportive sites, each with who lives there (head of household first) or vacant and since when. retired: true includes retired units.",
    scope: "roster:read",
    as: "creator",
    http: { method: "GET", path: "/residency/units" },
    shape: { site, retired: z.boolean().optional() },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.route(residencyRouter, { method: "GET", path: "/units", query: { site: a.site, retired: a.retired ? "1" : undefined } }),
  }),

  defineOp({
    name: "save_unit",
    description: "Add a unit to a site (site + label), or change one (id): label, unit type, program, notes, active (false retires an empty unit). Site Managers' and Admins' keys.",
    scope: "roster:archive",
    as: "creator",
    http: { method: "POST", path: "/residency/units/save" },
    shape: {
      id: z.string().optional().describe("A unit to change; leave out to add one"),
      site: z.string().optional().describe("Site code or id, when adding"),
      label: z.string().max(40).optional(),
      unitType: z.string().max(40).nullable().optional(),
      program: z.string().max(255).nullable().optional(),
      notes: z.string().max(1000).nullable().optional(),
      active: z.boolean().optional(),
    },
    run: (ctx, { id: uid, ...body }) =>
      uid ? ctx.route(residencyRouter, { method: "PATCH", path: `/units/${id(uid)}`, body }) : ctx.route(residencyRouter, { method: "POST", path: "/units", body }),
  }),

  defineOp({
    name: "add_units",
    description: "Add many units to a site at once (labels); ones it already has are skipped.",
    scope: "roster:archive",
    as: "creator",
    http: { method: "POST", path: "/residency/units/bulk" },
    shape: { site: z.string(), labels: z.array(z.string().max(40)).min(1).max(1000), unitType: z.string().max(40).nullable().optional(), program: z.string().max(255).nullable().optional() },
    run: (ctx, a) => ctx.route(residencyRouter, { method: "POST", path: "/units/bulk", body: a }),
  }),

  defineOp({
    name: "seed_units",
    description:
      "Set a supportive site up from its roster: a unit for every unit number on it, and each resident linked to theirs with a stay from their move-in date and the recurring checklist. Safe to run again (adds only what's missing). Needs confirm: true.",
    scope: "roster:archive",
    as: "creator",
    http: { method: "POST", path: "/residency/units/seed" },
    shape: { site: z.string() },
    confirm: true,
    run: (ctx, a) => ctx.route(residencyRouter, { method: "POST", path: "/units/seed", body: { site: a.site } }),
  }),

  defineOp({
    name: "move_in",
    description:
      "Move residents (on the site's roster, not living in a unit) into a unit on a date (not in the future). One person per unit, except at household sites: the first into a vacant unit is head of household; everyone else needs relation (residency_options relations), joining an existing household included. Starts their stay and checklist.",
    scope: "roster:write",
    as: "creator",
    http: { method: "POST", path: "/residency/units/:unitId/move-in" },
    shape: {
      unitId: z.string(),
      date: z.string().describe("YYYY-MM-DD"),
      people: z.array(z.object({ tenantId: z.string(), relation: z.string().max(80).nullable().optional() })).min(1).max(20),
      program: z.string().max(255).nullable().optional().describe("Defaults to the unit's program"),
    },
    run: (ctx, { unitId, ...body }) => ctx.route(residencyRouter, { method: "POST", path: `/units/${id(unitId)}/move-in`, body }),
  }),

  defineOp({
    name: "transfer_resident",
    description:
      "Move a resident who lives in a unit to another unit, at the same or another site (an internal transfer): their stay ends as transferred and a new one starts. withHousehold moves their whole household (a head can't leave theirs behind).",
    scope: "roster:write",
    as: "creator",
    http: { method: "POST", path: "/residency/residents/:id/transfer" },
    shape: {
      id: residentId,
      toUnitId: z.string(),
      date: z.string().describe("YYYY-MM-DD"),
      reason: z.string().max(120).nullable().optional(),
      withHousehold: z.boolean().optional(),
      relations: z.record(z.string().max(80)).optional().describe("{ tenantId: relation } when joining a household"),
    },
    run: (ctx, { id: tid, ...body }) => ctx.route(residencyRouter, { method: "POST", path: `/tenants/${id(tid)}/transfer`, body }),
  }),

  defineOp({
    name: "move_out",
    description:
      "Move a resident out: date, reason (residency_options moveOutReasons), HUD exit destination, forwarding address, note; alsoIds for household members leaving with them; newHeadId when a head leaves a household behind. Ends their stay, removes them from the roster, frees the unit, cancels open checklist items and adds the HMIS exit assessment. Needs confirm: true.",
    scope: "roster:archive",
    as: "creator",
    http: { method: "POST", path: "/residency/residents/:id/move-out" },
    shape: {
      id: residentId,
      date: z.string().describe("YYYY-MM-DD"),
      reason: z.string().max(120),
      destination: z.string().max(200).nullable().optional(),
      forwardingAddress: z.object({ line1: z.string().optional(), line2: z.string().optional(), city: z.string().optional(), state: z.string().optional(), zip: z.string().optional() }).nullable().optional(),
      note: z.string().max(2000).nullable().optional(),
      alsoIds: z.array(z.string()).max(20).optional(),
      newHeadId: z.string().nullable().optional(),
    },
    confirm: true,
    run: (ctx, { id: tid, ...body }) => ctx.route(residencyRouter, { method: "POST", path: `/tenants/${id(tid)}/move-out`, body }),
  }),

  defineOp({
    name: "mark_away",
    description: "Mark a resident away from the building (PlanStreet's Out of Building Status): last seen, reason (residency_options awayReasons), detail, expected return. They stay out of review until marked back.",
    scope: "roster:write",
    as: "creator",
    http: { method: "POST", path: "/residency/residents/:id/away" },
    shape: { id: residentId, lastSeen: z.string(), reason: z.string().max(120), detail: z.string().max(1000).nullable().optional(), expectedReturn: z.string().nullable().optional() },
    run: (ctx, { id: tid, ...body }) => ctx.route(residencyRouter, { method: "POST", path: `/tenants/${id(tid)}/away`, body }),
  }),

  defineOp({
    name: "mark_returned",
    description: "A resident marked away is back (date).",
    scope: "roster:write",
    as: "creator",
    http: { method: "POST", path: "/residency/residents/:id/returned" },
    shape: { id: residentId, date: z.string() },
    run: (ctx, { id: tid, ...body }) => ctx.route(residencyRouter, { method: "POST", path: `/tenants/${id(tid)}/returned`, body }),
  }),

  defineOp({
    name: "get_residency",
    description: "A resident's unit, household, whether they're away, every stay (move-in to move-out, reason, destination) and their checklist.",
    scope: "roster:read",
    as: "creator",
    http: { method: "GET", path: "/residency/residents/:id" },
    shape: { id: residentId },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.route(residencyRouter, { method: "GET", path: `/tenants/${id(a.id)}` }),
  }),

  defineOp({
    name: "list_checklist",
    description: "Move-in checklist tasks at supportive sites: view overdue, due (next two weeks, overdue included, the default), open, or done (last 90 days). mine: only residents the key's maker is case lead for.",
    scope: "roster:read",
    as: "creator",
    http: { method: "GET", path: "/residency/checklist" },
    shape: { site, view: z.enum(["overdue", "due", "open", "done"]).optional(), mine: z.boolean().optional() },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.route(residencyRouter, { method: "GET", path: "/tasks", query: { site: a.site, view: a.view, mine: a.mine ? "1" : undefined } }),
  }),

  defineOp({
    name: "update_checklist_task",
    description: "Mark a checklist task done (doneOn, note), skipped (not needed; note required) or open again. A recurring one makes its next.",
    scope: "roster:write",
    as: "creator",
    http: { method: "POST", path: "/residency/checklist/:id" },
    shape: { id: z.string(), status: z.enum(["done", "skipped", "open"]), doneOn: z.string().optional(), note: z.string().max(2000).nullable().optional() },
    run: (ctx, { id: tid, ...body }) => ctx.route(residencyRouter, { method: "POST", path: `/tasks/${id(tid)}`, body }),
  }),

  defineOp({
    name: "residency_report",
    description: "Move-ins, move-outs (by month, reason, HUD destination), length of stay, vacancies now, people waiting to move in or away, and checklist on-time rates, for supportive sites between from and to (default: the last year).",
    scope: "roster:read",
    as: "creator",
    http: { method: "GET", path: "/residency/report" },
    shape: { site, from: z.string().optional(), to: z.string().optional() },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.route(residencyRouter, { method: "GET", path: "/report", query: { site: a.site, from: a.from, to: a.to } }),
  }),

  // ── Applicants (case management): referral to accepted ──
  defineOp({
    name: "list_applicants",
    description:
      "People referred for a unit at supportive sites (PlanStreet's Applicants): name, date of birth, contact, program, referral (source, who referred them, date), eligibility notes, stage and how long they've been at it, the viewing date, why it closed, the resident they became, and every stage change. status: open (the default: still in the pipeline, or accepted and not moved in yet), closed (ineligible, rejected, declined, withdrawn, or moved in) or all. Each has the version update_applicant and accept_applicant need. Case management only.",
    scope: "clients:read",
    as: "creator",
    http: { method: "GET", path: "/applicants" },
    shape: {
      site,
      status: z.enum(["open", "closed", "all"]).optional(),
      stage: z.enum(STAGES).optional(),
      program: z.string().max(255).optional().describe("Only applicants referred to this program (residency_options programs)"),
    },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.route(applicantsRouter, { method: "GET", path: "/", query: { site: a.site, status: a.status, stage: a.stage, program: a.program } }),
  }),

  defineOp({
    name: "add_applicant",
    description:
      "Add someone referred for a unit at a supportive site. They start at Referred, on the referral date (today if none). program: one of that site's programs (residency_options programs); referralSource: HASA, DSS/HRA, Property Management, ACS or HPD; referralAgency: who referred them, in words.",
    scope: "roster:write",
    as: "creator",
    http: { method: "POST", path: "/applicants" },
    shape: { site: z.string().describe("Site code or id"), ...applicantFields },
    run: (ctx, a) => ctx.route(applicantsRouter, { method: "POST", path: "/", body: a }),
  }),

  defineOp({
    name: "update_applicant",
    description:
      "Change an applicant's details (site moves them to another supportive site), and/or move them to a stage: referred, eligibility_review, eligible, viewing_scheduled (needs viewingDate), or closed — ineligible, rejected, declined (they turned it down) or withdrawn — which needs a reason (Other needs a note). date: the day of the move (default today). A closed applicant can be moved back to an open stage. Accepting is accept_applicant. Pass the version from list_applicants: if someone changed them since, it's refused. Reasons: " +
      Object.entries(CLOSE_REASONS).map(([stage, list]) => `${stage}: ${list.join(" | ")}`).join("; ") +
      ".",
    scope: "roster:write",
    as: "creator",
    http: { method: "PATCH", path: "/applicants/:id" },
    shape: {
      id: z.string().describe("The applicant's id"),
      version: z.number().int().describe("From list_applicants"),
      site: z.string().optional().describe("Move them to this supportive site (code or id)"),
      ...applicantFields,
      firstName: applicantFields.firstName.optional(),
      stage: z.enum(MOVE_STAGES).optional(),
      date: z.string().optional().describe("YYYY-MM-DD: when they reached the stage"),
      viewingDate: z.string().optional().describe("YYYY-MM-DD: viewing_scheduled only"),
      reason: z.string().max(120).optional().describe("Closed stages only"),
      note: z.string().max(2000).optional(),
    },
    run: async (ctx, { id: aid, version, stage, date, viewingDate, reason, note, ...details }) => {
      let current: { version: number } | null = null;
      if (Object.values(details).some((v) => v !== undefined)) {
        current = await ctx.route(applicantsRouter, { method: "PATCH", path: `/${id(aid)}`, body: { version, ...details } });
      }
      if (!stage) return current ?? { error: "Nothing to change: pass details or a stage." };
      return ctx.route(applicantsRouter, { method: "POST", path: `/${id(aid)}/stage`, body: { version: current?.version ?? version, stage, date, viewingDate, reason, note } });
    },
  }),

  defineOp({
    name: "accept_applicant",
    description:
      "Accept an eligible applicant (eligible or viewing_scheduled): they go on the site's roster as a resident who isn't moved in yet, and their date of birth, contact, program and referral are copied into their client information. Returns the applicant, the new resident and which client information fields were filled. Moving in is then move_in with the resident's id.",
    scope: "roster:write",
    as: "creator",
    http: { method: "POST", path: "/applicants/:id/accept" },
    shape: {
      id: z.string().describe("The applicant's id"),
      version: z.number().int().describe("From list_applicants"),
      date: z.string().optional().describe("YYYY-MM-DD: when they were accepted (default today)"),
      note: z.string().max(2000).optional(),
    },
    run: (ctx, { id: aid, ...body }) => ctx.route(applicantsRouter, { method: "POST", path: `/${id(aid)}/accept`, body }),
  }),
];

