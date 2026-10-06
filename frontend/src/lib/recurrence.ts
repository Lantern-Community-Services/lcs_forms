// GENERATED from backend/src/calendar/recurrence.ts by `npm run sync:engine` (backend). Do not edit here.
/**
 * Repeating calendar events: the rule, the days it falls on, and the rule in
 * words.
 *
 * Shared with the browser. frontend/src/lib/recurrence.ts is written from this
 * file by `npm run sync:engine` (backend), so the editor's preview and the
 * server's calendar can't disagree about which days an event is on. That's
 * also why it imports nothing.
 *
 * Everything here is calendar days ("2026-10-02"), never instants. An event at
 * 9:00 is at 9:00 New York time on every one of its days, either side of a
 * clock change; the caller attaches the times.
 */

export type Freq = "daily" | "weekly" | "monthly" | "yearly";
/** 0 = Sunday … 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
/** Which one in the month: the 1st to 5th, or counting back from the end (-1 the last, -2 the second to last). */
export type Nth = 1 | 2 | 3 | 4 | 5 | -1 | -2;
/** What "the first …" counts: one day of the week, any day, a weekday (Monday to Friday) or a weekend day. */
export type NthOf = Weekday | "day" | "weekday" | "weekend";

/** Monthly and yearly: which day in the month. */
export type MonthDay =
  /** Day 1–31 (a month without that day is skipped), or -1 for the month's last day. */
  | { kind: "day"; day: number }
  /** "The second Tuesday", "the last weekday". A month without one (a fifth Monday) is skipped. */
  | { kind: "nth"; nth: Nth; of: NthOf };

export type RecurrenceEnd =
  | { kind: "never" }
  /** After this many occurrences. Ones cancelled later still count, so the end doesn't move. */
  | { kind: "count"; count: number }
  /** Nothing after this day. */
  | { kind: "until"; date: string };

export interface Recurrence {
  freq: Freq;
  /** Every 1st, 2nd, 3rd … day, week, month or year. */
  interval: number;
  /** Weekly: the days of the week it's on (default: the start's). Daily: only on these days. */
  weekdays?: Weekday[];
  /** Monthly and yearly: which day of the month (default: the start's date). */
  monthDay?: MonthDay;
  /** Yearly: the months it's in, 1–12 (default: the start's month). */
  months?: number[];
  end: RecurrenceEnd;
}

export const MAX_INTERVAL = 99;
export const MAX_COUNT = 999;

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
export const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
export const NTH_WORDS: Record<Nth, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", [-1]: "last", [-2]: "second-to-last" };

// ── Days ─────────────────────────────────────────────────────────────────
// A day is "YYYY-MM-DD". Arithmetic is on day numbers (days since 1970-01-01),
// which have no time of day and so no time zone.

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;
/** Day numbers past year 9999 don't print as YYYY-MM-DD; nothing repeats beyond it. */
const LAST_DAY_NUMBER = 2_932_896; // 9999-12-31

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** A real calendar day, written YYYY-MM-DD. */
export function isDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DAY_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  return y >= 1970 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

/** Days since 1970-01-01. */
export function dayNumber(day: string): number {
  return Math.round(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / MS_PER_DAY);
}

