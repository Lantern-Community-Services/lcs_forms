import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env.js";

/**
 * Reads one receipt (a photo or a PDF) with Claude and returns what's on it, for a code form to
 * fill a row in (ai.readReceipt in the SDK). Staff always check the row before it's saved.
 *
 * Needs ANTHROPIC_API_KEY on the API (an App Service setting in Azure, backend/.env locally); without
 * it the feature reports itself unavailable and pages hide their button. RECEIPT_MODEL picks the
 * model (default Claude Opus 5.5).
 */

export const receiptReaderReady = () => Boolean(env.anthropic.apiKey);

export interface ReceiptHints {
  /** Program codes the form offers ({ code, label }); the reading suggests one of these, or none. */
  codes?: { code: string; label: string }[];
  /** The period the receipt should fall in ("YYYY-MM-DD"), to read two-digit years right. */
  from?: string;
  to?: string;
}

export interface ReceiptReading {
  isReceipt: boolean;
  /** "YYYY-MM-DD", or "" when it can't be read. */
  date: string;
  vendor: string;
  /** The total paid, in dollars; 0 when it can't be read. */
  total: number;
  /** A short "what was bought", e.g. "Snacks and juice for movie night". */
  items: string;
  /** One of the hinted codes, or "" when none fits. */
  code: string;
  confidence: "high" | "medium" | "low";
  /** Anything staff should check: two receipts in one photo, a handwritten total, a tip, a refund. */
  notes: string;
  model: string;
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic({ apiKey: env.anthropic.apiKey, timeout: 90_000, maxRetries: 2 }));

export class ReceiptError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
  }
}

const SYSTEM = `You read receipts for a nonprofit's petty cash report. Staff photograph or scan a receipt; you return what's on it so a row can be filled in for them to check.

Rules:
- Read only what the receipt shows. Never guess a figure: if the total, date or store can't be read, leave it empty ("" or 0) and say why in notes.
- total is the amount actually paid, after tax and discounts, in dollars. If there's a tip, include it and mention it in notes. If it's a refund or return, use the amount refunded and say so in notes.
- date is the purchase date as YYYY-MM-DD. Use the expected period to settle the year when the receipt only shows two digits or none.
- vendor is the store or business name as a person would say it ("Target", "Key Food"), not the legal entity or address.
- items is a short plain description of what was bought (under 80 characters), e.g. "Snacks and juice", "Cleaning supplies", "MetroCard refill". Don't list every line.
- code: pick the one program code from the list that best fits what was bought. Use "" if none clearly fits or no list was given.
- isReceipt is false if the image isn't a receipt or invoice at all (then leave the other fields empty and explain in notes).
- If one photo holds more than one receipt, read the most prominent one and say in notes that there are others.
- confidence: high when every field is clearly printed; medium when something was hard to read; low when you had to leave fields empty or the image is very unclear.
- notes: one short sentence for anything staff should double-check, otherwise "".`;

