import { z } from "zod";
import { prisma } from "../prisma.js";
import { HttpError } from "../http.js";
import type { CurrentUser } from "../auth/middleware.js";
import { findAnyForm } from "../forms/service.js";
import { fillRouter } from "../routes/fill.js";
import { appsRouter } from "../routes/apps.js";
import { tenantsRouter } from "../routes/tenants.js";
import { attendanceRouter } from "../routes/attendance.js";
import { makeDownload } from "../services/exportLinks.js";
import { countEntries, GROUPS } from "../services/entryCounts.js";
import { exportFilterShape, MAX_PDF } from "../apps/entryExport.js";
import type { CallFrom } from "./callRoute.js";

/**
 * Files and counts for Claude's reports: the connector (ops/person.ts) and the API-key MCP
 * (apps/mcpTools.ts). Every file is made by the site's own export route run as the person —
 * the Export buttons on the Entries screens, Roster and Attendance — so it holds exactly what
 * they could export themselves, and is audited the same way. See services/exportLinks.ts.
 */

const enc = (v: string) => encodeURIComponent(v);
const format = z.enum(["pdf", "xlsx", "csv"]).describe("pdf (print-ready; a code form with a paper layout prints each entry as its paper form), xlsx (Excel) or csv.");
const LINK = "Returns a download link that opens only for this person, signed in to Lantern Forms, for an hour: give it to them (you can't open it yourself).";

export const exportEntriesShape = {
  form: z.string().describe("The form's slug (list_forms), basic or code."),
  format,
  ...exportFilterShape,
  title: z.string().max(160).optional().describe("The file's title, e.g. \"Incident reports — Randy Woods (#610)\" (code forms)."),
};
export const EXPORT_ENTRIES_HELP =
  `A form's entries as a file — "copies of every incident report about Randy Woods as one PDF", "this month's Hot Foods in Excel". Works for every form, basic or code. Pick entries by ids or filters: resident (roster id from list_residents; also catches older entries that only name them), search, site, from/to (YYYY-MM-DD). PDF: up to ${MAX_PDF} entries, oldest first, each on its own page. Only what this person can see on the site goes in. ${LINK}`;

export async function exportEntries(user: CurrentUser, a: z.infer<z.ZodObject<typeof exportEntriesShape>>, from?: CallFrom) {
  const form = await findAnyForm(a.form);
  const path = `/${enc(form.slug)}/entries-export`;
  if (form.kind === "code") {
    const query = {
      format: a.format,
      ids: a.ids?.join(","),
      resident: a.resident,
      search: a.search,
      site: a.site,
      from: a.from,
      to: a.to,
      includeVoided: a.includeVoided ? "1" : undefined,
      mine: a.mine ? "1" : undefined,
      title: a.title,
    };
    return makeDownload(appsRouter, { method: "GET", path, query }, user, { from, fallbackName: form.title });
  }
  // A basic form: its Entries screen's export. It filters one site (by id) and finds people by text.
  let q = a.search;
  if (a.resident) {
    const t = await prisma.tenant.findUnique({ where: { id: a.resident }, select: { firstName: true, lastName: true } });
    if (!t) throw new HttpError(404, "No such resident.");
    q = `${t.firstName} ${t.lastName}`.trim();
  }
  let site: string | undefined;
  if (a.site) {
    const codes = a.site.split(",").map((s) => s.trim()).filter(Boolean);
    if (codes.length > 1) throw new HttpError(400, "A basic form's export takes one site at a time.");
    const s = await prisma.site.findUnique({ where: { code: codes[0] }, select: { id: true } });
    if (!s) throw new HttpError(404, `No site "${codes[0]}".`);
    site = s.id;
  }
  const query = { format: a.format, q, site, from: a.from, to: a.to, status: a.includeVoided ? "all" : "active", archived: "all" };
  const call = a.ids?.length ? ({ method: "POST", path, query, body: { ids: a.ids } } as const) : ({ method: "GET", path, query } as const);
  return makeDownload(fillRouter, call, user, { from, fallbackName: form.title });
}

export const exportRosterShape = {
  format,
  site: z.string().max(400).optional().describe("Site code(s), comma-separated. Leave out for every site you can see."),
  status: z.enum(["active", "attention", "archived"]).optional().describe("active (default), attention (past the review threshold) or archived (moved out)."),
  q: z.string().max(120).optional().describe("Name or unit."),
};
export const EXPORT_ROSTER_HELP = `The resident roster as a file (as Roster → Export): who lives where, by site — for a site list, a move-out list, a review list. ${LINK}`;
export const exportRoster = (user: CurrentUser, a: z.infer<z.ZodObject<typeof exportRosterShape>>, from?: CallFrom) =>
  makeDownload(tenantsRouter, { method: "GET", path: "/export", query: { format: a.format, site: a.site, status: a.status, q: a.q } }, user, { from, fallbackName: "Roster" });

export const exportAttendanceShape = {
  format,
  event: z.string().max(40).optional().describe("One attendance record's id (list_attendance): its sign-in sheet."),
  ids: z.array(z.string().max(40)).max(500).optional().describe("Several attendance records' ids."),
  site: z.string().max(400).optional().describe("Site code(s), comma-separated."),
  q: z.string().max(120).optional().describe("Text in the activity's title."),
};
export const EXPORT_ATTENDANCE_HELP = `Attendance as a file (as Attendance → Export): one record's sign-in sheet (event), chosen records (ids), or everything at a site or matching a title. ${LINK}`;
export function exportAttendance(user: CurrentUser, a: z.infer<z.ZodObject<typeof exportAttendanceShape>>, from?: CallFrom) {
  if (a.event) return makeDownload(attendanceRouter, { method: "GET", path: `/${enc(a.event)}/export`, query: { format: a.format } }, user, { from, fallbackName: "Attendance" });
  return makeDownload(attendanceRouter, { method: "GET", path: "/export", query: { format: a.format, site: a.site, q: a.q, ids: a.ids?.join(",") } }, user, { from, fallbackName: "Attendance" });
}

export const countEntriesShape = {
  form: z.string().describe("The form's slug (list_forms), basic or code."),
  by: z
    .array(z.string().max(130))
    .min(1)
    .max(2)
    .describe(`One or two of ${GROUPS.join(", ")}, or field:<id> — a basic form's field id (get_form), or a path into a code form's saved data (e.g. field:type, field:site.name; list_code_entries shows the shape). Two make a cross-tab.`),
  from: z.string().max(10).optional().describe("YYYY-MM-DD"),
  to: z.string().max(10).optional().describe("YYYY-MM-DD"),
  site: z.string().max(400).optional().describe("Site code(s), comma-separated."),
  search: z.string().max(120).optional(),
  includeVoided: z.boolean().optional(),
};
export const COUNT_ENTRIES_HELP =
  "Count a form's entries, grouped — the numbers for a report without paging through every entry: by site, month, week, day, weekday, hour, who filed, status, or any field's answer (e.g. incidents by type and site; meals by weekday). Counts only what this person can see, and says which. Use it before list_entries / list_code_entries whenever the question is \"how many\".";
export const countEntriesTool = (user: CurrentUser, a: z.infer<z.ZodObject<typeof countEntriesShape>>) => countEntries(user, a);