export function dayString(n: number): string {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

export const addDays = (day: string, n: number) => dayString(dayNumber(day) + n);
export const daysApart = (from: string, to: string) => dayNumber(to) - dayNumber(from);

const weekdayOfNumber = (n: number) => ((((n + 4) % 7) + 7) % 7) as Weekday; // 1970-01-01 was a Thursday
export const weekdayOf = (day: string) => weekdayOfNumber(dayNumber(day));

const ymd = (y: number, m: number, d: number) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const partsOf = (day: string) => ({ y: +day.slice(0, 4), m: +day.slice(5, 7), d: +day.slice(8, 10) });

/** "Oct 2, 2026". */
export function formatDay(day: string): string {
  const { y, m, d } = partsOf(day);
  return `${MONTH_SHORT[m - 1]} ${d}, ${y}`;
}

// ── Which day in a month ─────────────────────────────────────────────────

function fits(weekday: number, of: NthOf): boolean {
  if (typeof of === "number") return weekday === of;
  if (of === "day") return true;
  if (of === "weekday") return weekday >= 1 && weekday <= 5;
  return weekday === 0 || weekday === 6;
}

/** The day of the month `md` picks in month `m` of year `y`, or null when that month has none. */
function resolveMonthDay(y: number, m: number, md: MonthDay): number | null {
  const dim = daysInMonth(y, m);
  if (md.kind === "day") {
    if (md.day === -1) return dim;
    return md.day >= 1 && md.day <= dim ? md.day : null;
  }
  const first = weekdayOfNumber(dayNumber(ymd(y, m, 1)));
  const hits: number[] = [];
  for (let d = 1; d <= dim; d++) if (fits((first + d - 1) % 7, md.of)) hits.push(d);
  return hits[md.nth > 0 ? md.nth - 1 : hits.length + md.nth] ?? null;
}

// ── The rule, with its defaults filled in ────────────────────────────────

const uniqueSorted = <T extends number>(values: T[]) => [...new Set(values)].sort((a, b) => a - b);

/**
 * The rule as it's stored: the defaults a start date implies written out, so a
 * weekly rule names its days and a later change to the start can't quietly
 * change which days it means. Fields the frequency doesn't use are dropped.
 */
export function canonicalRule(start: string, rule: Recurrence): Recurrence {
  const { m, d } = partsOf(start);
  const out: Recurrence = { freq: rule.freq, interval: Math.max(1, Math.floor(rule.interval || 1)), end: rule.end };
  if (rule.freq === "daily" && rule.weekdays?.length && uniqueSorted(rule.weekdays).length < 7) out.weekdays = uniqueSorted(rule.weekdays);
  if (rule.freq === "weekly") out.weekdays = rule.weekdays?.length ? uniqueSorted(rule.weekdays) : [weekdayOf(start)];
  if (rule.freq === "monthly" || rule.freq === "yearly") {
    const md = rule.monthDay ?? { kind: "day", day: d };
    out.monthDay = md.kind === "day" ? { kind: "day", day: md.day } : { kind: "nth", nth: md.nth, of: md.of };
  }
  if (rule.freq === "yearly") out.months = rule.months?.length ? uniqueSorted(rule.months) : [m];
  out.end = rule.end.kind === "count" ? { kind: "count", count: Math.floor(rule.end.count) } : rule.end.kind === "until" ? { kind: "until", date: rule.end.date } : { kind: "never" };
  return out;
}

/**
 * Every day the series falls on, in order, from its start, as day numbers.
 * Stops at `stopAfter` as well as at the rule's own end. `skipTo` lets a rule
 * with no count start near there instead of walking from the start; one with a
 * count has to walk, to know where the count runs out.
 */
function* walk(start: string, input: Recurrence, stopAfter: number, skipTo?: number): Generator<number> {
  const rule = canonicalRule(start, input);
  const s = dayNumber(start);
  const { y: y0, m: m0 } = partsOf(start);
  const until = Math.min(rule.end.kind === "until" ? dayNumber(rule.end.date) : Infinity, stopAfter, LAST_DAY_NUMBER);
  const count = rule.end.kind === "count" ? rule.end.count : Infinity;
  const skip = count === Infinity && skipTo !== undefined && skipTo > s ? skipTo : null;
  const n = rule.interval;
  const weekStart = s - weekdayOfNumber(s); // weeks run Sunday to Saturday
  const startMonth = y0 * 12 + (m0 - 1);
  const only = rule.freq === "daily" && rule.weekdays ? new Set<number>(rule.weekdays) : null;

  let k = 0;
  if (skip !== null) {
    const { y: sy, m: sm } = partsOf(dayString(skip));
    if (rule.freq === "daily") k = Math.floor((skip - s) / n);
    if (rule.freq === "weekly") k = Math.floor((skip - weekStart) / (7 * n));
    if (rule.freq === "monthly") k = Math.floor((sy * 12 + sm - 1 - startMonth) / n);
    if (rule.freq === "yearly") k = Math.floor((sy - y0) / n);
    k = Math.max(0, k);
  }

  let found = 0;
  // A rule that never lands (day 30 of February, every year) ends with the
  // calendar rather than spinning: the base of a period only ever moves on.
  for (; ; k++) {
    let base: number;
    let candidates: number[];
    if (rule.freq === "daily") {
      base = s + k * n;
      candidates = !only || only.has(weekdayOfNumber(base)) ? [base] : [];
    } else if (rule.freq === "weekly") {
      base = weekStart + k * 7 * n;
      candidates = rule.weekdays!.map((w) => base + w);
    } else if (rule.freq === "monthly") {
      const mi = startMonth + k * n;
      const y = Math.floor(mi / 12);
      const m = (mi % 12) + 1;
      if (y > 9999) return;
      base = dayNumber(ymd(y, m, 1));
      const d = resolveMonthDay(y, m, rule.monthDay!);
      candidates = d === null ? [] : [base + d - 1];
    } else {
      const y = y0 + k * n;
      if (y > 9999) return;
      base = dayNumber(ymd(y, 1, 1));
      candidates = [];
      for (const m of rule.months!) {
        const d = resolveMonthDay(y, m, rule.monthDay!);
        if (d !== null) candidates.push(dayNumber(ymd(y, m, d)));
      }
    }
    if (base > until) return;
    for (const c of candidates) {
      if (c < s) continue;
      if (c > until) return;
      yield c;
      if (++found >= count) return;
    }
  }
}

// ── Asking about a series ────────────────────────────────────────────────

/** The days a series falls on from `from` to `to`, inclusive. With no rule it's a one-off on its start. */
export function daysBetween(start: string, rule: Recurrence | null, from: string, to: string): string[] {
  if (!rule) return start >= from && start <= to ? [start] : [];
  const f = dayNumber(from);
  const out: string[] = [];
  for (const n of walk(start, rule, dayNumber(to), f)) if (n >= f) out.push(dayString(n));
  return out;
}

/** The first `count` days a series falls on, on or after `from` (default: its start). */
export function nextDays(start: string, rule: Recurrence | null, count: number, from = start): string[] {
  if (!rule) return start >= from ? [start] : [];
  const f = dayNumber(from);
  const out: string[] = [];
  for (const n of walk(start, rule, LAST_DAY_NUMBER, f)) {
    if (n < f) continue;
    out.push(dayString(n));
    if (out.length >= count) break;
  }
  return out;
}

/** The series' first day (its start, or the first day after it the rule picks), or null when it never happens. */
export function firstDay(start: string, rule: Recurrence | null): string | null {
  return nextDays(start, rule, 1)[0] ?? null;
}

/** The series' last day, or null when it repeats forever. */
export function lastDay(start: string, rule: Recurrence | null): string | null {
  if (!rule) return start;
  if (rule.end.kind === "never") return null;
  let last: number | null = null;
  for (const n of walk(start, rule, LAST_DAY_NUMBER)) last = n;
  return last === null ? start : dayString(last);
}

/** Does the series fall on this day? */
export function isOccurrence(start: string, rule: Recurrence | null, day: string): boolean {
  return daysBetween(start, rule, day, day).length === 1;
}

/** How many times the series happens before `day`. */
export function countBefore(start: string, rule: Recurrence, day: string): number {
  let n = 0;
  for (const _ of walk(start, rule, dayNumber(day) - 1)) n++;
  return n;
}

/** What's wrong with a rule for a series starting on `start`, in words, or null when nothing is. */
export function ruleProblem(start: string, rule: Recurrence): string | null {
  const units = { daily: "days", weekly: "weeks", monthly: "months", yearly: "years" }[rule.freq];
  if (!units) return "Choose how often it repeats.";
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > MAX_INTERVAL) return `Repeat every 1 to ${MAX_INTERVAL} ${units}.`;
  if (rule.weekdays?.some((w) => !Number.isInteger(w) || w < 0 || w > 6)) return "Choose days of the week.";
  if (rule.months?.some((m) => !Number.isInteger(m) || m < 1 || m > 12)) return "Choose months.";
  const md = rule.monthDay;
  if (md?.kind === "day" && !(Number.isInteger(md.day) && ((md.day >= 1 && md.day <= 31) || md.day === -1))) return "Choose a day of the month from 1 to 31.";
  if (md?.kind === "nth" && ![1, 2, 3, 4, 5, -1, -2].includes(md.nth)) return "Choose first, second, third, fourth, fifth or last.";
  if (rule.end.kind === "count" && !(Number.isInteger(rule.end.count) && rule.end.count >= 1 && rule.end.count <= MAX_COUNT)) return `End after 1 to ${MAX_COUNT} times.`;
  if (rule.end.kind === "until" && !isDay(rule.end.date)) return "Choose the day it ends.";
  if (rule.end.kind === "until" && rule.end.date < start) return "It can't stop repeating before it starts.";
  if (firstDay(start, rule) === null) return "That pattern never happens. Check the day and the months.";
  return null;
}

