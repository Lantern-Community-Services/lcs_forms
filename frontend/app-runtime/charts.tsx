import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Legend, slotColor, type Series } from "@/components/hotfoods/Charts";

/**
 * @lcs/charts — the Reports tab's charts (re-exported) plus general ones for
 * code-form dashboards, built the same way: the app's categorical slots
 * (--viz-1…8, fixed order, colorblind-checked), text in ink/muted tokens,
 * thin marks, a hover tooltip on every chart and a legend wherever two or more
 * colors appear.
 */
export * from "@/components/hotfoods/Charts";

const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 1 }));

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

function ticks(max: number) {
  const raw = Math.max(1, max) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? 10 * mag);
  const out = [0];
  while (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  if (out.length === 1) out.push(step);
  return out;
}

/** "2026-10-06" → "Oct 6"; anything else as given. */
const axisLabel = (x: string) => (/^\d{4}-\d{2}-\d{2}$/.test(x) ? new Date(`${x}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" }) : x);
const longLabel = (x: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(x) ? new Date(`${x}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" }) : x;

function Tooltip({ left, width, title, children }: { left: number; width: number; title: string; children: React.ReactNode }) {
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 w-max min-w-[150px] -translate-x-1/2 rounded-input border border-hairline bg-surface px-2.5 py-2 text-[12px] shadow-panel"
      style={{ left: Math.min(Math.max(left, 85), Math.max(85, width - 85)) }}
    >
      <p className="mb-0.5 font-semibold text-ink">{title}</p>
      {children}
    </div>
  );
}

/**
 * Change over time: one 2px line per series (up to 8), with a crosshair and
 * tooltip. `x` is a day ("YYYY-MM-DD") or any label; values are keyed by series.
 * One axis only — two measures of different size belong in two charts.
 */
export function TrendChart({ data, series, unit = "", area = false, height = 210 }: {
  data: { x: string; values: Record<string, number> }[];
  series: Series[];
  unit?: string;
  /** Fill under a single series. */
  area?: boolean;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = height;
  const PAD = { top: 10, right: 10, bottom: 22, left: 38 };
  const max = Math.max(0, ...data.flatMap((d) => series.map((s) => d.values[s.key] ?? 0)));
  const t = ticks(max);
  const top = t[t.length - 1];
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (data.length <= 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(plotW / 70))));
  const pick = (clientX: number, el: Element) => {
    if (!data.length) return;
    const rel = clientX - el.getBoundingClientRect().left - PAD.left;
    setHover(Math.min(data.length - 1, Math.max(0, Math.round(data.length <= 1 ? 0 : (rel / plotW) * (data.length - 1)))));
  };
  const hovered = hover !== null ? data[hover] : null;

  return (
    <div>
      {series.length > 1 && <Legend className="mb-3" items={series.map((s) => ({ label: s.name, color: slotColor(s.slot) }))} />}
      <div ref={ref} className="relative w-full select-none" onMouseLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={H} role="img" aria-label={series.map((s) => s.name).join(", ")}
            onMouseMove={(e) => pick(e.clientX, e.currentTarget)} onClick={(e) => pick(e.clientX, e.currentTarget)}>
            {t.map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} className="stroke-hairline" strokeWidth={1} />
                <text x={PAD.left - 6} y={y(v) + 4} textAnchor="end" className="fill-muted text-[10.5px] tabular">{fmt(v)}</text>
              </g>
            ))}
            {area && series.length === 1 && data.length > 1 && (
              <path
                d={`M${x(0)},${y(0)} ${data.map((d, i) => `L${x(i)},${y(d.values[series[0].key] ?? 0)}`).join(" ")} L${x(data.length - 1)},${y(0)} Z`}
                style={{ fill: slotColor(series[0].slot), opacity: 0.14 }}
              />
            )}
            {series.map((s) => (
              <path
                key={s.key}
                d={data.map((d, i) => `${i ? "L" : "M"}${x(i)},${y(d.values[s.key] ?? 0)}`).join(" ")}
                fill="none"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                style={{ stroke: slotColor(s.slot) }}
              />
            ))}
            {hover !== null && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} className="stroke-strongline" strokeWidth={1} />
                {series.map((s) => (
                  <circle key={s.key} cx={x(hover)} cy={y(data[hover].values[s.key] ?? 0)} r={4.5} strokeWidth={2} className="stroke-surface" style={{ fill: slotColor(s.slot) }} />
                ))}
              </g>
            )}
            {data.map((d, i) =>
              i % every === 0 ? (
                <text key={`${d.x}-${i}`} x={x(i)} y={H - 6} textAnchor="middle" className="fill-muted text-[10.5px]">{axisLabel(d.x)}</text>
              ) : null
            )}
          </svg>
        )}
        {hovered && hover !== null && (
          <Tooltip left={x(hover)} width={width} title={longLabel(hovered.x)}>
            {series.map((s) => (
              <p key={s.key} className="flex items-center gap-1.5 tabular text-muted">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: slotColor(s.slot) }} />
                <span className="flex-1">{s.name}</span>
                <span className="font-semibold text-ink">{fmt(hovered.values[s.key] ?? 0)}{unit && ` ${unit}`}</span>
              </p>
            ))}
          </Tooltip>
        )}
      </div>
    </div>
  );
}

/**
 * Amounts by category as columns (few categories with short names; for many or
 * long names, RankedBars reads better). One color unless `slot` says what
 * each column is; columns sit on the baseline with rounded tops and a 2px gap.
 */
