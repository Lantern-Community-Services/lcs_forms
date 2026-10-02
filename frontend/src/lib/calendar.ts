import { addDays, dayNumber, daysApart, daysInMonth, DAY_NAMES, MONTH_NAMES, MONTH_SHORT, weekdayOf } from "./recurrence";
import type { CalendarOccurrence } from "./types";

/**
 * The calendar screen's arithmetic: which days a view covers, how events stack
 * in a month row or overlap in a day column, and how times read. Days are
 * "YYYY-MM-DD" in New York, as the API sends them; nothing here converts time
 * zones, because the calendar is New York's.
 */

export type CalendarView = "month" | "week" | "day" | "list";

/** Today in New York, whatever zone this device is set to. */
export function nyToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** Minutes past midnight in New York, now. */
export function nyNowMinutes(): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

const parts = (day: string) => ({ y: +day.slice(0, 4), m: +day.slice(5, 7), d: +day.slice(8, 10) });
const pad = (n: number) => String(n).padStart(2, "0");

export const startOfWeek = (day: string) => addDays(day, -weekdayOf(day));
export const firstOfMonth = (day: string) => `${day.slice(0, 7)}-01`;
export const lastOfMonth = (day: string) => {
  const { y, m } = parts(day);
  return `${day.slice(0, 7)}-${pad(daysInMonth(y, m))}`;
};

/** The whole weeks (Sunday to Saturday) that show the month `day` is in. */
export function monthGrid(day: string): { from: string; to: string; weeks: string[][] } {
  const from = startOfWeek(firstOfMonth(day));
  const to = addDays(startOfWeek(lastOfMonth(day)), 6);
  const weeks: string[][] = [];
  for (let w = from; w <= to; w = addDays(w, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(w, i)));
  return { from, to, weeks };
}

/**
 * What every view reads: the month grid around `day`. The week and the day on
 * screen are always inside it, so moving between them, or a week at a time
 * within the month, needs no new read, and one read a month is what the
 * device keeps for offline (lib/snapshot.ts).
 */
export const fetchRange = (day: string) => {
  const { from, to } = monthGrid(day);
  return { from, to };
};

export function addMonths(day: string, n: number): string {
  const { y, m, d } = parts(day);
  const index = y * 12 + (m - 1) + n;
  const ny = Math.floor(index / 12);
  const nm = (index % 12) + 1;
  return `${ny}-${pad(nm)}-${pad(Math.min(d, daysInMonth(ny, nm)))}`;
}

/** Where the arrows go from `day` in a view. */
export function step(view: CalendarView, day: string, dir: 1 | -1): string {
  if (view === "week") return addDays(day, 7 * dir);
  if (view === "day") return addDays(day, dir);
  return addMonths(day, dir);
}

/** The heading over a view: "October 2026", "Sep 27 – Oct 3, 2026", "Friday, October 2". */
export function viewTitle(view: CalendarView, day: string, today = nyToday()): string {
  const { y, m, d } = parts(day);
  if (view === "month" || view === "list") return `${MONTH_NAMES[m - 1]} ${y}`;
  if (view === "day") return `${DAY_NAMES[weekdayOf(day)]}, ${MONTH_NAMES[m - 1]} ${d}${y !== +today.slice(0, 4) ? `, ${y}` : ""}`;
  const a = startOfWeek(day);
  const b = addDays(a, 6);
  const pa = parts(a);
  const pb = parts(b);
  if (pa.m === pb.m) return `${MONTH_SHORT[pa.m - 1]} ${pa.d} – ${pb.d}, ${pb.y}`;
  return `${MONTH_SHORT[pa.m - 1]} ${pa.d}${pa.y !== pb.y ? `, ${pa.y}` : ""} – ${MONTH_SHORT[pb.m - 1]} ${pb.d}, ${pb.y}`;
}

// ── Reading times and days ───────────────────────────────────────────────

export const minutesOf = (time: string) => +time.slice(0, 2) * 60 + +time.slice(3, 5);
export const timeOf = (minutes: number) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;

/** "9am", "9:30am", "12pm". */
export function formatTime(time: string): string {
  const h = +time.slice(0, 2);
  const min = time.slice(3, 5);
  const h12 = h % 12 || 12;
  return `${h12}${min === "00" ? "" : `:${min}`}${h < 12 ? "am" : "pm"}`;
}

/** "Fri, Oct 2". */
export function shortDay(day: string): string {
  const { m, d } = parts(day);
  return `${DAY_NAMES[weekdayOf(day)].slice(0, 3)}, ${MONTH_SHORT[m - 1]} ${d}`;
}

/** "Friday, October 2, 2026". */
export function longDay(day: string): string {
  const { y, m, d } = parts(day);
  return `${DAY_NAMES[weekdayOf(day)]}, ${MONTH_NAMES[m - 1]} ${d}, ${y}`;
}

