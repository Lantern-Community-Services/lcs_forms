import type { QueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { isOnline, offlineEnabled, onReconnect } from "./offline";
import type { Tenant } from "./types";

/**
 * The roster, kept on the device for the sites it uses.
 *
 * An iPad at a site opens the same couple of hundred residents all day. They
 * live here in IndexedDB, so the list (Roster, a code form's resident list, a form's
 * resident picker, attendance) shows at once, online or offline, and after the
 * first load only changes travel: GET /api/tenants/sync?since= returns who
 * changed at any of my sites since the last pull, usually nobody.
 *
 * Pulled every 20 s while the app is open and online, when it comes back to the
 * front, when the connection returns, and before re-reading after any roster
 * edit (edits invalidate the ["roster"] queries, which lands in loadTenants).
 * A full reload every 12 hours catches anything a delta can't see (someone
 * moved to a site this person can't see).
 *
 * Only active residents are kept; the Archived tab still asks the server. The
 * copy belongs to one person and is wiped when someone else signs in, or on
 * sign-out (lib/offline.ts). iPads and phones only: a computer reads the roster
 * from the server, as it always did.
 */

export interface RosterList {
  items: Tenant[];
  attentionHours: number;
  truncated: boolean;
}

interface SiteMeta {
  id: string;
  code: string;
  name: string;
  attentionHours: number | null;
}

interface State {
  userId: string;
  /** Server time to pull changes from. */
  cursor: string;
  /** Sites whose full list is here. */
  loaded: string[];
  /** Every site this person has (from a load of "all my sites"), or null if never loaded that way. */
  allCodes: string[] | null;
  sites: Record<string, SiteMeta>;
  defaultHours: number;
  /** When the last full reload finished (ms). */
  fullAt: number;
}

interface SyncResponse {
  full: boolean;
  items: Tenant[];
  truncated?: boolean;
  next: string;
  hasMore: boolean;
  sites: SiteMeta[];
  attentionHours: number;
}

const DB_NAME = "lcs-roster";
const ROWS = "tenants";
const META = "meta";
const PULL_EVERY = 20_000;
const FULL_EVERY = 12 * 3600_000;

// ── Storage ──────────────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase | null> | null = null;
function db() {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const rows = req.result.createObjectStore(ROWS, { keyPath: "id" });
        rows.createIndex("site", "siteCode");
        req.result.createObjectStore(META);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

type Row = Tenant & { siteCode: string };

function done(t: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

let memState: State | null | undefined;
async function readState(): Promise<State | null> {
  if (memState !== undefined) return memState;
  const d = await db();
  if (!d) return (memState = null);
  memState = ((await request(d.transaction(META).objectStore(META).get("state"))) as State | undefined) ?? null;
  return memState;
}

async function rowsFor(codes: string[]): Promise<Row[]> {
  const d = await db();
  if (!d) return [];
  const index = d.transaction(ROWS).objectStore(ROWS).index("site");
  const lists = await Promise.all(codes.map((c) => request(index.getAll(c) as IDBRequest<Row[]>)));
  return lists.flat();
}

/**
 * Writes rows and state in one transaction. `replaceSites`: drop what was kept
 * for those sites first. Their keys are read beforehand, in their own
 * transaction: nothing is awaited while the write is open (older iPad Safari
 * commits a transaction at the first await).
 */
async function write(state: State, rows: Tenant[], opts: { replaceSites?: string[]; remove?: string[] } = {}) {
  const d = await db();
  if (!d) throw new Error("No IndexedDB");
  let stale: IDBValidKey[] = [];
  if (opts.replaceSites?.length) {
    const index = d.transaction(ROWS).objectStore(ROWS).index("site");
    stale = (await Promise.all(opts.replaceSites.map((c) => request(index.getAllKeys(c))))).flat();
  }
  const t = d.transaction([ROWS, META], "readwrite");
  const store = t.objectStore(ROWS);
  stale.forEach((k) => store.delete(k));
  opts.remove?.forEach((id) => store.delete(id));
  for (const r of rows) store.put({ ...r, siteCode: r.site?.code ?? "" });
  t.objectStore(META).put(state, "state");
  await done(t);
  memState = state;
}

export async function clearRoster() {
  memState = null;
  const d = await db();
  if (!d) return;
  const t = d.transaction([ROWS, META], "readwrite");
  t.objectStore(ROWS).clear();
  t.objectStore(META).clear();
  await done(t).catch(() => undefined);
}

// ── Reading ──────────────────────────────────────────────────────────────

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** The list as the server would send it now: attention worked out for this moment, the server's order. */
function present(rows: Row[], state: State, codes: string[]): RosterList {
  const now = Date.now();
  const items: Tenant[] = rows.map(({ siteCode, ...t }) => {
    const hours = state.sites[siteCode]?.attentionHours ?? state.defaultHours;
    const quiet = Math.max(0, (now - new Date(t.attentionClockAt).getTime()) / 3600_000);
    return { ...t, hoursQuiet: Math.round(quiet), needsAttention: t.status === "active" && quiet >= hours };
  });
  items.sort(
    (a, b) =>
      collator.compare(a.site?.name ?? "", b.site?.name ?? "") ||
      collator.compare(a.unit ?? "~", b.unit ?? "~") ||
      collator.compare(a.displayName, b.displayName)
  );
  const one = codes.length === 1 ? state.sites[codes[0]] : undefined;
  return { items, attentionHours: one?.attentionHours ?? state.defaultHours, truncated: false };
}

/** Site codes a selection means, or null when this device can't tell yet ("all my sites", never loaded). */
const codesOf = (site: string | undefined, state: State | null) => (site ? site.split(",").filter(Boolean) : (state?.allCodes ?? null));

/** The kept copy for a selection, or null if any of its sites isn't kept here. */
async function readLocal(site: string | undefined): Promise<RosterList | null> {
  const state = await readState();
  if (!state || state.userId !== currentUser) return null;
  const codes = codesOf(site, state);
  if (!codes || !codes.every((c) => state.loaded.includes(c))) return null;
  return present(await rowsFor(codes), state, codes);
}

/** First time for these sites: the whole list from the server, kept from now on. */
async function loadFull(site: string | undefined): Promise<RosterList> {
  const userId = currentUser;
  const res = await api.get<SyncResponse>(`/tenants/sync${site ? `?site=${encodeURIComponent(site)}` : ""}`);
  if (userId && userId === currentUser && !res.truncated) {
    const codes = res.sites.map((s) => s.code);
    const prev = await readState();
    // Another person's copy is never built on.
    const same = prev && prev.userId === userId ? prev : null;
    if (prev && !same) await clearRoster();
    const state: State = {
      userId,
      // The older cursor wins: changes since then at the other kept sites still need pulling (this site's are in hand).
      cursor: same && same.cursor < res.next ? same.cursor : res.next,
      loaded: [...new Set([...(same?.loaded ?? []), ...codes])],
      allCodes: site ? (same?.allCodes ?? null) : codes,
      sites: { ...(same?.sites ?? {}), ...Object.fromEntries(res.sites.map((s) => [s.code, s])) },
      defaultHours: res.attentionHours,
      fullAt: same?.fullAt ?? Date.now(),
    };
    // No storage (private mode): the list still shows, it just isn't kept.
    await write(state, res.items, { replaceSites: codes }).catch(() => undefined);
  }
  return { items: res.items, attentionHours: res.attentionHours, truncated: Boolean(res.truncated) };
}

/**
 * The active roster for a selection (comma list of site codes; undefined = all
 * my sites). From the device when it's kept here — after pulling changes first
 * when `fresh` (a refetch after an edit, or the screen coming back) — else from
 * the server, keeping it from then on. Offline with nothing kept, the plain
 * list endpoint is tried (the service worker may hold a copy of it).
 */
export async function loadTenants(site: string | undefined, opts: { fresh?: boolean; userId?: string | null } = {}): Promise<RosterList> {
  // A computer doesn't keep the roster (offline mode is for iPads and phones): straight from the server, as before.
  if (!offlineEnabled()) return api.get<RosterList>(`/tenants?${new URLSearchParams({ ...(site ? { site } : {}), status: "active" })}`);
  // A screen's first query can run before AppShell's effect has said who's signed in.
  if (opts.userId && !currentUser) currentUser = opts.userId;
  if (opts.fresh && (await readLocal(site))) await pull({ timeoutMs: 4000 });
  const local = await readLocal(site);
  if (local) {
    if (!opts.fresh) void pull();
    return local;
  }
  try {
    return await loadFull(site);
  } catch (e) {
    try {
      return await api.get<RosterList>(`/tenants?${new URLSearchParams({ ...(site ? { site } : {}), status: "active" })}`);
    } catch {
      throw e;
    }
  }
}

// ── Pulling changes ──────────────────────────────────────────────────────

let qc: QueryClient | null = null;
let currentUser: string | null = null;
let pulling: Promise<void> | null = null;
let lastPull = 0;

/**
 * Pull what changed since the last pull; errors are swallowed (offline).
 * Routine callers share a running pull, and skip one made in the last 3 s. An
 * urgent one (`force`, or `timeoutMs` — a refetch after an edit) runs after any
 * pull already going, since that one may have asked before the edit was saved.
 * `timeoutMs` stops waiting (the pull carries on) so a slow line can't hold up
 * the screen.
 */
export function pull(opts: { timeoutMs?: number; force?: boolean } = {}): Promise<void> {
  const urgent = opts.force || opts.timeoutMs !== undefined;
  let p: Promise<void>;
  if (pulling && !urgent) p = pulling;
  else if (!pulling && !urgent && Date.now() - lastPull < 3000) p = Promise.resolve();
  else {
    const run: Promise<void> = (pulling ?? Promise.resolve())
      .then(() => doPull())
      .catch(() => undefined)
      .finally(() => {
        if (pulling === run) pulling = null;
        lastPull = Date.now();
      });
    pulling = run;
    p = run;
  }
  return opts.timeoutMs ? Promise.race([p, new Promise<void>((r) => setTimeout(r, opts.timeoutMs))]) : p;
}

async function doPull() {
  const userId = currentUser;
  let state = await readState();
  if (!userId || !state || state.userId !== userId || !state.loaded.length) return;

  // Twice a day, reload the kept sites whole instead.
  if (Date.now() - state.fullAt > FULL_EVERY && isOnline()) {
    const res = await api.get<SyncResponse>(`/tenants/sync?site=${encodeURIComponent(state.loaded.join(","))}`);
    if (currentUser !== userId || res.truncated) return;
    state = { ...state, cursor: res.next, fullAt: Date.now(), defaultHours: res.attentionHours, sites: { ...state.sites, ...Object.fromEntries(res.sites.map((s) => [s.code, s])) } };
    await write(state, res.items, { replaceSites: state.loaded });
    await publish();
    return;
  }

  let changed = false;
  for (let page = 0; page < 10; page++) {
    const res: SyncResponse = await api.get<SyncResponse>(`/tenants/sync?since=${encodeURIComponent(state.cursor)}`);
    if (currentUser !== userId) return;
    const kept = new Set(state.loaded);
    const keep = res.items.filter((t) => t.status === "active" && t.site && kept.has(t.site.code));
    // Archived, or now at a site this device doesn't keep.
    const remove = res.items.filter((t) => !keep.includes(t)).map((t) => t.id);
    const sites: Record<string, SiteMeta> = { ...state.sites, ...Object.fromEntries(res.sites.map((s) => [s.code, s])) };
    const hoursChanged = res.attentionHours !== state.defaultHours || res.sites.some((s) => state!.sites[s.code]?.attentionHours !== s.attentionHours);
    state = { ...state, cursor: res.next, sites, defaultHours: res.attentionHours };
    await write(state, keep, { remove });
    changed ||= res.items.length > 0 || hoursChanged;
    if (!res.hasMore) break;
  }
  if (changed) await publish();
}

/** Hand fresh copies to every roster list on screen, without them refetching. */
async function publish() {
  if (!qc) return;
  for (const q of qc.getQueryCache().findAll({ queryKey: ["roster", "tenants"] })) {
    const [, , site, status] = q.queryKey as [string, string, string, string];
    if (status !== "active") continue;
    const fresh = await readLocal(site === "all" ? undefined : site);
    if (fresh) qc.setQueryData(q.queryKey, fresh);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let started = false;

/** Called from AppShell with the signed-in person (null on sign-out). */
export function startRosterSync(client: QueryClient, userId: string | null) {
  qc = client;
  if (!offlineEnabled()) {
    // Nothing kept on a computer; a copy left from before offline mode was mobile-only goes.
    memState = null;
    try {
      indexedDB.deleteDatabase(DB_NAME);
    } catch {
      // No IndexedDB: nothing to remove.
    }
    return;
  }
  if (currentUser !== userId) {
    currentUser = userId;
    // Someone else's copy: not theirs to see.
    void readState().then((s) => {
      if (s && userId && s.userId !== userId) void clearRoster();
    });
  }
  if (timer) clearInterval(timer);
  timer = null;
  if (!userId) return;
  // Also in a background tab (browsers slow it to about once a minute), so the
  // list is current when someone comes back to it.
  timer = setInterval(() => {
    if (isOnline()) void pull();
  }, PULL_EVERY);
  if (!started) {
    started = true;
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void pull());
    onReconnect(() => void pull({ force: true }));
  }
  void pull();
}

/** Ids of the residents kept here for these sites. */
export async function keptResidentIds(codes: string[]): Promise<string[]> {
  return (await rowsFor(codes)).map((r) => r.id);
}

/**
 * Keep every site this person has (an admin: the whole organisation, ~2,000
 * people, one request). A form's resident picker can then name anyone offline,
 * whichever site is chosen, and Roster's "All my sites" opens from the device.
 */
export async function keepAllSites() {
  if (!(await readLocal(undefined))) await loadFull(undefined);
}