export function ColumnChart({ data, unit = "", height = 210 }: {
  data: { label: string; value: number; slot?: number | null }[];
  unit?: string;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = height;
  const PAD = { top: 8, right: 4, bottom: 22, left: 38 };
  const max = Math.max(0, ...data.map((d) => d.value));
  const t = ticks(max);
  const top = t[t.length - 1];
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const step = data.length ? plotW / data.length : 0;
  const barW = Math.max(1, Math.min(44, step - 2));
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(plotW / 64))));
  const colored = data.filter((d) => d.slot !== undefined);
  const legend = [...new Map(colored.map((d) => [d.slot ?? -1, d])).values()];

  return (
    <div>
      <div ref={ref} className="relative w-full select-none" onMouseLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={H} role="img" aria-label={data.map((d) => `${d.label}: ${fmt(d.value)}`).join(", ")}>
            {t.map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} className="stroke-hairline" strokeWidth={1} />
                <text x={PAD.left - 6} y={y(v) + 4} textAnchor="end" className="fill-muted text-[10.5px] tabular">{fmt(v)}</text>
              </g>
            ))}
            {data.map((d, i) => {
              const bx = PAD.left + i * step + (step - barW) / 2;
              const y0 = y(0);
              const hgt = Math.max(d.value > 0 ? 1 : 0, y0 - y(d.value));
              const r = Math.min(4, barW / 2, hgt);
              const yt = y0 - hgt;
              return (
                <g key={`${d.label}-${i}`} className={cn("transition-opacity", hover !== null && hover !== i && "opacity-35")}>
                  {hgt > 0 && (
                    <path
                      d={`M${bx},${y0} V${yt + r} Q${bx},${yt} ${bx + r},${yt} H${bx + barW - r} Q${bx + barW},${yt} ${bx + barW},${yt + r} V${y0} Z`}
                      style={{ fill: slotColor(d.slot === undefined ? 0 : d.slot) }}
                    />
                  )}
                  <rect x={PAD.left + i * step} y={PAD.top} width={step} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} />
                </g>
              );
            })}
            {data.map((d, i) =>
              i % every === 0 ? (
                <text key={`${d.label}-l${i}`} x={PAD.left + i * step + step / 2} y={H - 6} textAnchor="middle" className="fill-muted text-[10.5px]">
                  {axisLabel(d.label).length > 12 ? `${axisLabel(d.label).slice(0, 11)}…` : axisLabel(d.label)}
                </text>
              ) : null
            )}
          </svg>
        )}
        {hover !== null && data[hover] && (
          <Tooltip left={PAD.left + hover * step + step / 2} width={width} title={longLabel(data[hover].label)}>
            <p className="tabular text-muted"><span className="font-bold text-ink">{fmt(data[hover].value)}</span>{unit && ` ${unit}`}</p>
          </Tooltip>
        )}
      </div>
      {legend.length > 1 && <Legend className="mt-2" items={legend.map((d) => ({ label: d.label, color: slotColor(d.slot ?? null) }))} />}
    </div>
  );
}

/**
 * Parts of a whole, for a handful of parts (up to 6 — fold the rest into an
 * "Other" with slot null). The total sits in the middle; every part is named
 * with its value and share beside the ring, so it never relies on color alone.
 */
export function DonutChart({ data, unit = "", totalLabel = "Total", size = 168 }: {
  data: { label: string; value: number; slot: number | null }[];
  unit?: string;
  totalLabel?: string;
  size?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const parts = data.filter((d) => d.value > 0);
  const total = parts.reduce((s, d) => s + d.value, 0);
  const R = size / 2;
  const stroke = Math.max(14, Math.round(size * 0.16));
  const r = R - stroke / 2;
  const C = 2 * Math.PI * r;
  // A 2px surface gap between segments (none when there's only one).
  const gap = parts.length > 1 ? 2 : 0;
  let acc = 0;
  const shown = hover !== null ? parts[hover] : null;

  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="relative shrink-0" style={{ width: size, height: size }} onMouseLeave={() => setHover(null)}>
        <svg width={size} height={size} role="img" aria-label={parts.map((d) => `${d.label}: ${fmt(d.value)}`).join(", ")} className="-rotate-90">
          <circle cx={R} cy={R} r={r} fill="none" strokeWidth={stroke} className="stroke-subtle" />
          {total > 0 &&
            parts.map((d, i) => {
              const len = (d.value / total) * C;
              const dash = Math.max(0.5, len - gap);
              const el = (
                <circle
                  key={`${d.label}-${i}`}
                  cx={R}
                  cy={R}
                  r={r}
                  fill="none"
                  strokeWidth={stroke}
                  strokeDasharray={`${dash} ${C - dash}`}
                  strokeDashoffset={-acc}
                  style={{ stroke: slotColor(d.slot) }}
                  className={cn("cursor-default transition-opacity", hover !== null && hover !== i && "opacity-35")}
                  onMouseEnter={() => setHover(i)}
                  onClick={() => setHover(i)}
                />
              );
              acc += len;
              return el;
            })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="font-heading text-[22px] font-extrabold leading-none text-ink tabular">{fmt(shown ? shown.value : total)}</span>
          <span className="mt-1 max-w-[70%] truncate text-[11px] text-muted">{shown ? shown.label : totalLabel}</span>
        </div>
      </div>
      <ul className="min-w-[10rem] flex-1 space-y-1.5" aria-label="Legend">
        {parts.map((d, i) => (
          <li key={`${d.label}-${i}`} className={cn("flex items-center gap-2 text-[12.5px]", hover !== null && hover !== i && "opacity-50")} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: slotColor(d.slot) }} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-ink">{d.label}</span>
            <span className="font-semibold tabular text-ink">{fmt(d.value)}{unit && ` ${unit}`}</span>
            <span className="w-10 text-right tabular text-muted">{total ? Math.round((d.value / total) * 100) : 0}%</span>
          </li>
        ))}
        {!parts.length && <li className="text-[13px] text-muted">Nothing to show.</li>}
      </ul>
    </div>
  );
}
