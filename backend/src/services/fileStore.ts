import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import { prisma } from "../prisma.js";
import { env, isProd } from "../env.js";

/**
 * Where uploaded files' bytes live: File fields, code forms' photos and
 * signatures (FormFile rows).
 *
 * In Azure they go to Blob Storage: AZURE_STORAGE_ACCOUNT_URL, signed in with
 * the API app's managed identity (it needs "Storage Blob Data Contributor" on
 * the account or the container), one private container (AZURE_STORAGE_CONTAINER,
 * "form-files"), named "<formId>/<random uuid>". The FormFile row keeps the name,
 * type, size, who and which entry, and the blob's name in `storageKey`.
 *
 * Without that setting (local development) the bytes stay in the row's `data`.
 * Reading handles either, so a database that started without Blob Storage keeps
 * working after it's turned on; `npm run files:to-blob` moves the old ones over.
 */

export const blobConfigured = () => Boolean(env.blob.accountUrl || env.blob.connectionString);

export function fileStorageLabel(): string {
  if (env.blob.accountUrl) return `Azure Blob Storage (${env.blob.accountUrl}/${env.blob.container}, managed identity)`;
  if (env.blob.connectionString) return `Azure Blob Storage (connection string, container ${env.blob.container})`;
  return isProd ? "the database (AZURE_STORAGE_ACCOUNT_URL isn't set)" : "the database (local development)";
}

let container: Promise<ContainerClient> | null = null;

function blobContainer(): Promise<ContainerClient> {
  container ??= (async () => {
    const service = env.blob.connectionString
      ? BlobServiceClient.fromConnectionString(env.blob.connectionString)
      : new BlobServiceClient(env.blob.accountUrl, new DefaultAzureCredential());
    const client = service.getContainerClient(env.blob.container);
    // Usually made by the infrastructure already; making it here too keeps a new
    // environment (or Azurite) working. Private: files are only ever served
    // through the API's permission checks.
    await client.createIfNotExists().catch((err) => {
      console.warn(`[files] couldn't check or create the "${env.blob.container}" container (${err instanceof Error ? err.message : err}); assuming it exists.`);
    });
    return client;
  })().catch((err) => {
    container = null;
    throw err;
  });
  return container;
}

async function putBlob(formId: string, data: Buffer, mime: string): Promise<string> {
  const key = `${formId}/${crypto.randomUUID()}`;
  const blob = (await blobContainer()).getBlockBlobClient(key);
  await blob.uploadData(data, { blobHTTPHeaders: { blobContentType: mime } });
  return key;
}

async function deleteBlobs(keys: string[]) {
  if (!keys.length) return;
  const c = await blobContainer();
  for (const key of keys) {
    // An orphaned blob costs pennies and harms nothing; a failed delete never fails the caller.
    await c.deleteBlob(key, { deleteSnapshots: "include" }).catch((err) => {
      if (err?.statusCode !== 404) console.error(`[files] couldn't delete blob ${key}:`, err instanceof Error ? err.message : err);
    });
  }
}

export interface NewFile {
  formId: string;
  fieldId: string;
  name: string;
  mime: string;
  data: Buffer;
  entryId?: string | null;
  createdById?: string | null;
}

/** Save a file: its bytes where they're kept, then its FormFile row. */
export async function createFormFile(file: NewFile) {
  const { data, ...fields } = file;
  const storageKey = blobConfigured() ? await putBlob(file.formId, data, file.mime) : null;
  try {
    return await prisma.formFile.create({
      data: { ...fields, size: data.length, data: storageKey ? null : data, storageKey },
      select: { id: true, name: true, mime: true, size: true },
    });
  } catch (err) {
    if (storageKey) await deleteBlobs([storageKey]);
    throw err;
  }
}

/** A file's bytes, from the database or Blob Storage. */
export async function fileBytes(row: { id: string; data: Uint8Array | null; storageKey: string | null }): Promise<Buffer> {
  if (row.storageKey) return (await blobContainer()).getBlockBlobClient(row.storageKey).downloadToBuffer();
  if (row.data) return Buffer.from(row.data);
  throw new Error(`File ${row.id} has no contents.`);
}

/** Delete FormFile rows, and their blobs. Returns how many rows went. */
export async function deleteFiles(where: Prisma.FormFileWhereInput): Promise<number> {
  const keys = (await prisma.formFile.findMany({ where: { AND: [where, { storageKey: { not: null } }] }, select: { storageKey: true } })).map((r) => r.storageKey!);
  const { count } = await prisma.formFile.deleteMany({ where });
  if (keys.length) await deleteBlobs(keys);
  return count;
}

/** Uploaded but never saved with an entry, after a day: swept when the next file arrives, no scheduler needed. */
export function sweepUnattachedFiles() {
  return deleteFiles({ entryId: null, createdAt: { lt: new Date(Date.now() - 86_400_000) } });
}

/** Move files kept in the database into Blob Storage (scripts/files-to-blob.ts). */
export async function moveFilesToBlob(log: (line: string) => void = console.log): Promise<number> {
  if (!blobConfigured()) throw new Error("Set AZURE_STORAGE_ACCOUNT_URL (or AZURE_STORAGE_CONNECTION_STRING) first.");
  let moved = 0;
  for (;;) {
    const rows = await prisma.formFile.findMany({ where: { storageKey: null, data: { not: null } }, select: { id: true, formId: true, mime: true, data: true }, take: 50 });
    if (!rows.length) return moved;
    for (const r of rows) {
      const storageKey = await putBlob(r.formId, Buffer.from(r.data!), r.mime);
      await prisma.formFile.update({ where: { id: r.id }, data: { storageKey, data: null } });
      moved++;
    }
    log(`  moved ${moved} files`);
  }
}
