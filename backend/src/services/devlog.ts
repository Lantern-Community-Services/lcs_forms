import os from "node:os";
import util from "node:util";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { env } from "../env.js";

/**
 * Admin → Dev log: how the running site is doing, for tuning it once it's live.
 *
 * Every API request and every database query is counted into a one-minute
 * bucket in memory (calls, errors, total and worst time, and a duration
 * histogram so percentiles add up across minutes and servers). Once a minute
 * the finished buckets, a sample of the process (memory, CPU, event-loop
 * delay) and anything worth reading one at a time (a server error or warning,
 * a slow request or query, a browser's report) are written in a few batched
 * inserts. A write that fails is dropped: the log never gets in the way of the
 * site, and it never retries into a database that's struggling.
 *
 * Each server (App Service instance) keeps its own buckets and writes its own
 * rows, tagged with INSTANCE; the summary adds them up.
 */

/** Upper bounds (ms) of the duration buckets h0…h9; h10 is anything slower. */
export const DURATION_BOUNDS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const HIST_SIZE = DURATION_BOUNDS.length + 1;

export const INSTANCE = (process.env.WEBSITE_INSTANCE_ID ?? "").slice(0, 12) || os.hostname();

export const EVENT_KINDS = [
  "error", "log", "slow-request", "slow-query", "boot",
  "client-error", "page-load", "slow-interaction", "slow-api",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** What browsers report (POST /api/devlog/client); the rest come from the server. */
export const CLIENT_KINDS = new Set<EventKind>(["client-error", "page-load", "slow-interaction", "slow-api"]);

/** Distinct routes kept per minute; anything past this is counted as "other" (a scanner trying random paths). */
const MAX_ROUTES_PER_MINUTE = 200;
/** Events held between writes; past this they're counted, not kept. */
const MAX_EVENTS_PER_FLUSH = 500;
/** Server log lines kept a minute, so a loop that logs on every tick can't fill the table. */
const MAX_LOG_LINES_PER_MINUTE = 120;
const MAX_TEXT = 8000;

interface Bucket {
  calls: number;
  errors: number;
  rejected: number;
  totalMs: number;
  maxMs: number;
  h: number[];
}

interface Minute {
  routes: Map<string, Bucket>;
  db: Bucket;
}

export interface DevEventInput {
  kind: EventKind;
  level?: "error" | "warn" | "info";
  path?: string | null;
  status?: number | null;
  durationMs?: number | null;
  message?: string | null;
  data?: unknown;
  requestId?: string | null;
  userEmail?: string | null;
  createdAt?: Date;
}

const pending = new Map<number, Minute>();
let events: Prisma.DevEventCreateManyInput[] = [];
let droppedEvents = 0;
let logLines = 0;
let inFlight = 0;
let inFlightMax = 0;
let started = false;
let flushing = false;

const loop = monitorEventLoopDelay({ resolution: 20 });
let lastCpu = process.cpuUsage();
let lastCpuAt = process.hrtime.bigint();
let lastFlushAt: Date | null = null;
let lastFlushError: string | null = null;

const emptyBucket = (): Bucket => ({ calls: 0, errors: 0, rejected: 0, totalMs: 0, maxMs: 0, h: new Array(HIST_SIZE).fill(0) });
const minuteOf = (t: number) => t - (t % 60_000);
const clip = (s: string | null | undefined, n = MAX_TEXT) => (s == null ? null : s.length > n ? `${s.slice(0, n)}…` : s);

function minute(): Minute {
  const key = minuteOf(Date.now());
  let m = pending.get(key);
  if (!m) pending.set(key, (m = { routes: new Map(), db: emptyBucket() }));
  return m;
}

function bucketIndex(ms: number): number {
  const i = DURATION_BOUNDS.findIndex((b) => ms <= b);
  return i === -1 ? DURATION_BOUNDS.length : i;
}

function add(b: Bucket, ms: number, status = 200) {
  b.calls++;
  if (status >= 500) b.errors++;
  else if (status >= 400) b.rejected++;
  b.totalMs += ms;
  if (ms > b.maxMs) b.maxMs = ms;
  b.h[bucketIndex(ms)]++;
}

/**
 * An estimate of the p-th percentile (0–1) from a duration histogram: the
 * bucket it falls in, interpolated, and never past the slowest call seen.
 */
export function percentile(h: number[], maxMs: number, p: number): number | null {
  const n = h.reduce((a, b) => a + b, 0);
  if (!n) return null;
  const target = p * n;
  let seen = 0;
  for (let i = 0; i < h.length; i++) {
    if (h[i] && seen + h[i] >= target) {
      const lo = i === 0 ? 0 : DURATION_BOUNDS[i - 1];
      const hi = i < DURATION_BOUNDS.length ? DURATION_BOUNDS[i] : Math.max(maxMs, lo);
      return Math.min(lo + ((hi - lo) * (target - seen)) / h[i], maxMs);
    }
    seen += h[i];
  }
  return maxMs;
}

/** Queue an event for the next write. */
export function devEvent(e: DevEventInput) {
  if (!env.devlog.enabled) return;
  if (events.length >= MAX_EVENTS_PER_FLUSH) {
    droppedEvents++;
    return;
  }
  events.push({
    createdAt: e.createdAt ?? new Date(),
    kind: e.kind,
    level: e.level ?? "info",
    instance: CLIENT_KINDS.has(e.kind) ? null : INSTANCE,
    path: clip(e.path, 255),
    status: e.status ?? null,
    durationMs: e.durationMs ?? null,
    message: clip(e.message),
    data: e.data === undefined ? null : clip(typeof e.data === "string" ? e.data : JSON.stringify(e.data)),
    requestId: clip(e.requestId, 64),
    userEmail: clip(e.userEmail, 255),
  });
}

// ── Requests ──────────────────────────────────────────────────────────────

/** Path segments that are ids, so /api/tenants/ckx…/notes counts as one route. */
const ID_SEGMENT = /^(\d+|c[a-z0-9]{20,32}|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|[A-Za-z0-9_-]{24,})$/;

function normalisePath(path: string): string {
  return (
    path
      .split("/")
      .slice(0, 8)
      .map((s) => (ID_SEGMENT.test(s) ? ":id" : s.length > 60 ? ":long" : s))
      .join("/") || "/"
  );
}

/**
 * The route a request matched ("/api/tenants/:id"), so calls group by what
 * they ran rather than by the id in the address. A request that failed after
 * leaving its router has lost its mount path, so it's named from its address
 * instead; one that matched nothing is "(no route)".
 */
function routeName(req: Request, res: Response): string {
  const route = (req as Request & { route?: { path: unknown } }).route;
  if (route) {
    const p = Array.isArray(route.path) ? String(route.path[0]) : String(route.path);
    const full = `${req.baseUrl}${p === "/" ? "" : p}` || "/";
    if (full.startsWith("/api/") || full.startsWith("/mcp")) return full;
  }
  if (!route && res.statusCode === 404) return "(no route)";
  return normalisePath(req.originalUrl.split("?")[0]);
}

/** Time every request (but the health probes), from its first byte in to its last byte out. */
export function requestMetrics(req: Request, res: Response, next: NextFunction) {
  if (!env.devlog.enabled || req.path.startsWith("/api/health")) return next();
  const start = process.hrtime.bigint();
  inFlight++;
  if (inFlight > inFlightMax) inFlightMax = inFlight;
  let done = false;
  const end = (aborted: boolean) => {
    if (done) return;
    done = true;
    inFlight--;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    // 499: the client hung up before the answer was sent (nginx's convention).
    const status = aborted ? 499 : res.statusCode;
    const name = `${req.method} ${routeName(req, res)}`;
    const m = minute();
    let b = m.routes.get(name);
    if (!b) {
      const key = m.routes.size >= MAX_ROUTES_PER_MINUTE ? "(other)" : name;
      b = m.routes.get(key) ?? emptyBucket();
      m.routes.set(key, b);
    }
    add(b, ms, status);
    if (ms >= env.devlog.slowRequestMs) {
      devEvent({
        kind: "slow-request",
        level: "warn",
        path: name,
        status,
        durationMs: ms,
        // The address without its query string: a search box's text stays out of the log.
        message: `${req.method} ${req.originalUrl.split("?")[0]} took ${Math.round(ms).toLocaleString("en-US")} ms`,
        requestId: req.id,
        userEmail: req.user?.email,
      });
    }
  };
  res.on("finish", () => end(false));
  res.on("close", () => end(!res.writableFinished));
  next();
}

/** A 5xx from the error handler (http.ts), with what it takes to find it again. */
export function noteServerError(req: Request, status: number, err: unknown) {
  const e = err instanceof Error ? err : null;
  devEvent({
    kind: "error",
    level: "error",
    path: `${req.method} ${routeName(req, { statusCode: status } as Response)}`,
    status,
    message: e?.message ?? String(err),
    data: { url: req.originalUrl.split("?")[0], stack: e?.stack ?? null },
    requestId: req.id,
    userEmail: req.user?.email,
  });
}

// ── Database ──────────────────────────────────────────────────────────────

/** The log's own writes aren't the site's work; leave them out of the numbers. */
const OWN_TABLES = /\[Dev(Metric|Sample|Event)\]/;

function noteQuery(ms: number, query: string) {
  if (OWN_TABLES.test(query)) return;
  add(minute().db, ms);
  if (ms >= env.devlog.slowQueryMs) {
    // The SQL text, never its parameters: those are people's names and notes.
    devEvent({ kind: "slow-query", level: "warn", durationMs: ms, message: clip(query, 4000), path: tableOf(query) });
  }
}

function tableOf(query: string): string | null {
  return /\b(?:FROM|INTO|UPDATE)\s+\[dbo\]\.\[(\w+)\]/i.exec(query)?.[1] ?? null;
}

// ── Server log ────────────────────────────────────────────────────────────

/** The error handler's own line for a 5xx; noteServerError has already kept it, better shaped. */
const HANDLER_LINE = /^\[[^\]]+\] [A-Z]+ \S+ -> \d{3} \(user /;

/**
 * Keep console.error / console.warn (every "[outlook] …", "[jobs] …" failure
 * in the server) as log events, as well as printing them as before: App
 * Service's log stream is the only other place they go, and it forgets.
 */
function captureConsole() {
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      if (flushing || !args.length) return;
      if (typeof args[0] === "string" && HANDLER_LINE.test(args[0])) return;
      if (++logLines > MAX_LOG_LINES_PER_MINUTE) return;
      const text = util.format(...args);
      const err = args.find((a): a is Error => a instanceof Error);
      devEvent({
        kind: "log",
        level,
        message: text.split("\n")[0],
        path: /^\[([\w-]+)\]/.exec(text)?.[1] ?? null,
        data: err?.stack ? { stack: err.stack } : text.includes("\n") ? { text } : undefined,
      });
    };
  }
}

