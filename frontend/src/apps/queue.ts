import { ApiError } from "@/lib/api";
import { runtimeApi, submitAppEntry } from "./api";
import { isOnline } from "@/lib/offline";

/**
 * The device's offline queue for code forms. A page calls
 * entries.create(entry, { offline: true }); the entry is written here first
 * (IndexedDB, in the app's own origin — the sandboxed frame has no storage of
 * its own) and uploaded in the background, retried until the server answers.
 * Its clientId makes a retry return the entry already saved rather than
 * saving it twice. Started once from AppShell, so uploads continue whichever
 * screen is open.
 */

export interface QueuedEntry {
  clientId: string;
  slug: string;
  /** The form's title, for the app's "saved on this device" list. */
  title?: string;
  draft: boolean;
  userId: string;
  entry: Record<string, unknown>;
  offlineOverride?: string;
  queuedAt: number;
  attempts: number;
  /** Set when the server refused it; it waits for a person then. */
  error?: string;
}

export interface QueueStatus {
  pending: number;
  pendingIds: string[];
  failed: { clientId: string; error: string; entry: Record<string, unknown> }[];
  online: boolean;
  syncing: boolean;
  lastSyncedAt: string | null;
}

const DB = "lcs-app-queue";
const STORE = "entries";
/** Photos and files taken with no connection, waiting to upload ahead of their entry. */
const FILES = "files";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "clientId" });
      if (!req.result.objectStoreNames.contains(FILES)) req.result.createObjectStore(FILES, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, store = STORE): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
  });
}

const all = () => tx<QueuedEntry[]>("readonly", (s) => s.getAll() as IDBRequest<QueuedEntry[]>);
const put = (e: QueuedEntry) => tx("readwrite", (s) => s.put(e));
const del = (id: string) => tx("readwrite", (s) => s.delete(id));

// ── Files kept on the device ─────────────────────────────────────────────

export interface LocalFile {
  /** "local:<uuid>" — the fileId the page holds until it uploads. */
  id: string;
  slug: string;
  draft: boolean;
  userId: string;
  name: string;
  mime: string;
  label?: string;
  data: Blob;
  savedAt: number;
}

export interface FileRef {
  fileId: string;
  name: string;
  mime: string;
  size: number;
}

/** Keep a file on the device; the ref works in an entry and with files.url until it uploads. */
export async function saveLocalFile(f: Omit<LocalFile, "id" | "savedAt">): Promise<FileRef> {
  const id = `local:${crypto.randomUUID()}`;
  await tx("readwrite", (s) => s.put({ ...f, id, savedAt: Date.now() }), FILES);
  return { fileId: id, name: f.name, mime: f.mime, size: f.data.size };
}

export const localFile = (id: string) => tx<LocalFile | undefined>("readonly", (s) => s.get(id) as IDBRequest<LocalFile | undefined>, FILES);

/**
 * Upload the device-kept files an entry refers to and swap in the server's
 * ids. Throws (leaving the entry queued) if an upload can't go through yet.
 */
function localIdsIn(data: unknown): Set<string> {
  const ids = new Set<string>();
  const walk = (v: unknown, depth = 0) => {
    if (depth > 20 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    if (typeof o.fileId === "string" && o.fileId.startsWith("local:")) ids.add(o.fileId);
    Object.values(o).forEach((x) => walk(x, depth + 1));
  };
  walk(data);
  return ids;
}

async function uploadLocalFiles(r: QueuedEntry): Promise<QueuedEntry> {
  const ids = localIdsIn(r.entry.data);
  if (!ids.size) return r;
  const swap = new Map<string, FileRef>();
  for (const id of ids) {
    const f = await localFile(id);
    if (!f) throw new ApiError(400, "A photo for this entry is missing from the device.");
    swap.set(id, await runtimeApi.upload(r.slug, r.draft, { name: f.name, mime: f.mime, label: f.label, data: f.data }));
  }
  const replace = (v: unknown, depth = 0): unknown => {
    if (depth > 20 || !v || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => replace(x, depth + 1));
    const o = v as Record<string, unknown>;
    if (typeof o.fileId === "string" && swap.has(o.fileId)) return { ...o, ...swap.get(o.fileId) };
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, replace(x, depth + 1)]));
  };
  const next = { ...r, entry: { ...r.entry, data: replace(r.entry.data) } };
  // Saved before the entry goes, so a retry doesn't upload the photos twice.
  await put(next);
  for (const id of ids) await tx("readwrite", (s) => s.delete(id), FILES);
  return next;
}

