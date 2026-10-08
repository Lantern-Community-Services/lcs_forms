/**
 * Lantern Forms service worker: lets the app open, and its forms be filled in,
 * with no connection.
 *
 * Site internet drops, and staff use the app from a home-screen icon with no
 * reload button, so a dropped connection mustn't leave a blank screen. This
 * keeps three things on the device:
 *
 *   the app itself   — the page and its scripts, so it starts with no signal.
 *   what it last read — every GET /api answer, so screens opened before still
 *                       show their data (the roster, a form, its entries).
 *                       Kept for the signed-in person only; the app clears it
 *                       on sign-out or when someone else signs in.
 *   (Lists that rarely change — the forms list, sites — are
 *   answered from that copy first and refreshed behind it; see DEVICE_FIRST.)
 *   fonts and images — Archivo from Google, and pictures forms show from other
 *                       sites (Hot Foods' meal pictures, on the WordPress media library).
 *
 * Saving entries offline is not done here: the app's own queues (built
 * forms, code forms) hold them in IndexedDB and upload them. POSTs pass
 * straight through.
 *
 * Everything is network-first: online, the app always gets the server's answer
 * and the copy is refreshed in passing. The cache answers only when the network
 * fails or hangs (connected to Wi-Fi with no internet behind it can hang a
 * request for a minute). Answers from the cache carry `x-lcs-cached-at` so the
 * app can tell, and say how old they are.
 *
 * Hashed build files (/_next/static in a production build) never change, so
 * those are cache-first.
 *
 * Registered by lib/offline.ts with ?dev=1 under `next dev`, where file names
 * aren't hashed and nothing may be cache-first.
 */

const VERSION = "v1";
const SHELL = `lcs-shell-${VERSION}`;
const API = "lcs-api";
const FONTS = "lcs-fonts";
const IMAGES = "lcs-images";
const IMAGES_MAX_ENTRIES = 150;
const DEV = new URL(self.location.href).searchParams.has("dev");

/** Every route is the same single-page app, so one copy of the page serves them all. */
const PAGE_KEY = "/__lcs-app-page";
// Under `next dev` a first compile can take longer than these; there, the copy
// is only for when the server is really gone.
const PAGE_TIMEOUT = DEV ? 30000 : 3500;
const API_TIMEOUT = DEV ? 30000 : 6000;
const STATIC_TIMEOUT = DEV ? 30000 : 5000;
/** Old build files unused for this long are dropped. */
const STATIC_MAX_AGE = 30 * 24 * 3600 * 1000;
const API_MAX_ENTRIES = 600;

const PRECACHE = ["/manifest.webmanifest", "/lcs_logo_color.svg", "/lcs_logo_white.svg", "/app-runtime/runtime.js", "/app-runtime/runtime.css"];

/**
 * Lists that rarely change and that screens need instantly: answered from the
 * device's copy at once, then checked with the server in the background. When
 * the server's answer differs, open pages are told ("api-updated") and refetch,
 * which the fresh copy then answers. A save under one of these paths (POST,
 * PATCH, PUT, DELETE) drops its copies first, so an admin's edit is never
 * hidden behind them.
 */
const DEVICE_FIRST = ["/api/forms", "/api/sites", "/api/tenants/meta/archive-reasons", "/api/auth/roles"];

/** API paths that must always reach the server, or can't be replayed from a copy. */
function bypassApi(url) {
  const p = url.pathname;
  return (
    p.startsWith("/api/auth/microsoft") ||
    p === "/api/auth/logout" ||
    p === "/api/auth/dev-login" ||
    p.startsWith("/api/health") ||
    // The roster's change feed: the app keeps its own copy (lib/rosterStore.ts), and a stored delta would only be stale.
    p === "/api/tenants/sync" ||
    // Downloads and stored files: big, and only useful online.
    /export/.test(p) ||
    /\/files\//.test(p)
  );
}

