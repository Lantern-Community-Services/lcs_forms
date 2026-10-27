import { z } from "zod";

/**
 * "Paper form" pages for a code form's PDF export (spec.documents): a record
 * laid out like the form people know on paper — a title block, shaded section
 * bars, labelled boxes in rows, rows of check boxes with the chosen ones
 * ticked, and signature images — instead of a question/answer table. Each
 * document starts on its own page. Only the PDF draws them.
 */

const text = (max: number) => z.string().max(max);
const SIGNATURE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;

const docField = z.object({
  label: text(120).default(""),
  value: text(8000).default(""),
  /** Share of the row (the row's widths are relative to each other). */
  width: z.number().min(1).max(100).default(1),
  /** A signature or other image (PNG or JPEG data: URL), drawn inside the box. */
  image: z.string().max(600_000).regex(SIGNATURE, "An image is a PNG or JPEG data: URL.").optional(),
  /** The box's height in lines, at least (it grows to fit its text). */
  lines: z.number().int().min(1).max(20).optional(),
});

const docBlock = z.discriminatedUnion("type", [
  /** A shaded bar: the section's title on the left, an italic note on the right. */
  z.object({ type: z.literal("section"), title: text(160), note: text(200).optional() }),
  /** One row of labelled boxes. */
  z.object({ type: z.literal("fields"), fields: z.array(docField).min(1).max(6) }),
  /** Check boxes: every option, the checked ones ticked. Each inner array is one printed line. */
  z.object({
    type: z.literal("choices"),
    label: text(200).optional(),
    rows: z.array(z.array(text(160)).max(10)).max(20),
    checked: z.array(text(160)).max(200).default([]),
    /** Bold options (a "none of these" line). */
    strong: z.boolean().optional(),
  }),
  /** An italic line of guidance. */
  z.object({ type: z.literal("note"), text: text(1000) }),
]);

export const exportDocument = z.object({
  title: text(160),
  /** Right of the title, in small capitals (the organisation). */
  org: text(120).optional(),
  /** Under the title, above a hairline. */
  intro: text(600).optional(),
  /** Shown in red under the title, e.g. "VOIDED". */
  stamp: text(80).optional(),
  /** Left of each page's footer (the page number is on the right). */
  footer: text(160).optional(),
  blocks: z.array(docBlock).max(300),
});
export type ExportDocument = z.infer<typeof exportDocument>;
type Block = ExportDocument["blocks"][number];
type Doc = PDFKit.PDFDocument;
export type Page = { left: number; width: number; bottom: () => number };

const INK = "#111111";
const SOFT = "#555555";
const LABEL = "#777777";
const BAR_BG = "#e9edf1";
const BOX_BG = "#eceff9";
const BOX_LINE = "#a5abc4";
const TICK_OFF = "#7b8196";
const RED = "#b42318";

// The template's own sizes (points), so a typical record fits one page as the paper form does.
const GAP = 12; // between boxes in a row
const PAD_X = 5;
const PAD_Y = 3;
const VALUE_SIZE = 9;
const LABEL_SIZE = 8.5;
const IMAGE_H = 18;
const ROW_GAP = 3; // under a row of boxes
const LINE = 11.5; // one line of check boxes

/** A page like this one (portrait, whatever the export's first page was). */
function newPage(doc: Doc) {
  doc.addPage({ size: [doc.page.width, doc.page.height], margins: doc.page.margins });
  doc.y = doc.page.margins.top;
}

/** Room for h points on this page, or a new page. */
function ensure(doc: Doc, h: number, page: Page) {
  if (doc.y + h > page.bottom()) newPage(doc);
}

function imageOf(dataUrl: string | undefined) {
  if (!dataUrl) return null;
  try {
    return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  } catch {
    return null;
  }
}

function lineH(doc: Doc) {
  return doc.font("Helvetica").fontSize(VALUE_SIZE).currentLineHeight(true);
}