// ── Writing ───────────────────────────────────────────────────────────────

function processSample(at: Date): Prisma.DevSampleCreateManyInput {
  const mem = process.memoryUsage();
  const now = process.hrtime.bigint();
  const cpu = process.cpuUsage(lastCpu);
  const elapsedUs = Number(now - lastCpuAt) / 1000;
  lastCpu = process.cpuUsage();
  lastCpuAt = now;
  const ns = (v: number) => (Number.isFinite(v) ? v / 1e6 : 0);
  const sample = {
    at,
    instance: INSTANCE,
    rssMb: mem.rss / 1048576,
    heapUsedMb: mem.heapUsed / 1048576,
    heapTotalMb: mem.heapTotal / 1048576,
    cpuPct: elapsedUs > 0 ? ((cpu.user + cpu.system) / elapsedUs) * 100 : 0,
    loopP50Ms: ns(loop.percentile(50)),
    loopP99Ms: ns(loop.percentile(99)),
    loopMaxMs: ns(loop.max),
    inFlightMax,
    uptimeSec: Math.round(process.uptime()),
  };
  loop.reset();
  inFlightMax = inFlight;
  return sample;
}

function metricRow(at: Date, kind: "route" | "db", name: string, b: Bucket): Prisma.DevMetricCreateManyInput {
  const row: Prisma.DevMetricCreateManyInput = {
    at, instance: INSTANCE, kind, name: name.slice(0, 255),
    calls: b.calls, errors: b.errors, rejected: b.rejected, totalMs: b.totalMs, maxMs: b.maxMs,
  };
  b.h.forEach((n, i) => ((row as Record<string, unknown>)[`h${i}`] = n));
  return row;
}