// ── Lifecycle ────────────────────────────────────────────────────────────

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await Promise.all(PRECACHE.map((url) => refresh(cache, url)));
      // The page, and the build files it names directly.
      try {
        const res = await fetch("/", { cache: "no-store" });
        if (res.ok) {
          const html = await res.clone().text();
          await cache.put(PAGE_KEY, await stamped(res));
          const files = [...new Set(html.match(/\/_next\/static\/[^"'\s)\\]+/g) ?? [])];
          await Promise.all(files.map((url) => refresh(cache, url)));
        }
      } catch {
        // Offline while installing: the app fills the cache as it runs.
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("lcs-shell-") && name !== SHELL) await caches.delete(name);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type === "clear-api") event.waitUntil(caches.delete(API));
  if (msg.type === "warm" && Array.isArray(msg.urls)) event.waitUntil(warm(msg.urls));
});

// ── Routing ──────────────────────────────────────────────────────────────

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // A save to something answered device-first: drop the copy, so the next read is the server's.
  if (req.method !== "GET") {
    const family = url.origin === self.location.origin && DEVICE_FIRST.find((p) => url.pathname.startsWith(p));
    if (family) event.respondWith(fetch(req).finally(() => forget(family)));
    return;
  }
  if (req.headers.has("range")) return;

  if (url.origin !== self.location.origin) {
    if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") event.respondWith(staleWhileRevalidate(event, req, FONTS));
    // Pictures from other sites (Hot Foods' meal pictures are on the WordPress media library).
    else if (req.destination === "image") event.respondWith(staleWhileRevalidate(event, req, IMAGES, IMAGES_MAX_ENTRIES));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    if (bypassApi(url)) return;
    if (DEVICE_FIRST.includes(url.pathname)) event.respondWith(deviceFirst(event, req));
    else event.respondWith(networkFirst(event, req, { cache: API, timeout: API_TIMEOUT, offline: notOpenedYet }));
    return;
  }

  // Dev server plumbing.
  if (url.pathname.startsWith("/_next/webpack-hmr") || url.pathname.startsWith("/__nextjs") || url.searchParams.has("_rsc")) return;

  if (req.mode === "navigate") {
    event.respondWith(networkFirst(event, req, { cache: SHELL, key: PAGE_KEY, timeout: PAGE_TIMEOUT, okIf: isHtml }));
    return;
  }

  if (!DEV && url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(req));
    return;
  }

  event.respondWith(networkFirst(event, req, { cache: SHELL, timeout: STATIC_TIMEOUT }));
});

// ── Strategies ───────────────────────────────────────────────────────────

/**
 * The server's answer if it comes in time, else the stored copy; with no copy,
 * keep waiting on the server after all. A late answer still refreshes the copy.
 */
async function networkFirst(event, req, { cache, key = req, timeout, offline, okIf }) {
  const network = fetch(req).then(async (res) => {
    if (res.ok && res.type === "basic" && (!okIf || okIf(res))) {
      const c = await caches.open(cache);
      await c.put(key, await stamped(res.clone()));
      if (cache === API) maybeTrim(c);
    }
    return res;
  });
  event.waitUntil(network.then(noop, noop));

  const stored = () => caches.open(cache).then((c) => c.match(key, { ignoreVary: true }));
  try {
    const first = await Promise.race([network, wait(timeout)]);
    if (first) return first;
    return (await stored()) ?? (await network);
  } catch {
    const hit = await stored();
    if (hit) return hit;
    return offline ? offline() : Response.error();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === "basic") await cache.put(req, await stamped(res.clone()));
  return res;
}

async function staleWhileRevalidate(event, req, name, maxEntries) {
  const cache = await caches.open(name);
  const hit = await cache.match(req, { ignoreVary: true });
  const network = fetch(req).then(async (res) => {
    if (res.ok || res.type === "opaque") {
      await cache.put(req, res.clone());
      if (maxEntries) await trim(cache, maxEntries);
    }
    return res;
  });
  event.waitUntil(network.then(noop, noop));
  return hit ?? network;
}