/** The title block: title and organisation on one line, the intro under a hairline. */
function drawHead(doc: Doc, d: ExportDocument, page: Page) {
  const { left, width } = page;
  const y = doc.y;
  doc.font("Helvetica-Bold").fontSize(19).fillColor(INK).text(d.title, left, y, { width: width * 0.7, lineBreak: false });
  const titleH = doc.currentLineHeight();
  if (d.org) {
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(SOFT);
    doc.text(d.org.toUpperCase(), left + width * 0.4, y + titleH - doc.currentLineHeight() - 3, { width: width * 0.6, align: "right", lineBreak: false });
  }
  doc.y = y + titleH + 4;
  if (d.stamp) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor(RED).text(d.stamp, left, doc.y, { width });
    doc.y += 2;
  }
  if (d.intro) {
    doc.font("Helvetica-Oblique").fontSize(8).fillColor(SOFT).text(d.intro, left, doc.y, { width });
    doc.y += 3;
  }
  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.6).strokeColor("#bbbbbb").stroke();
  doc.y += 4;
}

function drawSection(doc: Doc, b: Extract<Block, { type: "section" }>, page: Page) {
  const { left, width } = page;
  // A bar is never the last thing on a page: keep room for what follows it.
  ensure(doc, 5 + 17 + 40, page);
  // text() moves doc.y even with lineBreak: false, so the bar's top is kept.
  const y = doc.y + 5;
  const h = 17;
  doc.rect(left, y, width, h).fill(BAR_BG);
  doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text(b.title, left + 7, y + 4, { width: width * 0.6, lineBreak: false });
  if (b.note) doc.font("Helvetica-Oblique").fontSize(8).fillColor(SOFT).text(b.note, left + width * 0.4, y + 5, { width: width * 0.6 - 7, align: "right", lineBreak: false });
  doc.x = left;
  doc.y = y + h + 3;
}

function drawNote(doc: Doc, b: Extract<Block, { type: "note" }>, page: Page) {
  doc.font("Helvetica-Oblique").fontSize(8.5);
  const h = doc.heightOfString(b.text, { width: page.width });
  ensure(doc, h + 4, page);
  doc.y += 1;
  doc.fillColor(SOFT).text(b.text, page.left, doc.y, { width: page.width });
  doc.y += 2;
}

/** One check box, ticked or not, at (x, y): a square with an X when checked. */
function tick(doc: Doc, x: number, y: number, on: boolean) {
  const s = 7.5;
  doc.rect(x, y, s, s).lineWidth(0.7).strokeColor(on ? INK : TICK_OFF).stroke();
  if (on) {
    doc.moveTo(x + 1.5, y + 1.5).lineTo(x + s - 1.5, y + s - 1.5).moveTo(x + s - 1.5, y + 1.5).lineTo(x + 1.5, y + s - 1.5).lineWidth(1).strokeColor(INK).stroke();
  }
}

function drawChoices(doc: Doc, b: Extract<Block, { type: "choices" }>, page: Page) {
  const { left, width } = page;
  const on = new Set(b.checked);
  const font = b.strong ? "Helvetica-Bold" : "Helvetica";
  const BOX = 7.5;
  const SPACE = 16; // between options on a line

  // Lay the options out first (a printed line that's too long wraps), so the group never splits.
  doc.font(font).fontSize(VALUE_SIZE);
  const lines: { label: string; x: number }[][] = [];
  for (const row of b.rows) {
    let line: { label: string; x: number }[] = [];
    let x = 0;
    for (const label of row) {
      const w = BOX + 4 + doc.widthOfString(label);
      if (line.length && x + w > width) {
        lines.push(line);
        line = [];
        x = 0;
      }
      line.push({ label, x });
      x += w + SPACE;
    }
    if (line.length) lines.push(line);
  }
  const labelH = b.label ? 11.5 : 0;
  ensure(doc, 2 + labelH + lines.length * LINE + 2, page);
  doc.y += 2;
  if (b.label) {
    const y = doc.y;
    doc.font("Helvetica-BoldOblique").fontSize(LABEL_SIZE).fillColor(SOFT).text(b.label, left, y, { width, lineBreak: false });
    doc.y = y + labelH;
  }
  for (const line of lines) {
    const y = doc.y;
    doc.font(font).fontSize(VALUE_SIZE);
    for (const o of line) {
      const checked = on.has(o.label);
      tick(doc, left + o.x, y + 1, checked);
      doc.fillColor(INK).text(o.label, left + o.x + BOX + 4, y, { lineBreak: false });
    }
    doc.x = left;
    doc.y = y + LINE;
  }
  doc.y += 2;
}

