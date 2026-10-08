import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { z } from "zod";
import { stamp, TZ } from "../services/exportCommon.js";

/**
 * Excel, PDF and CSV files for code forms (app.export and app.print(spec) in a
 * page). The page hands over what it's showing — a title, a few headline
 * numbers, charts and one or more tables — and the file is built here with the
 * same look as the app's own exports (the roster's, for one). Charts are
 * redrawn with PDF primitives in the light-mode chart palette, so a printed
 * report matches the screen and doesn't depend on the browser's print engine.
 */

const column = z.object({
  key: z.string().min(1).max(100),
  label: z.string().min(1).max(100),
  /** text (default) | number | date ("YYYY-MM-DD" or ISO) | datetime (ISO) */
  type: z.enum(["text", "number", "date", "datetime"]).optional(),
  /** Relative width (Excel characters; PDF share of the page). */
  width: z.number().min(2).max(120).optional(),
});

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "A color is a hex value like #2c3453.");
const slot = z.number().int().min(0).max(7).nullable();
/** A palette slot, a site type, or a hex color. */
const colorOf = { slot: slot.optional(), siteType: z.string().max(40).optional(), color: hex.optional() };
const label = z.string().max(120);

const chart = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("dailyBars"),
    title: label,
    data: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), meals: z.number().min(0), parts: z.record(z.number().min(0)) })).max(400),
    series: z.array(z.object({ key: z.string().max(100), name: label, slot })).max(20),
  }),
  z.object({
    type: z.literal("rankedBars"),
    title: label,
    unit: z.string().max(40),
    rows: z.array(z.object({ name: label, value: z.number(), note: z.string().max(80).optional(), ...colorOf })).max(200),
    limit: z.number().int().min(1).max(200).optional(),
    legend: z.array(z.object({ label: z.string().max(60), ...colorOf })).max(12).optional(),
  }),
  z.object({
    type: z.literal("heatGrid"),
    title: label,
    note: z.string().max(200).optional(),
    unit: z.string().max(40).optional(),
    heat: z.array(z.array(z.number().min(0)).length(24)).length(7),
  }),
]);
export type ExportChart = z.infer<typeof chart>;

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
  /** PDF only: default true when there are charts, or a table has more than 5 columns. */
  landscape: z.boolean().optional(),
  /** PDF only: drawn after the headline numbers, before the tables. */
  charts: z.array(chart).max(12).optional(),
  /** PDF only: false leaves the tables out (the charts say it all). */
  pdfTables: z.boolean().optional(),
});
export type ExportSpec = z.infer<typeof exportSpec>;

const TYPES = {
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" },
  pdf: { mime: "application/pdf", ext: "pdf" },
  csv: { mime: "text/csv; charset=utf-8", ext: "csv" },
} as const;

const INK = "#232a3a";
const MUTED = "#6a7189";
const LINE = "#e2e6ee";
const BAR = "#2d4a86";
/**
 * The light-mode values of the validated chart palette in frontend index.css
 * (--viz-*), so a printed chart wears the same colors as the screen.
 */
const VIZ = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const VIZ_OTHER = "#898781";
const SITE_TYPE: Record<string, string> = { supportive: "#4a3aa7", shelter: "#008300", other: "#898781" };
const SEQ = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
const slotHex = (s: number | null | undefined) => (s === null || s === undefined ? VIZ_OTHER : VIZ[s] ?? VIZ_OTHER);
/** A row's or legend item's color: hex, then site type, then slot; the app's bar navy when none is given. */
function colorHex(c: { slot?: number | null; siteType?: string; color?: string }) {
  if (c.color) return c.color;
  if (c.siteType !== undefined) return SITE_TYPE[c.siteType] ?? SITE_TYPE.other;
  if (c.slot !== undefined) return slotHex(c.slot);
  return BAR;
}

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
  const landscape = spec.landscape ?? (Boolean(spec.charts?.length) || spec.sheets.some((s) => s.columns.length > 5));
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
    // One row of tiles on a landscape page (up to six), as the Reports screen.
    const per = Math.min(width >= 600 ? 6 : 4, spec.stats.length);
    const boxW = (width - (per - 1) * 10) / per;
    spec.stats.forEach((s, i) => {
      if (i > 0 && i % per === 0) doc.y += 52;
      const x = left + (i % per) * (boxW + 10);
      const y = doc.y;
      doc.roundedRect(x, y, boxW, 44, 6).lineWidth(0.8).strokeColor("#e2e6ee").stroke();
      // One line each, shrunk (then shortened) to fit the tile, so a long label never runs into its number.
      doc.font("Helvetica");
      const label = fitSize(doc, s.label.toUpperCase(), boxW - 18, 8, 6.5);
      doc.fillColor(MUTED).text(label, x + 9, y + 8, { lineBreak: false });
      doc.font("Helvetica-Bold");
      const shown = fitSize(doc, typeof s.value === "number" ? s.value.toLocaleString("en-US") : s.value, boxW - 18, 16, 10);
      doc.fillColor(INK).text(shown, x + 9, y + 21, { lineBreak: false });
      doc.y = y;
    });
    doc.y += 58;
  }

  if (spec.charts?.length) drawCharts(doc, spec.charts, { left, width, bottom });
  for (const sheet of spec.pdfTables === false ? [] : spec.sheets) drawTable(doc, sheet, spec.sheets.length > 1, { left, width, bottom });

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

