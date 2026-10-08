import { useEffect, useRef, useState } from "react";
import { Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import { DAY_SHORT } from "@/lib/recurrence";
import { formatTime, inMonth, isSpanning, layoutWeek, longDay, monthGrid, type Segment } from "@/lib/calendar";
import type { CalendarOccurrence } from "@/lib/types";
import { AgendaDay } from "./AgendaList";
import { colorOf, type ColorOf } from "./colors";

/** One lane of event bars in a month row, plus the gap under it. */
const LANE_PX = 22;
/** The day number at the top of a cell. */
const HEAD_PX = 28;

/**
 * A month as a grid of weeks. Multi-day and all-day events run across the days
 * as bars; timed ones are a dot, a time and a title. The rows share the height
 * there is, and as many lanes show as fit; the rest of a day is "+2 more",
 * which opens that day.
 */
export function MonthGrid({
  anchor, today, items, colors, onOpen, onDay, onNew,
}: {
  anchor: string;
  today: string;
  items: CalendarOccurrence[];
  colors: ColorOf;
  onOpen: (o: CalendarOccurrence) => void;
  /** Show this day on its own (the "+2 more"). */
  onDay: (day: string) => void;
  /** Admins: start a new event on this day (a tap on its empty space). */
  onNew?: (day: string) => void;
}) {
  const { weeks } = monthGrid(anchor);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [rowHeight, setRowHeight] = useState(120);
  useEffect(() => {
    const el = rowsRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const read = () => {
      const first = el.firstElementChild as HTMLElement | null;
      if (first) setRowHeight(first.offsetHeight);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [weeks.length]);
  const lanes = Math.max(1, Math.floor((rowHeight - HEAD_PX - 4) / LANE_PX));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid flex-none grid-cols-7 border-b border-hairline">
        {DAY_SHORT.map((d) => (
          <div key={d} className="px-2 py-1.5 text-micro font-bold uppercase tracking-[0.04em] text-muted">{d}</div>
        ))}
      </div>
      <div
        ref={rowsRef}
        className="grid min-h-0 flex-1 overflow-y-auto scroll-thin"
        style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(104px, 1fr))` }}
      >
        {weeks.map((week) => (
          <WeekRow key={week[0]} week={week} anchor={anchor} today={today} items={items} lanes={lanes} colors={colors} onOpen={onOpen} onDay={onDay} onNew={onNew} />
        ))}
      </div>
    </div>
  );
}

function WeekRow({
  week, anchor, today, items, lanes, colors, onOpen, onDay, onNew,
}: {
  week: string[];
  anchor: string;
  today: string;
  items: CalendarOccurrence[];
  lanes: number;
  colors: ColorOf;
  onOpen: (o: CalendarOccurrence) => void;
  onDay: (day: string) => void;
  onNew?: (day: string) => void;
}) {
  const segs = layoutWeek(week, items);
  // How many bars cover each day. The last lane is shown only where no day it
  // covers has more than fits; otherwise that slot says "+n more".
  const perDay = week.map((_, i) => segs.filter((s) => s.start <= i && s.end >= i).length);
  const shown = (s: Segment) => s.lane < lanes - 1 || (s.lane === lanes - 1 && perDay.slice(s.start, s.end + 1).every((n) => n <= lanes));
  const hiddenPerDay = week.map((_, i) => segs.filter((s) => !shown(s) && s.start <= i && s.end >= i).length);

  return (
    <div className="relative grid grid-cols-7 border-b border-hairline last:border-b-0">
      {week.map((day, i) => {
        const out = !inMonth(day, anchor);
        return (
          <div
            key={day}
            onClick={onNew ? () => onNew(day) : undefined}
            className={cn("min-w-0 border-r border-hairline last:border-r-0", out && "bg-subtle/60 dark:bg-transparent", onNew && "cursor-pointer hover:bg-rowhover/60")}
          >
            <div className="flex h-[28px] items-center px-1.5">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDay(day);
                }}
                aria-label={`Show ${longDay(day)}`}
                className={cn(
                  "flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[12.5px] font-bold tabular hover:bg-navsel",
                  day === today ? "bg-navy text-white hover:bg-navy dark:bg-white dark:text-navy" : out ? "text-muted" : "text-ink"
                )}
              >
                {+day.slice(8, 10) === 1 ? `${monthShort(day)} 1` : +day.slice(8, 10)}
              </button>
            </div>
          </div>
        );
      })}
      <div
        className="pointer-events-none absolute inset-x-0 grid grid-cols-7 gap-y-[2px] px-[3px]"
        style={{ top: HEAD_PX, gridAutoRows: `${LANE_PX - 2}px` }}
      >
        {segs.filter(shown).map((s) => (
          <MonthBar key={s.occ.key} seg={s} colors={colors} onOpen={onOpen} />
        ))}
        {hiddenPerDay.map((n, i) =>
          n > 0 ? (
            <button
              key={`more-${i}`}
              type="button"
              onClick={() => onDay(week[i])}
              style={{ gridColumn: `${i + 1} / span 1`, gridRow: lanes }}
              className="pointer-events-auto mx-[2px] truncate rounded-[4px] px-1.5 text-left text-[11.5px] font-bold text-muted hover:bg-navsel hover:text-ink"
            >
              +{n} more
            </button>
          ) : null
        )}
      </div>
    </div>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthShort = (day: string) => MONTHS[+day.slice(5, 7) - 1];

function MonthBar({ seg, colors, onOpen }: { seg: Segment; colors: ColorOf; onOpen: (o: CalendarOccurrence) => void }) {
  const { occ } = seg;
  const color = colorOf(colors, occ.categoryId);
  const place = { gridColumn: `${seg.start + 1} / ${seg.end + 2}`, gridRow: seg.lane + 1 };
  const label = `${occ.title}${occ.allDay ? "" : `, ${formatTime(occ.startTime!)}`}${occ.pending ? " (needs approval)" : ""}`;
  if (isSpanning(occ)) {
    return (
      <button
        type="button"
        onClick={() => onOpen(occ)}
        title={label}
        style={{ ...place, background: color.tint, borderLeftColor: seg.fromBefore ? "transparent" : color.solid }}
        className={cn(
          "pointer-events-auto mx-[2px] flex min-w-0 items-center gap-1 border-l-[3px] px-1.5 text-left text-[12px] font-semibold leading-none text-ink hover:brightness-95",
          seg.fromBefore ? "rounded-l-none" : "rounded-l-[4px]",
          seg.toAfter ? "rounded-r-none" : "rounded-r-[4px]",
          occ.pending && "cal-pending"
        )}
      >
        {!occ.allDay && !seg.fromBefore && <span className="shrink-0 font-bold tabular text-muted">{formatTime(occ.startTime!)}</span>}
        <span className="truncate">{occ.title}</span>
        {occ.repeats && <Repeat className="h-3 w-3 shrink-0 opacity-50" aria-label="Repeats" />}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(occ)}
      title={label}
      style={place}
      className={cn("pointer-events-auto mx-[2px] flex min-w-0 items-center gap-1.5 rounded-[4px] px-1.5 text-left text-[12px] leading-none text-ink hover:bg-navsel", occ.pending && "opacity-80")}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={occ.pending ? { boxShadow: `inset 0 0 0 1.5px ${color.solid}` } : { background: color.solid }} />
      <span className="shrink-0 font-semibold tabular text-muted">{formatTime(occ.startTime!)}</span>
      <span className="truncate font-semibold">{occ.title}</span>
    </button>
  );
}

// ── Phone ────────────────────────────────────────────────────────────────

/**
 * The phone's month: day numbers with a dot per event (up to three), the
 * chosen day's events underneath. Swiping the grid sideways changes month.
 */
export function MonthCompact({
  anchor, today, items, colors, onOpen, onPick, onSwipe, onNew,
}: {
  anchor: string;
  today: string;
  items: CalendarOccurrence[];
  colors: ColorOf;
  onOpen: (o: CalendarOccurrence) => void;
  onPick: (day: string) => void;
  onSwipe: (dir: 1 | -1) => void;
  onNew?: (day: string) => void;
}) {
  const { weeks } = monthGrid(anchor);
  const start = useRef<{ x: number; y: number } | null>(null);
  const onDayItems = (day: string) => items.filter((o) => o.startDate <= day && o.endDate >= day);

  return (
    <div className="flex min-h-full flex-col">
      <div
        data-no-pull
        className="flex-none touch-pan-y border-b border-hairline px-2 pb-2"
        onPointerDown={(e) => {
          start.current = e.pointerType === "touch" ? { x: e.clientX, y: e.clientY } : null;
        }}
        onPointerUp={(e) => {
          const s = start.current;
          start.current = null;
          if (!s) return;
          const dx = e.clientX - s.x;
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(e.clientY - s.y) * 1.5) onSwipe(dx < 0 ? 1 : -1);
        }}
      >
        <div className="grid grid-cols-7">
          {DAY_SHORT.map((d) => (
            <div key={d} className="py-1.5 text-center text-[10.5px] font-bold uppercase text-muted">{d.slice(0, 1)}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-y-0.5">
          {weeks.flat().map((day) => {
            const dayItems = onDayItems(day);
            const picked = day === anchor;
            const out = !inMonth(day, anchor);
            return (
              <button
                key={day}
                type="button"
                onClick={() => onPick(day)}
                aria-label={`${longDay(day)}, ${dayItems.length} ${dayItems.length === 1 ? "event" : "events"}`}
                aria-pressed={picked}
                className="flex h-[50px] flex-col items-center justify-start gap-1 rounded-[12px] pt-1.5"
              >
                <span
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-full text-[14px] font-bold tabular",
                    picked ? "bg-navy text-white dark:bg-white dark:text-navy" : day === today ? "text-accent ring-2 ring-navy/40 dark:text-white dark:ring-white/50" : out ? "text-muted/70" : "text-ink"
                  )}
                >
                  {+day.slice(8, 10)}
                </span>
                <span className="flex h-1.5 gap-[3px]">
                  {dayItems.slice(0, 3).map((o) => (
                    <span key={o.key} className="h-1.5 w-1.5 rounded-full" style={o.pending ? { boxShadow: `inset 0 0 0 1px ${colorOf(colors, o.categoryId).solid}` } : { background: colorOf(colors, o.categoryId).solid }} />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex-1 px-4 pb-6 pt-3">
        <AgendaDay day={anchor} today={today} items={onDayItems(anchor)} colors={colors} onOpen={onOpen} onNew={onNew} showEmpty />
      </div>
    </div>
  );
}
