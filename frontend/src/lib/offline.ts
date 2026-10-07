import { useSyncExternalStore } from "react";
import { readStorage, writeStorage } from "./storage";
import { isMobileDevice } from "./device";

/**
 * Offline mode, the page's side of it. public/sw.js keeps the app and what it
 * last read on the device; this registers it, keeps track of whether the
 * server can actually be reached. (lib/snapshot.ts reads the rest of the site
 * ahead, so it opens with no connection later.)
 *
 * `navigator.onLine` is not enough on its own: an iPad on site Wi-Fi with no
 * internet behind it says it's online while every request hangs. So every API
 * answer reports in (lib/api.ts) — a real answer means online, a copy from the
 * cache or a network failure means offline — and while offline the health
 * endpoint is polled, so the app notices the connection coming back without a
 * person having to do anything.
 *
 * Entries themselves are kept by the queues (lib/fillQueue.ts,
 * apps/queue.ts); `onReconnect` is how they hear it's time to
 * upload.
 */

interface Connectivity {
  online: boolean;
  /** The service worker is in charge of this page: it will open with no connection. */
  ready: boolean;
  /** Offline, and showing data stored at this time (ms) — the oldest seen since going offline. */
  showingSavedFrom: number | null;
  /** When the connection was last lost (ms). */
  offlineSince: number | null;
}

let state: Connectivity = {
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  ready: false,
  showingSavedFrom: null,
  offlineSince: typeof navigator !== "undefined" && !navigator.onLine ? Date.now() : null,
};
const listeners = new Set<() => void>();
const reconnectListeners = new Set<() => void>();

function set(patch: Partial<Connectivity>) {
  const next = { ...state, ...patch };
  if (Object.keys(patch).every((k) => next[k as keyof Connectivity] === state[k as keyof Connectivity])) return;
  const cameBack = !state.online && next.online;
  state = next;
  listeners.forEach((l) => l());
  if (cameBack) reconnectListeners.forEach((l) => l());
}

function goOffline() {
  if (state.online) set({ online: false, offlineSince: Date.now() });
  schedulePoll();
}

function goOnline() {
  set({ online: true, showingSavedFrom: null, offlineSince: null });
}

// ── Reports from lib/api.ts ──────────────────────────────────────────────

/** A response reached the page: from the server, or the worker's stored copy. */
export function noteResponse(res: Response) {
  // A device-first list (public/sw.js DEVICE_FIRST) says nothing about the connection.
  if (res.headers.get("x-lcs-device")) return;
  const cachedAt = Number(res.headers.get("x-lcs-cached-at")) || null;
  if (res.headers.get("x-lcs-offline")) return goOffline();
  if (!cachedAt) return goOnline();
  goOffline();
  set({ showingSavedFrom: Math.min(state.showingSavedFrom ?? cachedAt, cachedAt) });
}

/** The request never got an answer. */
export function noteNetworkFailure() {
  goOffline();
}

/** When a stored copy was saved, or null for a fresh answer from the server. */
export function cachedAtOf(res: Response) {
  return Number(res.headers.get("x-lcs-cached-at")) || null;
}

// ── Answers the worker can't see ─────────────────────────────────────────

/**
 * A copy of an answer that didn't come from a GET: a code form's read-only
 * server actions are POSTs, so the service worker never stores them. Kept in
 * the same per-person cache, so signing out clears them too.
 */
const answerKey = (key: string) => new Request(`${location.origin}/__lcs-answer/${key}`);

export async function storeAnswer(key: string, value: unknown) {
  if (!offlineEnabled()) return;
  try {
    const cache = await caches.open("lcs-api");
    await cache.put(answerKey(key), new Response(JSON.stringify(value ?? null), { headers: { "Content-Type": "application/json", "x-lcs-cached-at": String(Date.now()) } }));
  } catch {
    // No Cache Storage here (plain http): there's just no offline copy.
  }
}

/** The stored answer, or undefined. Being shown it counts as showing stored data. */
export async function storedAnswer<T>(key: string): Promise<T | undefined> {
  if (!offlineEnabled()) return undefined;
  try {
    const hit = await (await caches.open("lcs-api")).match(answerKey(key));
    if (!hit) return undefined;
    const value = (await hit.json()) as T;
    noteResponse(hit);
    return value;
  } catch {
    return undefined;
  }
}

// ── Is the app busy? ─────────────────────────────────────────────────────

let inFlight = 0;
let lastRequestAt = 0;

/** A screen's own request started; call the result when it ends. (Background reads aren't counted.) */
export function requestStarted() {
  inFlight++;
  lastRequestAt = Date.now();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    inFlight--;
    lastRequestAt = Date.now();
  };
}

/** No screen request in flight, and none for `ms` — room for background work. */
export const appIsQuiet = (ms: number) => inFlight === 0 && Date.now() - lastRequestAt > ms;

// ── Updates from the worker ──────────────────────────────────────────────

const updateListeners = new Set<(path: string) => void>();

/** A device-first list (meal types, the forms list…) changed on the server: `path` is under /api. Returns an unsubscribe. */
export function onApiUpdated(fn: (path: string) => void) {
  updateListeners.add(fn);
  return () => {
    updateListeners.delete(fn);
  };
}