// ── Charts ────────────────────────────────────────────────────────────────

const fmt = (n: number) => (Number.isInteger(n) ? n : Math.round(n * 10) / 10).toLocaleString("en-US");
const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });

/** 0 and three or four round steps up to at least `max` (whole numbers: counts don't come in quarters). */
function niceTicks(max: number) {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? 10 * mag);
  const out: number[] = [];
  for (let v = 0; v < max + step * 0.001; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

type Doc = PDFKit.PDFDocument;

/**
 * `s` shortened with … to fit `w` points in the current font. PDFKit wraps a
 * too-long line even with lineBreak: false, so single-line text is fitted
 * before it's drawn.
 */
function fit(doc: Doc, s: string, w: number) {
  if (doc.widthOfString(s) <= w) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.widthOfString(`${s.slice(0, mid).trimEnd()}…`) <= w) lo = mid;
    else hi = mid - 1;
  }
  return lo ? `${s.slice(0, lo).trimEnd()}…` : "";
}

/** Sets the largest font size from `max` down to `min` at which `s` fits `w`; returns the text to draw (fitted at `min`). */
function fitSize(doc: Doc, s: string, w: number, max: number, min: number) {
  for (let size = max; size >= min; size -= 0.5) {
    doc.fontSize(size);
    if (doc.widthOfString(s) <= w) return s;
  }
  return fit(doc, s, w);
}

/** Card chrome, as the Section cards on screen: a hairline rounded box with the title inside. */
const CARD = { pad: 14, gap: 12, title: 22, radius: 8 };
const LEGEND_H = 18;
const ROW_H = 17;
const DAILY_PLOT_H = 160;
const HEAT_ROW = 18;

