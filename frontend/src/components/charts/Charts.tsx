import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The Reports tab's charts, hand-built in SVG/HTML rather than a charting
 * library. Color always carries meaning, never decoration:
 *   - meal types wear a fixed categorical slot (--viz-1…8, see index.css),
 *     chosen by their Manage-meal-types order, so a meal is the same color on
 *     every chart, range and export;
 *   - site bars wear their site type;
 *   - the heat grid is a one-hue sequential scale.
 * Text stays in ink/muted tokens; every chart has a hover tooltip, a legend
 * wherever there are two or more colors, and a table or direct labels.
 */

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

export interface Series {
  key: string;
  name: string;
  slot: number | null;
}

/** CSS color for a categorical slot (0-based); null = "Other" gray. */
export const slotColor = (slot: number | null) => (slot === null ? "var(--viz-other)" : `var(--viz-${slot + 1})`);

export const SITE_TYPE = {
  supportive: { label: "Supportive housing", color: "var(--viz-site-supportive)" },
  shelter: { label: "Shelter", color: "var(--viz-site-shelter)" },
  other: { label: "Other", color: "var(--viz-site-other)" },
} as const;
export const siteTypeOf = (t: string) => SITE_TYPE[(t in SITE_TYPE ? t : "other") as keyof typeof SITE_TYPE];

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** 0 and three or four whole-number steps up to at least `max`. */
function ticks(max: number) {
  const raw = Math.max(1, max) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? 10 * mag);
  const out = [0];
  while (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  if (out.length === 1) out.push(step);
  return out;
}

const shortDay = (key: string) => new Date(`${key}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const longDay = (key: string) => new Date(`${key}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });

/** Swatch + label row. Identity is never color alone: every swatch is named. */
export function Legend({ items, className }: { items: { label: string; color: string }[]; className?: string }) {
  return (
    <ul className={cn("flex flex-wrap gap-x-4 gap-y-1.5", className)} aria-label="Legend">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5 text-[12px] text-muted">
          <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: i.color }} aria-hidden />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Meals per day, stacked by meal type in slot order (bottom → top). Segments
 * are split by a 2px surface gap; only the top of each column is rounded, and
 * it sits flat on the baseline. Hover or tap a day for its breakdown.
 */
