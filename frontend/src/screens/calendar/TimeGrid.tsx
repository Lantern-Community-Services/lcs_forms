import { useEffect, useRef, useState } from "react";
import { Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import { DAY_SHORT, weekdayOf } from "@/lib/recurrence";
import { formatTime, isSpanning, layoutDay, layoutWeek, nyNowMinutes, timeOf, type Segment } from "@/lib/calendar";
import type { CalendarOccurrence } from "@/lib/types";
import { colorOf, type ColorOf } from "./colors";

const HOUR_PX = 48;
const GUTTER = "52px";
/** A click picks a half hour; a drag picks whole half hours. */
const SLOT = 30;
/** All-day lanes shown before the row offers "+n more". */
const ALL_DAY_LANES = 3;

/** Minutes past midnight in New York, kept current. */
function useNowMinutes() {
  const [now, setNow] = useState(nyNowMinutes);
  useEffect(() => {
    const t = window.setInterval(() => setNow(nyNowMinutes()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

/**
 * A week or a day as columns of hours. All-day and multi-day events sit in a
 * row across the top; timed ones are placed at their times, side by side
 * where they overlap. Opens scrolled to the morning (or to now, later in the day).
 */
export function TimeGrid({
  days, today, items, colors, onOpen, onDay, onNewAt,
}: {
  days: string[];
  today: string;
  items: CalendarOccurrence[];
  colors: ColorOf;
  onOpen: (o: CalendarOccurrence) => void;
  /** Open one day on its own (a tap on its heading). */
  onDay?: (day: string) => void;
  /**
   * Start a new event on this day at this time (minutes past midnight; -1 for
   * all day). `end` is set when a time was dragged out, as in Outlook.
   */
  onNewAt?: (day: string, minutes: number, end?: number) => void;
}) {
  const now = useNowMinutes();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const cols = `repeat(${days.length}, minmax(0, 1fr))`;
  const showsToday = days.includes(today);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const hour = showsToday ? Math.max(7, Math.min(Math.floor(now / 60) - 2, 17)) : 7;
    el.scrollTop = hour * HOUR_PX - 8;
    // Only when the days on screen change, not every minute.
  }, [days[0], days.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const segs = layoutWeek(days, items.filter(isSpanning));
  const lanes = segs.reduce((n, s) => Math.max(n, s.lane + 1), 0);
  const limit = expanded ? lanes : ALL_DAY_LANES;
  const perDay = days.map((_, i) => segs.filter((s) => s.start <= i && s.end >= i).length);
  const shown = (s: Segment) => s.lane < limit - 1 || (s.lane === limit - 1 && perDay.slice(s.start, s.end + 1).every((n) => n <= limit));
  const hiddenPerDay = days.map((_, i) => segs.filter((s) => !shown(s) && s.start <= i && s.end >= i).length);
  const timed = items.filter((o) => !isSpanning(o));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Day headings and the all-day row. The same scrollbar gutter as the hours below, so the columns line up. */}
      <div className="flex-none overflow-y-hidden border-b border-hairline [scrollbar-gutter:stable]">
        <div className="grid" style={{ gridTemplateColumns: `${GUTTER} ${cols}` }}>
          <div />
          {days.map((d) => (
            <button
              key={d}
              type="button"
              onClick={onDay ? () => onDay(d) : undefined}
              disabled={!onDay}
              className="flex flex-col items-center gap-0.5 border-l border-hairline py-1.5 disabled:cursor-default"
            >
              <span className={cn("text-micro font-bold uppercase tracking-[0.04em]", d === today ? "text-accent dark:text-white" : "text-muted")}>{DAY_SHORT[weekdayOf(d)]}</span>
              <span className={cn("flex h-8 w-8 items-center justify-center rounded-full text-[17px] font-extrabold tabular", d === today ? "bg-navy text-white dark:bg-white dark:text-navy" : "text-ink")}>
                {+d.slice(8, 10)}
              </span>
            </button>
          ))}
        </div>
        {(segs.length > 0 || onNewAt) && (
          <div className="grid border-t border-hairline" style={{ gridTemplateColumns: `${GUTTER} minmax(0, 1fr)` }}>
            <div className="flex flex-col items-end justify-start gap-1 pr-2 pt-1.5 text-micro font-semibold text-muted">
              All day
              {lanes > ALL_DAY_LANES && (
                <button type="button" onClick={() => setExpanded((e) => !e)} className="font-bold text-accent dark:text-white">
                  {expanded ? "Less" : "More"}
                </button>
              )}
            </div>
            <div className="relative min-h-[26px]">
              <div className="absolute inset-0 grid" style={{ gridTemplateColumns: cols }}>
                {days.map((d) => (
                  <div key={d} className={cn("border-l border-hairline", onNewAt && "cursor-pointer hover:bg-rowhover/60")} onClick={onNewAt ? () => onNewAt(d, -1) : undefined} />
                ))}
              </div>
              <div className="pointer-events-none relative grid gap-y-[2px] px-[3px] py-[3px]" style={{ gridTemplateColumns: cols, gridAutoRows: "20px" }}>
                {segs.filter(shown).map((s) => (
                  <AllDayBar key={s.occ.key} seg={s} colors={colors} onOpen={onOpen} />
                ))}
                {hiddenPerDay.map((n, i) =>
                  n > 0 ? (
                    <button
                      key={`more-${i}`}
                      type="button"
                      onClick={() => setExpanded(true)}
                      style={{ gridColumn: `${i + 1} / span 1`, gridRow: limit }}
                      className="pointer-events-auto mx-[2px] truncate rounded-[4px] px-1.5 text-left text-[11.5px] font-bold text-muted hover:bg-navsel hover:text-ink"
                    >
                      +{n} more
                    </button>
                  ) : null
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto scroll-thin [scrollbar-gutter:stable]">
        <div className="grid" style={{ gridTemplateColumns: `${GUTTER} ${cols}`, height: 24 * HOUR_PX }}>
          <div className="relative">
            {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
              <span key={h} className="absolute right-2 -translate-y-1/2 text-[10.5px] font-semibold tabular text-muted" style={{ top: h * HOUR_PX }}>
                {formatTime(timeOf(h * 60))}
              </span>
            ))}
          </div>
          {days.map((d) => (
            <DayColumn key={d} day={d} items={timed} colors={colors} onOpen={onOpen} onNewAt={onNewAt} nowMinutes={d === today ? now : null} />
          ))}
        </div>
      </div>
    </div>
  );
}

function AllDayBar({ seg, colors, onOpen }: { seg: Segment; colors: ColorOf; onOpen: (o: CalendarOccurrence) => void }) {
  const { occ } = seg;
  const color = colorOf(colors, occ.categoryId);
  return (
    <button
      type="button"
      onClick={() => onOpen(occ)}
      title={occ.pending ? `${occ.title} (needs approval)` : occ.title}
      style={{ gridColumn: `${seg.start + 1} / ${seg.end + 2}`, gridRow: seg.lane + 1, background: color.tint, borderLeftColor: seg.fromBefore ? "transparent" : color.solid }}
      className={cn(
        "pointer-events-auto mx-[2px] flex min-w-0 items-center gap-1 border-l-[3px] px-1.5 text-left text-[12px] font-semibold leading-none text-ink hover:brightness-95",
        seg.fromBefore ? "rounded-l-none" : "rounded-l-[4px]",
        seg.toAfter ? "rounded-r-none" : "rounded-r-[4px]",
        occ.pending && "cal-pending"
      )}
    >
      {!occ.allDay && !seg.fromBefore && <span className="shrink-0 font-bold tabular text-muted">{formatTime(occ.startTime!)}</span>}
      <span className="truncate">{occ.title}</span>
    </button>
  );
}

function DayColumn({
  day, items, colors, onOpen, onNewAt, nowMinutes,
}: {
  day: string;
  items: CalendarOccurrence[];
  colors: ColorOf;
  onOpen: (o: CalendarOccurrence) => void;
  onNewAt?: (day: string, minutes: number, end?: number) => void;
  /** Set on today's column: where the now line goes. */
  nowMinutes: number | null;
}) {
  const placed = layoutDay(day, items);
  // Dragging out a time with a mouse or pen: the half hours covered so far.
  // A finger scrolls instead, so a tap picks one half hour.
  const [sel, setSel] = useState<{ from: number; to: number } | null>(null);
  const drag = useRef<{ id: number; anchor: number; touch: boolean; y: number } | null>(null);
  const slotAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    return Math.max(0, Math.min(24 * 60 - SLOT, Math.floor(((y / HOUR_PX) * 60) / SLOT) * SLOT));
  };
  const span = (anchor: number, at: number) => ({ from: Math.min(anchor, at), to: Math.max(anchor, at) + SLOT });

  // Escape drops a drag in progress.
  const dragging = sel !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      drag.current = null;
      setSel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragging]);

  return (
    <div
      className={cn("relative border-l border-hairline", onNewAt && "cursor-pointer select-none")}
      style={{ backgroundImage: "linear-gradient(to bottom, rgb(var(--c-hairline)) 1px, transparent 1px)", backgroundSize: `100% ${HOUR_PX}px` }}
      onPointerDown={
        onNewAt
          ? (e) => {
              if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
              const at = slotAt(e);
              const touch = e.pointerType === "touch";
              drag.current = { id: e.pointerId, anchor: at, touch, y: e.clientY };
              if (touch) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              setSel({ from: at, to: at + SLOT });
            }
          : undefined
      }
      onPointerMove={(e) => {
        const d = drag.current;
        if (d && d.id === e.pointerId && !d.touch) setSel(span(d.anchor, slotAt(e)));
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        setSel(null);
        if (!d || d.id !== e.pointerId || !onNewAt) return;
        if (d.touch) {
          // A tap, not the start of a scroll.
          if (Math.abs(e.clientY - d.y) < 10) onNewAt(day, d.anchor);
          return;
        }
        const { from, to } = span(d.anchor, slotAt(e));
        // One half hour is a click: the editor's usual hour. More is the time dragged out.
        onNewAt(day, from, to - from > SLOT ? to : undefined);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setSel(null);
      }}
    >
      {sel && (
        <div
          className="pointer-events-none absolute inset-x-[2px] z-20 rounded-[5px] border-2 border-navy bg-navy/15 px-1.5 py-0.5 text-[11.5px] font-bold leading-[15px] text-ink dark:border-white dark:bg-white/15"
          style={{ top: (sel.from / 60) * HOUR_PX + 1, height: ((sel.to - sel.from) / 60) * HOUR_PX - 2 }}
        >
          {formatTime(timeOf(sel.from))} – {formatTime(timeOf(sel.to % (24 * 60)))}
        </div>
      )}
      {placed.map((p) => {
        const color = colorOf(colors, p.occ.categoryId);
        const height = ((p.bottom - p.top) / 60) * HOUR_PX - 2;
        const short = height < 36;
        return (
          <button
            key={p.occ.key}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(p.occ);
            }}
            title={`${p.occ.title}, ${formatTime(p.occ.startTime!)} – ${formatTime(p.occ.endTime!)}${p.occ.pending ? " (needs approval)" : ""}`}
            style={{
              top: (p.top / 60) * HOUR_PX + 1,
              height,
              left: `calc(${(p.col / p.cols) * 100}% + 2px)`,
              width: `calc(${100 / p.cols}% - 4px)`,
              background: `color-mix(in srgb, ${color.solid} 18%, rgb(var(--c-surface)))`,
              borderLeftColor: color.solid,
            }}
            className={cn("absolute overflow-hidden rounded-[5px] border-l-[3px] px-1.5 py-1 text-left text-[12px] leading-[15px] text-ink shadow-card hover:brightness-95", p.occ.pending && "cal-pending")}
          >
            {short ? (
              <span className="block truncate font-semibold">
                {p.occ.title} <span className="font-medium text-muted">{formatTime(p.occ.startTime!)}</span>
              </span>
            ) : (
              <>
                <span className="flex items-center gap-1 font-semibold">
                  <span className="line-clamp-2">{p.occ.title}</span>
                  {p.occ.repeats && <Repeat className="h-3 w-3 shrink-0 opacity-50" aria-label="Repeats" />}
                </span>
                <span className="block truncate text-[11px] font-medium text-muted">
                  {p.occ.pending && "Needs approval · "}
                  {formatTime(p.occ.startTime!)} – {formatTime(p.occ.endTime!)}
                  {p.occ.location ? ` · ${p.occ.location}` : ""}
                </span>
              </>
            )}
          </button>
        );
      })}
      {nowMinutes !== null && (
        <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-status-redDot" style={{ top: (nowMinutes / 60) * HOUR_PX }}>
          <span className="absolute -left-[5px] -top-[6px] h-2.5 w-2.5 rounded-full bg-status-redDot" />
        </div>
      )}
    </div>
  );
}
