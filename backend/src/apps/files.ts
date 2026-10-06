import { prisma } from "../prisma.js";
import { HttpError, badRequest, forbidden, notFound } from "../http.js";
import type { CurrentUser } from "../auth/middleware.js";
import { requireOpen, type LoadedApp } from "./runtime.js";

/**
 * Photos and files for code forms. Stored in FormFile (the same table as the
 * form builder's File field), so the database stays the one thing to back up.
 *
 * A page uploads a file first and gets a FileRef back; it puts the ref
 * anywhere in an entry's data. When the entry is saved, every { fileId } in
 * its data is attached to it. Until then only the uploader can read the file
 * back, and anything never attached is swept after a day.
 */

export const MAX_APP_FILE_BYTES = 10 * 1024 * 1024;

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
  const cap = Math.min(MAX_APP_FILE_BYTES, (rule.maxMb ?? 10) * 1024 * 1024);
  if (file.data.length === 0) throw badRequest("That file is empty.");
  if (file.data.length > cap) throw new HttpError(413, `Files can be at most ${Math.round(cap / 1024 / 1024)} MB.`);
  const accept = rule.accept ?? "image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt";
  if (!acceptOk(accept, file.name, file.mime)) throw badRequest(`This form takes ${accept} files.`);
  // Uploaded but never saved with an entry, after a day: swept here, no scheduler needed.
  await prisma.formFile.deleteMany({ where: { entryId: null, createdAt: { lt: new Date(Date.now() - 86_400_000) } } });
  const row = await prisma.formFile.create({
    data: {
      formId: app.form.id,
      fieldId: (file.label || "file").slice(0, 60),
      name: file.name.slice(0, 200) || "file",
      mime: file.mime.slice(0, 100) || "application/octet-stream",
      size: file.data.length,
      data: file.data,
      createdById: user.userId,
    },
    select: { id: true, name: true, mime: true, size: true },
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
  const rows = await prisma.formFile.findMany({ where: { id: { in: ids }, formId: app.form.id }, select: { id: true, entryId: true, createdById: true } });
  const found = new Map(rows.map((r) => [r.id, r]));
  const attach: string[] = [];
  for (const id of ids) {
    const r = found.get(id);
    if (!r) throw badRequest("One of the files isn't on this form (it may have expired — upload it again).");
    if (r.entryId) {
      if (r.entryId !== entryId) throw badRequest("One of the files belongs to another entry.");
      continue;
    }
    if (user && r.createdById && r.createdById !== user.userId) throw forbidden("One of the files was uploaded by someone else.");
    attach.push(id);
  }
  return attach;
}

export async function attachFiles(entryId: string, ids: string[]) {
  if (ids.length) await prisma.formFile.updateMany({ where: { id: { in: ids }, entryId: null }, data: { entryId } });
}

/**
 * A file, for someone allowed to see it: on an entry they can read, or their
 * own upload that isn't on an entry yet. `canReadEntry` is the entry check.
 */
export async function readAppFile(app: LoadedApp, user: CurrentUser | null, fileId: string, canReadEntry: (entryId: string) => Promise<unknown>) {
  const file = await prisma.formFile.findFirst({ where: { id: fileId, formId: app.form.id } });
  if (!file) throw notFound("No such file.");
  if (file.entryId) await canReadEntry(file.entryId);
  else if (user && file.createdById !== user.userId) throw forbidden("That file isn't yours.");
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
