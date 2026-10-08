import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Input } from "@/components/ui/input";
import { ToneBadge } from "@/components/ui/badge";
import { EmptyState, LoadMore, LoadingState } from "@/components/ui/misc";
import { StatTile, ticks, useWidth } from "@/components/charts/Charts";
import { api } from "@/lib/api";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";

/**
 * Admin → Dev log: how the live site is doing, from the server's own counts
 * (backend services/devlog.ts) and what browsers report (lib/telemetry.ts).
 * For tuning, not alerting: nothing here pages anyone.
 */

type RangeKey = "1h" | "6h" | "24h" | "7d" | "30d";
const RANGES: { key: RangeKey; label: string }[] = [
  { key: "1h", label: "Last hour" },
  { key: "6h", label: "6 hours" },
  { key: "24h", label: "24 hours" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
];

interface Timing {
  calls: number;
  errors: number;
  rejected: number;
  totalMs: number | null;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
}

interface Point {
  at: string;
  calls: number;
  errors: number;
  avgMs: number | null;
  p95Ms: number | null;
  dbCalls: number;
  dbAvgMs: number | null;
  rssMb: number | null;
  heapUsedMb: number | null;
  cpuPct: number | null;
  loopP99Ms: number | null;
  inFlightMax: number | null;
}

interface Summary {
  range: RangeKey;
  bucketMin: number;
  since: string;
  live: {
    instance: string;
    enabled: boolean;
    node: string;
    version: string | null;
    environment: string;
    uptimeSec: number;
    rssMb: number;
    heapUsedMb: number;
    inFlight: number;
    callsThisMinute: number;
    loopP99Ms: number;
    lastFlushAt: string | null;
    lastFlushError: string | null;
    slowRequestMs: number;
    slowQueryMs: number;
    retentionDays: number;
  };
  requests: Timing;
  database: Timing;
  series: Point[];
  routes: (Timing & { name: string })[];
  events: Record<string, number>;
  browsers: {
    sampled: number;
    capped: boolean;
    devices: { device: string; loads: number; ttfbMs: number | null; fcpMs: number | null; lcpMs: number | null; loadMs: number | null; jsKb: number | null }[];
  };
  instances: { instance: string; lastSeen: string | null; rssMaxMb: number | null; uptimeSec: number | null; cpuAvgPct: number | null }[];
}

interface DevEventRow {
  id: string;
  createdAt: string;
  kind: string;
  level: "error" | "warn" | "info";
  instance: string | null;
  path: string | null;
  status: number | null;
  durationMs: number | null;
  message: string | null;
  data: string | null;
  requestId: string | null;
  userEmail: string | null;
}

const KIND_LABEL: Record<string, string> = {
  error: "Server error",
  log: "Server log",
  "slow-request": "Slow request",
  "slow-query": "Slow query",
  boot: "Server start",
  "client-error": "Browser error",
  "page-load": "Page load",
  "slow-interaction": "Slow tap",
  "slow-api": "Slow on device",
};

/** The event list's filters: each a set of kinds. */
const FILTERS: { key: string; label: string; kinds: string[] }[] = [
  { key: "all", label: "All", kinds: [] },
  { key: "errors", label: "Errors", kinds: ["error", "client-error"] },
  { key: "log", label: "Server log", kinds: ["log"] },
  { key: "slow", label: "Slow requests", kinds: ["slow-request", "slow-api"] },
  { key: "queries", label: "Slow queries", kinds: ["slow-query"] },
  { key: "taps", label: "Slow taps", kinds: ["slow-interaction"] },
  { key: "loads", label: "Page loads", kinds: ["page-load"] },
  { key: "boot", label: "Server starts", kinds: ["boot"] },
];

const num = (n: number | null | undefined) => (n == null ? "—" : Math.round(n).toLocaleString("en-US"));

function ms(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 10_000) return `${Math.round(n / 1000)} s`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)} s`;
  if (n >= 10) return `${Math.round(n)} ms`;
  return `${n.toFixed(1)} ms`;
}

function duration(sec: number | null | undefined): string {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

const pct = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(part / whole < 0.01 ? 2 : 1)}%` : "—");

