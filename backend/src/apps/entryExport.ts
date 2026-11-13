import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { HttpError } from "../http.js";
import type { CurrentUser } from "../auth/middleware.js";
import { buildExport } from "./exports.js";
import { exportDocument, type ExportDocument } from "./exportDocuments.js";
import { access, dateWhere, runAction, type LoadedApp } from "./runtime.js";

/**
 * Every code form's entries as CSV, Excel or PDF, with no code in the form:
 * the Export button in the form's header and Claude's export_entries
 * (GET /api/apps/:slug/entries-export).
 *
 * Two ways in:
 * - The form has a "pdf" action (form.json): it's run AS THE PERSON with { ids } and lays each entry it lets
 *   them see out as its paper form. The PDF draws those; Excel and CSV take one column per box on the form.
 *   The form's own rules decide what's in the file, so people who can't read every entry can still export
 *   the ones the form shows them.
 * - It hasn't: the entries' saved data, flattened to columns (a nested "client.name" becomes a column),
 *   limited as list_code_entries is — everyone's if the form's "Who sees entries" lets them, else their own.
 *   The PDF lays each entry out as labelled boxes.
 */

export const MAX_PDF = 300;
const MAX_VIA_ACTION = 1000;
const MAX_ROWS = 20_000;
const BATCH = 40; // ids per pdf-action call: the sandbox stops server code after 3 s

export type Format = "csv" | "xlsx" | "pdf";

export interface ExportQuery {
  format: Format;
  ids?: string[];
  resident?: string;
  search?: string;
  site?: string;
  from?: string;
  to?: string;
  includeVoided?: boolean;
  /** Only entries this person filed. */
  mine?: boolean;
  title?: string;
}

/** For tools: which entries, by ids or a filter. */
export const exportFilterShape = {
  ids: z.array(z.string().max(40)).max(MAX_PDF).optional().describe("Entry ids, in the order wanted. Or leave out and filter instead."),
  resident: z.string().max(40).optional().describe("A resident's roster id (list_residents): entries linked to them, plus any that name them (older imported entries often aren't linked)."),
  search: z.string().max(120).optional().describe("Text the entry contains, e.g. a name."),
  site: z.string().max(200).optional().describe("Site code (comma-separate several)."),
  from: z.string().max(10).optional().describe("YYYY-MM-DD"),
  to: z.string().max(10).optional().describe("YYYY-MM-DD"),
  includeVoided: z.boolean().optional(),
  mine: z.boolean().optional().describe("Only entries this person filed."),
};

/** The query string the export route reads (and the tools send). */
export function exportQueryOf(q: Record<string, unknown>): ExportQuery {
  const str = (k: string, max = 200) => (typeof q[k] === "string" && (q[k] as string).trim() ? (q[k] as string).trim().slice(0, max) : undefined);
  const format = q.format === "xlsx" || q.format === "pdf" ? q.format : "csv";
  const ids = str("ids", 20_000)?.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    format,
    ids: ids?.length ? ids : undefined,
    resident: str("resident", 40),
    search: str("search", 120),
    site: str("site"),
    from: str("from", 30),
    to: str("to", 30),
    includeVoided: q.includeVoided === "1" || q.includeVoided === "true",
    mine: q.mine === "1" || q.mine === "true",
    title: str("title", 160),
  };
}

type Row = { id: string; occurredAt: Date; siteId: string | null; createdById: string | null; createdByName: string; status: string };

/** The entries the query picks (oldest first; ids: in the order given), limited to this person's sites. */
async function pick(app: LoadedApp, user: CurrentUser, q: ExportQuery, max: number): Promise<{ rows: Row[]; more: boolean }> {
  const and: Prisma.FormEntryWhereInput[] = [{ formId: app.form.id }, { source: { not: "preview" } }];
  if (!q.includeVoided) and.push({ status: "active" });
  if (user.siteIds) and.push({ OR: [{ siteId: null }, { siteId: { in: user.siteIds } }] });
  if (q.mine) and.push({ createdById: user.userId });
  if (q.ids?.length) and.push({ id: { in: q.ids.slice(0, 5000) } });
  if (q.site) {
    const sites = await prisma.site.findMany({ where: { code: { in: q.site.split(",").map((s) => s.trim()) } }, select: { id: true } });
    and.push({ siteId: { in: sites.map((s) => s.id) } });
  }
  const occurred = dateWhere(q.from, q.to);
  if (occurred) and.push({ occurredAt: occurred });
  if (q.search) and.push({ data: { contains: q.search } });
  if (q.resident) {
    const t = await prisma.tenant.findUnique({ where: { id: q.resident }, select: { id: true, firstName: true, lastName: true, preferredName: true, siteId: true } });
    if (!t || (user.siteIds && !user.siteIds.includes(t.siteId))) throw new HttpError(404, "No such resident at your sites.");
    const names = [...new Set([`${t.firstName} ${t.lastName}`, t.preferredName ? `${t.preferredName} ${t.lastName}` : ""].map((s) => s.trim()).filter((s) => s.includes(" ")))];
    and.push({ OR: [{ tenantId: t.id }, ...names.map((n) => ({ AND: [{ siteId: t.siteId }, { data: { contains: n } }] }))] });
  }
  let rows: Row[] = await prisma.formEntry.findMany({
    where: { AND: and },
    orderBy: { occurredAt: "asc" },
    take: max + 1,
    select: { id: true, occurredAt: true, siteId: true, createdById: true, createdByName: true, status: true },
  });
  if (q.ids?.length) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    rows = [...new Set(q.ids)].map((id) => byId.get(id)).filter((r): r is Row => Boolean(r));
  }
  return { rows: rows.slice(0, max), more: rows.length > max };
}