/** Write every finished minute (all of them when `everything`), the process sample and the queued events. */
export async function flushDevlog(everything = false) {
  if (flushing) return;
  flushing = true;
  try {
    const now = minuteOf(Date.now());
    const metrics: Prisma.DevMetricCreateManyInput[] = [];
    for (const [t, m] of pending) {
      if (!everything && t >= now) continue;
      const at = new Date(t);
      for (const [name, b] of m.routes) metrics.push(metricRow(at, "route", name, b));
      if (m.db.calls) metrics.push(metricRow(at, "db", "", m.db));
      pending.delete(t);
    }
    const sample = processSample(new Date(now - 60_000));
    if (droppedEvents) {
      devEvent({ kind: "log", level: "warn", path: "devlog", message: `${droppedEvents} events weren't kept: more than ${MAX_EVENTS_PER_FLUSH} in a minute.` });
      droppedEvents = 0;
    }
    if (logLines > MAX_LOG_LINES_PER_MINUTE) {
      devEvent({ kind: "log", level: "warn", path: "devlog", message: `${logLines - MAX_LOG_LINES_PER_MINUTE} server log lines weren't kept: more than ${MAX_LOG_LINES_PER_MINUTE} in a minute.` });
    }
    logLines = 0;
    const batch = events;
    events = [];
    await prisma.devSample.create({ data: sample });
    if (metrics.length) await prisma.devMetric.createMany({ data: metrics });
    if (batch.length) await prisma.devEvent.createMany({ data: batch });
    lastFlushAt = new Date();
    lastFlushError = null;
  } catch (err) {
    lastFlushError = err instanceof Error ? err.message : String(err);
    // Printed, not logged: a log write that failed shouldn't queue another.
    process.stderr.write(`[devlog] couldn't write the dev log: ${lastFlushError}\n`);
  } finally {
    flushing = false;
  }
}

