import { z } from "zod";
import { HttpError } from "../http.js";
import { tenantsRouter, ARCHIVE_REASONS } from "../routes/tenants.js";
import { attendanceRouter } from "../routes/attendance.js";
import { activityRouter } from "../routes/activity.js";
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

export const rosterOps = [
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
];