type ActionDoc = ExportDocument & { entryId?: string };

/** Run the form's pdf action as the person, in batches: one paper-form document per entry they may see. */
async function viaAction(app: LoadedApp, user: CurrentUser, ids: string[]) {
  const action = app.manifest.pdf!.action;
  const out: ActionDoc[] = [];
  let title: string | undefined;
  for (let i = 0; i < ids.length; i += BATCH) {
    const r = await runAction(app, user, action, { ids: ids.slice(i, i + BATCH) });
    if (!r.ok) throw new HttpError(422, `The form couldn't lay its entries out: ${r.error ?? "its pdf action failed"}.`);
    const v = r.value as { documents?: unknown[]; title?: string } | null;
    if (!v || !Array.isArray(v.documents)) throw new HttpError(422, "The form's pdf action didn't return { documents }.");
    for (const [j, d] of v.documents.entries()) {
      const doc = exportDocument.safeParse(d);
      if (!doc.success) throw new HttpError(422, `Document ${i + j + 1} from the form's pdf action isn't a paper-form document: ${doc.error.issues[0]?.path.join(".")} ${doc.error.issues[0]?.message}`);
      const entryId = (d as { entryId?: unknown }).entryId;
      out.push({ ...doc.data, ...(typeof entryId === "string" ? { entryId } : {}) });
    }
    title ??= typeof v.title === "string" ? v.title.slice(0, 160) : undefined;
  }
  return { docs: out, title };
}

// ── Flattening saved data (forms without a pdf action) ───────────────────

const isFile = (v: unknown): v is { fileId: string; name?: string } => Boolean(v && typeof v === "object" && typeof (v as { fileId?: unknown }).fileId === "string");
const CELL = 32_000;

function flatten(v: unknown, path: string, out: Map<string, string>) {
  if (v === null || v === undefined || v === "") return;
  if (Array.isArray(v)) {
    if (!v.length) return;
    if (v.every((x) => x === null || typeof x !== "object")) out.set(path, v.filter((x) => x !== null && x !== "").join("; ").slice(0, CELL));
    else if (v.every(isFile)) out.set(path, `${v.length} file${v.length === 1 ? "" : "s"}`);
    else v.forEach((x, i) => flatten(x, `${path} ${i + 1}`, out));
    return;
  }
  if (isFile(v)) return void out.set(path, v.name ?? "file");
  if (typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) flatten(x, path ? `${path}.${k}` : k, out);
    return;
  }
  if (typeof v === "boolean") return void out.set(path, v ? "Yes" : "No");
  const s = String(v);
  out.set(path, /^data:image\//.test(s) ? "(image)" : s.slice(0, CELL));
}

/** "client.firstName" → "Client › First name". */
const labelOf = (path: string) =>
  path
    .split(".")
    .map((p) => p.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase()))
    .join(" › ")
    .slice(0, 100);

/** A paper-form document's boxes as label → value, in order (Excel and CSV columns). */
function docCells(d: ExportDocument): Map<string, string> {
  const out = new Map<string, string>();
  let section = "";
  const put = (label: string, value: string) => {
    let k = (label || section || "Value").slice(0, 90);
    for (let n = 2; out.has(k); n++) k = `${(label || section).slice(0, 85)} (${n})`;
    out.set(k, value);
  };
  for (const b of d.blocks) {
    if (b.type === "section") section = b.title.replace(/^\s*\d+\.\s*/, "").trim();
    else if (b.type === "fields") for (const f of b.fields) put(f.label, f.image ? "(signature)" : f.value);
    else if (b.type === "choices") put(b.label ?? section, b.checked.join("; "));
  }
  return out;
}

// ── The file ─────────────────────────────────────────────────────────────

const dayOf = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const stampOf = (d: Date) => d.toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });

