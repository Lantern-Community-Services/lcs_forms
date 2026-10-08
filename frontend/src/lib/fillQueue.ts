import { useSyncExternalStore } from "react";
import { ApiError } from "./api";
import { fillApi, submitErrors } from "./builder";
import type { Values } from "./formEngine";
import { errorMessage } from "./utils";

/**
 * Built forms (/f/<slug>) filled in with no connection. The entry is kept on
 * the device and uploaded when the server can be reached, from whichever
 * screen is open (started from AppShell). Its clientId — the one FillPage
 * already sends — makes a retry after a timed-out upload return the saved
 * entry instead of saving it twice.
 *
 * A file attached offline can't be uploaded when it's picked, as it normally
 * is, so it's kept here too (as a Blob, under a `local-…` id in the answers)
 * and uploaded just before the entry; the answers are then rewritten with the
 * server's file ids.
 *
 * Like the code forms' queue, an entry only uploads as the person who filled it
 * in. Public forms (userId null) upload under whoever is here, or no one.
 */

export interface QueuedFill {
  clientId: string;
  slug: string;
  title: string;
  userId: string | null;
  values: Values;
  siteCode?: string | null;
  codeErrors?: Record<string, string>;
  /** The published version it was filled in on; missing on entries queued before this was kept. */
  formVersion?: number | null;
  queuedAt: number;
  attempts: number;
  /** The server refused it (not a network problem); it waits for a person. */
  error?: string;
}

interface LocalFile {
  id: string;
  slug: string;
  fieldId: string;
  name: string;
  mime: string;
  size: number;
  blob: Blob;
  savedAt: number;
}

export interface UploadedFileRef {
  id: string;
  name: string;
  size: number;
  mime: string;
}

const DB_NAME = "lcs-fill-queue";
const ENTRIES = "entries";
const FILES = "files";
const LOCAL_PREFIX = "local-";

// ── Storage ──────────────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null;
function db() {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(ENTRIES, { keyPath: "clientId" });
      req.result.createObjectStore(FILES, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Storage is blocked."));
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

async function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise<T>((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = run(t.objectStore(store));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const allRows = () => tx<QueuedFill[]>(ENTRIES, "readonly", (s) => s.getAll() as IDBRequest<QueuedFill[]>);
const putRow = (r: QueuedFill) => tx(ENTRIES, "readwrite", (s) => s.put(r));
const delRow = (id: string) => tx(ENTRIES, "readwrite", (s) => s.delete(id));
const getFile = (id: string) => tx<LocalFile | undefined>(FILES, "readonly", (s) => s.get(id) as IDBRequest<LocalFile | undefined>);
const delFile = (id: string) => tx(FILES, "readwrite", (s) => s.delete(id));

function newId() {
  try {
    return crypto.randomUUID();
  } catch {
    // Not a secure context (plain http on a LAN address).
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

// ── Files attached offline ───────────────────────────────────────────────

/** Keep a file on the device; the returned ref goes into the answers like an uploaded one. */
export async function saveLocalFile(slug: string, fieldId: string, file: File): Promise<UploadedFileRef> {
  const rec: LocalFile = { id: `${LOCAL_PREFIX}${newId()}`, slug, fieldId, name: file.name, mime: file.type, size: file.size, blob: file, savedAt: Date.now() };
  await tx(FILES, "readwrite", (s) => s.put(rec));
  return { id: rec.id, name: rec.name, size: rec.size, mime: rec.mime };
}

export const isLocalFile = (id: string) => id.startsWith(LOCAL_PREFIX);

/** Ids of every `local-…` file ref in a set of answers (files can sit inside repeaters). */
function localIds(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => localIds(x, out));
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.id === "string" && isLocalFile(o.id) && typeof o.name === "string") out.add(o.id);
    else Object.values(o).forEach((x) => localIds(x, out));
  }
  return out;
}

function swapIds<T>(v: T, map: Map<string, UploadedFileRef>): T {
  if (Array.isArray(v)) return v.map((x) => swapIds(x, map)) as T;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.id === "string" && map.has(o.id)) return map.get(o.id) as T;
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, swapIds(x, map)])) as T;
  }
  return v;
}

export const hasLocalFiles = (values: Values) => localIds(values).size > 0;