// ── In words ─────────────────────────────────────────────────────────────

/** "a", "a and b", "a, b and c". */
export function listWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function weekdaysWords(days: number[]): string {
  const set = uniqueSorted(days);
  if (set.length === 7) return "every day";
  if (set.join() === "1,2,3,4,5") return "weekdays";
  if (set.join() === "0,6") return "weekends";
  return listWords(set.map((d) => DAY_NAMES[d]));
}

function nthOfWords(of: NthOf): string {
  if (typeof of === "number") return DAY_NAMES[of];
  return of === "day" ? "day" : of === "weekday" ? "weekday" : "weekend day";
}

export function monthDayWords(md: MonthDay): string {
  if (md.kind === "day") return md.day === -1 ? "the last day" : `day ${md.day}`;
  return `the ${NTH_WORDS[md.nth]} ${nthOfWords(md.of)}`;
}

/** "Every 2 weeks on Monday and Wednesday, until Dec 31, 2026". */
export function describeRule(start: string, input: Recurrence): string {
  const rule = canonicalRule(start, input);
  const n = rule.interval;
  const every = (one: string, many: string) => (n === 1 ? `Every ${one}` : `Every ${n} ${many}`);
  let text: string;
  if (rule.freq === "daily") {
    const only = rule.weekdays;
    if (!only) text = every("day", "days");
    else if (n === 1) text = only.join() === "1,2,3,4,5" ? "Every weekday" : `Every ${listWords(only.map((d) => DAY_NAMES[d]))}`;
    else text = `${every("day", "days")}, on ${weekdaysWords(only)} only`;
  } else if (rule.freq === "weekly") {
    text = `${every("week", "weeks")} on ${weekdaysWords(rule.weekdays!)}`;
  } else if (rule.freq === "monthly") {
    text = `${every("month", "months")} on ${monthDayWords(rule.monthDay!)}`;
  } else {
    const md = rule.monthDay!;
    const months = rule.months!.map((m) => MONTH_NAMES[m - 1]);
    if (md.kind === "day" && md.day !== -1 && months.length === 1) text = `${every("year", "years")} on ${months[0]} ${md.day}`;
    else text = `${every("year", "years")} on ${monthDayWords(md)} of ${listWords(months)}`;
  }
  if (rule.end.kind === "count") text += rule.end.count === 1 ? ", once" : `, ${rule.end.count} times`;
  if (rule.end.kind === "until") text += `, until ${formatDay(rule.end.date)}`;
  return text;
}