export function AdminDevLog() {
  const [range, setRange] = useState<RangeKey>("24h");
  const short = range === "1h" || range === "6h";
  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["admin", "devlog", range],
    queryFn: () => api.get<Summary>(`/devlog/summary?range=${range}`),
    // The short ranges move while you watch; the long ones barely do.
    refetchInterval: short ? 30_000 : false,
  });

  return (
    <Page>
      <PageHeader
        title="Dev log"
        subtitle="How the site is running: response times, errors, the database, memory, and what people's devices see."
        actions={
          <Button variant="secondary" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} /> Refresh
          </Button>
        }
      />

      <div className="chiprow -mx-1 mb-5 flex gap-1.5 px-1">
        {RANGES.map((r) => (
          <Chip key={r.key} active={range === r.key} onClick={() => setRange(r.key)}>{r.label}</Chip>
        ))}
      </div>

      {isLoading ? (
        <LoadingState />
      ) : error || !data ? (
        <EmptyState title="The dev log didn't load" hint={error instanceof Error ? error.message : undefined} />
      ) : (
        <div className="space-y-6">
          <LiveStrip live={data.live} />
          <Totals data={data} />
          <SeriesCharts data={data} />
          <RoutesTable routes={data.routes} />
          <div className="grid gap-6 lg:grid-cols-2">
            <BrowsersTable browsers={data.browsers} />
            <ServersTable instances={data.instances} live={data.live} />
          </div>
          <EventLog range={range} counts={data.events} />
        </div>
      )}
    </Page>
  );
}

// ── This server now ───────────────────────────────────────────────────────

function LiveStrip({ live }: { live: Summary["live"] }) {
  const items = [
    ["Server", live.instance],
    ["Up for", duration(live.uptimeSec)],
    ["Memory", `${num(live.rssMb)} MB`],
    ["In progress", num(live.inFlight)],
    ["Requests this minute", num(live.callsThisMinute)],
    ["Event loop p99", ms(live.loopP99Ms)],
    ["Node", live.node],
    ["Version", live.version ?? "not set"],
  ];
  return (
    <div>
      {!live.enabled && (
        <p className="mb-3 flex items-center gap-2 rounded-input bg-status-amberBg px-3 py-2 text-[13px] text-status-amberText">
          <TriangleAlert className="h-4 w-4 shrink-0" /> The dev log is off on this server (DEVLOG=false): nothing new is being recorded.
        </p>
      )}
      {live.lastFlushError && (
        <p className="mb-3 flex items-center gap-2 rounded-input bg-status-redBg px-3 py-2 text-[13px] text-status-redText">
          <TriangleAlert className="h-4 w-4 shrink-0" /> The last write to the dev log failed: {live.lastFlushError}
        </p>
      )}
      <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-card border border-hairline bg-surface px-4 py-3">
        <p className="w-full text-[11px] font-semibold uppercase tracking-wide text-muted">This server, right now</p>
        {items.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <p className="text-[11.5px] text-muted">{label}</p>
            <p className="truncate text-[14px] font-semibold text-ink tabular">{value}</p>
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[11.5px] text-muted">
        Counted by the minute and written once a minute, so the last minute shows up a minute late. Slow means over {ms(live.slowRequestMs)} for a request and {ms(live.slowQueryMs)} for a query. Kept {live.retentionDays} days.
      </p>
    </div>
  );
}

// ── Range totals ──────────────────────────────────────────────────────────

function Totals({ data }: { data: Summary }) {
  const r = data.requests;
  const d = data.database;
  // The device with the most loads. Not every browser reports the largest paint (older Safari), so fall back to the first.
  const top = data.browsers.devices[0];
  const shown = top ? (top.lcpMs != null ? { v: top.lcpMs, what: "main content" } : top.fcpMs != null ? { v: top.fcpMs, what: "first paint" } : { v: top.loadMs, what: "fully loaded" }) : null;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <StatTile label="Requests" value={num(r.calls)} hint={`${num(r.rejected)} refused (4xx)`} />
      <StatTile
        label="Server errors"
        value={num(r.errors)}
        hint={`${pct(r.errors, r.calls)} of requests`}
        icon={r.errors ? <TriangleAlert className="h-3.5 w-3.5 text-status-redText" /> : undefined}
        accent={r.errors ? "rgb(var(--st-red-dot))" : undefined}
      />
      <StatTile label="Response p95" value={ms(r.p95Ms)} hint={`median ${ms(r.p50Ms)} · worst ${ms(r.maxMs)}`} />
      <StatTile label="Average response" value={ms(r.avgMs)} hint={`p99 ${ms(r.p99Ms)}`} />
      <StatTile label="Database queries" value={num(d.calls)} hint={`avg ${ms(d.avgMs)} · p95 ${ms(d.p95Ms)}`} />
      <StatTile
        label="Page load (p75)"
        value={ms(shown?.v)}
        hint={top && shown ? `${shown.what} on ${top.device} · ${num(top.loads)} loads` : "no page loads reported yet"}
      />
    </div>
  );
}