// ── State ────────────────────────────────────────────────────────────────

interface State {
  rows: QueuedFill[];
  syncing: boolean;
  userId: string | null;
}

let state: State = { rows: [], syncing: false, userId: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

async function reload() {
  try {
    set({ rows: (await allRows()).sort((a, b) => a.queuedAt - b.queuedAt) });
  } catch {
    // Storage unavailable: nothing was queued here.
  }
}

// ── Public actions ───────────────────────────────────────────────────────

export async function enqueueFill(row: Omit<QueuedFill, "queuedAt" | "attempts">) {
  await putRow({ ...row, queuedAt: Date.now(), attempts: 0 });
  await reload();
  void syncFills();
}

export async function discardFill(clientId: string) {
  const row = state.rows.find((r) => r.clientId === clientId);
  await delRow(clientId);
  if (row) for (const id of localIds(row.values)) await delFile(id).catch(() => undefined);
  await reload();
}

export async function retryFills() {
  for (const r of state.rows) if (r.error) await putRow({ ...r, error: undefined, attempts: 0 });
  await reload();
  await syncFills();
}

// ── Upload loop ──────────────────────────────────────────────────────────

/** Worth retrying on its own. Anything else needs a person. */
const transient = (e: unknown) => !(e instanceof ApiError) || e.status >= 500 || [401, 408, 425, 429].includes(e.status);

const mine = (r: QueuedFill) => r.userId === null || r.userId === state.userId;

export async function syncFills() {
  if (state.syncing) return;
  set({ syncing: true });
  try {
    await reload();
    for (const row of state.rows.filter((r) => !r.error && mine(r))) {
      let current = row;
      try {
        const locals = [...localIds(row.values)];
        if (locals.length) {
          const map = new Map<string, UploadedFileRef>();
          for (const id of locals) {
            const f = await getFile(id);
            if (!f) throw new ApiError(410, "A file attached to this entry is no longer on this device.");
            map.set(id, await fillApi.upload(row.slug, f.fieldId, new File([f.blob], f.name, { type: f.mime })));
          }
          // Uploaded: from here on a retry sends these refs, not the files again.
          current = { ...row, values: swapIds(row.values, map) };
          await putRow(current);
          for (const id of locals) await delFile(id).catch(() => undefined);
        }
        await fillApi.submit(row.slug, { values: current.values, siteCode: row.siteCode, clientId: row.clientId, codeErrors: row.codeErrors, formVersion: row.formVersion });
        await delRow(row.clientId);
      } catch (e) {
        if (transient(e)) {
          await putRow({ ...current, attempts: current.attempts + 1 }).catch(() => undefined);
          break;
        }
        const fields = Object.values(submitErrors(e));
        await putRow({ ...current, attempts: current.attempts + 1, error: fields.length ? fields.join(" ") : errorMessage(e, "The server refused this entry.") });
      }
      await reload();
    }
  } catch {
    // Storage unavailable.
  } finally {
    await reload();
    set({ syncing: false });
  }
}

/** Files left behind by a draft nobody sent, after two weeks. */
async function sweepFiles() {
  const keep = new Set(state.rows.flatMap((r) => [...localIds(r.values)]));
  const files = await tx<LocalFile[]>(FILES, "readonly", (s) => s.getAll() as IDBRequest<LocalFile[]>);
  for (const f of files) if (!keep.has(f.id) && Date.now() - f.savedAt > 14 * 86_400_000) await delFile(f.id);
}

let started = false;
/**
 * Called from AppShell with the signed-in person (null on sign-out), and from a
 * public form with `undefined` (just make sure uploads run). Safe to repeat.
 */
export function startFillQueue(userId: string | null | undefined) {
  if (userId !== undefined) set({ userId });
  if (!started && typeof window !== "undefined" && typeof indexedDB !== "undefined") {
    started = true;
    void reload().then(() => sweepFiles().catch(() => undefined));
    window.addEventListener("online", () => void syncFills());
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void syncFills());
    setInterval(() => void syncFills(), 30_000);
  }
  void syncFills();
}

export function useFillQueue() {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state
  );
  const rows = s.rows.filter(mine);
  return { ...s, pending: rows.filter((r) => !r.error), failed: rows.filter((r) => r.error), others: s.rows.filter((r) => !mine(r)) };
}