// ── The editor's quick choices ───────────────────────────────────────────

export interface RepeatPreset {
  key: string;
  label: string;
  /** Without an end: the editor asks for that separately. Null = does not repeat. */
  rule: Recurrence | null;
}

/** The usual ways to repeat an event starting on `start`, worded for that day. */
export function repeatPresets(start: string): RepeatPreset[] {
  const wd = weekdayOf(start);
  const { y, m, d } = partsOf(start);
  const dim = daysInMonth(y, m);
  const nth = Math.ceil(d / 7) as Nth;
  const never: RecurrenceEnd = { kind: "never" };
  const day = DAY_NAMES[wd];
  const out: RepeatPreset[] = [
    { key: "none", label: "Does not repeat", rule: null },
    { key: "daily", label: "Every day", rule: { freq: "daily", interval: 1, end: never } },
    { key: "weekdays", label: "Every weekday (Monday to Friday)", rule: { freq: "daily", interval: 1, weekdays: [1, 2, 3, 4, 5], end: never } },
    { key: "weekly", label: `Every week on ${day}`, rule: { freq: "weekly", interval: 1, weekdays: [wd], end: never } },
    { key: "biweekly", label: `Every 2 weeks on ${day}`, rule: { freq: "weekly", interval: 2, weekdays: [wd], end: never } },
    { key: "monthlyDay", label: `Every month on day ${d}`, rule: { freq: "monthly", interval: 1, monthDay: { kind: "day", day: d }, end: never } },
  ];
  if (nth <= 4) out.push({ key: "monthlyNth", label: `Every month on the ${NTH_WORDS[nth]} ${day}`, rule: { freq: "monthly", interval: 1, monthDay: { kind: "nth", nth, of: wd }, end: never } });
  if (d + 7 > dim) out.push({ key: "monthlyLast", label: `Every month on the last ${day}`, rule: { freq: "monthly", interval: 1, monthDay: { kind: "nth", nth: -1, of: wd }, end: never } });
  if (d === dim) out.push({ key: "monthlyLastDay", label: "Every month on the last day", rule: { freq: "monthly", interval: 1, monthDay: { kind: "day", day: -1 }, end: never } });
  out.push({ key: "yearly", label: `Every year on ${MONTH_NAMES[m - 1]} ${d}`, rule: { freq: "yearly", interval: 1, months: [m], monthDay: { kind: "day", day: d }, end: never } });
  return out;
}

/** Which quick choice a rule is (its end aside), or "custom". */
export function presetKeyFor(start: string, rule: Recurrence | null): string {
  if (!rule) return "none";
  const shape = (r: Recurrence) => JSON.stringify({ ...canonicalRule(start, r), end: null });
  const want = shape(rule);
  return repeatPresets(start).find((p) => p.rule && shape(p.rule) === want)?.key ?? "custom";
}