// ── Polling while offline ────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePoll(delay = 8000) {
  if (pollTimer || typeof window === "undefined") return;
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    if (state.online) return;
    if (await reachable()) goOnline();
    else schedulePoll(15_000);
  }, delay);
}

/** Can the server actually be reached? (/api/health always skips the worker's cache.) */
export async function reachable(timeoutMs = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("/api/health", { cache: "no-store", signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** Runs each time the connection comes back. Returns an unsubscribe. */
export function onReconnect(fn: () => void) {
  reconnectListeners.add(fn);
  return () => {
    reconnectListeners.delete(fn);
  };
}

/** Runs on any change of connection state. Returns an unsubscribe. */
export function onConnectivityChange(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Outside React: is the server believed reachable right now? */
export const isOnline = () => state.online;

export function useConnectivity() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state
  );
}

// ── The service worker ───────────────────────────────────────────────────

let started = false;
let enabled: boolean | null = null;

/**
 * Offline mode — the service worker, stored copies of screens, the background
 * download (lib/snapshot.ts) and the roster kept on the device
 * (lib/rosterStore.ts) — runs on iPads and phones only. A computer is used
 * online at an office, and needn't hold a copy of every resident. (Entries
 * that lose their connection mid-save are still queued there, as before.)
 * Decided once per page load.
 */
export function offlineEnabled() {
  enabled ??= typeof window !== "undefined" && isMobileDevice();
  return enabled;
}

/** The service worker and every copy it or the app stored, gone (a computer, or the kill switch). */
function removeOfflineCopies() {
  void navigator.serviceWorker?.getRegistrations().then((rs) => rs.forEach((r) => void r.unregister()));
  if (typeof caches !== "undefined") void caches.keys().then((ks) => ks.filter((k) => k.startsWith("lcs-")).forEach((k) => void caches.delete(k)));
}

/**
 * Called once when the app starts. Service workers need https (or localhost):
 * on plain http — the dev server opened from an iPad by LAN address — there is
 * none, and the app only survives a drop while it stays open.
 */
export function startOffline() {
  if (started || typeof window === "undefined") return;
  started = true;

  window.addEventListener("online", () => void reachable().then((ok) => (ok ? goOnline() : goOffline())));
  window.addEventListener("offline", goOffline);
  if (!navigator.onLine) schedulePoll(0);

  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;

  // A computer (anything left from before offline mode was mobile-only goes too), or the kill switch:
  // NEXT_PUBLIC_OFFLINE=off removes the worker and its copies from every device that opens the app.
  if (!offlineEnabled() || process.env.NEXT_PUBLIC_OFFLINE === "off") {
    enabled = false;
    removeOfflineCopies();
    return;
  }

  const dev = process.env.NODE_ENV !== "production";
  navigator.serviceWorker
    .register(dev ? "/sw.js?dev=1" : "/sw.js", { scope: "/", updateViaCache: "none" })
    .then((reg) => {
      // A home-screen app can stay open for days; look for a new version when it comes back to the front.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && state.online) void reg.update().catch(() => undefined);
      });
    })
    .catch(() => undefined);

  const markReady = () => {
    set({ ready: Boolean(navigator.serviceWorker.controller) });
    sendLoadedFiles();
  };
  if (navigator.serviceWorker.controller) markReady();
  navigator.serviceWorker.addEventListener("controllerchange", markReady);
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "api-updated" && typeof e.data.path === "string") {
      const path = e.data.path.replace(/^\/api/, "");
      updateListeners.forEach((l) => l(path));
    }
  });

  // Ask the browser not to clear this site's storage under pressure (queued entries live there too).
  void navigator.storage?.persist?.().catch(() => false);
}

/** Files this page loaded before the worker took over (the first visit) — it stores them now. */
function sendLoadedFiles() {
  const urls = performance
    .getEntriesByType("resource")
    .map((e) => e.name)
    .filter((u) => u.startsWith(location.origin) && !u.includes("/api/") && !u.includes("webpack-hmr"));
  urls.push(`${location.origin}/app-runtime/runtime.js`, `${location.origin}/app-runtime/runtime.css`);
  navigator.serviceWorker.controller?.postMessage({ type: "warm", urls });
}

// ── Whose data is stored ─────────────────────────────────────────────────

const LAST_USER = "ln.offline.user";

function clearStoredReads() {
  navigator.serviceWorker?.controller?.postMessage({ type: "clear-api" });
  // Also when no worker controls this page yet.
  void (typeof caches !== "undefined" ? caches.delete("lcs-api") : undefined)?.catch(() => undefined);
}

/**
 * The stored reads belong to one person. Called with whoever is signed in:
 * when that changes (a shared iPad, a new shift), the last person's copies go.
 */
export function noteSignedIn(userId: string | null) {
  if (!userId) return;
  const last = readStorage(LAST_USER);
  if (last && last !== userId) clearStoredReads();
  writeStorage(LAST_USER, userId);
}

/** Signing out: nothing of theirs is left to read on the device. Queued entries stay and upload when they sign in again. */
export function noteSignedOut() {
  clearStoredReads();
  writeStorage(LAST_USER, null);
}