type Laid = { label: string; x: number; w: number; value: string; image: Buffer | null; minH: number };

/** The height a box needs for this text (or image), at its width. */
function boxHeight(doc: Doc, f: Laid, value: string) {
  doc.font("Helvetica").fontSize(VALUE_SIZE);
  const textH = value ? doc.heightOfString(value, { width: f.w - PAD_X * 2 }) : 0;
  return Math.max(f.minH, (f.image ? IMAGE_H : textH) + PAD_Y * 2);
}

/** The longest start of `value` (whole words) that fits `h` points of box. */
function fitText(doc: Doc, value: string, w: number, h: number) {
  doc.font("Helvetica").fontSize(VALUE_SIZE);
  const words = value.split(/(\s+)/);
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.heightOfString(words.slice(0, mid).join(""), { width: w }) <= h) lo = mid;
    else hi = mid - 1;
  }
  return { head: words.slice(0, lo).join("").trimEnd(), rest: words.slice(lo).join("").trimStart() };
}

function drawFields(doc: Doc, b: Extract<Block, { type: "fields" }>, page: Page) {
  const { left, width } = page;
  const total = b.fields.reduce((a, f) => a + f.width, 0);
  const free = width - GAP * (b.fields.length - 1);
  const minLine = lineH(doc);
  let x = left;
  const fields: Laid[] = b.fields.map((f) => {
    const w = (free * f.width) / total;
    const laid = { label: f.label, x, w, value: f.value, image: imageOf(f.image), minH: Math.max(1, f.lines ?? 1) * minLine + PAD_Y * 2 };
    if (f.image && !f.lines) laid.minH = IMAGE_H + PAD_Y * 2;
    x += w + GAP;
    return laid;
  });
  const labelled = fields.some((f) => f.label);
  const LABEL_H = labelled ? 11 : 0;

  // A row that's longer than a page (a long narrative) carries on, box and all, on the next.
  let pending = fields.map((f) => f.value);
  let first = true;
  for (;;) {
    const need = Math.max(...fields.map((f, i) => boxHeight(doc, f, pending[i])));
    // A box that won't fit starts here anyway (and carries on) when there's room for a few lines.
    const start = Math.min(need, 3 * minLine + PAD_Y * 2);
    ensure(doc, start + LABEL_H + ROW_GAP, page);
    const room = page.bottom() - doc.y - LABEL_H - ROW_GAP;
    const h = Math.min(need, room);
    const y = doc.y;
    if (labelled) {
      doc.font("Helvetica").fontSize(LABEL_SIZE).fillColor(LABEL);
      for (const f of fields) if (f.label) doc.text(first ? f.label : `${f.label} (continued)`, f.x, y, { width: f.w, lineBreak: false });
    }
    const top = y + LABEL_H;
    const next: string[] = [];
    fields.forEach((f, i) => {
      doc.rect(f.x, top, f.w, h).lineWidth(0.6).fillAndStroke(BOX_BG, BOX_LINE);
      if (f.image && first) {
        try {
          doc.image(f.image, f.x + PAD_X, top + (h - IMAGE_H) / 2, { fit: [f.w - PAD_X * 2, IMAGE_H] });
        } catch {
          // An image PDFKit can't read is left out rather than failing the whole file.
        }
      }
      const { head, rest } = need > h ? fitText(doc, pending[i], f.w - PAD_X * 2, h - PAD_Y * 2) : { head: pending[i], rest: "" };
      if (head) doc.font("Helvetica").fontSize(VALUE_SIZE).fillColor(INK).text(head, f.x + PAD_X, top + PAD_Y, { width: f.w - PAD_X * 2 });
      next.push(rest);
    });
    doc.x = left;
    doc.y = top + h + ROW_GAP;
    pending = next;
    first = false;
    if (!pending.some(Boolean)) break;
    newPage(doc);
  }
}

/** Draws one document from the top of the current page. */
export function drawDocument(doc: Doc, d: ExportDocument, page: Page) {
  drawHead(doc, d, page);
  for (const b of d.blocks) {
    if (b.type === "section") drawSection(doc, b, page);
    else if (b.type === "fields") drawFields(doc, b, page);
    else if (b.type === "choices") drawChoices(doc, b, page);
    else drawNote(doc, b, page);
  }
}