/** When an occurrence is, in one line: "Friday, October 2, 2026 · 10am – 11am", "Oct 14 – Oct 16, 2026 · All day". */
export function whenText(o: Pick<CalendarOccurrence, "allDay" | "startDate" | "startTime" | "endDate" | "endTime">): string {
  const sameDay = o.startDate === o.endDate;
  if (o.allDay) return sameDay ? `${longDay(o.startDate)} · All day` : `${shortDay(o.startDate)} – ${shortDay(o.endDate)}, ${o.endDate.slice(0, 4)} · All day`;
  if (sameDay) return `${longDay(o.startDate)} · ${formatTime(o.startTime!)} – ${formatTime(o.endTime!)}`;
  return `${shortDay(o.startDate)}, ${formatTime(o.startTime!)} – ${shortDay(o.endDate)}, ${formatTime(o.endTime!)}`;
}

/** Shown as a bar across days (all day, or running past midnight) rather than at a time in one day. */
export const isSpanning = (o: CalendarOccurrence) => o.allDay || o.startDate !== o.endDate;

// ── Color ────────────────────────────────────────────────────────────────

/** A category's color (the chart palette, index.css --viz-1…8), or gray for none. */
export function categoryColor(slot: number | null | undefined): string {
  return slot === null || slot === undefined || slot < 0 || slot > 7 ? "var(--viz-other)" : `var(--viz-${slot + 1})`;
}

/** The color, faded onto the page for a filled event bar. */
export const tint = (color: string, percent = 16) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

// ── Laying out a week row ────────────────────────────────────────────────

export interface Segment {
  occ: CalendarOccurrence;
  /** The columns (0 = the row's first day) the bar covers. */
  start: number;
  end: number;
  /** It began before this week / carries on after it. */
  fromBefore: boolean;
  toAfter: boolean;
  lane: number;
}

/**
 * The events across a row of days (a week, or one day) as bars, each on the
 * lowest free lane: multi-day ones first so they run straight across, then the
 * rest in time order.
 */
export function layoutWeek(week: string[], items: CalendarOccurrence[]): Segment[] {
  const first = week[0];
  const last = week[week.length - 1];
  const segs = items
    .filter((o) => o.startDate <= last && o.endDate >= first)
    .map((occ) => {
      const s = occ.startDate < first ? first : occ.startDate;
      const e = occ.endDate > last ? last : occ.endDate;
      return { occ, start: daysApart(first, s), end: daysApart(first, e), fromBefore: occ.startDate < first, toAfter: occ.endDate > last, lane: 0 };
    })
    .sort(
      (a, b) =>
        a.start - b.start ||
        b.end - b.start - (a.end - a.start) ||
        Number(isSpanning(b.occ)) - Number(isSpanning(a.occ)) ||
        (a.occ.startTime ?? "").localeCompare(b.occ.startTime ?? "") ||
        a.occ.title.localeCompare(b.occ.title)
    );
  const lanes: number[] = []; // per lane, the last column taken
  for (const seg of segs) {
    let lane = lanes.findIndex((lastCol) => lastCol < seg.start);
    if (lane === -1) lane = lanes.length;
    lanes[lane] = seg.end;
    seg.lane = lane;
  }
  return segs;
}

// ── Laying out a day column ──────────────────────────────────────────────

export interface Placed {
  occ: CalendarOccurrence;
  /** Minutes past midnight this day, clipped to the day. */
  top: number;
  bottom: number;
  /** Side by side with the events it overlaps: which column of how many. */
  col: number;
  cols: number;
}

/** The timed events on `day`, clipped to it, in columns where they overlap. */
export function layoutDay(day: string, items: CalendarOccurrence[]): Placed[] {
  const placed = items
    .filter((o) => !o.allDay && o.startDate <= day && o.endDate >= day)
    .map((occ) => {
      const top = occ.startDate === day ? minutesOf(occ.startTime!) : 0;
      const bottom = occ.endDate === day ? minutesOf(occ.endTime!) : 24 * 60;
      return { occ, top, bottom: Math.max(bottom, top + 15), col: 0, cols: 1 };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  // Groups of events that overlap one another share the width between them.
  let group: Placed[] = [];
  let groupEnd = -1;
  const columnsEnd: number[] = [];
  const close = () => {
    const cols = Math.max(1, ...group.map((p) => p.col + 1));
    for (const p of group) p.cols = cols;
    group = [];
    columnsEnd.length = 0;
  };
  for (const p of placed) {
    if (p.top >= groupEnd) close();
    let col = columnsEnd.findIndex((end) => end <= p.top);
    if (col === -1) col = columnsEnd.length;
    columnsEnd[col] = p.bottom;
    p.col = col;
    group.push(p);
    groupEnd = Math.max(groupEnd, p.bottom);
  }
  close();
  return placed;
}

/** Is `day` within the dates of the month `anchor` is in? */
export const inMonth = (day: string, anchor: string) => day.slice(0, 7) === anchor.slice(0, 7);

/** How far a day is from today, for "Today", "Tomorrow". */
export function relativeDayName(day: string, today = nyToday()): string | null {
  const n = dayNumber(day) - dayNumber(today);
  return n === 0 ? "Today" : n === 1 ? "Tomorrow" : n === -1 ? "Yesterday" : null;
}