// ── Charts ────────────────────────────────────────────────────────────────

function SeriesCharts({ data }: { data: Summary }) {
  const s = data.series;
  const long = data.range === "7d" || data.range === "30d";
  const charts: { title: string; note: string; kind: "bar" | "line"; values: (number | null)[]; fmt: (v: number) => string }[] = [
    { title: "Requests", note: `per ${bucketWord(data.bucketMin)}`, kind: "bar", values: s.map((p) => p.calls), fmt: (v) => num(v) },
    { title: "Response time, p95", note: "95% of requests were faster", kind: "line", values: s.map((p) => p.p95Ms), fmt: ms },
    { title: "Server errors", note: `5xx per ${bucketWord(data.bucketMin)}`, kind: "bar", values: s.map((p) => p.errors), fmt: (v) => num(v) },
    { title: "Database query time", note: "average per query", kind: "line", values: s.map((p) => p.dbAvgMs), fmt: ms },
    { title: "Memory", note: "server process, MB", kind: "line", values: s.map((p) => p.rssMb), fmt: (v) => `${num(v)} MB` },
    { title: "CPU", note: "share of one core", kind: "line", values: s.map((p) => p.cpuPct), fmt: (v) => `${v.toFixed(v < 10 ? 1 : 0)}%` },
    { title: "Event loop delay, p99", note: "how long work waited its turn", kind: "line", values: s.map((p) => p.loopP99Ms), fmt: ms },
    { title: "Requests at once", note: "most in progress together", kind: "bar", values: s.map((p) => p.inFlightMax), fmt: (v) => num(v) },
  ];
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {charts.map((c) => {
        const present = c.values.filter((v): v is number => v != null);
        const peak = present.length ? Math.max(...present) : null;
        return (
          <Card key={c.title} className="p-4">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[13.5px] font-bold text-ink">{c.title}</p>
                <p className="text-[11.5px] text-muted">{c.note}</p>
              </div>
              <p className="shrink-0 text-[11.5px] text-muted tabular">peak <span className="font-semibold text-ink">{peak == null ? "—" : c.fmt(peak)}</span></p>
            </div>
            <TimeChart times={s.map((p) => p.at)} values={c.values} kind={c.kind} fmt={c.fmt} long={long} label={c.title} />
          </Card>
        );
      })}
    </div>
  );
}

const bucketWord = (min: number) => (min === 1 ? "minute" : min < 60 ? `${min} minutes` : `${min / 60} hours`);