/** The hours a heat grid shows: the ones in use, widened to at least 12 so one busy hour isn't a lone square. */
function heatHours(heat: number[][]) {
  const used = Array.from({ length: 24 }, (_, h) => h).filter((h) => heat.some((row) => row[h] > 0));
  if (!used.length) return [];
  let from = used[0];
  let to = used[used.length - 1];
  while (to - from + 1 < 12) {
    if (from > 0) from--;
    if (to - from + 1 < 12 && to < 23) to++;
  }
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** Swatch + label rows: every color on a chart is named. Returns the height used. */
function drawLegend(doc: Doc, items: { label: string; color: string }[], x0: number, y0: number, w: number) {
  let x = x0;
  let y = y0;
  doc.font("Helvetica").fontSize(8.5);
  for (const it of items) {
    const iw = doc.widthOfString(it.label) + 22;
    if (x + iw > x0 + w && x > x0) {
      x = x0;
      y += 14;
    }
    doc.roundedRect(x, y + 1, 8, 8, 1.5).fill(it.color);
    doc.fillColor(MUTED).text(it.label, x + 12, y, { lineBreak: false });
    x += iw;
  }
  return y - y0 + LEGEND_H;
}

function legendItems(c: ExportChart): { label: string; color: string }[] {
  if (c.type === "dailyBars") return c.series.length > 1 ? c.series.map((s) => ({ label: s.name, color: slotHex(s.slot) })) : [];
  if (c.type === "rankedBars") return c.legend && c.legend.length > 1 ? c.legend.map((l) => ({ label: l.label, color: colorHex(l) })) : [];
  return [];
}

/** The height of a chart's body (inside the card, under its title) at inner width `w`. */
function chartHeight(doc: Doc, c: ExportChart, w: number) {
  const legend = legendItems(c).length ? measureLegend(doc, legendItems(c), w) : 0;
  if (c.type === "dailyBars") return legend + DAILY_PLOT_H + 16;
  if (c.type === "rankedBars") {
    const shown = Math.min(c.rows.length, c.limit ?? c.rows.length);
    return legend + Math.max(1, shown) * ROW_H + (c.limit && c.rows.length > c.limit ? 14 : 0);
  }
  return heatHours(c.heat).length ? 16 + 7 * HEAT_ROW + 16 + 18 : 16;
}

function measureLegend(doc: Doc, items: { label: string; color: string }[], w: number) {
  doc.font("Helvetica").fontSize(8.5);
  let x = 0;
  let lines = 1;
  for (const it of items) {
    const iw = doc.widthOfString(it.label) + 22;
    if (x + iw > w && x > 0) {
      x = 0;
      lines++;
    }
    x += iw;
  }
  return (lines - 1) * 14 + LEGEND_H;
}

/** Draws a chart's body at (x, y), inner width w. */
function drawChartBody(doc: Doc, c: ExportChart, x: number, y: number, w: number) {
  const items = legendItems(c);
  if (items.length) y += drawLegend(doc, items, x, y, w);

  if (c.type === "dailyBars") {
    // Vertical bars per day, stacked by series in the order given (a fixed color order).
    const h = DAILY_PLOT_H;
    const top = y;
    const max = Math.max(1, ...c.data.map((d) => d.meals));
    const axisW = 30;
    const plotW = w - axisW;
    const step = plotW / Math.max(1, c.data.length);
    const barW = Math.max(1, Math.min(22, step * 0.72));
    const ticks = niceTicks(max);
    const scaleMax = ticks[ticks.length - 1];
    doc.font("Helvetica").fontSize(7.5);
    for (const tv of ticks) {
      const ty = top + h - (tv / scaleMax) * h;
      doc.moveTo(x + axisW, ty).lineTo(x + w, ty).lineWidth(0.4).strokeColor(LINE).stroke();
      doc.fillColor(MUTED).text(fmt(tv), x, ty - 4, { width: axisW - 6, align: "right", lineBreak: false });
    }
    c.data.forEach((d, i) => {
      if (!d.meals) return;
      const bx = x + axisW + i * step + (step - barW) / 2;
      const segs = c.series.filter((s) => d.parts[s.key]);
      if (!segs.length) {
        doc.rect(bx, top + h - (d.meals / scaleMax) * h, barW, Math.max(0.3, (d.meals / scaleMax) * h)).fill(BAR);
        return;
      }
      let acc = 0;
      segs.forEach((s, j) => {
        const y0 = top + h - (acc / scaleMax) * h;
        acc += d.parts[s.key];
        const y1 = top + h - (acc / scaleMax) * h;
        // A 1pt paper-white gap between segments, so neighbours never merge.
        const gap = j === segs.length - 1 ? 0 : 1;
        doc.rect(bx, y1 + gap, barW, Math.max(0.3, y0 - y1 - gap)).fill(slotHex(s.slot));
      });
    });
    // About eight day labels along the axis, never every bar.
    const every = Math.max(1, Math.ceil(c.data.length / 8));
    c.data.forEach((d, i) => {
      if (i % every) return;
      doc.fillColor(MUTED).fontSize(7.5).text(dayLabel(d.day), x + axisW + i * step + step / 2 - 22, top + h + 5, { width: 44, align: "center", lineBreak: false });
    });
    return;
  }

  if (c.type === "rankedBars") {
    const rows = c.rows.slice(0, c.limit ?? c.rows.length);
    if (!rows.length) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(9).text("Nothing in this range.", x, y + 2, { width: w });
      return;
    }
    const max = Math.max(1, ...rows.map((r) => r.value));
    // Name and value columns as wide as their longest text needs (within limits),
    // the bar taking the rest; anything longer is shortened with …, never wrapped.
    const values = rows.map((r) => `${fmt(r.value)} ${c.unit}${r.note ? ` · ${r.note}` : ""}`);
    doc.font("Helvetica").fontSize(9);
    const nameW = Math.min(w * 0.32, Math.max(60, ...rows.map((r) => doc.widthOfString(r.name))) + 10);
    doc.font("Helvetica-Bold").fontSize(9);
    const valW = Math.min(w * 0.4, Math.max(...values.map((v) => doc.widthOfString(v))) + 4);
    const barMax = Math.max(40, w - nameW - valW - 8);
    rows.forEach((r, i) => {
      const ry = y + i * ROW_H;
      doc.fillColor(INK).font("Helvetica").fontSize(9).text(fit(doc, r.name, nameW - 10), x, ry + 2, { lineBreak: false });
      doc.roundedRect(x + nameW, ry + 3, Math.max(2, (Math.max(0, r.value) / max) * barMax), ROW_H - 7, 2).fill(colorHex(r));
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(9).text(fit(doc, values[i], valW), x + nameW + barMax + 8, ry + 2, { lineBreak: false });
    });
    if (c.limit && c.rows.length > c.limit) doc.fillColor(MUTED).font("Helvetica").fontSize(8.5).text(`and ${c.rows.length - c.limit} more`, x, y + rows.length * ROW_H + 2, { width: w });
    return;
  }

  // heatGrid: weekday × hour on the sequential blue scale, with its key.
  const hours = heatHours(c.heat);
  if (!hours.length) {
    doc.fillColor(MUTED).font("Helvetica").fontSize(9).text("Nothing in this range.", x, y + 2, { width: w });
    return;
  }
  doc.fillColor(MUTED).font("Helvetica").fontSize(8.5);
  doc.text(fit(doc, c.note ?? "By weekday and hour. Darker blue means more (scale below).", w), x, y, { lineBreak: false });
  const top = y + 16;
  const labelW = 32;
  const cell = Math.min(34, (w - labelW) / hours.length);
  const max = Math.max(1, ...c.heat.flat());
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach((d, wd) => {
    const ry = top + wd * HEAT_ROW;
    doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(d, x, ry + 4, { width: labelW - 4, lineBreak: false });
    hours.forEach((h, i) => {
      const v = c.heat[wd][h];
      doc.rect(x + labelW + i * cell + 1, ry + 1, cell - 2, HEAT_ROW - 2).fill(v ? SEQ[Math.min(SEQ.length - 1, Math.max(0, Math.ceil((v / max) * SEQ.length) - 1))] : "#f3f5f9");
    });
  });
  const every = cell < 24 ? 3 : 2;
  hours.forEach((h, i) => {
    if (i % every) return;
    doc.fillColor(MUTED).fontSize(7).text(hourLabel(h), x + labelW + i * cell + cell / 2 - 18, top + 7 * HEAT_ROW + 3, { width: 36, align: "center", lineBreak: false });
  });
  const ky = top + 7 * HEAT_ROW + 18;
  doc.fillColor(MUTED).fontSize(7.5).text("Fewer", x + labelW, ky + 1, { lineBreak: false });
  SEQ.forEach((col, i) => doc.rect(x + labelW + 30 + i * 14, ky, 12, 9).fill(col));
  doc.fillColor(MUTED).fontSize(7.5).text(`More (${fmt(max)}${c.unit ? ` ${c.unit}` : ""} an hour)`, x + labelW + 30 + SEQ.length * 14 + 4, ky + 1, { lineBreak: false });
}

