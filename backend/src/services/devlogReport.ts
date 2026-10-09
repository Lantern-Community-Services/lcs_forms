import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { DURATION_BOUNDS, liveStatus, percentile } from "./devlog.js";

/**
 * What Admin → Dev log shows: the dev log (services/devlog.ts) added up over a
 * time range, by time bucket, by route, and across servers.
 */

/** Each range and how wide its chart's buckets are (minutes): roughly 60–120 bars. */
export const RANGES = {
  "1h": { ms: 3600_000, bucketMin: 1 },
  "6h": { ms: 6 * 3600_000, bucketMin: 5 },
  "24h": { ms: 24 * 3600_000, bucketMin: 15 },
  "7d": { ms: 7 * 86_400_000, bucketMin: 120 },
  "30d": { ms: 30 * 86_400_000, bucketMin: 360 },
} as const;
export type RangeKey = keyof typeof RANGES;

const H = DURATION_BOUNDS.map((_, i) => `h${i}`).concat(`h${DURATION_BOUNDS.length}`);
const histOf = (row: Record<string, unknown>) => H.map((k) => Number(row[k] ?? 0));
const round = (n: number | null | undefined, d = 1) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

/** Most page loads read for the browser numbers; past this it's the most recent ones. */
const PAGE_LOAD_SAMPLE = 2000;

interface MetricBucketRow {
  bucket: Date;
  calls: number;
  errors: number;
  rejected: number;
  totalMs: number;
  maxMs: number;
  [h: string]: unknown;
}

interface SampleBucketRow {
  bucket: Date;
  rssMb: number;
  rssMaxMb: number;
  heapUsedMb: number;
  cpuPct: number;
  cpuMaxPct: number;
  loopP99Ms: number;
  inFlightMax: number;
}

/** A bucket's start: the time rounded down to `minutes` (counted from 2000-01-01, so buckets line up across calls). */
const bucketSql = (minutes: number) =>
  Prisma.raw(`DATEADD(minute, (DATEDIFF(minute, '20000101', [at]) / ${minutes}) * ${minutes}, CAST('20000101' AS datetime2))`);

async function metricSeries(kind: "route" | "db", since: Date, minutes: number) {
  const bucket = bucketSql(minutes);
  const sums = Prisma.raw(H.map((h) => `SUM([${h}]) AS [${h}]`).join(", "));
  return prisma.$queryRaw<MetricBucketRow[]>`
    SELECT ${bucket} AS bucket, SUM([calls]) AS calls, SUM([errors]) AS errors, SUM([rejected]) AS rejected,
           SUM([totalMs]) AS totalMs, MAX([maxMs]) AS maxMs, ${sums}
    FROM [dbo].[DevMetric]
    WHERE [kind] = ${kind} AND [at] >= ${since}
    GROUP BY ${bucket}
    ORDER BY bucket`;
}

async function sampleSeries(since: Date, minutes: number) {
  const bucket = bucketSql(minutes);
  return prisma.$queryRaw<SampleBucketRow[]>`
    SELECT ${bucket} AS bucket, AVG([rssMb]) AS rssMb, MAX([rssMb]) AS rssMaxMb, AVG([heapUsedMb]) AS heapUsedMb,
           AVG([cpuPct]) AS cpuPct, MAX([cpuPct]) AS cpuMaxPct, MAX([loopP99Ms]) AS loopP99Ms, MAX([inFlightMax]) AS inFlightMax
    FROM [dbo].[DevSample]
    WHERE [at] >= ${since}
    GROUP BY ${bucket}
    ORDER BY bucket`;
}

function summarise(row: { calls: number; errors: number; rejected: number; totalMs: number; maxMs: number }, h: number[]) {
  return {
    calls: row.calls,
    errors: row.errors,
    rejected: row.rejected,
    totalMs: round(row.totalMs, 0),
    avgMs: row.calls ? round(row.totalMs / row.calls) : null,
    p50Ms: round(percentile(h, row.maxMs, 0.5)),
    p95Ms: round(percentile(h, row.maxMs, 0.95)),
    p99Ms: round(percentile(h, row.maxMs, 0.99)),
    maxMs: round(row.maxMs),
  };
}

const p75 = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))], 0);
};