function timeLabel(iso: string, long: boolean) {
  const d = new Date(iso);
  return long
    ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/**
 * One measure over time, on its own axis: bars for counts, a 2px line for
 * timings and levels (a gap where nothing was recorded). Hover for the value.
 */
function TimeChart({ times, values, kind, fmt, long, label }: {
  times: string[];
  values: (number | null)[];
  kind: "bar" | "line";
  fmt: (v: number) => string;
  long: boolean;
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 150;
  const PAD = { top: 8, right: 6, bottom: 20, left: 44 };
  const max = Math.max(0, ...values.map((v) => v ?? 0));
  const t = ticks(max);
  const top = t[t.length - 1];
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const n = values.length;
  const step = n ? plotW / n : 0;
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const cx = (i: number) => PAD.left + i * step + step / 2;
  const barW = Math.max(1, Math.min(14, step - 2));
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 80))));

  // Line segments, broken wherever a bucket has no value.
  const path = useMemo(() => {
    if (kind !== "line") return "";
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${cx(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, values, width, top]);

  const hv = hover !== null ? values[hover] : null;

  return (
    <div
      ref={ref}
      className="relative w-full select-none"
      onMouseLeave={() => setHover(null)}
      onMouseMove={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        const i = Math.floor((e.clientX - box.left - PAD.left) / (step || 1));
        setHover(i >= 0 && i < n ? i : null);
      }}
    >
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label={label}>
          {t.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} className="stroke-hairline" strokeWidth={1} />
              <text x={PAD.left - 6} y={y(v) + 4} textAnchor="end" className="fill-muted text-[10.5px] tabular">{fmt(v)}</text>
            </g>
          ))}
          {hover !== null && <line x1={cx(hover)} x2={cx(hover)} y1={PAD.top} y2={PAD.top + plotH} className="stroke-strongline" strokeWidth={1} />}
          {kind === "bar" &&
            values.map((v, i) => {
              if (!v) return null;
              const x = cx(i) - barW / 2;
              const yt = y(v);
              const base = PAD.top + plotH;
              const r = Math.min(4, barW / 2, base - yt);
              return (
                <path
                  key={i}
                  d={`M${x},${base} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + barW - r} Q${x + barW},${yt} ${x + barW},${yt + r} V${base} Z`}
                  style={{ fill: "var(--viz-1)" }}
                  className={cn("transition-opacity", hover !== null && hover !== i && "opacity-40")}
                />
              );
            })}
          {kind === "line" && <path d={path} fill="none" style={{ stroke: "var(--viz-1)" }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
          {kind === "line" && hover !== null && hv != null && (
            <circle cx={cx(hover)} cy={y(hv)} r={4.5} style={{ fill: "var(--viz-1)" }} className="stroke-surface" strokeWidth={2} />
          )}
          {times.map((at, i) =>
            i % every === 0 ? (
              <text key={at} x={cx(i)} y={H - 5} textAnchor="middle" className="fill-muted text-[10.5px]">{timeLabel(at, long)}</text>
            ) : null
          )}
        </svg>
      )}
      {hover !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 w-max -translate-x-1/2 rounded-input border border-hairline bg-surface px-2.5 py-1.5 text-[12px] shadow-panel"
          style={{ left: Math.min(Math.max(cx(hover), 70), width - 70) }}
        >
          <p className="text-muted">{new Date(times[hover]).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</p>
          <p className="font-semibold text-ink tabular">{hv == null ? "nothing recorded" : fmt(hv)}</p>
        </div>
      )}
    </div>
  );
}

// ── Tables ────────────────────────────────────────────────────────────────

type RouteSort = "totalMs" | "calls" | "p95Ms" | "maxMs" | "errors";
const ROUTE_COLUMNS: { key: RouteSort | null; label: string }[] = [
  { key: null, label: "Route" },
  { key: "calls", label: "Calls" },
  { key: null, label: "Average" },
  { key: "p95Ms", label: "p95" },
  { key: "maxMs", label: "Slowest" },
  { key: "totalMs", label: "Total time" },
  { key: "errors", label: "5xx" },
  { key: null, label: "4xx" },
];

