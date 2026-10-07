import { useSyncExternalStore } from "react";
import { api } from "./api";
import { appIsQuiet, isOnline, offlineEnabled } from "./offline";
import { calendarPath } from "./queries";
import { addMonths, fetchRange, nyToday } from "./calendar";
import { keepAllSites, keptResidentIds } from "./rosterStore";
import { rememberedSiteParam } from "./site";
import { readStoredJson, writeStorage } from "./storage";
import type { FormCatalog, Site, User } from "./types";

/**
 * A copy of the whole site on the device, built a little at a time while it's
 * in use.
 *
 * public/sw.js keeps every answer the app reads, so whatever someone opens is
 * there offline later. This makes sure of the rest. In the background it works
 * through every screen this person can open and reads each one: the residents
 * at all of their sites, the forms and their definitions, each resident's page
 * (at the sites this device is used at), Review, Overview and Activity,
 * attendance, this month's and next month's calendar, and the entries the
 * person may see. (A code form keeps its own offline reads: form.json "offline".) The worker stores each answer exactly as if
 * the screen had asked, because each read here uses the screen's own URL,
 * default filters included.
 *
 * It never gets in the way:
 * - one read at a time, about a second apart;
 * - only while no screen is waiting on a request of its own (lib/api.ts tells
 *   lib/offline.ts);
 * - only online, with the app in front, and with the service worker in
 *   charge (there's nowhere to keep the copy otherwise);
 * - with "Low Data Mode" on, only what forms need to be filled in.
 *
 * Each item is refreshed on its own schedule, from half an hour (entries) to
 * a day (a resident's page). The schedule is per person and per device
 * (localStorage), so a reload doesn't start over.
 */

type Tier = 0 | 1 | 2;

interface Target {
  key: string;
  label: string;
  /** 0: filling in forms. 1: the roster's screens. 2: reading entries back. */
  tier: Tier;
  ttlMs: number;
  run: () => Promise<unknown>;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const GAP_MS = 1200;
const QUIET_MS = 1500;
/** Residents' own pages: only at the sites this device is used at, never every site an admin has. */
const MAX_DETAIL_SITES = 6;

// ── Status, for the "Saved on this device" sheet ─────────────────────────

export interface SnapshotStatus {
  running: boolean;
  total: number;
  /** Items stored and still within their refresh time. */
  fresh: number;
  /** When everything was last up to date (ms), or null. */
  completeAt: number | null;
  /** What's being saved right now ("Residents", "Forms", …). */
  current: string | null;
}

let status: SnapshotStatus = { running: false, total: 0, fresh: 0, completeAt: null, current: null };
const listeners = new Set<() => void>();
function setStatus(patch: Partial<SnapshotStatus>) {
  status = { ...status, ...patch };
  listeners.forEach((l) => l());
}

export function useSnapshotStatus() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
    () => status
  );
}

// ── When each item was last read ─────────────────────────────────────────

const stampsKey = (userId: string) => `ln.snapshot.${userId}`;
let stamps: Record<string, number> = {};

function loadStamps(userId: string) {
  const raw = readStoredJson(stampsKey(userId));
  stamps = raw && typeof raw === "object" ? (raw as Record<string, number>) : {};
}

function saveStamps(userId: string) {
  // Forget anything not read for a week (a form taken off the catalog, a resident who left).
  const cutoff = Date.now() - 7 * 24 * HOUR;
  for (const k of Object.keys(stamps)) if (stamps[k] < cutoff) delete stamps[k];
  writeStorage(stampsKey(userId), JSON.stringify(stamps));
}

const isFresh = (t: Target) => Date.now() - (stamps[t.key] ?? 0) < t.ttlMs;

// ── What to read ─────────────────────────────────────────────────────────

const get = (path: string) => () => api.getInBackground(path);

const siteQs = (site: string | undefined) => (site ? `site=${encodeURIComponent(site)}` : "");

/**
 * Everything this person can open, most needed first. Built from the lists the
 * app already has (catalog, sites), read here in the background.
 */
