import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { z } from "zod";
import { stamp, TZ } from "../services/exportCommon.js";

/**
 * Excel, PDF and CSV files for code forms (app.export in a page). The page
 * hands over what it's showing — a title, a few headline numbers and one or
 * more tables — and the file is built here with the same look as the app's own
 * exports (Hot Foods, the roster).
 */

const column = z.object({
  key: z.string().min(1).max(100),
  label: z.string().min(1).max(100),
  /** text (default) | number | date ("YYYY-MM-DD" or ISO) | datetime (ISO) */
  type: z.enum(["text", "number", "date", "datetime"]).optional(),
  /** Relative width (Excel characters; PDF share of the page). */
  width: z.number().min(2).max(120).optional(),
});

export const exportSpec = z.object({
  format: z.enum(["xlsx", "pdf", "csv"]),
  filename: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(200),
  subtitle: z.string().max(400).optional(),
  /** Headline numbers printed above the tables (and on a Summary sheet in Excel). */
  stats: z.array(z.object({ label: z.string().max(60), value: z.union([z.string().max(60), z.number()]) })).max(12).optional(),
  sheets: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(31),
        columns: z.array(column).min(1).max(40),
        rows: z.array(z.record(z.unknown())).max(20_000),
      })
    )
    .min(1)
    .max(12),
  /** PDF only: default true when a table has more than 5 columns. */
  landscape: z.boolean().optional(),
});
export type ExportSpec = z.infer<typeof exportSpec>;

const TYPES = {
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" },
  pdf: { mime: "application/pdf", ext: "pdf" },
  csv: { mime: "text/csv; charset=utf-8", ext: "csv" },
} as const;

const INK = "#232a3a";
const MUTED = "#6a7189";

/** Spreadsheet formula injection: a cell starting with = + - @ is shown as text. */
const safe = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

type Col = z.infer<typeof column>;

