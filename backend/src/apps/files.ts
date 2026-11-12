import { prisma } from "../prisma.js";
import { HttpError, badRequest, forbidden, notFound } from "../http.js";
import type { CurrentUser } from "../auth/middleware.js";
import { requireOpen, type LoadedApp } from "./runtime.js";
import { createFormFile, sweepUnattachedFiles } from "../services/fileStore.js";

/**
 * Photos and files for code forms. FormFile rows (the same table as the form
 * builder's File field), with the bytes in Blob Storage (services/fileStore.ts).
 *
 * A page uploads a file first and gets a FileRef back; it puts the ref
 * anywhere in an entry's data. When the entry is saved, every { fileId } in
 * its data is attached to it. Until then only the uploader can read the file
 * back, and anything never attached is swept after a day.
 *
 * A form's server code can keep uploads that a draft holds (ctx.files.keep): their label gets the KEPT
 * prefix, the sweep leaves them for KEPT_DAYS, and anyone who can open the form can read them and attach
 * them to an entry (a coworker picking up the site's draft). Only the form decides which files to keep.
 */
export const KEPT = "keep:";
export const KEPT_DAYS = 180;
export const isKept = (f: { fieldId: string }) => f.fieldId.startsWith(KEPT);

/** Keep these uploads of this form (not yet on an entry). Returns how many were newly kept. */
export async function keepAppFiles(app: LoadedApp, ids: unknown): Promise<number> {
  const list = (Array.isArray(ids) ? ids : [])
    .map((x) => (typeof x === "string" ? x : x && typeof x === "object" && typeof (x as { fileId?: unknown }).fileId === "string" ? (x as { fileId: string }).fileId : ""))
    .filter((x) => x && !x.startsWith("local:"))
    .slice(0, 500);
  if (!list.length) return 0;
  const rows = await prisma.formFile.findMany({ where: { id: { in: list }, formId: app.form.id, entryId: null }, select: { id: true, fieldId: true } });
  let n = 0;
  for (const r of rows) {
    if (isKept(r)) continue;
    await prisma.formFile.update({ where: { id: r.id }, data: { fieldId: (KEPT + r.fieldId).slice(0, 255) } });
    n++;
  }
  return n;
}

/** The most any one file can be (a big one uploads in parts: services/uploadChunks.ts). */
export const MAX_APP_FILE_BYTES = 50 * 1024 * 1024;

export interface FileRef {
  fileId: string;
  name: string;
  mime: string;
  size: number;
}

const refOut = (r: { id: string; name: string; mime: string; size: number }): FileRef => ({ fileId: r.id, name: r.name, mime: r.mime, size: r.size });

function acceptOk(accept: string, name: string, mime: string) {
  const lower = name.toLowerCase();
  return accept.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).some((a) => {
    if (a.startsWith(".")) return lower.endsWith(a);
    if (a.endsWith("/*")) return mime.toLowerCase().startsWith(a.slice(0, -1));
    return mime.toLowerCase() === a;
  });
}

export async function uploadAppFile(app: LoadedApp, user: CurrentUser, file: { name: string; mime: string; label?: string; data: Buffer }): Promise<FileRef> {
  const a = requireOpen(app, user);
  if (!a.create && !a.editAny) throw forbidden("You can't add files to this form.");
  const rule = app.manifest.files ?? {};
  // Photos are shrunk on the device first; files.maxMb is for other files.
  const cap = file.mime.toLowerCase().startsWith("image/") ? MAX_APP_FILE_BYTES : Math.min(MAX_APP_FILE_BYTES, (rule.maxMb ?? 10) * 1024 * 1024);
  if (file.data.length === 0) throw badRequest("That file is empty.");
  if (file.data.length > cap) throw new HttpError(413, `Files can be at most ${Math.round(cap / 1024 / 1024)} MB.`);
  const accept = rule.accept ?? "image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt";
  if (!acceptOk(accept, file.name, file.mime)) throw badRequest(`This form takes ${accept} files.`);
  await sweepUnattachedFiles();
  const row = await createFormFile({
    formId: app.form.id,
    fieldId: (file.label || "file").slice(0, 60),
    name: file.name.slice(0, 200) || "file",
    mime: file.mime.slice(0, 100) || "application/octet-stream",
    data: file.data,
    // A guest (share link) has no account: their uploads are nobody's, like an API key's.
    createdById: user.guest ? null : user.userId,
  });
  return refOut(row);
}

/** Every { fileId } anywhere in an entry's data. */
export function fileIdsIn(data: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 20 || !data || typeof data !== "object") return out;
  if (Array.isArray(data)) {
    for (const v of data) fileIdsIn(v, out, depth + 1);
    return out;
  }
  const o = data as Record<string, unknown>;
  if (typeof o.fileId === "string") out.add(o.fileId);
  for (const v of Object.values(o)) fileIdsIn(v, out, depth + 1);
  return out;
}

/**
 * Check the files an entry refers to before it's saved: each must belong to
 * this form and be either already on this entry or a fresh upload by the same
 * person (any fresh upload, for an API key). Returns the ids still to attach.
 */
export async function filesToAttach(app: LoadedApp, user: CurrentUser | null, data: unknown, entryId?: string): Promise<string[]> {
  const ids = [...fileIdsIn(data)];
  if (!ids.length) return [];
  if (ids.length > 50) throw badRequest("An entry can hold at most 50 files.");
  if (ids.some((id) => id.startsWith("local:"))) throw badRequest("A photo taken offline hasn't uploaded yet — try again in a moment.");
  const rows = await prisma.formFile.findMany({ where: { id: { in: ids }, formId: app.form.id }, select: { id: true, entryId: true, createdById: true, fieldId: true } });
  const found = new Map(rows.map((r) => [r.id, r]));
  const attach: string[] = [];
  for (const id of ids) {
    const r = found.get(id);
    if (!r) throw badRequest("One of the files isn't on this form (it may have expired — upload it again).");
    if (r.entryId) {
      if (r.entryId !== entryId) throw badRequest("One of the files belongs to another entry.");
      continue;
    }
    if (user && r.createdById && r.createdById !== user.userId && !isKept(r)) throw forbidden("One of the files was uploaded by someone else.");
    attach.push(id);
  }
  return attach;
}

export async function attachFiles(entryId: string, ids: string[]) {
  if (ids.length) await prisma.formFile.updateMany({ where: { id: { in: ids }, entryId: null }, data: { entryId } });
}

/**
 * A file, for someone allowed to see it: on an entry they can read, their own
 * upload that isn't on an entry yet, or one the form keeps for a draft (callers
 * check the person can open the form). `canReadEntry` is the entry check.
 */
export async function readAppFile(app: LoadedApp, user: CurrentUser | null, fileId: string, canReadEntry: (entryId: string) => Promise<unknown>) {
  const file = await prisma.formFile.findFirst({ where: { id: fileId, formId: app.form.id } });
  if (!file) throw notFound("No such file.");
  if (file.entryId) await canReadEntry(file.entryId);
  else if (user && file.createdById !== user.userId && !isKept(file)) throw forbidden("That file isn't yours.");
  return file;
}

/** The files on some entries, by entry id (for the MCP server and exports). */
export async function filesOf(entryIds: string[]) {
  if (!entryIds.length) return new Map<string, FileRef[]>();
  const rows = await prisma.formFile.findMany({ where: { entryId: { in: entryIds } }, select: { id: true, name: true, mime: true, size: true, entryId: true } });
  const out = new Map<string, FileRef[]>();
  for (const r of rows) out.set(r.entryId!, [...(out.get(r.entryId!) ?? []), refOut(r)]);
  return out;
}
