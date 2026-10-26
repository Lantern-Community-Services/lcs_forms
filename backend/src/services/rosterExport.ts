import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import type { TenantDTO } from "./roster.js";
import type { ScopedSite } from "./siteScope.js";
import type { RosterStatus } from "./rosterQuery.js";
import { scopeLabel, stamp, TZ } from "./exportCommon.js";

/**
 * Roster exports: CSV, Excel (a real Excel table), and a print-ready PDF.
 *
 * Deliberately left out of every format: staff notes. They're internal, and an
 * export is the easiest way for them to leave the building.
 */

export interface ExportContext {
  sites: ScopedSite[];
  /** Every site the person could have picked — to say "All my sites" honestly. */
  isAll: boolean;
  status: RosterStatus;
  q: string;
  items: TenantDTO[];
  generatedBy: string;
  generatedAt: Date;
}

const STATUS_LABEL: Record<RosterStatus, string> = {
  active: "On roster",
  attention: "Needs review",
  archived: "Removed",
};

export { scopeLabel };

export function exportFilename(ctx: ExportContext, ext: string) {
  const scope = ctx.sites.length === 1 ? ctx.sites[0].code : ctx.isAll ? "all-sites" : `${ctx.sites.length}-sites`;
  const tab = ctx.status === "active" ? "" : `-${ctx.status === "attention" ? "needs-review" : "removed"}`;
  return `lantern-roster-${scope}${tab}-${ctx.generatedAt.toISOString().slice(0, 10)}.${ext}`;
}

const day = (d: Date | string | null | undefined) => (d ? new Date(d) : null);
const ymd = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "");
/** Timestamps (last on a form, removed) are shown in New York time. */
const pretty = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric" }) : "";
/** Calendar dates (move-in) are stored as midnight UTC; read them in UTC or they slip a day. */
const prettyDate = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }) : "";

function statusOf(t: TenantDTO) {
  if (t.status === "archived") return "Removed";
  return t.needsAttention ? "Needs review" : "On roster";
}

interface Column {
  header: string;
  value: (t: TenantDTO) => string | number | Date | null;
  width: number;
  date?: boolean;
}

function columns(ctx: ExportContext): Column[] {
  const archived = ctx.status === "archived";
  return [
    { header: "Site", value: (t) => t.site?.name ?? "", width: 22 },
    { header: "Unit", value: (t) => t.unit ?? "", width: 10 },
    { header: "Last name", value: (t) => t.lastName, width: 18 },
    { header: "First name", value: (t) => t.firstName, width: 16 },
    { header: "Goes by", value: (t) => t.preferredName ?? "", width: 14 },
    { header: "Status", value: statusOf, width: 14 },
    { header: "High Acuity", value: (t) => (t.highAcuity ? "Yes" : ""), width: 12 },
    { header: "Moved in", value: (t) => day(t.moveInDate), width: 12, date: true },
    { header: "Last on a form", value: (t) => day(t.lastActivityAt), width: 15, date: true },
    { header: "Last form", value: (t) => t.lastActivitySource ?? "", width: 26 },
    { header: "Last confirmed", value: (t) => day(t.lastKeptAt), width: 15, date: true },
    ...(archived
      ? [
          { header: "Removed on", value: (t: TenantDTO) => day(t.archivedAt), width: 12, date: true },
          { header: "Removal reason", value: (t: TenantDTO) => t.archiveReason ?? "", width: 30 },
        ]
      : []),
    { header: "External ID", value: (t) => t.externalId ?? "", width: 14 },
    { header: "Roster ID", value: (t) => t.id, width: 28 },
  ];
}

// ── CSV ──────────────────────────────────────────────────────────────────

/**
 * RFC 4180, UTF-8 with a BOM so Excel on Windows reads accented names right.
 * Cells that would start a formula are prefixed with a quote — a resident
 * named "=HYPERLINK(...)" must not become a live link on someone's desktop.
 */