async function buildTargets(user: User): Promise<Target[]> {
  const can = (p: string) => user.permissions.includes(p as never);
  const targets: Target[] = [
    { key: "me", label: "Your account", tier: 0, ttlMs: 30 * MIN, run: get("/auth/me") },
    { key: "home", label: "Home", tier: 0, ttlMs: 30 * MIN, run: get("/home") },
  ];

  const [catalog, sites] = await Promise.all([
    api.getInBackground<FormCatalog>("/forms").catch(() => null),
    api.getInBackground<Site[]>("/sites").catch(() => [] as Site[]),
  ]);
  const urls = (catalog?.categories ?? []).flatMap((c) => c.forms.map((f) => f.url));
  const slugs = (prefix: string) => [...new Set(urls.filter((u) => u.startsWith(prefix)).map((u) => u.slice(prefix.length).split(/[/?#]/)[0]).filter(Boolean))];

  // ── Filling in forms ──
  // Residents first: every form that names someone needs them. All of the
  // person's sites (lib/rosterStore.ts keeps them current from then on).
  if (can("roster.view")) targets.push({ key: "roster:all", label: "Residents", tier: 0, ttlMs: 12 * HOUR, run: () => keepAllSites() });
  for (const slug of [...slugs("/f/"), ...slugs("/p/")]) targets.push({ key: `form:${slug}`, label: "Forms", tier: 0, ttlMs: HOUR, run: get(`/f/${slug}`) });
  for (const slug of slugs("/apps/")) targets.push({ key: `app:${slug}`, label: "Forms", tier: 0, ttlMs: HOUR, run: get(`/apps/${slug}/runtime`) });

  // The sites this device is used at: the person's default, (unless they have every site) their
  // own, and those picked on the roster screens here.
  const mine = [
    ...(user.defaultSiteCode ? [user.defaultSiteCode] : []),
    ...(user.allSites ? [] : user.sites.map((s) => s.code)),
    // The sites picked on the roster screens here.
    ...(rememberedSiteParam(sites)?.split(",") ?? []),
  ].filter((c, i, all) => all.indexOf(c) === i && sites.some((s) => s.code === c));

  // ── The roster's screens ──
  const selection = rememberedSiteParam(sites);
  if (can("roster.view")) {
    targets.push(
      { key: "meta:reasons", label: "Roster", tier: 1, ttlMs: 24 * HOUR, run: get("/tenants/meta/archive-reasons") },
      { key: `review:${selection ?? "all"}`, label: "Review", tier: 1, ttlMs: 30 * MIN, run: get(`/tenants/review?${siteQs(selection)}`) },
      { key: `dashboard:${selection ?? "all"}`, label: "Overview", tier: 1, ttlMs: HOUR, run: get(`/activity/dashboard?${siteQs(selection)}`) },
      { key: `audit:${selection ?? "all"}`, label: "Activity", tier: 1, ttlMs: HOUR, run: get(`/activity/audit?limit=100&${siteQs(selection)}`) },
      { key: `attendance:${selection ?? "all"}`, label: "Attendance", tier: 1, ttlMs: HOUR, run: get(`/attendance?${new URLSearchParams(selection ? { site: selection } : {})}`) }
    );
    const detailSites = mine.slice(0, MAX_DETAIL_SITES);
    for (const id of await keptResidentIds(detailSites)) targets.push({ key: `tenant:${id}`, label: "Residents' pages", tier: 1, ttlMs: 24 * HOUR, run: get(`/tenants/${id}`) });
  }

  // ── The calendar ── this month and next, as the screen reads them (its site selection is the roster's).
  targets.push({ key: "cal:categories", label: "Calendar", tier: 1, ttlMs: 24 * HOUR, run: get("/calendar/categories") });
  for (const day of [nyToday(), addMonths(nyToday(), 1)]) {
    const { from, to } = fetchRange(day);
    targets.push({ key: `cal:${from}:${selection ?? "all"}`, label: "Calendar", tier: 1, ttlMs: HOUR, run: get(calendarPath(from, to, selection)) });
  }

  // ── Reading entries back ──
  if (can("entries.view")) {
    for (const slug of slugs("/f/")) targets.push({ key: `entries:${slug}`, label: "Form entries", tier: 2, ttlMs: 30 * MIN, run: get(`/f/${slug}/entries?status=active&take=50&skip=0`) });
  }

  // Low Data Mode: only what's needed to fill in forms.
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  return saveData ? targets.filter((t) => t.tier === 0) : targets;
}

// ── The loop ─────────────────────────────────────────────────────────────

let current: string | null = null;
let generation = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the app has room: online, in front, the worker in charge, no screen request going. */
async function room(gen: number) {
  for (;;) {
    if (gen !== generation) return false;
    if (isOnline() && document.visibilityState === "visible" && navigator.serviceWorker?.controller && appIsQuiet(QUIET_MS)) return true;
    await sleep(1000);
  }
}

async function loop(user: User, gen: number) {
  let targets: Target[] = [];
  let builtAt = 0;
  let complete = false;
  for (;;) {
    if (!(await room(gen))) return;
    // The list itself goes stale (new forms, residents): rebuild it every half hour.
    if (!targets.length || Date.now() - builtAt > 30 * MIN) {
      try {
        targets = await buildTargets(user);
        builtAt = Date.now();
      } catch {
        await sleep(30_000);
        continue;
      }
      if (gen !== generation) return;
    }
    const next = targets.filter((t) => !isFresh(t)).sort((a, b) => a.tier - b.tier)[0];
    const fresh = targets.filter(isFresh).length;
    if (!next) {
      if (!complete) setStatus({ completeAt: Date.now() });
      complete = true;
      setStatus({ running: false, total: targets.length, fresh, current: null });
      // Everything's current: look again in a minute (something will be due by then, or the list will change).
      await sleep(MIN);
      continue;
    }
    complete = false;
    setStatus({ running: true, total: targets.length, fresh, current: next.label });
    try {
      await next.run();
      stamps[next.key] = Date.now();
    } catch {
      // Offline now, or refused (no access any more): try it again on a later round.
      stamps[next.key] = Date.now() - next.ttlMs + 5 * MIN;
    }
    if (gen !== generation) return;
    saveStamps(user.id);
    await sleep(GAP_MS);
  }
}

/** Called from AppShell with the signed-in person (null on sign-out). */
export function startSnapshot(user: User | null) {
  if ((user?.id ?? null) === current) return;
  generation++;
  current = user?.id ?? null;
  setStatus({ running: false, total: 0, fresh: 0, completeAt: null, current: null });
  // Offline mode is for iPads and phones (lib/offline.ts).
  if (!user || typeof window === "undefined" || !offlineEnabled()) return;
  loadStamps(user.id);
  void loop(user, generation);
}
