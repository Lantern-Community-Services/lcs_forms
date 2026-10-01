import { useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";
import { hotFoodsApi } from "./queries";
import type { HotFoodToday } from "./types";
import { errorMessage } from "@/lib/utils";
import { isOnline, onConnectivityChange } from "./offline";

/**
 * Hot Foods entries are saved on the device first and uploaded behind the
 * scenes, so a serving line never waits on the network and a dropped
 * connection loses nothing. The resident has signed and has their meal by the
 * time Save is tapped; everything after that is bookkeeping.
 *
 * Entries live in IndexedDB (signatures are too big for localStorage's 5 MB)
 * and carry a device-made `clientId`, so an upload that timed out after the
 * server wrote it is recognised on retry instead of recorded twice. Each entry
 * is held for a few seconds before upload so Undo is just a local delete.
 *
 * Uploads go as whoever is signed in, so an entry only uploads under the
 * account that recorded it; another person's entries wait on the device.
 */

export interface QueuedEntry {
  clientId: string;
  userId: string;
  siteCode: string;
  tenantId: string;
  tenantName: string;
  unit: string | null;
  mealCount: number;
  /** Device clock, ms. Sent as `servedAt`. */
  savedAt: number;
  /** Not uploaded before this, so Undo can still take it back. */
  holdUntil: number;
  attempts: number;
  /** "failed": the server refused it (not a network problem) — needs a person. */
  status: "pending" | "failed";
  error?: string;
  body: {
    site: string;
    tenantId: string;
    items: { itemId: string; quantity: number }[];
    notes?: string;
    overrideReason?: string;
    signature: string;
  };
}

export const UNDO_MS = 6000;
const DB_NAME = "ln-offline";
const STORE = "hotfoods";

// ── Storage ──────────────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase | null> | null = null;
function db() {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "clientId" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve, reject) => {
    const req = run(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── State ────────────────────────────────────────────────────────────────

interface State {
  loaded: boolean;
  /** False when IndexedDB is unavailable: entries only live while the tab is open. */
  durable: boolean;
  online: boolean;
  syncing: boolean;
  /** Who uploads go as; null when signed out. */
  userId: string | null;
  items: QueuedEntry[];
}

let state: State = { loaded: false, durable: true, online: typeof navigator === "undefined" ? true : navigator.onLine, syncing: false, userId: null, items: [] };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

let loading: Promise<void> | null = null;
function load() {
  loading ??= (async () => {
    const d = await db();
    let items: QueuedEntry[] = [];
    try {
      items = (await tx<QueuedEntry[]>("readonly", (s) => s.getAll())) ?? [];
    } catch {
      // Unreadable store: carry on in memory rather than block recording.
    }
    // Anything saved while this tab was loading stays too.
    const known = new Set(items.map((i) => i.clientId));
    set({ loaded: true, durable: Boolean(d), items: [...items, ...state.items.filter((i) => !known.has(i.clientId))].sort((a, b) => a.savedAt - b.savedAt) });
  })();
  return loading;
}

async function put(item: QueuedEntry) {
  set({ items: [...state.items.filter((i) => i.clientId !== item.clientId), item].sort((a, b) => a.savedAt - b.savedAt) });
  try {
    await tx("readwrite", (s) => s.put(item));
  } catch {
    set({ durable: false });
  }
}

async function remove(clientId: string) {
  set({ items: state.items.filter((i) => i.clientId !== clientId) });
  try {
    await tx("readwrite", (s) => s.delete(clientId));
  } catch {
    // Already gone, or storage unavailable — memory is the source of truth now.
  }
}

function newId() {
  try {
    return crypto.randomUUID();
  } catch {
    // Not a secure context (plain http on a LAN address).
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

// ── Public actions ───────────────────────────────────────────────────────

export async function enqueueHotFood(entry: Omit<QueuedEntry, "clientId" | "savedAt" | "holdUntil" | "attempts" | "status">) {
  const now = Date.now();
  const item: QueuedEntry = { ...entry, clientId: newId(), savedAt: now, holdUntil: now + UNDO_MS, attempts: 0, status: "pending" };
  await put(item);
  setTimeout(kick, UNDO_MS + 50);
  return item;
}

/** Take back an entry that hasn't uploaded yet. False if it already went. */
export function undoHotFood(clientId: string) {
  const item = state.items.find((i) => i.clientId === clientId);
  if (!item || inFlight === clientId) return false;
  void remove(clientId);
  return true;
}

export function discardHotFood(clientId: string) {
  if (inFlight === clientId) return;
  void remove(clientId);
}

/** Put refused entries back in line (after, say, the resident is restored to the roster). */
export function retryHotFoods() {
  state.items.filter((i) => i.status === "failed").forEach((i) => void put({ ...i, status: "pending", error: undefined, attempts: 0 }));
  backoffUntil = 0;
  kick();
}

// ── Upload loop ──────────────────────────────────────────────────────────

let qc: QueryClient | null = null;
let inFlight: string | null = null;
let backoffUntil = 0;
let failures = 0;

/** Transient: worth retrying on its own. Anything else needs a person to look. */
const transient = (e: unknown) => !(e instanceof ApiError) || e.status >= 500 || [401, 408, 425, 429].includes(e.status);

export async function kick() {
  const userId = state.userId;
  if (!userId || state.syncing || Date.now() < backoffUntil) return;
  await load();
  set({ syncing: true });
  try {
    for (;;) {
      const next = state.items.find((i) => i.userId === userId && i.status === "pending" && i.holdUntil <= Date.now());
      if (!next) break;
      inFlight = next.clientId;
      try {
        const res = await hotFoodsApi.create({ ...next.body, clientId: next.clientId, servedAt: new Date(next.savedAt).toISOString() });
        failures = 0;
        set({ online: true });
        // The server's count for that resident, so the list doesn't blink
        // back to "not served" between this upload and the next refetch.
        qc?.setQueryData<HotFoodToday>(["hotfoods", "today", next.siteCode], (t) => (t ? { ...t, counts: { ...t.counts, [next.tenantId]: res.todayCount } } : t));
        inFlight = null;
        await remove(next.clientId);
        qc?.invalidateQueries({ queryKey: ["hotfoods"], predicate: (q) => q.queryKey[1] !== "today" && q.queryKey[1] !== "items" });
      } catch (e) {
        inFlight = null;
        if (transient(e)) {
          failures++;
          // 5s, 10s, 20s … capped at a minute. The online event cuts it short.
          backoffUntil = Date.now() + Math.min(60_000, 5000 * 2 ** (failures - 1));
          if (!(e instanceof ApiError)) set({ online: false });
          await put({ ...next, attempts: next.attempts + 1 });
          setTimeout(kick, backoffUntil - Date.now() + 50);
          break;
        }
        await put({ ...next, status: "failed", attempts: next.attempts + 1, error: errorMessage(e, "The server refused this entry.") });
      }
    }
  } finally {
    inFlight = null;
    set({ syncing: false });
  }
  // One saved while this pass ran is picked up when its Undo window closes.
  const held = state.items.filter((i) => i.userId === userId && i.status === "pending" && i.holdUntil > Date.now());
  if (held.length && Date.now() >= backoffUntil) setTimeout(kick, Math.min(...held.map((i) => i.holdUntil)) - Date.now() + 50);
}

let started = false;
/** Called by the app shell once someone is signed in; safe to call repeatedly. */
export function startHotFoodsSync(client: QueryClient, uid: string | null) {
  qc = client;
  if (state.userId !== uid) {
    backoffUntil = 0;
    set({ userId: uid });
  }
  if (!started && typeof window !== "undefined") {
    started = true;
    void load();
    const wake = () => {
      backoffUntil = 0;
      set({ online: navigator.onLine });
      void kick();
    };
    window.addEventListener("online", wake);
    window.addEventListener("offline", () => set({ online: false }));
    // The app's own reading (lib/offline.ts): site Wi-Fi with no internet still says navigator.onLine.
    onConnectivityChange(() => {
      if (isOnline() === state.online) return;
      if (isOnline()) wake();
      else set({ online: false });
    });
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void kick());
    setInterval(() => void kick(), 20_000);
  }
  void kick();
}

export function useHotFoodsQueue() {
  const s = useSyncExternalStore(subscribe, () => state, () => state);
  const mine = s.items.filter((i) => i.userId === s.userId);
  return {
    ...s,
    mine,
    pending: mine.filter((i) => i.status === "pending"),
    failed: mine.filter((i) => i.status === "failed"),
    /** Other people's entries recorded on this device, waiting for them to sign in. */
    others: s.items.filter((i) => i.userId !== s.userId),
  };
}

/** Today's server counts plus this device's not-yet-uploaded entries for the site. */
export function withQueued(counts: Record<string, number>, items: QueuedEntry[], siteCode: string | undefined) {
  if (!siteCode) return counts;
  const out = { ...counts };
  const today = new Date().toDateString();
  for (const i of items) {
    if (i.siteCode === siteCode && new Date(i.savedAt).toDateString() === today) out[i.tenantId] = (out[i.tenantId] ?? 0) + 1;
  }
  return out;
}