export async function exportCodeEntries(app: LoadedApp, user: CurrentUser, q: ExportQuery) {
  if (user.guest) throw new HttpError(403, "Sign in to export entries.");
  const a = access(app, user);
  if (!a.canOpen) throw new HttpError(403, "This form is only open to some people.");
  const viaPdf = Boolean(app.manifest.pdf?.action);
  // Without the form's own rules, it's the list's: everyone's only for those the form lets read them.
  const q2: ExportQuery = viaPdf || a.readAll ? q : { ...q, mine: true };
  const max = q.format === "pdf" ? MAX_PDF : viaPdf ? MAX_VIA_ACTION : MAX_ROWS;
  const { rows, more } = await pick(app, user, q2, max);
  if (more) throw new HttpError(413, `More than ${max.toLocaleString("en-US")} entries match${q.format === "pdf" ? " (a PDF holds that many)" : ""}. Narrow the dates or site, or use Excel.`);
  if (!rows.length) throw new HttpError(404, q2.mine && !q.mine ? "You haven't filed any entries that match (you can only export your own on this form)." : "No entries match.");
  const sites = new Map((await prisma.site.findMany({ select: { id: true, name: true } })).map((s) => [s.id, s.name]));
  const title = q.title ?? app.manifest.title;
  const filename = `${title} - ${dayOf(new Date())}`;
  const meta = new Map(rows.map((r) => [r.id, r]));

  let docs: ActionDoc[] = [];
  let records: { row: Row | undefined; cells: Map<string, string> }[];
  if (viaPdf) {
    docs = (await viaAction(app, user, rows.map((r) => r.id))).docs;
    if (!docs.length) throw new HttpError(403, `${rows.length} entries match, but this form doesn't show you any of them.`);
    records = docs.map((d) => ({ row: d.entryId ? meta.get(d.entryId) : undefined, cells: docCells(d) }));
  } else {
    const data = new Map((await prisma.formEntry.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, data: true } })).map((e) => [e.id, e.data]));
    records = rows.map((row) => {
      const cells = new Map<string, string>();
      try {
        flatten(JSON.parse(data.get(row.id) ?? "null"), "", cells);
      } catch {
        /* unreadable data: just the entry's own columns */
      }
      return { row, cells: new Map([...cells].map(([k, v]) => [labelOf(k), v])) };
    });
  }

  if (q.format === "pdf") {
    const documents: ExportDocument[] = viaPdf
      ? docs.map(({ entryId: _id, ...d }) => d)
      : records.map(({ row, cells }) => {
          const fields = [...cells].map(([label, value]) => ({ label, value: value.slice(0, 7900), width: value.length > 60 ? 2 : 1 }));
          const blocks: ExportDocument["blocks"] = [];
          for (let i = 0; i < fields.length; ) {
            const take = fields[i].width > 1 ? 1 : Math.min(2, fields.length - i);
            blocks.push({ type: "fields", fields: fields.slice(i, i + take) });
            i += take;
          }
          return {
            title: app.manifest.title,
            org: "Lantern Community Services",
            intro: row ? `${stampOf(row.occurredAt)}${row.siteId ? ` · ${sites.get(row.siteId) ?? ""}` : ""}${row.createdByName ? ` · by ${row.createdByName}` : ""} · Entry ${row.id}` : undefined,
            stamp: row?.status === "voided" ? "VOIDED" : undefined,
            footer: `${app.manifest.title}${row ? ` · ${dayOf(row.occurredAt)}` : ""}`,
            blocks: blocks.length ? blocks : [{ type: "note", text: "Nothing was filled in." }],
          };
        });
    return buildExport({ format: "pdf", filename, title, sheets: [], documents }, user.name);
  }

  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of records) for (const k of r.cells.keys()) if (!seen.has(k)) (seen.add(k), keys.push(k));
  const columns = [
    { key: "__id", label: "Entry ID", width: 26 },
    { key: "__at", label: "Date", type: "datetime" as const, width: 18 },
    { key: "__site", label: "Site", width: 18 },
    { key: "__by", label: "Filed by", width: 20 },
    { key: "__status", label: "Status", width: 10 },
    ...keys.map((k, i) => ({ key: `c${i}`, label: k.slice(0, 100), width: 24 })),
  ];
  const sheetRows = records.map(({ row, cells }) => {
    const o: Record<string, unknown> = {
      __id: row?.id ?? "",
      __at: row ? row.occurredAt.toISOString() : "",
      __site: row?.siteId ? sites.get(row.siteId) ?? "" : "",
      __by: row?.createdByName ?? "",
      __status: row?.status ?? "",
    };
    keys.forEach((k, i) => (o[`c${i}`] = cells.get(k) ?? ""));
    return o;
  });
  return buildExport({ format: q.format, filename, title, subtitle: `${records.length} ${records.length === 1 ? "entry" : "entries"}`, sheets: [{ name: "Entries", columns, rows: sheetRows }] }, user.name);
}
