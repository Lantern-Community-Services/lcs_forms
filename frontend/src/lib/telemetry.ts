import { currentDeviceKind as deviceKind } from "./device";

/**
 * What a device tells Admin → Dev log (backend routes/devlog.ts): how long a
 * page took to load, scripts that broke, taps that took long to answer, and
 * requests that were slow as the device saw them (the server's own count
 * can't see a weak phone signal).
 *
 * Small on purpose, and runs everywhere — it's the one piece of the dev log a
 * phone carries. It sends nothing a person typed: addresses lose their query
 * string and ids, a slow tap names the kind of control, not its text. Reports
 * go in a batch, at most every few seconds and when the app is put away;
 * offline, they wait (a few dozen at most) for the connection.
 */

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "/api";
const ENDPOINT = `${BASE}/devlog/client`;

/** A request the device waited this long for is reported. */
const SLOW_API_MS = 3000;
/** A tap or key press the page took this long to answer is reported. */
const SLOW_INTERACTION_MS = 500;
/** Per page load, so a broken loop can't flood the log. */
const LIMITS = { "client-error": 10, "slow-api": 10, "slow-interaction": 5 } as const;
const MAX_QUEUE = 50;

interface Item {
  kind: "client-error" | "page-load" | "slow-interaction" | "slow-api";
  path?: string;
  message?: string;
  status?: number;
  durationMs?: number;
  data?: Record<string, unknown>;
}

let queue: Item[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
const sent: Record<keyof typeof LIMITS, number> = { "client-error": 0, "slow-api": 0, "slow-interaction": 0 };
const seenErrors = new Set<string>();

const ID_SEGMENT = /^(\d+|c[a-z0-9]{20,32}|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|[A-Za-z0-9_-]{24,})$/;

/** An address with its ids and query string taken out: "/tenants/:id". */
export function pagePath(path = window.location.pathname): string {
  return path.split("?")[0].split("/").slice(0, 8).map((s) => (ID_SEGMENT.test(s) ? ":id" : s)).join("/") || "/";
}

function push(item: Item) {
  const limit = LIMITS[item.kind as keyof typeof LIMITS];
  if (limit !== undefined) {
    const k = item.kind as keyof typeof LIMITS;
    if (sent[k] >= limit) return;
    sent[k]++;
  }
  if (queue.length >= MAX_QUEUE) return;
  queue.push({ ...item, path: item.path ?? pagePath() });
  if (!timer) timer = setTimeout(() => flush(false), 5000);
}

function flush(leaving: boolean) {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!queue.length || !navigator.onLine) return;
  const batch = queue.splice(0, 25);
  const body = JSON.stringify({ items: batch });
  try {
    // Leaving the page: a beacon is the request the browser still sends.
    if (leaving && navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: "application/json" }))) return;
    void fetch(ENDPOINT, { method: "POST", credentials: "include", keepalive: true, headers: { "Content-Type": "application/json" }, body }).catch(() => {});
  } catch {
    /* reporting never breaks the page */
  }
  if (queue.length) timer = setTimeout(() => flush(false), 5000);
}

// ── Reports ───────────────────────────────────────────────────────────────

/** A script error: from window.onerror, an unhandled promise, or a screen's error boundary. */
export function reportClientError(error: unknown, extra?: Record<string, unknown>) {
  if (!started) return;
  const e = error instanceof Error ? error : null;
  const message = (e?.message || String(error) || "Unknown error").slice(0, 1000);
  // The browser's own noise, not the app's.
  if (/ResizeObserver loop|^Script error\.?$/i.test(message)) return;
  if (seenErrors.has(message)) return;
  seenErrors.add(message);
  push({ kind: "client-error", message, data: { stack: e?.stack?.slice(0, 4000) ?? null, device: deviceKind(), ...extra } });
}

/** A request's time on this device (lib/api.ts). Only the slow ones are reported. */
export function noteApiTiming(method: string, path: string, ms: number, status: number, fromDevice: boolean) {
  if (!started || ms < SLOW_API_MS || path.startsWith("/devlog")) return;
  push({
    kind: "slow-api",
    message: `${method} ${pagePath(path)} took ${(ms / 1000).toFixed(1)} s on the device`,
    status,
    durationMs: Math.round(ms),
    data: { request: `${method} ${pagePath(path)}`, device: deviceKind(), connection: connection(), storedCopy: fromDevice },
  });
}

