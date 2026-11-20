import type { ClientDocument, Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { badRequest, HttpError } from "../http.js";
import { blobConfigured, deleteBlobs, fileBytes, putBlob } from "./fileStore.js";

/**
 * Documents on a resident's record (PlanStreet's case attachments): their ID, a
 * lease, a signed release, benefit and income letters. The routes
 * (routes/clientRecord.ts) check the case management switch, the permission
 * (clients.view to see and open, clients.edit to add and remove) and the
 * resident's site, and write the audit log; this file checks the file and keeps
 * its bytes where uploaded files are kept (services/fileStore.ts): Blob Storage
 * in Azure, the row itself locally.
 *
 * Removing one only marks it removed: the bytes and the row stay, so the audit
 * log's "added" and "removed" still point at something an Admin can find.
 */

export const DOCUMENT_KINDS = [
  { key: "id", label: "ID" },
  { key: "lease", label: "Lease" },
  { key: "consent", label: "Consent / release" },
  { key: "benefits", label: "Benefits" },
  { key: "income", label: "Income" },
  { key: "medical", label: "Medical" },
  { key: "other", label: "Other" },
] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number]["key"];

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/**
 * Audit actions for documents. "client.", not "tenant.": the roster's Activity feed
 * shows every "tenant." event to anyone at the site, and these name the document.
 * A resident's History shows them only to people with clients.view (PROFILE_AUDIT_ACTIONS).
 */
export const DOCUMENT_AUDIT_ACTIONS = ["client.document_added", "client.document_removed", "client.document_opened"] as const;

const kindLabel = (k: string) => DOCUMENT_KINDS.find((x) => x.key === k)?.label ?? "Other";

/**
 * What can be kept, by file ending: PDFs, photos and Word files. The type a
 * document is served as comes from here, never from the browser, and the first
 * bytes must look like that kind of file (a renamed file is turned away).
 */