/** Page loads by device: the 75th percentile of each timing, the measure web vitals are judged by. */
async function browserSummary(since: Date) {
  const rows = await prisma.devEvent.findMany({
    where: { kind: "page-load", createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: PAGE_LOAD_SAMPLE,
    select: { data: true },
  });
  const byDevice = new Map<string, Record<string, number>[]>();
  for (const r of rows) {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(r.data ?? "{}");
    } catch {
      continue;
    }
    const device = typeof d.device === "string" ? d.device : "unknown";
    const list = byDevice.get(device) ?? [];
    list.push(d as Record<string, number>);
    byDevice.set(device, list);
  }
  const pick = (list: Record<string, number>[], k: string) => list.map((d) => d[k]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return {
    sampled: rows.length,
    capped: rows.length === PAGE_LOAD_SAMPLE,
    devices: [...byDevice].map(([device, list]) => ({
      device,
      loads: list.length,
      ttfbMs: p75(pick(list, "ttfb")),
      fcpMs: p75(pick(list, "fcp")),
      lcpMs: p75(pick(list, "lcp")),
      loadMs: p75(pick(list, "load")),
      jsKb: p75(pick(list, "jsKb")),
    })).sort((a, b) => b.loads - a.loads),
  };
}

/** Everything the Dev log shows for a range, but the event list (devlogEvents). */
export async function devlogSummary(range: RangeKey) {
  const { ms, bucketMin } = RANGES[range];
  const now = Date.now();
  const since = new Date(now - ms);

  const [routeSeries, dbSeries, samples, routeRows, eventCounts, browsers, instances] = await Promise.all([
    metricSeries("route", since, bucketMin),
    metricSeries("db", since, bucketMin),
    sampleSeries(since, bucketMin),
    prisma.devMetric.groupBy({
      by: ["name"],
      where: { kind: "route", at: { gte: since } },
      _sum: { calls: true, errors: true, rejected: true, totalMs: true, h0: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true, h7: true, h8: true, h9: true, h10: true },
      _max: { maxMs: true },
    }),
    prisma.devEvent.groupBy({ by: ["kind"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    browserSummary(since),
    prisma.devSample.groupBy({ by: ["instance"], where: { at: { gte: since } }, _max: { at: true, rssMb: true, uptimeSec: true }, _avg: { cpuPct: true } }),
  ]);

  // Every bucket in the range, empty ones included, so the chart's x axis is time.
  const step = bucketMin * 60_000;
  const first = Math.floor(since.getTime() / step) * step;
  const routeBy = new Map(routeSeries.map((r) => [new Date(r.bucket).getTime(), r]));
  const dbBy = new Map(dbSeries.map((r) => [new Date(r.bucket).getTime(), r]));
  const sampleBy = new Map(samples.map((r) => [new Date(r.bucket).getTime(), r]));
  const series = [];
  for (let t = first; t <= now; t += step) {
    const r = routeBy.get(t);
    const d = dbBy.get(t);
    const s = sampleBy.get(t);
    series.push({
      at: new Date(t).toISOString(),
      calls: r?.calls ?? 0,
      errors: r?.errors ?? 0,
      avgMs: r?.calls ? round(r.totalMs / r.calls) : null,
      p95Ms: r ? round(percentile(histOf(r), r.maxMs, 0.95)) : null,
      dbCalls: d?.calls ?? 0,
      dbAvgMs: d?.calls ? round(d.totalMs / d.calls, 2) : null,
      rssMb: round(s?.rssMb),
      heapUsedMb: round(s?.heapUsedMb),
      cpuPct: round(s?.cpuPct),
      loopP99Ms: round(s?.loopP99Ms),
      inFlightMax: s?.inFlightMax ?? null,
    });
  }

  const routes = routeRows
    .map((r) => {
      const h = H.map((k) => Number((r._sum as Record<string, number | null>)[k] ?? 0));
      return {
        name: r.name,
        ...summarise(
          { calls: r._sum.calls ?? 0, errors: r._sum.errors ?? 0, rejected: r._sum.rejected ?? 0, totalMs: r._sum.totalMs ?? 0, maxMs: r._max.maxMs ?? 0 },
          h
        ),
      };
    })
    .sort((a, b) => (b.totalMs ?? 0) - (a.totalMs ?? 0));

  // Whole-range totals, from the same histograms so the percentiles agree with the table.
  const add = (rows: MetricBucketRow[]) => {
    const t = { calls: 0, errors: 0, rejected: 0, totalMs: 0, maxMs: 0 };
    const h = new Array(H.length).fill(0);
    for (const r of rows) {
      t.calls += r.calls;
      t.errors += r.errors;
      t.rejected += r.rejected;
      t.totalMs += r.totalMs;
      t.maxMs = Math.max(t.maxMs, r.maxMs);
      histOf(r).forEach((n, i) => (h[i] += n));
    }
    return summarise(t, h);
  };

  return {
    range,
    bucketMin,
    since: since.toISOString(),
    live: liveStatus(),
    requests: add(routeSeries),
    database: add(dbSeries),
    series,
    routes,
    events: Object.fromEntries(eventCounts.map((e) => [e.kind, e._count._all])),
    browsers,
    instances: instances
      .map((i) => ({ instance: i.instance, lastSeen: i._max.at, rssMaxMb: round(i._max.rssMb), uptimeSec: i._max.uptimeSec, cpuAvgPct: round(i._avg.cpuPct) }))
      .sort((a, b) => (b.lastSeen?.getTime() ?? 0) - (a.lastSeen?.getTime() ?? 0)),
  };
}

/** The event list, newest first, a page at a time (`after` = the id of the last one already shown). */
export async function devlogEvents(opts: { kinds?: string[]; level?: string; q?: string; after?: string; since?: Date; limit: number }) {
  const where: Prisma.DevEventWhereInput = {
    ...(opts.kinds?.length ? { kind: { in: opts.kinds } } : {}),
    ...(opts.level ? { level: opts.level } : {}),
    ...(opts.since ? { createdAt: { gte: opts.since } } : {}),
    ...(opts.q
      ? { OR: [{ message: { contains: opts.q } }, { path: { contains: opts.q } }, { requestId: opts.q }, { userEmail: { contains: opts.q } }] }
      : {}),
  };
  const rows = await prisma.devEvent.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: opts.limit + 1,
    ...(opts.after ? { cursor: { id: opts.after }, skip: 1 } : {}),
  });
  return { items: rows.slice(0, opts.limit), more: rows.length > opts.limit };
}
