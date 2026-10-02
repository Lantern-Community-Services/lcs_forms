import { CalendarClock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  DAY_NAMES, MONTH_SHORT, NTH_WORDS, describeRule, nextDays, weekdayOf,
  type Freq, type MonthDay, type Nth, type NthOf, type Recurrence, type Weekday,
} from "@/lib/recurrence";
import { shortDay } from "@/lib/calendar";

/** A repeat rule without its end: what the custom pattern edits. */
export type RuleShape = Omit<Recurrence, "end">;

export interface EndDraft {
  kind: "never" | "count" | "until";
  count: number;
  until: string;
}

const UNITS: Record<Freq, [string, string]> = { daily: ["day", "days"], weekly: ["week", "weeks"], monthly: ["month", "months"], yearly: ["year", "years"] };
const LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const NTHS: Nth[] = [1, 2, 3, 4, 5, -2, -1];
const NTH_OFS: { value: string; label: string }[] = [
  ...DAY_NAMES.map((d, i) => ({ value: String(i), label: d })),
  { value: "day", label: "day" },
  { value: "weekday", label: "weekday (Mon–Fri)" },
  { value: "weekend", label: "weekend day" },
];
const parseOf = (v: string): NthOf => (/^\d$/.test(v) ? (Number(v) as Weekday) : (v as NthOf));

/** The defaults a frequency starts with, worded from the start day. */
export function shapeFor(freq: Freq, start: string, interval = 1): RuleShape {
  const d = +start.slice(8, 10);
  const m = +start.slice(5, 7);
  if (freq === "weekly") return { freq, interval, weekdays: [weekdayOf(start)] };
  if (freq === "monthly") return { freq, interval, monthDay: { kind: "day", day: d } };
  if (freq === "yearly") return { freq, interval, months: [m], monthDay: { kind: "day", day: d } };
  return { freq, interval };
}

/**
 * The custom pattern: every N days / weeks / months / years, and for each the
 * choices that make sense — days of the week, a day of the month or "the
 * second Tuesday", which months.
 */
export function CustomRepeat({ value, start, onChange }: { value: RuleShape; start: string; onChange: (next: RuleShape) => void }) {
  const set = (patch: Partial<RuleShape>) => onChange({ ...value, ...patch });
  const [one, many] = UNITS[value.freq];
  return (
    <div className="space-y-3 rounded-input border border-hairline bg-subtle/50 p-3">
      <div className="flex flex-wrap items-center gap-2 text-[13.5px] text-ink">
        <span className="font-semibold">Every</span>
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={99}
          value={value.interval}
          onChange={(e) => set({ interval: Math.max(1, Math.min(99, Math.floor(Number(e.target.value) || 1))) })}
          aria-label="How many"
          className="w-[72px] min-h-[40px] md:min-h-9"
        />
        <div className="w-[130px]">
          <Select
            value={value.freq}
            onChange={(e) => onChange(shapeFor(e.target.value as Freq, start, value.interval))}
            aria-label="Unit"
            className="min-h-[40px] md:min-h-9"
            options={(Object.keys(UNITS) as Freq[]).map((f) => ({ value: f, label: value.interval === 1 ? UNITS[f][0] : UNITS[f][1] }))}
          />
        </div>
        <span className="sr-only">{value.interval === 1 ? one : many}</span>
      </div>

      {(value.freq === "weekly" || value.freq === "daily") && (
        <div>
          <p className="mb-1.5 text-[12px] font-semibold text-muted">{value.freq === "weekly" ? "On" : "Only on these days (leave all off for every day)"}</p>
          <WeekdayToggles
            value={value.weekdays ?? []}
            onChange={(days) => set({ weekdays: value.freq === "weekly" && days.length === 0 ? value.weekdays : days.length ? days : undefined })}
          />
        </div>
      )}

      {value.freq === "yearly" && (
        <div>
          <p className="mb-1.5 text-[12px] font-semibold text-muted">In</p>
          <div className="grid grid-cols-6 gap-1.5">
            {MONTH_SHORT.map((label, i) => {
              const m = i + 1;
              const on = (value.months ?? []).includes(m);
              return (
                <Toggle
                  key={label}
                  on={on}
                  label={label}
                  onClick={() => {
                    const next = on ? (value.months ?? []).filter((x) => x !== m) : [...(value.months ?? []), m];
                    if (next.length) set({ months: next.sort((a, b) => a - b) });
                  }}
                  className="h-9 rounded-input text-[12.5px]"
                />
              );
            })}
          </div>
        </div>
      )}

      {(value.freq === "monthly" || value.freq === "yearly") && (
        <MonthDayFields value={value.monthDay ?? { kind: "day", day: +start.slice(8, 10) }} start={start} onChange={(monthDay) => set({ monthDay })} />
      )}
    </div>
  );
}

function Toggle({ on, label, onClick, className, title }: { on: boolean; label: string; onClick: () => void; className?: string; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={cn(
        "flex items-center justify-center border font-bold transition-colors",
        on ? "border-navy bg-navy text-white dark:border-white dark:bg-white dark:text-navy" : "border-hairline bg-surface text-ink hover:bg-navsel/60",
        className
      )}
    >
      {label}
    </button>
  );
}

export function WeekdayToggles({ value, onChange }: { value: number[]; onChange: (days: Weekday[]) => void }) {
  return (
    <div className="flex gap-1.5">
      {LETTERS.map((letter, i) => {
        const on = value.includes(i);
        return (
          <Toggle
            key={i}
            on={on}
            label={letter}
            title={DAY_NAMES[i]}
            onClick={() => onChange((on ? value.filter((d) => d !== i) : [...value, i]).sort((a, b) => a - b) as Weekday[])}
            className="h-9 w-9 rounded-full text-[13px]"
          />
        );
      })}
    </div>
  );
}