const SCHEMA = (codes: string[]) => ({
  type: "object",
  properties: {
    isReceipt: { type: "boolean" },
    date: { type: "string", description: "YYYY-MM-DD or empty" },
    vendor: { type: "string" },
    total: { type: "number" },
    items: { type: "string" },
    code: codes.length ? { type: "string", enum: [...codes, ""] } : { type: "string", enum: [""] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    notes: { type: "string" },
  },
  required: ["isReceipt", "date", "vendor", "total", "items", "code", "confidence", "notes"],
  additionalProperties: false,
});

export async function readReceipt(file: { bytes: Buffer; mime: string; name: string }, hints: ReceiptHints = {}): Promise<ReceiptReading> {
  if (!receiptReaderReady()) throw new ReceiptError("Receipt reading isn't set up on this site yet.", 503);
  const mime = file.mime.toLowerCase();
  let media: Anthropic.Messages.ContentBlockParam;
  if (IMAGE_TYPES.has(mime)) {
    if (file.bytes.length > MAX_IMAGE_BYTES) throw new ReceiptError("That photo is too large to read (5 MB at most). Take it again, or attach a smaller copy.");
    media = { type: "image", source: { type: "base64", media_type: mime as "image/jpeg", data: file.bytes.toString("base64") } };
  } else if (mime === "application/pdf") {
    if (file.bytes.length > MAX_PDF_BYTES) throw new ReceiptError("That PDF is too large to read (20 MB at most).");
    media = { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.bytes.toString("base64") } };
  } else {
    throw new ReceiptError("Only photos (JPEG, PNG, WebP) and PDFs can be read. iPhone HEIC photos need to be taken with the in-app camera or saved as JPEG.");
  }

  // Sorted so every request with the same list sends the same bytes (the cached prefix below).
  const codes = (hints.codes ?? [])
    .filter((c) => c && typeof c.code === "string" && c.code.trim())
    .slice(0, 300)
    .sort((a, b) => a.code.localeCompare(b.code));
  const codeList = codes.length ? codes.map((c) => `${c.code} — ${String(c.label ?? "").slice(0, 120)}`).join("\n") : "(none given)";
  const period = hints.from && hints.to ? `Expected period: ${hints.from} to ${hints.to}.` : "";

  const response = await anthropic().beta.messages.create({
    model: env.anthropic.receiptModel,
    max_tokens: 4000,
    // If the model declines (a rare false positive on a receipt), the API retries on its default fallback.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // The instructions and the code list are the same for every receipt: cached, so after the first
    // reading in a batch they're billed at a twentieth of the price. Only the receipt and the answer vary.
    system: [
      { type: "text", text: SYSTEM },
      { type: "text", text: `Program codes to choose from:\n${codeList}`, cache_control: { type: "ephemeral" } },
    ],
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA(codes.map((c) => c.code)) } },
    messages: [
      {
        role: "user",
        content: [media, { type: "text", text: `${period}\nRead this receipt (file "${file.name.slice(0, 120)}").`.trim() }],
      },
    ],
  });

  if (response.stop_reason === "refusal") throw new ReceiptError("This file couldn't be read. Fill the row in by hand.");
  if (response.stop_reason === "max_tokens") throw new ReceiptError("Reading this receipt ran too long. Fill the row in by hand.");
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  let out: Omit<ReceiptReading, "model">;
  try {
    out = JSON.parse(text);
  } catch {
    throw new ReceiptError("The reading came back unreadable. Try again, or fill the row in by hand.", 502);
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(out.date ?? "")) ? out.date : "";
  const total = Number.isFinite(Number(out.total)) && Number(out.total) > 0 ? Math.round(Number(out.total) * 100) / 100 : 0;
  console.log(`[receipt] read ${mime} ${file.bytes.length}B with ${response.model}: in ${response.usage.input_tokens}, cached ${response.usage.cache_read_input_tokens ?? 0}, cache write ${response.usage.cache_creation_input_tokens ?? 0}, out ${response.usage.output_tokens}`);
  return {
    isReceipt: out.isReceipt !== false,
    date,
    vendor: String(out.vendor ?? "").slice(0, 120),
    total,
    items: String(out.items ?? "").slice(0, 200),
    code: codes.some((c) => c.code === out.code) ? out.code : "",
    confidence: out.confidence === "high" || out.confidence === "low" ? out.confidence : "medium",
    notes: String(out.notes ?? "").slice(0, 300),
    model: response.model,
  };
}

/** A few readings a minute per person is normal; this stops a runaway loop from spending the budget. */
const recent = new Map<string, number[]>();
export function allowReading(userId: string, perHour = 300) {
  const now = Date.now();
  const list = (recent.get(userId) ?? []).filter((t) => now - t < 3_600_000);
  if (list.length >= perHour) return false;
  list.push(now);
  recent.set(userId, list);
  return true;
}