/**
 * Every chart in a card, laid out like the Reports screen: daily bars across
 * the page, the rest two to a row on a wide page. A row that doesn't fit what's
 * left of the page starts a new one; a card never splits.
 */
function drawCharts(doc: Doc, charts: ExportChart[], page: { left: number; width: number; bottom: () => number }) {
  const { left, width, bottom } = page;
  const twoUp = width >= 600;
  const halfW = (width - CARD.gap) / 2;
  // Rows of one full-width card, or up to two half-width ones.
  const rows: ExportChart[][] = [];
  for (const c of charts) {
    const last = rows[rows.length - 1];
    const full = c.type === "dailyBars" || !twoUp;
    if (!full && last && last.length === 1 && last[0].type !== "dailyBars") last.push(c);
    else rows.push([c]);
  }
  for (const row of rows) {
    const cardW = row.length === 2 || (twoUp && row[0].type !== "dailyBars" && rows.length > 1) ? halfW : width;
    const inner = cardW - CARD.pad * 2;
    const h = Math.max(...row.map((c) => chartHeight(doc, c, inner))) + CARD.title + CARD.pad * 2;
    if (doc.y + h > bottom()) {
      doc.addPage();
      doc.y = doc.page.margins.top;
    }
    const y = doc.y;
    row.forEach((c, i) => {
      const x = left + i * (cardW + CARD.gap);
      doc.roundedRect(x, y, cardW, h, CARD.radius).lineWidth(0.8).strokeColor(LINE).stroke();
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(11.5);
      doc.text(fit(doc, c.title, inner), x + CARD.pad, y + CARD.pad, { lineBreak: false });
      drawChartBody(doc, c, x + CARD.pad, y + CARD.pad + CARD.title, inner);
    });
    doc.x = left;
    doc.y = y + h + CARD.gap;
  }
}