function Radio({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13.5px] text-ink">
      <button type="button" role="radio" aria-checked={on} onClick={onClick} className="flex min-h-[40px] items-center gap-2 md:min-h-9">
        <span className={cn("flex h-4 w-4 items-center justify-center rounded-full border-2", on ? "border-navy dark:border-white" : "border-strongline")}>
          {on && <span className="h-2 w-2 rounded-full bg-navy dark:bg-white" />}
        </span>
      </button>
      {children}
    </div>
  );
}

function MonthDayFields({ value, start, onChange }: { value: MonthDay; start: string; onChange: (next: MonthDay) => void }) {
  // The choice not in use starts from the start day: day 9, or the second Monday.
  const startDay = +start.slice(8, 10);
  const day = value.kind === "day" ? value.day : startDay;
  const nth = value.kind === "nth" ? value.nth : (Math.min(4, Math.ceil(startDay / 7)) as Nth);
  const of = value.kind === "nth" ? value.of : weekdayOf(start);
  return (
    <div role="radiogroup" className="space-y-1">
      <Radio on={value.kind === "day"} onClick={() => onChange({ kind: "day", day })}>
        <span className="font-semibold">On day</span>
        <div className="w-[120px]">
          <Select
            value={String(day)}
            onChange={(e) => onChange({ kind: "day", day: Number(e.target.value) })}
            aria-label="Day of the month"
            className="min-h-[40px] md:min-h-9"
            options={[...Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })), { value: "-1", label: "Last day" }]}
          />
        </div>
      </Radio>
      {value.kind === "day" && value.day > 28 && <p className="pl-6 text-micro text-muted">Months without a day {value.day} are skipped. Choose “Last day” to land on every month's end.</p>}
      <Radio on={value.kind === "nth"} onClick={() => onChange({ kind: "nth", nth, of })}>
        <span className="font-semibold">On the</span>
        <div className="w-[140px]">
          <Select
            value={String(nth)}
            onChange={(e) => onChange({ kind: "nth", nth: Number(e.target.value) as Nth, of })}
            aria-label="Which one"
            className="min-h-[40px] md:min-h-9"
            options={NTHS.map((n) => ({ value: String(n), label: NTH_WORDS[n] }))}
          />
        </div>
        <div className="w-[190px]">
          <Select
            value={String(of)}
            onChange={(e) => onChange({ kind: "nth", nth, of: parseOf(e.target.value) })}
            aria-label="Of what"
            className="min-h-[40px] md:min-h-9"
            options={NTH_OFS}
          />
        </div>
      </Radio>
      {value.kind === "nth" && value.nth === 5 && <p className="pl-6 text-micro text-muted">Months without a fifth one are skipped.</p>}
    </div>
  );
}

/** When the repeating stops: never, on a day, or after a number of times. */
export function EndFields({ value, start, onChange }: { value: EndDraft; start: string; onChange: (next: EndDraft) => void }) {
  return (
    <div role="radiogroup" aria-label="Ends" className="space-y-1">
      <Radio on={value.kind === "never"} onClick={() => onChange({ ...value, kind: "never" })}>
        <span className="font-semibold">Never ends</span>
      </Radio>
      <Radio on={value.kind === "until"} onClick={() => onChange({ ...value, kind: "until" })}>
        <span className="font-semibold">Ends on</span>
        <Input
          type="date"
          min={start}
          value={value.until}
          onChange={(e) => onChange({ ...value, kind: "until", until: e.target.value })}
          aria-label="Last day"
          className="w-[170px] min-h-[40px] md:min-h-9"
        />
      </Radio>
      <Radio on={value.kind === "count"} onClick={() => onChange({ ...value, kind: "count" })}>
        <span className="font-semibold">Ends after</span>
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={999}
          value={value.count}
          onChange={(e) => onChange({ ...value, kind: "count", count: Math.max(1, Math.min(999, Math.floor(Number(e.target.value) || 1))) })}
          aria-label="How many times"
          className="w-[84px] min-h-[40px] md:min-h-9"
        />
        <span className="font-semibold">{value.count === 1 ? "time" : "times"}</span>
      </Radio>
    </div>
  );
}

/** The rule in words and the next few days it lands on, or what's wrong with it. */
export function RepeatSummary({ rule, start, problem }: { rule: Recurrence; start: string; problem: string | null }) {
  const upcoming = problem ? [] : nextDays(start, rule, 6);
  return (
    <div className={cn("rounded-input px-3 py-2.5 text-[13px]", problem ? "bg-status-redBg text-status-redText" : "bg-navsel/50 text-ink")}>
      {problem ? (
        problem
      ) : (
        <>
          <p className="flex items-center gap-1.5 font-semibold">
            <CalendarClock className="h-4 w-4 shrink-0" /> {describeRule(start, rule)}
          </p>
          <p className="mt-1 text-[12.5px] text-muted">
            {upcoming.length === 1 ? "Only on " : "Next: "}
            {upcoming.map((d) => (d.slice(0, 4) === start.slice(0, 4) ? shortDay(d) : `${shortDay(d)}, ${d.slice(0, 4)}`)).join(" · ")}
            {upcoming.length === 6 ? " …" : ""}
          </p>
        </>
      )}
    </div>
  );
}