function value(row: Record<string, unknown>, c: Col): string | number | Date | null {
  const v = row[c.key];
  if (v === null || v === undefined || v === "") return null;
  if (c.type === "number") {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : String(v);
  }
  if (c.type === "date" || c.type === "datetime") {
    const d = new Date(typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00Z` : String(v));
    return Number.isNaN(d.getTime()) ? String(v) : d;
  }
  if (typeof v === "object") return Array.isArray(v) ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ") : JSON.stringify(v);
  return String(v);
}

function text(v: ReturnType<typeof value>, c: Col): string {
  if (v === null) return "";
  if (v instanceof Date) {
    return c.type === "date"
      ? v.toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric" })
      : v.toLocaleString("en-US", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" });
  }
  if (typeof v === "number") return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return v;
}

function csv(spec: ExportSpec): Buffer {
  const sheet = spec.sheets[0];
  const cell = (s: string) => {
    const t = safe(s);
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines = [
    sheet.columns.map((c) => cell(c.label)).join(","),
    ...sheet.rows.map((r) =>
      sheet.columns
        .map((c) => {
          const v = value(r, c);
          return cell(v instanceof Date ? (c.type === "date" ? v.toISOString().slice(0, 10) : v.toISOString()) : v === null ? "" : String(v));
        })
        .join(",")
    ),
  ];
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join("\r\n") + "\r\n", "utf8")]);
}

async function xlsx(spec: ExportSpec, by: string, at: Date): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Lantern Forms";
  wb.created = at;
  const note = `${spec.subtitle ? `${spec.subtitle} · ` : ""}exported ${stamp(at)} by ${by}`;
  if (spec.stats?.length) {
    const ws = wb.addWorksheet("Summary");
    ws.getCell("A1").value = spec.title;
    ws.getCell("A1").font = { bold: true, size: 14 };
    ws.getCell("A2").value = note;
    ws.getCell("A2").font = { italic: true, color: { argb: "FF6A7189" } };
    ws.getColumn(1).width = 34;
    ws.getColumn(2).width = 18;
    spec.stats.forEach((s, i) => {
      ws.getCell(`A${i + 4}`).value = s.label;
      ws.getCell(`B${i + 4}`).value = s.value;
      ws.getCell(`B${i + 4}`).font = { bold: true };
    });
  }
  const used = new Set<string>();
  spec.sheets.forEach((sheet, si) => {
    let name = sheet.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || `Sheet ${si + 1}`;
    while (used.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${si + 1}`;
    used.add(name.toLowerCase());
    const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 3 }] });
    ws.getCell("A1").value = spec.sheets.length > 1 ? `${spec.title} · ${sheet.name}` : spec.title;
    ws.getCell("A1").font = { bold: true, size: 14 };
    ws.getCell("A2").value = `${sheet.rows.length} rows · ${note}`;
    ws.getCell("A2").font = { italic: true, color: { argb: "FF6A7189" } };
    sheet.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.width = c.width ?? (c.type === "number" ? 12 : c.type === "datetime" ? 20 : c.type === "date" ? 14 : 22);
      if (c.type === "date") col.numFmt = "mmm d, yyyy";
      if (c.type === "datetime") col.numFmt = "mmm d, yyyy h:mm AM/PM";
    });
    ws.addTable({
      name: `T${si + 1}`,
      ref: "A3",
      headerRow: true,
      style: { theme: "TableStyleMedium2", showRowStripes: true },
      columns: sheet.columns.map((c) => ({ name: c.label, filterButton: true })),
      rows: sheet.rows.length
        ? sheet.rows.map((r) =>
            sheet.columns.map((c) => {
              const v = value(r, c);
              if (v instanceof Date && c.type === "datetime") {
                // Excel has no time zones: write New York wall-clock time.
                const ny = new Date(v.toLocaleString("en-US", { timeZone: TZ }));
                return new Date(Date.UTC(ny.getFullYear(), ny.getMonth(), ny.getDate(), ny.getHours(), ny.getMinutes()));
              }
              return typeof v === "string" ? safe(v) : v;
            })
          )
        : [sheet.columns.map(() => null)],
    });
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function pdf(spec: ExportSpec, by: string, at: Date): Promise<Buffer> {
  const landscape = spec.landscape ?? spec.sheets.some((s) => s.columns.length > 5);
  const doc = new PDFDocument({ size: "LETTER", layout: landscape ? "landscape" : "portrait", margin: 36, bufferPages: true, info: { Title: spec.title, Author: "Lantern Forms" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 6;

  doc.fillColor(INK).font("Helvetica-Bold").fontSize(16).text(spec.title, left, doc.page.margins.top, { width });
  doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(`${spec.subtitle ? `${spec.subtitle} · ` : ""}printed ${stamp(at)} by ${by}`, { width });
  doc.moveDown(0.8);

  if (spec.stats?.length) {
    const per = Math.min(4, spec.stats.length);
    const boxW = (width - (per - 1) * 10) / per;
    spec.stats.forEach((s, i) => {
      if (i > 0 && i % per === 0) doc.y += 52;
      const x = left + (i % per) * (boxW + 10);
      const y = doc.y;
      doc.roundedRect(x, y, boxW, 44, 6).lineWidth(0.8).strokeColor("#e2e6ee").stroke();
      doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(s.label.toUpperCase(), x + 9, y + 8, { width: boxW - 18, lineBreak: false, ellipsis: true });
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(16).text(typeof s.value === "number" ? s.value.toLocaleString("en-US") : s.value, x + 9, y + 20, { width: boxW - 18, lineBreak: false, ellipsis: true });
      doc.y = y;
    });
    doc.y += 58;
  }

  const ROW = 17;
  for (const sheet of spec.sheets) {
    const weights = sheet.columns.map((c) => c.width ?? (c.type === "number" ? 8 : c.type === "date" ? 11 : c.type === "datetime" ? 15 : 18));
    const total = weights.reduce((a, b) => a + b, 0);
    const cols = sheet.columns.map((c, i) => ({ c, w: (weights[i] / total) * width }));
    const head = (title: boolean) => {
      if (title && spec.sheets.length > 1) {
        doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text(sheet.name, left, doc.y, { width });
        doc.moveDown(0.3);
      }
      const y = doc.y;
      let x = left;
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(MUTED);
      for (const { c, w } of cols) {
        doc.text(c.label.toUpperCase(), x + 3, y, { width: w - 6, lineBreak: false, ellipsis: true, align: c.type === "number" ? "right" : "left" });
        x += w;
      }
      doc.moveTo(left, y + 11).lineTo(left + width, y + 11).lineWidth(0.8).strokeColor(MUTED).stroke();
      doc.y = y + 15;
    };
    if (doc.y + ROW * 3 > bottom()) doc.addPage();
    head(true);
    if (!sheet.rows.length) doc.fillColor(MUTED).font("Helvetica").fontSize(10).text("Nothing to show.", left, doc.y + 4);
    sheet.rows.forEach((r, i) => {
      if (doc.y + ROW > bottom()) {
        doc.addPage();
        head(false);
      }
      const y = doc.y;
      if (i % 2 === 1) doc.rect(left, y - 3, width, ROW).fill("#f6f8fb");
      let x = left;
      for (const { c, w } of cols) {
        doc.fillColor(INK).font("Helvetica").fontSize(9)
          .text(text(value(r, c), c), x + 3, y, { width: w - 6, height: ROW - 4, lineBreak: false, ellipsis: true, align: c.type === "number" ? "right" : "left" });
        x += w;
      }
      doc.y = y + ROW;
    });
    doc.y += 14;
  }

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const margin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - margin + 10;
    doc.fillColor(MUTED).font("Helvetica").fontSize(8);
    doc.text("Confidential — may contain resident information.", left, y, { width: width / 2, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, left + width / 2, y, { width: width / 2, align: "right", lineBreak: false });
    doc.page.margins.bottom = margin;
  }
  doc.end();
  return done;
}

export async function buildExport(spec: ExportSpec, by: string) {
  const at = new Date();
  const body = spec.format === "csv" ? csv(spec) : spec.format === "xlsx" ? await xlsx(spec, by, at) : await pdf(spec, by, at);
  const base = spec.filename.replace(/\.(xlsx|pdf|csv)$/i, "").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 100) || "export";
  return { body, mime: TYPES[spec.format].mime, filename: `${base}.${TYPES[spec.format].ext}` };
}
