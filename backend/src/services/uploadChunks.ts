import type { Request } from "express";
import { prisma } from "../prisma.js";
import { badRequest, HttpError } from "../http.js";
import { createFormFile, deleteFiles, fileBytes } from "./fileStore.js";

/**
 * Files bigger than one request may carry go up in parts. A request through
 * the web app's proxy is cut off at its body limit, and a phone on a weak
 * connection does better with small requests, so the browser sends any file
 * over 8 MB as 4 MB parts (lib/upload.ts) and the MCP import's files can come
 * in parts too (upload_import_file).
 *
 * Each part is a FormFile row of the form with fieldId "__chunk:<uploadId>"
 * and no entry, so it needs no table of its own and an abandoned upload is
 * swept with the other unattached files after a day. When the last part
 * arrives, the parts are joined, their rows deleted, and the whole file goes
 * on to the upload it belongs to as if it had been sent in one piece.
 */

/** The largest file, put together from parts. */
export const MAX_ASSEMBLED_BYTES = 50 * 1024 * 1024;
export const MAX_PART_BYTES = 10 * 1024 * 1024;
const MAX_PARTS = 64;
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

const chunkField = (uploadId: string) => `__chunk:${uploadId}`;

export interface Part {
  formId: string;
  uploadId: string;
  index: number;
  count: number;
  data: Buffer;
  /** Who sent it (null for a guest or an API key); every part of one upload must come from the same sender. */
  createdById: string | null;
}

/**
 * Keep one part. Returns null while parts are still to come, and the whole
 * file once the last one is in.
 */
export async function receivePart(p: Part): Promise<Buffer | null> {
  // Checked here, not only by the caller: the bytes and the id come from a request.
  if (!Buffer.isBuffer(p.data)) throw badRequest("Send the part as the request body.");
  if (typeof p.uploadId !== "string" || !ID_RE.test(p.uploadId)) throw badRequest("That upload id isn't valid.");
  if (!Number.isInteger(p.count) || p.count < 1 || p.count > MAX_PARTS) throw badRequest(`An upload has 1 to ${MAX_PARTS} parts.`);
  if (!Number.isInteger(p.index) || p.index < 0 || p.index >= p.count) throw badRequest("That part number isn't in the upload.");
  if (p.data.length === 0) throw badRequest("That part is empty.");
  if (p.data.length > MAX_PART_BYTES) throw new HttpError(413, "Each part can be at most 10 MB.");
  const where = { formId: p.formId, fieldId: chunkField(p.uploadId), entryId: null };
  const have = await prisma.formFile.findMany({ where, select: { id: true, name: true, size: true, createdById: true } });
  if (have.some((r) => r.createdById !== p.createdById)) throw badRequest("That upload belongs to someone else.");
  const sent = have.reduce((n, r) => n + (r.name === String(p.index) ? 0 : r.size), 0) + p.data.length;
  if (sent > MAX_ASSEMBLED_BYTES) throw new HttpError(413, `Files can be at most ${MAX_ASSEMBLED_BYTES / 1024 / 1024} MB.`);
  // A part sent again (a retry) replaces the one before.
  const again = have.filter((r) => r.name === String(p.index)).map((r) => r.id);
  if (again.length) await deleteFiles({ id: { in: again } });
  await createFormFile({ formId: p.formId, fieldId: chunkField(p.uploadId), name: String(p.index), mime: "application/octet-stream", data: p.data, createdById: p.createdById });
  if (p.index < p.count - 1) return null;

  // The last part: every one must be here, then they're joined in order.
  const rows = await prisma.formFile.findMany({ where, select: { id: true, name: true, data: true, storageKey: true } });
  const byIndex = new Map(rows.map((r) => [Number(r.name), r]));
  const missing = Array.from({ length: p.count }, (_, i) => i).filter((i) => !byIndex.has(i));
  if (missing.length) throw new HttpError(409, `Parts ${missing.join(", ")} of this upload haven't arrived. Send them, then the last part again.`);
  const parts: Buffer[] = [];
  for (let i = 0; i < p.count; i++) parts.push(await fileBytes(byIndex.get(i)!));
  await deleteFiles({ id: { in: rows.map((r) => r.id) } });
  return Buffer.concat(parts);
}

/**
 * For a raw-body upload route: the file, whole — the body itself, or, when the
 * request is one part of a larger file (X-Upload-Id, X-Upload-Part,
 * X-Upload-Parts headers), the joined parts once the last is in. Null means a
 * part was kept and the route should answer 202 with PART_RECEIVED.
 */
export async function wholeBody(req: Request, formId: string, createdById: string | null): Promise<Buffer | null> {
  const body: unknown = req.body;
  if (!Buffer.isBuffer(body)) throw badRequest("Send the file as the request body.");
  const uploadId = header(req, "x-upload-id");
  if (uploadId === null) return body;
  return receivePart({
    formId,
    uploadId,
    index: Number(header(req, "x-upload-part")),
    count: Number(header(req, "x-upload-parts")),
    data: body,
    createdById,
  });
}

/** One header's value; sent twice (an array) or not at all counts as missing. */
function header(req: Request, name: string): string | null {
  const v: unknown = req.headers[name];
  return typeof v === "string" && v !== "" ? v : null;
}

/** The answer to a part that isn't the last. */
export const PART_RECEIVED = { received: true } as const;