/**
 * The stored copy straight away (marked x-lcs-device, so the app doesn't take
 * it as a sign of being offline), and the server's answer kept for next time.
 * With no copy yet, the server's answer, as usual.
 */
async function deviceFirst(event, req) {
  const cache = await caches.open(API);
  const hit = await cache.match(req, { ignoreVary: true });
  const before = hit ? await hit.clone().text() : null;
  const network = fetch(req).then(async (res) => {
    if (res.ok && res.type === "basic") {
      const after = await res.clone().text();
      await cache.put(req, await stamped(res.clone()));
      if (before !== null && before !== after) {
        const u = new URL(req.url);
        for (const client of await self.clients.matchAll({ type: "window" })) client.postMessage({ type: "api-updated", path: u.pathname + u.search });
      }
    }
    return res;
  });
  event.waitUntil(network.then(noop, noop));
  if (!hit) return network.catch(() => notOpenedYet());
  const headers = new Headers(hit.headers);
  headers.set("x-lcs-device", "1");
  return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
}

/** Drop the stored copies of one device-first family (e.g. every /api/forms… answer). */
async function forget(prefix) {
  const cache = await caches.open(API);
  for (const req of await cache.keys()) if (new URL(req.url).pathname.startsWith(prefix)) await cache.delete(req);
}

/** A GET the app has never made on this device, asked for with no connection. */
function notOpenedYet() {
  return new Response(
    JSON.stringify({ error: "You're offline, and this hasn't been opened on this device yet. It will load once the connection is back." }),
    { status: 503, headers: { "Content-Type": "application/json", "x-lcs-offline": "1" } }
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** A copy with the time it was stored, for the app to show and for expiry. */
async function stamped(res) {
  const headers = new Headers(res.headers);
  headers.set("x-lcs-cached-at", String(Date.now()));
  headers.delete("vary");
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers });
}

const isHtml = (res) => (res.headers.get("content-type") || "").includes("text/html");

async function refresh(cache, url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) await cache.put(url, await stamped(res));
  } catch {
    // Picked up later, as the app asks for it.
  }
}

/**
 * The app sends what it has loaded (its build files, the code-form runtime), so
 * files fetched before this worker took control are stored too. Anything in use
 * is re-stamped; build files of old versions that nothing has used for a month
 * are deleted.
 */
async function warm(urls) {
  const cache = await caches.open(SHELL);
  const now = Date.now();
  const inUse = new Set();
  for (const u of urls) {
    let url;
    try {
      url = new URL(u, self.location.origin);
    } catch {
      continue;
    }
    if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) continue;
    inUse.add(url.href);
    const hit = await cache.match(url.href, { ignoreVary: true });
    if (!hit) await refresh(cache, url.href);
    else if (now - Number(hit.headers.get("x-lcs-cached-at") || 0) > 7 * 24 * 3600 * 1000) await cache.put(url.href, await stamped(hit));
  }
  for (const req of await cache.keys()) {
    if (inUse.has(req.url) || !new URL(req.url).pathname.startsWith("/_next/static/")) continue;
    const hit = await cache.match(req);
    if (hit && now - Number(hit.headers.get("x-lcs-cached-at") || 0) > STATIC_MAX_AGE) await cache.delete(req);
  }
}

let puts = 0;
/** Every screen and filter adds a copy; keep the newest few hundred. */
async function maybeTrim(cache) {
  if (++puts % 25 === 0) await trim(cache, API_MAX_ENTRIES);
}

/** Keys come back oldest-stored first (a put moves a key to the end). */
async function trim(cache, max) {
  const keys = await cache.keys();
  for (const req of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(req);
}

const wait = (ms) => new Promise((resolve) => setTimeout(() => resolve(null), ms));
const noop = () => {};