export function toCsv(ctx: ExportContext): Buffer {
  const cols = columns(ctx);
  const cell = (v: unknown) => {
    let s = v instanceof Date ? ymd(v) : v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map((c) => cell(c.header)).join(","), ...ctx.items.map((t) => cols.map((c) => cell(c.value(t))).join(","))];
  const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
  return Buffer.concat([BOM, Buffer.from(lines.join("\r\n") + "\r\n", "utf8")]);
}

// ── Excel ────────────────────────────────────────────────────────────────

/** One sheet with a proper Excel table (filter buttons, banded rows, a name). */
export async function toXlsx(ctx: ExportContext): Promise<Buffer> {
  const cols = columns(ctx);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Lantern Roster";
  wb.created = ctx.generatedAt;
  const ws = wb.addWorksheet("Roster", { views: [{ state: "frozen", ySplit: 3 }] });

  ws.getCell("A1").value = `Lantern Roster — ${scopeLabel(ctx)} · ${STATUS_LABEL[ctx.status]}`;
  ws.getCell("A1").font = { bold: true, size: 14 };
  ws.getCell("A2").value = `${ctx.items.length} ${ctx.items.length === 1 ? "person" : "people"}${ctx.q ? ` matching “${ctx.q}”` : ""} · exported ${stamp(ctx.generatedAt)} by ${ctx.generatedBy}`;
  ws.getCell("A2").font = { italic: true, color: { argb: "FF6A7189" } };

  cols.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width;
    if (c.date) ws.getColumn(i + 1).numFmt = "mmm d, yyyy";
  });

  // An Excel table needs at least one data row.
  const rows = ctx.items.length ? ctx.items.map((t) => cols.map((c) => c.value(t))) : [cols.map(() => null)];
  ws.addTable({
    name: "Roster",
    ref: "A3",
    headerRow: true,
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: cols.map((c) => ({ name: c.header, filterButton: true })),
    rows,
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── PDF ──────────────────────────────────────────────────────────────────

/**
 * Print layout: US Letter, grouped by site, a heading and column header repeated
 * on every page, and an empty "Seen" box per person so a printed copy works as
 * a walk-through headcount sheet.
 */
export function toPdf(ctx: ExportContext): Promise<Buffer> {
  const archived = ctx.status === "archived";
  const doc = new PDFDocument({ size: "LETTER", margin: 40, bufferPages: true, info: { Title: `Lantern Roster — ${scopeLabel(ctx)}`, Author: "Lantern Roster" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const INK = "#232a3a";
  const MUTED = "#6a7189";
  const LINE = "#e2e6ee";
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 18; // room for the footer

  type PdfCol = { header: string; w: number; value: (t: TenantDTO) => string };
  const cols: PdfCol[] = archived
    ? [
        { header: "Unit", w: 50, value: (t) => t.unit ?? "" },
        { header: "Name", w: 150, value: (t) => t.displayName },
        { header: "Legal name", w: 110, value: (t) => (t.preferredName ? `${t.firstName} ${t.lastName}` : "") },
        { header: "Removed", w: 70, value: (t) => pretty(t.archivedAt) },
        { header: "Reason", w: width - 380, value: (t) => t.archiveReason ?? "" },
      ]
    : [
        { header: "Seen", w: 34, value: () => "" },
        { header: "Unit", w: 50, value: (t) => t.unit ?? "" },
        { header: "Name", w: 150, value: (t) => t.displayName },
        { header: "Legal name", w: 110, value: (t) => (t.preferredName ? `${t.firstName} ${t.lastName}` : "") },
        { header: "Moved in", w: 70, value: (t) => prettyDate(t.moveInDate) },
        { header: "Last on a form", w: width - 414, value: (t) => (t.lastActivityAt ? pretty(t.lastActivityAt) : "—") },
      ];
  const ROW = 18;

  function pageTitle() {
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(15).text(`Lantern Roster — ${scopeLabel(ctx)}`, left, doc.page.margins.top, { width });
    doc
      .fillColor(MUTED)
      .font("Helvetica")
      .fontSize(9)
      .text(
        `${STATUS_LABEL[ctx.status]} · ${ctx.items.length} ${ctx.items.length === 1 ? "person" : "people"}${ctx.q ? ` matching “${ctx.q}”` : ""} · printed ${stamp(ctx.generatedAt)} by ${ctx.generatedBy}${archived ? "" : " · amber dot = due for review"}`,
        { width }
      );
    doc.moveDown(0.8);
  }

  function columnHeader() {
    const y = doc.y;
    let x = left;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED);
    for (const c of cols) {
      doc.text(c.header.toUpperCase(), x + 3, y, { width: c.w - 6, lineBreak: false });
      x += c.w;
    }
    doc.moveTo(left, y + 12).lineTo(left + width, y + 12).lineWidth(0.8).strokeColor(MUTED).stroke();
    doc.y = y + 16;
  }

  function newPage() {
    doc.addPage();
    pageTitle();
  }

  function siteHeading(name: string, count: number, continued = false) {
    if (doc.y + 22 + ROW * 2 > bottom()) newPage();
    const y = doc.y;
    doc.rect(left, y, width, 20).fill("#eef1f6");
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(10.5).text(`${name}${continued ? " (continued)" : ""}`, left + 6, y + 5.5, { width: width - 80, lineBreak: false });
    doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(`${count}`, left + width - 70, y + 6, { width: 64, align: "right", lineBreak: false });
    doc.y = y + 26;
    columnHeader();
  }

  pageTitle();
  if (ctx.items.length === 0) {
    doc.fillColor(MUTED).font("Helvetica").fontSize(11).text("Nobody matches this selection.", left, doc.y + 10);
  }

  // Group by site (archived is ordered by date, so it groups as one list).
  const groups: { name: string; items: TenantDTO[] }[] = [];
  const grouped = !archived && ctx.sites.length > 1;
  for (const t of ctx.items) {
    const name = grouped ? t.site?.name ?? "" : scopeLabel(ctx);
    if (!groups.length || groups[groups.length - 1].name !== name) groups.push({ name, items: [] });
    groups[groups.length - 1].items.push(t);
  }

  for (const g of groups) {
    siteHeading(g.name, g.items.length);
    g.items.forEach((t, i) => {
      if (doc.y + ROW > bottom()) {
        newPage();
        siteHeading(g.name, g.items.length, true);
      }
      const y = doc.y;
      if (i % 2 === 1) doc.rect(left, y - 3, width, ROW).fill("#f6f8fb");
      let x = left;
      for (const c of cols) {
        if (c.header === "Seen") {
          doc.rect(x + 10, y - 0.5, 10, 10).lineWidth(0.8).strokeColor(MUTED).stroke();
        } else {
          const bold = c.header === "Name" || c.header === "Unit";
          doc
            .fillColor(INK)
            .font(bold ? "Helvetica-Bold" : "Helvetica")
            .fontSize(9.5)
            .text(c.value(t), x + 3, y, { width: c.w - 6, height: ROW - 4, lineBreak: false, ellipsis: true });
        }
        x += c.w;
      }
      if (!archived && t.needsAttention) {
        // A small amber mark beside anyone due for review.
        doc.circle(left + width - 6, y + 4, 2.5).fill("#d99327");
      }
      doc.moveTo(left, y + ROW - 3).lineTo(left + width, y + ROW - 3).lineWidth(0.4).strokeColor(LINE).stroke();
      doc.y = y + ROW;
    });
    doc.y += 8;
  }

  // Footers, now that the page count is known.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Text inside the bottom margin makes pdfkit start a new page; lift the
    // margin while the footer is drawn.
    const margin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - margin - 8;
    doc.fillColor(MUTED).font("Helvetica").fontSize(8);
    doc.text("Confidential — resident information. Do not leave unattended.", left, y, { width: width / 2, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, left + width / 2, y, { width: width / 2, align: "right", lineBreak: false });
    doc.page.margins.bottom = margin;
  }
  doc.end();
  return done;
}