let syncing = false;
let lastSyncedAt: string | null = null;
let currentUser: string | null = null;
const listeners = new Set<() => void>();

export function onQueueChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => listeners.forEach((l) => l());

export async function queueStatus(slug: string): Promise<QueueStatus> {
  const rows = (await all().catch(() => [] as QueuedEntry[])).filter((r) => r.slug === slug && r.userId === currentUser);
  return {
    pending: rows.filter((r) => !r.error).length,
    pendingIds: rows.filter((r) => !r.error).map((r) => r.clientId),
    failed: rows.filter((r) => r.error).map((r) => ({ clientId: r.clientId, error: r.error!, entry: r.entry })),
    online: isOnline(),
    syncing,
    lastSyncedAt,
  };
}

/** Every entry of the signed-in person's waiting on this device, all forms. */
export async function allQueued() {
  return (await all().catch(() => [] as QueuedEntry[])).filter((r) => r.userId === currentUser).sort((a, b) => a.queuedAt - b.queuedAt);
}

export async function enqueue(e: Omit<QueuedEntry, "queuedAt" | "attempts">) {
  await put({ ...e, queuedAt: Date.now(), attempts: 0 });
  notify();
  void syncNow();
}

export async function discard(clientId: string) {
  const row = (await all().catch(() => [] as QueuedEntry[])).find((r) => r.clientId === clientId);
  await del(clientId);
  // Its photos taken offline go with it.
  for (const id of row ? localIdsIn(row.entry.data) : []) await tx("readwrite", (s) => s.delete(id), FILES).catch(() => undefined);
  notify();
}

export async function retryFailed(slug: string) {
  for (const r of await all()) if (r.slug === slug && r.error) await put({ ...r, error: undefined });
  notify();
  await syncNow();
}

export async function syncNow() {
  if (syncing || !navigator.onLine || !currentUser) return;
  syncing = true;
  notify();
  try {
    const rows = (await all()).filter((r) => !r.error && r.userId === currentUser).sort((a, b) => a.queuedAt - b.queuedAt);
    for (const queued of rows) {
      let r = queued;
      try {
        r = await uploadLocalFiles(r);
        let res = await submitAppEntry(r.slug, r.draft, r.entry);
        if (res.status === "needs_override") {
          res = await submitAppEntry(r.slug, r.draft, { ...r.entry, override: r.offlineOverride || "Recorded offline — the limit wasn't checked in time. Please review." });
        }
        if (res.status === "saved") await del(r.clientId);
        else await put({ ...r, attempts: r.attempts + 1, error: res.status === "invalid" ? res.message : "The server asked for a reason again." });
      } catch (err) {
        // No connection (or the server is down): leave it for the next pass.
        if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
          await put({ ...r, attempts: r.attempts + 1, error: err.message });
        } else {
          await put({ ...r, attempts: r.attempts + 1 });
          break;
        }
      }
      notify();
    }
    lastSyncedAt = new Date().toISOString();
  } finally {
    syncing = false;
    notify();
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Called from AppShell with the signed-in person (null on sign-out). */
export function startAppQueue(userId: string | null) {
  currentUser = userId;
  if (timer) clearInterval(timer);
  timer = null;
  if (!userId) return;
  timer = setInterval(() => void syncNow(), 30_000);
  window.addEventListener("online", () => {
    notify();
    void syncNow();
  });
  window.addEventListener("offline", notify);
  void syncNow();
}