function connection(): string | null {
  return (navigator as Navigator & { connection?: { effectiveType?: string } }).connection?.effectiveType ?? null;
}

/** The script a browser error came from, by its path. */
function fileOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname.slice(0, 200);
  } catch {
    return null;
  }
}

function describe(target: EventTarget | null | undefined): string | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest("button, a, input, select, textarea, [role]") ?? target;
  const role = el.getAttribute("role");
  return `${el.tagName.toLowerCase()}${role ? `[role=${role}]` : ""}`;
}

/** Page-load timings, once a page has had time to settle or is put away, whichever comes first. */
function watchPageLoad(appStartMs: number) {
  let fcp: number | null = null;
  let lcp: number | null = null;
  let done = false;
  const observers: PerformanceObserver[] = [];
  const observe = (type: string, fn: (entries: PerformanceEntryList) => void, extra: Record<string, unknown> = {}) => {
    try {
      const po = new PerformanceObserver((list) => fn(list.getEntries()));
      po.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
      observers.push(po);
    } catch {
      /* not supported here (older Safari): that timing is left out */
    }
  };
  observe("paint", (list) => {
    for (const e of list) if (e.name === "first-contentful-paint") fcp = e.startTime;
  });
  observe("largest-contentful-paint", (list) => {
    const last = list[list.length - 1];
    if (last) lcp = last.startTime;
  });

  const send = () => {
    if (done) return;
    done = true;
    observers.forEach((o) => o.disconnect());
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const scripts = performance.getEntriesByType("resource").filter((r) => (r as PerformanceResourceTiming).initiatorType === "script") as PerformanceResourceTiming[];
    const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    const r = (n: number | null | undefined) => (n == null || !Number.isFinite(n) || n <= 0 ? undefined : Math.round(n));
    push({
      kind: "page-load",
      durationMs: r(lcp ?? nav?.loadEventEnd),
      message: `${pagePath()} on ${deviceKind()}`,
      data: {
        device: deviceKind(),
        ttfb: r(nav?.responseStart),
        fcp: r(fcp),
        lcp: r(lcp),
        domReady: r(nav?.domContentLoadedEventEnd),
        load: r(nav?.loadEventEnd),
        appStart: r(appStartMs),
        // Downloaded, not from the browser's cache: 0 when every script was already on the device.
        jsKb: Math.round(scripts.reduce((n, s) => n + (s.transferSize || 0), 0) / 1024),
        scripts: scripts.length,
        navigation: nav?.type ?? null,
        connection: connection(),
        standalone,
        offlineReady: Boolean(navigator.serviceWorker?.controller),
        screen: `${window.screen.width}×${window.screen.height}`,
      },
    });
  };
  setTimeout(send, 15_000);
  return send;
}

/** Taps and key presses the page took a long time to answer (Event Timing; not in every browser). */
function watchInteractions() {
  const seen = new Set<number>();
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & { interactionId?: number; target?: Node | null })[]) {
        if (!e.interactionId || e.duration < SLOW_INTERACTION_MS || seen.has(e.interactionId)) continue;
        seen.add(e.interactionId);
        push({
          kind: "slow-interaction",
          message: `A ${e.name} on ${pagePath()} took ${Math.round(e.duration)} ms to answer`,
          durationMs: Math.round(e.duration),
          data: { event: e.name, target: describe(e.target as EventTarget | null), device: deviceKind() },
        });
      }
    });
    po.observe({ type: "event", buffered: true, durationThreshold: 104 } as PerformanceObserverInit);
  } catch {
    /* not supported here */
  }
}

/** Start reporting. Once, when the app starts (AppClient). */
export function startTelemetry() {
  if (started || typeof window === "undefined") return;
  started = true;
  const appStart = performance.now();
  const sendPageLoad = watchPageLoad(appStart);
  watchInteractions();
  window.addEventListener("error", (e) => reportClientError(e.error ?? e.message, { source: fileOf(e.filename), line: e.lineno || null }));
  window.addEventListener("unhandledrejection", (e) => reportClientError(e.reason, { unhandledPromise: true }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return;
    sendPageLoad();
    flush(true);
  });
  window.addEventListener("pagehide", () => {
    sendPageLoad();
    flush(true);
  });
  window.addEventListener("online", () => flush(false));
}