const startsWith = (b: Buffer, bytes: number[], at = 0) => bytes.every((x, i) => b[at + i] === x);
const FILE_TYPES: Record<string, { mime: string; looksRight: (b: Buffer) => boolean }> = {
  pdf: { mime: "application/pdf", looksRight: (b) => b.subarray(0, 1024).includes("%PDF") },
  jpg: { mime: "image/jpeg", looksRight: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  jpeg: { mime: "image/jpeg", looksRight: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  png: { mime: "image/png", looksRight: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  gif: { mime: "image/gif", looksRight: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  webp: { mime: "image/webp", looksRight: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  heic: { mime: "image/heic", looksRight: (b) => b.subarray(4, 8).toString("latin1") === "ftyp" },
  heif: { mime: "image/heif", looksRight: (b) => b.subarray(4, 8).toString("latin1") === "ftyp" },
  doc: { mime: "application/msword", looksRight: (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", looksRight: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) },
};

/** What the browser's file picker is told to offer (frontend). */
export const DOCUMENT_ACCEPT = Object.keys(FILE_TYPES).map((e) => `.${e}`).join(",");

/** Opened in the browser rather than downloaded: PDFs and pictures it can show. */
export const opensInBrowser = (mime: string) => /^(application\/pdf|image\/(png|jpeg|gif|webp|heic|heif))$/.test(mime);

/** A file name as it may be stored and sent back in a header: no folders, no control characters. */
function cleanName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  return base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200) || "document";
}

/** Row columns without the bytes. */
export const DOCUMENT_META = {
  id: true, tenantId: true, siteId: true, kind: true, label: true, name: true, mime: true, size: true, storageKey: true,
  createdById: true, createdByName: true, createdAt: true, removedAt: true, removedById: true, removedByName: true,
} satisfies Prisma.ClientDocumentSelect;

type DocumentMeta = Prisma.ClientDocumentGetPayload<{ select: typeof DOCUMENT_META }>;

export function documentOut(d: DocumentMeta) {
  return {
    id: d.id,
    kind: d.kind,
    kindLabel: kindLabel(d.kind),
    label: d.label,
    name: d.name,
    mime: d.mime,
    size: d.size,
    createdAt: d.createdAt,
    createdByName: d.createdByName,
  };
}

export type DocumentView = ReturnType<typeof documentOut>;

/** A resident's documents, newest first (removed ones left out). */
export async function listDocuments(tenantId: string): Promise<DocumentView[]> {
  const rows = await prisma.clientDocument.findMany({ where: { tenantId, removedAt: null }, orderBy: { createdAt: "desc" }, select: DOCUMENT_META, take: 500 });
  return rows.map(documentOut);
}

/** One document of this resident's that hasn't been removed, or null. */
export function findDocument(tenantId: string, id: string) {
  return prisma.clientDocument.findFirst({ where: { id, tenantId, removedAt: null }, select: DOCUMENT_META });
}

export interface NewDocument {
  tenant: { id: string; siteId: string };
  kind: unknown;
  label: unknown;
  name: string;
  data: Buffer;
  by: { id: string | null; name: string };
}

/** Check a file and keep it: its bytes where files are kept, then its row. */
export async function addDocument(input: NewDocument): Promise<DocumentView> {
  const kind = typeof input.kind === "string" && DOCUMENT_KINDS.some((k) => k.key === input.kind) ? (input.kind as DocumentKind) : null;
  if (!kind) throw badRequest(`Pick what kind of document it is: ${DOCUMENT_KINDS.map((k) => k.label).join(", ")}.`);
  const label = typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, 200) : null;
  const name = cleanName(input.name);
  const data = input.data;
  if (!Buffer.isBuffer(data) || data.length === 0) throw badRequest("That file is empty.");
  if (data.length > MAX_DOCUMENT_BYTES) throw new HttpError(413, `Documents can be at most ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`);
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  const type = FILE_TYPES[ext];
  if (!type) throw badRequest("Add a PDF, a photo (JPG, PNG, HEIC) or a Word file.");
  if (!type.looksRight(data)) throw badRequest(`That file doesn't look like a .${ext} file. Save it again as a PDF or photo and try again.`);

  const storageKey = blobConfigured() ? await putBlob(`clients/${input.tenant.id}`, data, type.mime) : null;
  try {
    const row = await prisma.clientDocument.create({
      data: {
        tenantId: input.tenant.id,
        siteId: input.tenant.siteId,
        kind,
        label,
        name,
        mime: type.mime,
        size: data.length,
        data: storageKey ? null : data,
        storageKey,
        createdById: input.by.id,
        createdByName: input.by.name.slice(0, 255),
      },
      select: DOCUMENT_META,
    });
    return documentOut(row);
  } catch (err) {
    if (storageKey) await deleteBlobs([storageKey]);
    throw err;
  }
}

/** Mark a document removed. Its bytes stay (see the top of this file). */
export async function removeDocument(doc: DocumentMeta, by: { id: string | null; name: string }) {
  await prisma.clientDocument.update({ where: { id: doc.id }, data: { removedAt: new Date(), removedById: by.id, removedByName: by.name.slice(0, 255) } });
}

/** A document's bytes, from the database or Blob Storage. */
export async function documentBytes(doc: Pick<ClientDocument, "id" | "storageKey">): Promise<Buffer> {
  if (doc.storageKey) return fileBytes({ id: doc.id, storageKey: doc.storageKey, data: null });
  const row = await prisma.clientDocument.findUniqueOrThrow({ where: { id: doc.id }, select: { id: true, data: true, storageKey: true } });
  return fileBytes(row);
}

/** Delete documents for good, with their blobs (the test-data reset, which deletes every resident). */
export async function deleteDocuments(where: Prisma.ClientDocumentWhereInput): Promise<number> {
  const keys = (await prisma.clientDocument.findMany({ where: { AND: [where, { storageKey: { not: null } }] }, select: { storageKey: true } })).map((r) => r.storageKey!);
  const { count } = await prisma.clientDocument.deleteMany({ where });
  if (keys.length) await deleteBlobs(keys);
  return count;
}

/** "Lease: lease-2026.pdf" — how the audit log names a document. */
export const documentWords = (d: Pick<DocumentMeta, "kind" | "label" | "name">) => `${kindLabel(d.kind)}: ${d.label ? `${d.label} (${d.name})` : d.name}`;
