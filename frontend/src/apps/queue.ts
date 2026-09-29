import { ApiError } from "@/lib/api";
import { submitAppEntry } from "./api";

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

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "clientId" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
  });
}

const all = () => tx<QueuedEntry[]>("readonly", (s) => s.getAll() as IDBRequest<QueuedEntry[]>);
const put = (e: QueuedEntry) => tx("readwrite", (s) => s.put(e));
const del = (id: string) => tx("readwrite", (s) => s.delete(id));

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
    online: navigator.onLine,
    syncing,
    lastSyncedAt,
  };
}

export async function enqueue(e: Omit<QueuedEntry, "queuedAt" | "attempts">) {
  await put({ ...e, queuedAt: Date.now(), attempts: 0 });
  notify();
  void syncNow();
}

export async function discard(clientId: string) {
  await del(clientId);
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
    for (const r of rows) {
      try {
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
