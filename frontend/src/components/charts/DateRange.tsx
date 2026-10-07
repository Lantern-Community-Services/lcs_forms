import { useSearchParams } from "react-router-dom";
import { CalendarDays } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The date range the Hot Foods Entries and Reports tabs are looking at, kept
 * in the URL (?from=2026-09-01&to=2026-09-25) so a link or a refresh opens the
 * same view. Days are New York calendar days — the server counts them the same
 * way, whatever the device's time zone.
 */

const NY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
export const todayKey = () => NY.format(new Date());

export function addDays(key: string, n: number) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const isKey = (s: string | null): s is string => Boolean(s && /^\d{4}-\d{2}-\d{2}$/.test(s));

export type Preset = "today" | "7d" | "30d" | "month" | "lastMonth" | "90d";

export const PRESETS: { key: Preset; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "month", label: "This month" },
  { key: "lastMonth", label: "Last month" },
  { key: "90d", label: "90 days" },
];

export function presetRange(p: Preset, today = todayKey()): { from: string; to: string } {
  switch (p) {
    case "today":
      return { from: today, to: today };
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "90d":
      return { from: addDays(today, -89), to: today };
    case "month":
      return { from: `${today.slice(0, 8)}01`, to: today };
    case "lastMonth": {
      const end = addDays(`${today.slice(0, 8)}01`, -1);
      return { from: `${end.slice(0, 8)}01`, to: end };
    }
  }
}

export function useDateRange(defaultPreset: Preset = "30d") {
  const [params, setParams] = useSearchParams();
  const fallback = presetRange(defaultPreset);
  let from = isKey(params.get("from")) ? params.get("from")! : fallback.from;
  let to = isKey(params.get("to")) ? params.get("to")! : fallback.to;
  if (from > to) [from, to] = [to, from];
  const preset = PRESETS.find((p) => {
    const r = presetRange(p.key);
    return r.from === from && r.to === to;
  })?.key;

  function setRange(next: { from: string; to: string }) {
    const p = new URLSearchParams(params);
    p.set("from", next.from);
    p.set("to", next.to);
    setParams(p, { replace: true });
  }
  return { from, to, preset, setRange };
}

export function rangeLabel(from: string, to: string) {
  const fmt = (k: string, withYear: boolean) =>
    new Date(`${k}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}) });
  if (from === to) return fmt(from, true);
  return `${fmt(from, from.slice(0, 4) !== to.slice(0, 4))} – ${fmt(to, true)}`;
}

/** Preset chips plus two native date inputs — the phone's own date wheel is the friendliest picker there is. */
export function DateRangeBar({ from, to, preset, onChange, className }: {
  from: string;
  to: string;
  preset?: Preset;
  onChange: (r: { from: string; to: string }) => void;
  className?: string;
}) {
  const today = todayKey();
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="chiprow -mx-4 flex gap-1.5 px-4 md:mx-0 md:flex-wrap md:px-0" role="group" aria-label="Date range">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            aria-pressed={preset === p.key}
            onClick={() => onChange(presetRange(p.key))}
            className={cn(
              "min-h-[36px] shrink-0 whitespace-nowrap rounded-pill border px-3 text-[13px] font-semibold transition-colors md:min-h-[32px]",
              preset === p.key ? "border-navy bg-navy text-white dark:border-white dark:bg-white dark:text-[#111]" : "border-hairline bg-surface text-ink hover:border-strongline"
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <CalendarDays className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <input
          type="date"
          aria-label="From"
          value={from}
          max={today}
          onChange={(e) => e.target.value && onChange({ from: e.target.value, to: e.target.value > to ? e.target.value : to })}
          className="min-h-[40px] min-w-0 flex-1 rounded-input border border-hairline bg-surface px-2 text-[14px] text-ink md:min-h-9 md:max-w-[160px]"
        />
        <span className="text-[13px] text-muted">to</span>
        <input
          type="date"
          aria-label="To"
          value={to}
          max={today}
          onChange={(e) => e.target.value && onChange({ from: e.target.value < from ? e.target.value : from, to: e.target.value })}
          className="min-h-[40px] min-w-0 flex-1 rounded-input border border-hairline bg-surface px-2 text-[14px] text-ink md:min-h-9 md:max-w-[160px]"
        />
      </div>
    </div>
  );
}