/**
 * One table: headers that wrap onto a second line rather than run into the
 * rows, and cells that wrap up to three lines (then …) rather than cut a name
 * short. A row never splits across pages; the header repeats on each page.
 */
function drawTable(doc: Doc, sheet: ExportSpec["sheets"][number], titled: boolean, page: { left: number; width: number; bottom: () => number }) {
  const { left, width, bottom } = page;
  const PAD = 4;
  const weights = sheet.columns.map((c) => c.width ?? (c.type === "number" ? 8 : c.type === "date" ? 11 : c.type === "datetime" ? 15 : 18));
  const total = weights.reduce((a, b) => a + b, 0);
  // Every column is at least as wide as its longest word (header or cell, a long
  // one capped), so nothing breaks mid-word ("STATU / S"); the width left over is
  // shared by the columns' weights.
  const longest = (s: string) => s.split(/\s+/).reduce((m, w) => Math.max(m, doc.widthOfString(w)), 0);
  const sample = sheet.rows.slice(0, 300);
  const minW = sheet.columns.map((c) => {
    doc.font("Helvetica-Bold").fontSize(7.5);
    const head = longest(c.label.toUpperCase());
    doc.font("Helvetica").fontSize(9);
    const cell = Math.min(90, sample.reduce((m, r) => Math.max(m, longest(text(value(r, c), c))), 0));
    return Math.max(head, cell) + PAD * 2 + 1;
  });
  const need = minW.reduce((a, b) => a + b, 0);
  const widths = need >= width ? minW.map((m) => (m / need) * width) : minW.map((m, i) => m + ((width - need) * weights[i]) / total);
  const cols = sheet.columns.map((c, i) => ({ c, w: widths[i], align: (c.type === "number" ? "right" : "left") as "right" | "left" }));
  const LINE_H = doc.font("Helvetica").fontSize(9).currentLineHeight(true);
  const MAX_CELL = LINE_H * 3;

  const head = () => {
    if (titled) {
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text(sheet.name, left, doc.y, { width });
      doc.moveDown(0.3);
    }
    doc.font("Helvetica-Bold").fontSize(7.5);
    const hh = Math.max(...cols.map(({ c, w }) => doc.heightOfString(c.label.toUpperCase(), { width: w - PAD * 2 })));
    const y = doc.y;
    let x = left;
    doc.fillColor(MUTED);
    for (const { c, w, align } of cols) {
      doc.text(c.label.toUpperCase(), x + PAD, y, { width: w - PAD * 2, align });
      x += w;
    }
    doc.moveTo(left, y + hh + 3).lineTo(left + width, y + hh + 3).lineWidth(0.8).strokeColor(MUTED).stroke();
    doc.x = left;
    doc.y = y + hh + 7;
  };

  if (doc.y + 60 > bottom()) {
    doc.addPage();
    doc.y = doc.page.margins.top;
  }
  head();
  if (!sheet.rows.length) {
    doc.fillColor(MUTED).font("Helvetica").fontSize(10).text("Nothing to show.", left, doc.y + 4);
    doc.y += 14;
    return;
  }
  doc.font("Helvetica").fontSize(9);
  sheet.rows.forEach((r, i) => {
    const cells = cols.map(({ c }) => text(value(r, c), c));
    const rowH = Math.min(MAX_CELL, Math.max(LINE_H, ...cells.map((t, j) => doc.heightOfString(t || " ", { width: cols[j].w - PAD * 2 })))) + 6;
    if (doc.y + rowH > bottom()) {
      doc.addPage();
      doc.y = doc.page.margins.top;
      titled = false;
      head();
      doc.font("Helvetica").fontSize(9);
    }
    const y = doc.y;
    if (i % 2 === 1) doc.rect(left, y, width, rowH).fill("#f6f8fb");
    let x = left;
    cols.forEach(({ w, align }, j) => {
      doc.fillColor(INK).text(cells[j], x + PAD, y + 3, { width: w - PAD * 2, height: rowH - 4, ellipsis: true, align });
      x += w;
    });
    doc.x = left;
    doc.y = y + rowH;
  });
  doc.y += 14;
}

export async function buildExport(spec: ExportSpec, by: string) {
  const at = new Date();
  const body = spec.format === "csv" ? csv(spec) : spec.format === "xlsx" ? await xlsx(spec, by, at) : await pdf(spec, by, at);
  const base = spec.filename.replace(/\.(xlsx|pdf|csv)$/i, "").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 100) || "export";
  return { body, mime: TYPES[spec.format].mime, filename: `${base}.${TYPES[spec.format].ext}` };
}
