import { z } from "zod";

/**
 * How an entry was filled, recorded with every entry (basic forms and code
 * forms alike): the kind of device, and the seconds from the person's first
 * answer to submitting. Both are measured on the filling device and sent with
 * the submission (an offline one keeps them in its queue). Entries made by
 * server code, the MCP server or an import have neither.
 */

export const DEVICE_KINDS = ["phone", "tablet", "desktop"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/** A week: anything longer is a form left open, not time spent filling it. */
const MAX_FILL_SECONDS = 7 * 24 * 60 * 60;

/** Optional fields for a submission's zod schema: loose, since a bad value is dropped (fillMeta), never a reason to refuse the entry. */
export const fillMetaFields = {
  deviceKind: z.string().max(40).nullish(),
  fillSeconds: z.number().nullish(),
};

/** The columns to store, from what the device sent. */
export function fillMeta(input: { deviceKind?: string | null; fillSeconds?: number | null }) {
  const deviceKind = (DEVICE_KINDS as readonly string[]).includes(input.deviceKind ?? "") ? (input.deviceKind as DeviceKind) : null;
  const s = input.fillSeconds;
  const fillSeconds = typeof s === "number" && Number.isFinite(s) && s >= 0 && s <= MAX_FILL_SECONDS ? Math.round(s) : null;
  return { deviceKind, fillSeconds };
}

export const deviceLabel = (k: string | null | undefined) => (k === "phone" ? "Phone" : k === "tablet" ? "Tablet" : k === "desktop" ? "Computer" : "");

/** Minutes, to one decimal, for a spreadsheet column ("" when unknown). */
export const fillMinutes = (s: number | null | undefined) => (typeof s === "number" ? Math.round(s / 6) / 10 : "");