function RoutesTable({ routes }: { routes: Summary["routes"] }) {
  const [sort, setSort] = useState<RouteSort>("totalMs");
  const [all, setAll] = useState(false);
  const sorted = useMemo(() => [...routes].sort((a, b) => (b[sort] ?? 0) - (a[sort] ?? 0)), [routes, sort]);
  const shown = all ? sorted : sorted.slice(0, 20);
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-hairline px-4 py-3">
        <p className="text-[14px] font-bold text-ink">Routes</p>
        <p className="text-[12px] text-muted">Every API route the site answered. Total time is where the server spends its effort: start there.</p>
      </div>
      {routes.length === 0 ? (
        <p className="px-4 py-6 text-[13px] text-muted">No requests in this range yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[12.5px]">
            <thead>
              <tr className="border-b border-hairline text-left text-[11px] uppercase tracking-wide text-muted">
                {ROUTE_COLUMNS.map((c, i) => (
                  <th key={c.label} className={cn("px-3 py-2 font-semibold", i > 0 && "text-right")}>
                    {c.key ? (
                      <button type="button" onClick={() => setSort(c.key!)} className={cn("uppercase tracking-wide hover:text-ink", sort === c.key && "font-bold text-ink")}>
                        {c.label}{sort === c.key ? " ↓" : ""}
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.name} className="border-b border-hairline last:border-0 hover:bg-rowhover">
                  <td className="max-w-[340px] truncate px-3 py-2 font-mono text-[12px] text-ink" title={r.name}>{r.name}</td>
                  <td className="px-3 py-2 text-right tabular text-ink">{num(r.calls)}</td>
                  <td className="px-3 py-2 text-right tabular text-ink">{ms(r.avgMs)}</td>
                  <td className="px-3 py-2 text-right tabular font-semibold text-ink">{ms(r.p95Ms)}</td>
                  <td className="px-3 py-2 text-right tabular text-ink">{ms(r.maxMs)}</td>
                  <td className="px-3 py-2 text-right tabular text-ink">{ms(r.totalMs)}</td>
                  <td className={cn("px-3 py-2 text-right tabular", r.errors ? "font-bold text-status-redText" : "text-muted")}>{num(r.errors)}</td>
                  <td className="px-3 py-2 text-right tabular text-muted">{num(r.rejected)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {routes.length > 20 && (
        <div className="border-t border-hairline px-4 py-2">
          <Button variant="ghost" size="sm" onClick={() => setAll(!all)}>{all ? "Show the top 20" : `Show all ${routes.length}`}</Button>
        </div>
      )}
    </Card>
  );
}

function BrowsersTable({ browsers }: { browsers: Summary["browsers"] }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-hairline px-4 py-3">
        <p className="text-[14px] font-bold text-ink">Page loads, by device</p>
        <p className="text-[12px] text-muted">
          75th percentile: three loads in four were at least this fast. First answer, first paint, the page's main content shown, fully loaded, and script downloaded.
          {browsers.capped && ` The latest ${num(browsers.sampled)} loads.`}
        </p>
      </div>
      {browsers.devices.length === 0 ? (
        <p className="px-4 py-6 text-[13px] text-muted">No page loads reported in this range.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-[12.5px]">
            <thead>
              <tr className="border-b border-hairline text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-semibold">Device</th>
                <th className="px-3 py-2 text-right font-semibold">Loads</th>
                <th className="px-3 py-2 text-right font-semibold">Answer</th>
                <th className="px-3 py-2 text-right font-semibold">Paint</th>
                <th className="px-3 py-2 text-right font-semibold">Content</th>
                <th className="px-3 py-2 text-right font-semibold">Loaded</th>
                <th className="px-3 py-2 text-right font-semibold">Script</th>
              </tr>
            </thead>
            <tbody>
              {browsers.devices.map((d) => (
                <tr key={d.device} className="border-b border-hairline last:border-0">
                  <td className="px-3 py-2 capitalize text-ink">{d.device}</td>
                  <td className="px-3 py-2 text-right tabular text-ink">{num(d.loads)}</td>
                  <td className="px-3 py-2 text-right tabular text-ink">{ms(d.ttfbMs)}</td>
                  <td className="px-3 py-2 text-right tabular text-ink">{ms(d.fcpMs)}</td>
                  <td className="px-3 py-2 text-right tabular font-semibold text-ink">{ms(d.lcpMs)}</td>
                  <td className="px-3 py-2 text-right tabular text-ink">{ms(d.loadMs)}</td>
                  <td className="px-3 py-2 text-right tabular text-ink">{d.jsKb == null ? "—" : `${num(d.jsKb)} KB`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ServersTable({ instances, live }: { instances: Summary["instances"]; live: Summary["live"] }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-hairline px-4 py-3">
        <p className="text-[14px] font-bold text-ink">Servers</p>
        <p className="text-[12px] text-muted">Each copy of the API that ran in this range. A new one, or uptime starting over, is a restart or a deploy.</p>
      </div>
      {instances.length === 0 ? (
        <p className="px-4 py-6 text-[13px] text-muted">Nothing recorded yet: the first minute is written a minute after the server starts.</p>
      ) : (
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-hairline text-left text-[11px] uppercase tracking-wide text-muted">
              <th className="px-3 py-2 font-semibold">Server</th>
              <th className="px-3 py-2 text-right font-semibold">Last seen</th>
              <th className="px-3 py-2 text-right font-semibold">Up for</th>
              <th className="px-3 py-2 text-right font-semibold">Peak memory</th>
              <th className="px-3 py-2 text-right font-semibold">CPU</th>
            </tr>
          </thead>
          <tbody>
            {instances.map((i) => (
              <tr key={i.instance} className="border-b border-hairline last:border-0">
                <td className="px-3 py-2 font-mono text-[12px] text-ink">
                  {i.instance}
                  {i.instance === live.instance && <span className="ml-1.5 font-sans text-[11px] text-muted">(this one)</span>}
                </td>
                <td className="px-3 py-2 text-right text-ink">{relativeTime(i.lastSeen)}</td>
                <td className="px-3 py-2 text-right tabular text-ink">{duration(i.uptimeSec)}</td>
                <td className="px-3 py-2 text-right tabular text-ink">{i.rssMaxMb == null ? "—" : `${num(i.rssMaxMb)} MB`}</td>
                <td className="px-3 py-2 text-right tabular text-ink">{i.cpuAvgPct == null ? "—" : `${i.cpuAvgPct}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ── Event log ─────────────────────────────────────────────────────────────

function EventLog({ range, counts }: { range: RangeKey; counts: Record<string, number> }) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const kinds = FILTERS.find((f) => f.key === filter)!.kinds;
  const query = useInfiniteQuery({
    queryKey: ["admin", "devlog", "events", range, filter, q],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ range, limit: "50" });
      if (kinds.length) p.set("kinds", kinds.join(","));
      if (q) p.set("q", q);
      if (pageParam) p.set("after", pageParam);
      return api.get<{ items: DevEventRow[]; more: boolean }>(`/devlog/events?${p}`);
    },
    getNextPageParam: (last) => (last.more ? last.items[last.items.length - 1]?.id : undefined),
  });
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  const countOf = (f: (typeof FILTERS)[number]) => (f.kinds.length ? f.kinds.reduce((n, k) => n + (counts[k] ?? 0), 0) : Object.values(counts).reduce((a, b) => a + b, 0));

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-hairline px-4 py-3">
        <p className="text-[14px] font-bold text-ink">Events</p>
        <p className="text-[12px] text-muted">Server errors and warnings, slow requests and queries, server starts, and what browsers report. Newest first.</p>
        <div className="mt-3 flex flex-col gap-2 md:flex-row md:items-center">
          <div className="chiprow -mx-1 flex min-w-0 flex-1 gap-1.5 px-1">
            {FILTERS.map((f) => (
              <Chip key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>
                {f.label} <span className="tabular text-muted">{num(countOf(f))}</span>
              </Chip>
            ))}
          </div>
          <form
            className="relative md:w-[260px]"
            onSubmit={(e) => {
              e.preventDefault();
              setQ(search.trim());
            }}
          >
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} onBlur={() => setQ(search.trim())} placeholder="Search text, route, reference, email" className="pl-8" />
          </form>
        </div>
      </div>
      {query.isLoading ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-[13px] text-muted">Nothing here for this range.</p>
      ) : (
        <ul>
          {rows.map((r) => <EventRow key={r.id} row={r} />)}
        </ul>
      )}
      {query.hasNextPage && (
        <div className="border-t border-hairline px-4 py-2">
          <LoadMore loading={query.isFetchingNextPage} onClick={() => query.fetchNextPage()} />
        </div>
      )}
    </Card>
  );
}

function EventRow({ row }: { row: DevEventRow }) {
  const [open, setOpen] = useState(false);
  const tone = row.level === "error" ? "red" : row.level === "warn" ? "amber" : row.kind === "boot" ? "blue" : "neutral";
  const details = useMemo(() => {
    if (!row.data) return null;
    try {
      return JSON.parse(row.data) as Record<string, unknown>;
    } catch {
      return { text: row.data };
    }
  }, [row.data]);
  const stack = typeof details?.stack === "string" ? details.stack : typeof details?.text === "string" ? details.text : null;
  const rest = details ? Object.fromEntries(Object.entries(details).filter(([k]) => k !== "stack" && k !== "text")) : null;

  return (
    <li className="border-b border-hairline last:border-0">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-rowhover">
        {open ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted" />}
        <span className="w-[86px] shrink-0 text-[12px] text-muted" title={formatDateTime(row.createdAt)}>{relativeTime(row.createdAt)}</span>
        <ToneBadge tone={tone} className="shrink-0">{KIND_LABEL[row.kind] ?? row.kind}</ToneBadge>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-ink">{row.message || row.path || "—"}</span>
          {row.path && row.message && <span className="block truncate font-mono text-[11.5px] text-muted">{row.path}</span>}
        </span>
        {row.durationMs != null && <span className="shrink-0 text-[12px] tabular text-ink">{ms(row.durationMs)}</span>}
        {row.status != null && <span className={cn("shrink-0 text-[12px] tabular", row.status >= 500 ? "font-bold text-status-redText" : "text-muted")}>{row.status}</span>}
      </button>
      {open && (
        <div className="space-y-2 px-4 pb-3 pl-11 text-[12px]">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted">
            <dt>When</dt><dd className="text-ink">{formatDateTime(row.createdAt)}</dd>
            {row.userEmail && (<><dt>Person</dt><dd className="text-ink">{row.userEmail}</dd></>)}
            {row.requestId && (<><dt>Reference</dt><dd className="font-mono text-ink">{row.requestId}</dd></>)}
            {row.instance && (<><dt>Server</dt><dd className="font-mono text-ink">{row.instance}</dd></>)}
          </dl>
          {row.message && row.message.length > 120 && (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-input bg-subtle p-2 font-mono text-[11.5px] text-ink">{row.message}</pre>
          )}
          {stack && <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-input bg-subtle p-2 font-mono text-[11.5px] text-ink">{stack}</pre>}
          {rest && Object.keys(rest).length > 0 && (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-input bg-subtle p-2 font-mono text-[11.5px] text-ink">{JSON.stringify(rest, null, 2)}</pre>
          )}
        </div>
      )}
    </li>
  );
}