// ── Outlook ──────────────────────────────────────────────────────────────

const GRAPH_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const GRAPH_INDEX: Partial<Record<Nth, string>> = { 1: "first", 2: "second", 3: "third", 4: "fourth", [-1]: "last" };

/** Microsoft Graph's patternedRecurrence, as it's sent to Outlook. */
export interface GraphRecurrence {
  pattern: {
    type: "daily" | "weekly" | "absoluteMonthly" | "relativeMonthly" | "absoluteYearly" | "relativeYearly";
    interval: number;
    daysOfWeek?: string[];
    firstDayOfWeek?: string;
    dayOfMonth?: number;
    month?: number;
    index?: string;
  };
  range: { type: "noEnd" | "endDate" | "numbered"; startDate: string; endDate?: string; numberOfOccurrences?: number; recurrenceTimeZone: string };
}

function graphDaysFor(of: NthOf): string[] {
  if (typeof of === "number") return [GRAPH_DAYS[of]];
  if (of === "day") return [...GRAPH_DAYS];
  if (of === "weekday") return GRAPH_DAYS.slice(1, 6);
  return ["saturday", "sunday"];
}

/**
 * The rule as Outlook's recurrence, or why Outlook can't repeat it that way.
 * Outlook has no "fifth" or "second-to-last", repeats a yearly event in one
 * month only, and can't limit "every 3 days" to some weekdays. Days 29–31 are
 * refused too: in a month without the day, Outlook and this calendar may not
 * agree on where the meeting goes, and invites must match the calendar.
 */
export function toGraphRecurrence(start: string, input: Recurrence): { ok: true; value: GraphRecurrence } | { ok: false; reason: string } {
  const rule = canonicalRule(start, input);
  const n = rule.interval;
  const no = (reason: string) => ({ ok: false as const, reason });
  let pattern: GraphRecurrence["pattern"];
  const monthDayPattern = (md: MonthDay, month: number | undefined, maxDay: number) => {
    if (md.kind === "day") {
      if (md.day === -1) return { type: month ? "relativeYearly" : "relativeMonthly", interval: n, daysOfWeek: [...GRAPH_DAYS], index: "last", ...(month ? { month } : {}) } as GraphRecurrence["pattern"];
      if (md.day > maxDay) return null;
      return { type: month ? "absoluteYearly" : "absoluteMonthly", interval: n, dayOfMonth: md.day, ...(month ? { month } : {}) } as GraphRecurrence["pattern"];
    }
    const index = GRAPH_INDEX[md.nth];
    if (!index) return undefined;
    return { type: month ? "relativeYearly" : "relativeMonthly", interval: n, daysOfWeek: graphDaysFor(md.of), index, ...(month ? { month } : {}) } as GraphRecurrence["pattern"];
  };

  if (rule.freq === "daily") {
    if (!rule.weekdays) pattern = { type: "daily", interval: n };
    else if (n === 1) pattern = { type: "weekly", interval: 1, daysOfWeek: rule.weekdays.map((d) => GRAPH_DAYS[d]), firstDayOfWeek: "sunday" };
    else return no("Outlook can't repeat every few days on some weekdays only.");
  } else if (rule.freq === "weekly") {
    pattern = { type: "weekly", interval: n, daysOfWeek: rule.weekdays!.map((d) => GRAPH_DAYS[d]), firstDayOfWeek: "sunday" };
  } else if (rule.freq === "monthly") {
    const p = monthDayPattern(rule.monthDay!, undefined, 28);
    if (p === null) return no("Outlook handles days 29–31 differently in short months. Choose “Last day”, or a day up to 28.");
    if (p === undefined) return no("Outlook has no “fifth” or “second-to-last”.");
    pattern = p;
  } else {
    if (rule.months!.length !== 1) return no("Outlook repeats a yearly event in one month only.");
    const month = rule.months![0];
    const p = monthDayPattern(rule.monthDay!, month, month === 2 ? 28 : daysInMonth(2001, month));
    if (p === null) return no("Outlook can't repeat on February 29.");
    if (p === undefined) return no("Outlook has no “fifth” or “second-to-last”.");
    pattern = p;
  }

  const tz = "Eastern Standard Time";
  const range: GraphRecurrence["range"] =
    rule.end.kind === "count"
      ? { type: "numbered", startDate: start, numberOfOccurrences: rule.end.count, recurrenceTimeZone: tz }
      : rule.end.kind === "until"
        ? { type: "endDate", startDate: start, endDate: rule.end.date, recurrenceTimeZone: tz }
        : { type: "noEnd", startDate: start, recurrenceTimeZone: tz };
  return { ok: true, value: { pattern, range } };
}