async function prune() {
  const before = new Date(Date.now() - env.devlog.retentionDays * 86_400_000);
  try {
    await prisma.devMetric.deleteMany({ where: { at: { lt: before } } });
    await prisma.devSample.deleteMany({ where: { at: { lt: before } } });
    await prisma.devEvent.deleteMany({ where: { createdAt: { lt: before } } });
  } catch (err) {
    process.stderr.write(`[devlog] couldn't remove old entries: ${err instanceof Error ? err.message : err}\n`);
  }
}

/** Start counting. Called once, before the app is created (index.ts). */
export function startDevlog(): boolean {
  if (!env.devlog.enabled || started) return false;
  started = true;
  loop.enable();
  captureConsole();
  prisma.$on("query", (e) => noteQuery(e.duration, e.query));
  // Write just after each minute turns, so a bucket is complete when it's written.
  const toNextMinute = 60_000 - (Date.now() % 60_000) + 2_000;
  setTimeout(() => {
    void flushDevlog();
    setInterval(() => void flushDevlog(), 60_000).unref();
  }, toNextMinute).unref();
  setTimeout(() => void prune(), 5 * 60_000).unref();
  setInterval(() => void prune(), 6 * 3600_000).unref();
  return true;
}

/** The server is up: one "boot" event, so a restart or a deploy shows in the log. */
export function noteBoot() {
  devEvent({
    kind: "boot",
    level: "info",
    message: `Server started on ${INSTANCE}${env.devlog.appVersion ? ` (version ${env.devlog.appVersion})` : ""}`,
    durationMs: process.uptime() * 1000,
    data: {
      node: process.version,
      platform: `${process.platform} ${os.release()}`,
      cpus: os.cpus().length,
      memoryMb: Math.round(os.totalmem() / 1048576),
      version: env.devlog.appVersion || null,
      environment: env.nodeEnv,
      appService: process.env.WEBSITE_SITE_NAME ?? null,
    },
  });
}

/** This server right now, for the top of the Dev log. */
export function liveStatus() {
  const mem = process.memoryUsage();
  const m = pending.get(minuteOf(Date.now()));
  let calls = 0;
  for (const b of m?.routes.values() ?? []) calls += b.calls;
  return {
    instance: INSTANCE,
    enabled: env.devlog.enabled,
    node: process.version,
    version: env.devlog.appVersion || null,
    environment: env.nodeEnv,
    uptimeSec: Math.round(process.uptime()),
    rssMb: mem.rss / 1048576,
    heapUsedMb: mem.heapUsed / 1048576,
    inFlight,
    callsThisMinute: calls,
    loopP99Ms: Number.isFinite(loop.percentile(99)) ? loop.percentile(99) / 1e6 : 0,
    lastFlushAt,
    lastFlushError,
    slowRequestMs: env.devlog.slowRequestMs,
    slowQueryMs: env.devlog.slowQueryMs,
    retentionDays: env.devlog.retentionDays,
  };
}