export function DailyBars({ data, series }: { data: { day: string; meals: number; entries: number; parts: Record<string, number> }[]; series: Series[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 210;
  const PAD = { top: 8, right: 4, bottom: 22, left: 34 };
  const GAP = 2;
  const max = Math.max(0, ...data.map((d) => d.meals));
  const t = ticks(max);
  const top = t[t.length - 1];
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const step = data.length ? plotW / data.length : 0;
  const barW = Math.max(1, Math.min(28, step - 2));
  const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(plotW / 64))));
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const hovered = hover !== null ? data[hover] : null;

  return (
    <div>
      {series.length > 1 && <Legend className="mb-3" items={series.map((s) => ({ label: s.name, color: slotColor(s.slot) }))} />}
      <div ref={ref} className="relative w-full select-none" onMouseLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={H} role="img" aria-label="Meals served per day, by meal type">
            {t.map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} className="stroke-hairline" strokeWidth={1} />
                <text x={PAD.left - 6} y={y(v) + 4} textAnchor="end" className="fill-muted text-[10.5px] tabular">{fmt(v)}</text>
              </g>
            ))}
            {data.map((d, i) => {
              const x = PAD.left + i * step + (step - barW) / 2;
              const segs = series.map((s) => ({ s, v: d.parts[s.key] ?? 0 })).filter((p) => p.v > 0);
              let acc = 0;
              return (
                <g key={d.day} className={cn("transition-opacity", hover !== null && hover !== i && "opacity-35")}>
                  {segs.map(({ s, v }, j) => {
                    const y0 = y(acc);
                    acc += v;
                    const y1 = y(acc);
                    const last = j === segs.length - 1;
                    // Gap above every segment but the top one; a thin segment never goes negative.
                    const hgt = Math.max(0.5, y0 - y1 - (last ? 0 : GAP));
                    const fill = slotColor(s.slot);
                    if (!last) return <rect key={s.key} x={x} y={y0 - hgt} width={barW} height={hgt} style={{ fill }} />;
                    const r = Math.min(4, barW / 2, hgt);
                    const yt = y0 - hgt;
                    return (
                      <path
                        key={s.key}
                        d={`M${x},${y0} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + barW - r} Q${x + barW},${yt} ${x + barW},${yt + r} V${y0} Z`}
                        style={{ fill }}
                      />
                    );
                  })}
                  {/* Hit target: the whole column, far bigger than a thin bar. */}
                  <rect x={PAD.left + i * step} y={PAD.top} width={step} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} />
                </g>
              );
            })}
            {data.map((d, i) =>
              i % every === 0 ? (
                <text key={d.day} x={PAD.left + i * step + step / 2} y={H - 6} textAnchor="middle" className="fill-muted text-[10.5px]">{shortDay(d.day)}</text>
              ) : null
            )}
          </svg>
        )}
        {hovered && hover !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 w-max min-w-[170px] -translate-x-1/2 rounded-input border border-hairline bg-surface px-2.5 py-2 text-[12px] shadow-panel"
            style={{ left: Math.min(Math.max(PAD.left + hover * step + step / 2, 95), width - 95) }}
          >
            <p className="font-semibold text-ink">{longDay(hovered.day)}</p>
            <p className="mb-1 tabular text-muted"><span className="font-bold text-ink">{fmt(hovered.meals)}</span> meals · {fmt(hovered.entries)} entries</p>
            {series.length > 1 &&
              [...series].reverse().filter((s) => hovered.parts[s.key]).map((s) => (
                <p key={s.key} className="flex items-center gap-1.5 tabular text-muted">
                  <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: slotColor(s.slot) }} />
                  <span className="flex-1">{s.name}</span>
                  <span className="font-semibold text-ink">{fmt(hovered.parts[s.key])}</span>
                </p>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Ranked horizontal bars in plain HTML: name (and note) on the left, value on the right, a bar between. */
export function RankedBars({ rows, unit, limit }: {
  /** `lead`: something shown before the name, e.g. the person's avatar. */
  rows: { name: string; value: number; note?: string; color?: string; lead?: React.ReactNode }[];
  unit: string;
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const max = Math.max(1, ...rows.map((r) => r.value));
  const shown = limit && !expanded ? rows.slice(0, limit) : rows;
  return (
    <div>
      <ul className="space-y-1.5">
        {shown.map((r) => (
          <li key={r.name} className="group grid grid-cols-[minmax(0,7.5rem)_minmax(4rem,1fr)_auto] items-center gap-2.5 md:grid-cols-[minmax(0,10rem)_minmax(5rem,1fr)_auto]" title={`${r.name}: ${fmt(r.value)} ${unit}${r.note ? ` · ${r.note}` : ""}`}>
            <span className="flex min-w-0 items-center gap-2">
              {r.lead}
              <span className="min-w-0">
                <span className="block truncate text-[13px] text-ink">{r.name}</span>
                {r.note && <span className="block truncate text-micro text-muted">{r.note}</span>}
              </span>
            </span>
            <span className="relative h-3.5 rounded-r-[4px] bg-subtle">
              <span
                // The inset edge keeps a very dark or very light chosen color visible on either theme.
                className={cn("absolute inset-y-0 left-0 rounded-r-[4px] shadow-[inset_0_0_0_1px_rgb(var(--c-ink)/0.12)] dark:shadow-[inset_0_0_0_1px_rgb(var(--c-ink)/0.35)] transition-opacity group-hover:opacity-80", !r.color && "bg-accent")}
                style={{ width: `${Math.max(1, (r.value / max) * 100)}%`, ...(r.color ? { background: r.color } : {}) }}
              />
            </span>
            <span className="min-w-[3rem] text-right text-[12.5px] font-bold tabular text-ink">{fmt(r.value)}</span>
          </li>
        ))}
      </ul>
      {limit && rows.length > limit && (
        <button type="button" onClick={() => setExpanded((e) => !e)} className="mt-2 min-h-[36px] text-[13px] font-semibold text-accent dark:text-white">
          {expanded ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 ? "a" : "p"}`;
const STEPS = 7;
/** 0 → the empty cell color; otherwise one of seven sequential steps. */
const heatColor = (v: number, max: number) => `var(--viz-seq-${v <= 0 ? 0 : Math.min(STEPS, Math.max(1, Math.ceil((v / max) * STEPS)))})`;

/** Weekday × hour grid on a one-hue sequential scale. Only the hours anyone was served are drawn. */
export function HeatGrid({ heat }: { heat: number[][] }) {
  const [hover, setHover] = useState<{ w: number; h: number } | null>(null);
  const used = Array.from({ length: 24 }, (_, h) => h).filter((h) => heat.some((row) => row[h] > 0));
  if (used.length === 0) return <p className="text-[13px] text-muted">Nothing served in this range.</p>;
  const hours = Array.from({ length: used[used.length - 1] - used[0] + 1 }, (_, i) => used[0] + i);
  const max = Math.max(1, ...heat.flat());
  const cur = hover ? heat[hover.w][hover.h] : null;

  return (
    <div>
      <div className="overflow-x-auto scroll-thin">
        <div className="grid min-w-max gap-[2px]" style={{ gridTemplateColumns: `2.25rem repeat(${hours.length}, minmax(1.6rem, 1fr))` }} onMouseLeave={() => setHover(null)}>
          {DAYS.map((d, w) => (
            <div key={d} className="contents">
              <span className="flex items-center text-[11px] text-muted">{d}</span>
              {hours.map((h) => {
                const v = heat[w][h];
                return (
                  <button
                    key={h}
                    type="button"
                    aria-label={`${d} ${hourLabel(h)}: ${v} meals`}
                    onMouseEnter={() => setHover({ w, h })}
                    onFocus={() => setHover({ w, h })}
                    onClick={() => setHover({ w, h })}
                    className={cn("h-6 rounded-[3px]", hover?.w === w && hover?.h === h && "ring-2 ring-ink/70")}
                    style={{ background: heatColor(v, max) }}
                  />
                );
              })}
            </div>
          ))}
          <span />
          {hours.map((h, i) => (
            <span key={h} className="text-center text-[10px] text-muted">{i % 2 === 0 ? hourLabel(h) : ""}</span>
          ))}
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <p className="min-h-[18px] text-[12px] text-muted">
          {hover && cur !== null ? (
            <><span className="font-semibold text-ink">{DAYS[hover.w]} {hourLabel(hover.h)}–{hourLabel((hover.h + 1) % 24)}</span> · <span className="font-bold text-ink tabular">{fmt(cur)}</span> meals</>
          ) : (
            "Hover or tap a square for its count."
          )}
        </p>
        <div className="flex items-center gap-1.5 text-[11px] text-muted" aria-label={`Scale: 0 to ${fmt(max)} meals an hour`}>
          <span>Fewer</span>
          {Array.from({ length: STEPS }, (_, i) => (
            <span key={i} className="h-3 w-4 rounded-[2px]" style={{ background: `var(--viz-seq-${i + 1})` }} />
          ))}
          <span>More ({fmt(max)})</span>
        </div>
      </div>
    </div>
  );
}

/** A headline number. `accent` is for status only (e.g. over-limit), always with an icon beside it — never decoration. */
export function StatTile({ label, value, hint, icon, accent }: { label: string; value: string; hint?: string; icon?: React.ReactNode; accent?: string }) {
  return (
    <div className="relative overflow-hidden rounded-card border border-hairline bg-surface px-3.5 py-3 md:px-4">
      {accent && <span className="absolute inset-y-0 left-0 w-1" style={{ background: accent }} aria-hidden />}
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{icon}{label}</p>
      <p className="mt-1 font-heading text-[24px] font-extrabold leading-none text-ink tabular md:text-[28px]">{value}</p>
      {hint && <p className="mt-1.5 text-[11.5px] text-muted">{hint}</p>}
    </div>
  );
}
