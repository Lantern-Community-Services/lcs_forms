/**
 * @lcs/ui's day and time pickers, and labelled detail rows: one look for every
 * code form, instead of each form keeping its own copy (Event Requests and the
 * incident reports had three between them).
 *
 * DatePicker and TimePicker are buttons that look like the other inputs and
 * open a calendar or a list of times: a popover on iPad and desktop, a sheet
 * from the bottom on a phone. Values are plain text, "YYYY-MM-DD" and "HH:MM"
 * (New York wall-clock, as everywhere in the app), and nothing is filled in
 * until someone picks.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Clock, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Sheet as SheetRoot, SheetBody, SheetContent, SheetHeader } from "@/components/ui/sheet";
import { useApp } from "./sdk";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEK = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

const weekdayOf = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** "Thu, Oct 8, 2026" */
const dayText = (day: string, year = true) => {
  const [y, m, d] = day.split("-").map(Number);
  return `${WEEKDAYS_SHORT[weekdayOf(day)]}, ${MONTHS[m - 1]} ${d}${year ? `, ${y}` : ""}`;
};
/** "9:30am", "2pm" */
const timeText = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
};

const triggerClass =
  "flex w-full min-h-[48px] items-center gap-2.5 rounded-input border bg-surface px-3 text-left text-[14px] text-ink md:text-[16px] hover:border-strongline focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy focus-visible:border-navy";

// ── The popover (or sheet on a phone) ─────────────────────────────────────

function Pop({ open, onClose, title, anchor, width, children }: { open: boolean; onClose: () => void; title: string; anchor: RefObject<HTMLDivElement | null>; width: number; children: ReactNode }) {
  const phone = useApp().device.kind === "phone";
  const panel = useRef<HTMLDivElement>(null);
  const [up, setUp] = useState(false);
  const [right, setRight] = useState(false);

  // Open upward when there's no room below, and keep it on screen sideways.
  useLayoutEffect(() => {
    if (!open || phone || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const h = panel.current?.offsetHeight ?? 360;
    setUp(window.innerHeight - r.bottom < h + 12 && r.top > h + 12);
    setRight(r.left + width > window.innerWidth - 8);
  }, [open, phone, anchor, width]);

  useEffect(() => {
    if (!open || phone) return;
    const down = (e: MouseEvent | TouchEvent) => {
      if (anchor.current && !anchor.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("touchstart", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("touchstart", down);
      document.removeEventListener("keydown", key);
    };
  }, [open, phone, anchor, onClose]);

  if (!open) return null;
  if (phone) {
    return (
      <SheetRoot open onOpenChange={(o) => !o && onClose()}>
        <SheetContent aria-describedby={undefined}>
          <SheetHeader title={title} />
          <SheetBody>{children}</SheetBody>
        </SheetContent>
      </SheetRoot>
    );
  }
  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={title}
      style={{ width }}
      className={cn("absolute z-40 rounded-card border border-hairline bg-surface p-3 shadow-[0_12px_32px_rgba(15,23,42,0.16)]", up ? "bottom-full mb-1.5" : "top-full mt-1.5", right ? "right-0" : "left-0")}
    >
      {children}
    </div>
  );
}

function Trigger({ icon, text, placeholder, open, invalid, onOpen, onClear, label }: { icon: ReactNode; text: string; placeholder: string; open: boolean; invalid?: boolean; onOpen: () => void; onClear?: () => void; label?: string }) {
  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        onClick={onOpen}
        className={cn(triggerClass, invalid ? "border-status-redDot" : "border-hairline", open && "border-navy outline outline-2 outline-navy", onClear && text && "pr-10")}
      >
        <span className="shrink-0 text-muted">{icon}</span>
        <span className={cn("min-w-0 flex-1 truncate", !text && "text-muted")}>{text || placeholder}</span>
      </button>
      {onClear && text && (
        <button type="button" aria-label="Clear" onClick={onClear} className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full text-muted hover:bg-rowhover hover:text-ink">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

// ── Days ───────────────────────────────────────────────────────────────────

const monthOf = (day: string) => day.slice(0, 7);
const firstOf = (month: string) => `${month}-01`;
const shiftMonth = (month: string, n: number) => {
  const [y, m] = month.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};

export function DatePicker({
  value,
  onChange,
  min,
  max,
  placeholder = "Choose a day",
  clearable,
  invalid,
  label,
}: {
  value: string;
  onChange: (day: string) => void;
  /** Days before / after these can't be picked. */
  min?: string;
  max?: string;
  placeholder?: string;
  /** Show an × to empty it. */
  clearable?: boolean;
  /** Red border (a validation error). */
  invalid?: boolean;
  label?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const { today } = useApp();
  const start = value || (max && max < today ? max : min && min > today ? min : today);
  const [month, setMonth] = useState(monthOf(start));
  useEffect(() => {
    if (open) setMonth(monthOf(start));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Six rows of days, Sunday first; as many rows as the month needs.
  const first = addDays(firstOf(month), -weekdayOf(firstOf(month)));
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i));
  const rows = monthOf(days[35]) === month ? 6 : monthOf(days[28]) === month ? 5 : 4;
  const [y, m] = month.split("-").map(Number);
  const allowed = (d: string) => (!min || d >= min) && (!max || d <= max);
  const canBack = !min || shiftMonth(month, -1) >= monthOf(min);
  const canNext = !max || shiftMonth(month, 1) <= monthOf(max);
  const pick = (d: string) => {
    onChange(d);
    setOpen(false);
  };
  // Looking back (no days after today): Today and Yesterday. Otherwise forward.
  const past = Boolean(max && max <= today);
  const quick = (past
    ? [{ label: "Today", day: today }, { label: "Yesterday", day: addDays(today, -1) }]
    : [{ label: "Today", day: today }, { label: "Tomorrow", day: addDays(today, 1) }, { label: "In a week", day: addDays(today, 7) }]
  ).filter((q) => allowed(q.day));
  const text = !value ? "" : value === today ? `Today · ${dayText(value, false)}` : value === addDays(today, -1) ? `Yesterday · ${dayText(value, false)}` : value === addDays(today, 1) ? `Tomorrow · ${dayText(value, false)}` : dayText(value);

  return (
    <div ref={wrap} className="relative">
      <Trigger icon={<CalendarDays className="h-[18px] w-[18px]" />} text={text} placeholder={placeholder} open={open} invalid={invalid} onOpen={() => setOpen(!open)} onClear={clearable ? () => onChange("") : undefined} label={label} />
      <Pop open={open} onClose={() => setOpen(false)} title={label ?? "Choose a day"} anchor={wrap} width={308}>
        <div className="mb-2 flex items-center justify-between">
          <button type="button" aria-label="Previous month" disabled={!canBack} onClick={() => setMonth(shiftMonth(month, -1))} className="grid h-9 w-9 place-items-center rounded-full text-ink hover:bg-rowhover disabled:opacity-30">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <b className="font-heading text-[15px] font-extrabold text-ink">{MONTHS_LONG[m - 1]} {y}</b>
          <button type="button" aria-label="Next month" disabled={!canNext} onClick={() => setMonth(shiftMonth(month, 1))} className="grid h-9 w-9 place-items-center rounded-full text-ink hover:bg-rowhover disabled:opacity-30">
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
        <div className="grid grid-cols-7 text-center text-[11.5px] font-bold uppercase tracking-wide text-muted">
          {WEEK.map((d) => <span key={d} className="py-1">{d}</span>)}
        </div>
        <div className="grid grid-cols-7 gap-y-0.5">
          {days.slice(0, rows * 7).map((d) => {
            const inMonth = monthOf(d) === month;
            const off = !allowed(d);
            const chosen = d === value;
            return (
              <button
                key={d}
                type="button"
                disabled={off}
                aria-label={dayText(d)}
                aria-pressed={chosen}
                onClick={() => pick(d)}
                className={cn(
                  "mx-auto grid h-10 w-10 place-items-center rounded-full text-[14px] tabular-nums",
                  chosen ? "bg-navy font-extrabold text-white dark:bg-white dark:text-navy" : off ? "text-muted/40" : inMonth ? "font-semibold text-ink hover:bg-rowhover" : "text-muted hover:bg-rowhover",
                  d === today && !chosen && "ring-[1.5px] ring-inset ring-navy dark:ring-white",
                )}
              >
                {Number(d.slice(8))}
              </button>
            );
          })}
        </div>
        {quick.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-hairline pt-2.5">
            {quick.map((q) => (
              <button key={q.label} type="button" onClick={() => pick(q.day)} className={cn("min-h-[34px] rounded-pill border px-3 text-[13px] font-bold", q.day === value ? "border-navy bg-navsel text-ink" : "border-hairline text-ink hover:bg-rowhover")}>
                {q.label}
              </button>
            ))}
          </div>
        )}
      </Pop>
    </div>
  );
}

// ── Times ──────────────────────────────────────────────────────────────────

const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
const fromMin = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

/** "930", "9:30", "9.30pm", "21:30", "9p" → "HH:MM", or null. A bare 1–7 means the afternoon. */
export function parseTime(text: string): string | null {
  const s = text.trim().toLowerCase().replace(/\s+/g, "").replace(".", ":");
  const m = s.match(/^(\d{1,2})(?::?(\d{2}))?(a|am|p|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return null;
  const ap = m[3];
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap.startsWith("p") && h !== 12) h += 12;
    if (ap.startsWith("a") && h === 12) h = 0;
  } else if (h > 23) return null;
  else if (!m[2] && h >= 1 && h <= 7) h += 12;
  return fromMin(h * 60 + min);
}

function lengthText(mins: number) {
  if (mins <= 0) return "";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h && m ? `${h} hr ${m} min` : h ? `${h} hr${h > 1 ? "s" : ""}` : `${m} min`;
}

/** New York's time now, "HH:MM". */
function nowTime() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("hour")}:${get("minute")}`;
}

export function TimePicker({
  value,
  onChange,
  after,
  now,
  placeholder = "Choose a time",
  invalid,
  label,
}: {
  value: string | null;
  onChange: (time: string) => void;
  /** An end time: the list starts after this one and shows how long it lasts. */
  after?: string | null;
  /** Offer "Now" (the time this minute), e.g. for when something happened. */
  now?: boolean;
  placeholder?: string;
  invalid?: boolean;
  label?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const from = after ? toMin(after) + 15 : 0;
  const times = useMemo(() => {
    const out: string[] = [];
    for (let t = from; t < 24 * 60; t += 15) out.push(fromMin(t));
    return out;
  }, [from]);

  // Scroll to the chosen time, or to 9am (an end time: just after the start).
  useLayoutEffect(() => {
    if (!open || !list.current) return;
    const target = value && times.includes(value) ? value : after ? times[0] : "09:00";
    const el = list.current.querySelector<HTMLElement>(`[data-time="${target}"]`);
    if (el) list.current.scrollTop = el.offsetTop - list.current.clientHeight / 2 + el.offsetHeight / 2;
    setTyped("");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = typed ? parseTime(typed) : null;
  const pick = (t: string) => {
    onChange(t);
    setOpen(false);
  };
  const lasts = (t: string) => (after ? lengthText(toMin(t) - toMin(after)) : "");

  return (
    <div ref={wrap} className="relative">
      <Trigger
        icon={<Clock className="h-[18px] w-[18px]" />}
        text={value ? `${timeText(value)}${after && toMin(value) > toMin(after) ? ` · ${lasts(value)}` : ""}` : ""}
        placeholder={placeholder}
        open={open}
        invalid={invalid}
        onOpen={() => setOpen(!open)}
        label={label}
      />
      <Pop open={open} onClose={() => setOpen(false)} title={label ?? "Choose a time"} anchor={wrap} width={240}>
        <div className="mb-2 flex gap-1.5">
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && parsed) {
                e.preventDefault();
                pick(parsed);
              }
            }}
            placeholder="Type a time, e.g. 9:30am"
            aria-label="Type a time"
            className="min-h-[40px] w-full min-w-0 rounded-input border border-hairline bg-surface px-3 text-[14px] text-ink placeholder:text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy"
          />
          {now && (
            <button type="button" onClick={() => pick(nowTime())} className="shrink-0 rounded-input border border-hairline px-3 text-[13px] font-bold text-ink hover:bg-rowhover">
              Now
            </button>
          )}
        </div>
        {typed && (
          <button type="button" disabled={!parsed} onClick={() => parsed && pick(parsed)} className="mb-2 w-full rounded-[8px] bg-navsel px-3 py-2 text-left text-[14px] font-bold text-ink disabled:bg-subtle disabled:font-semibold disabled:text-muted">
            {parsed ? `Use ${timeText(parsed)}` : "Try 9:30am or 14:00"}
          </button>
        )}
        <div ref={list} className="max-h-[264px] overflow-y-auto overscroll-contain pr-0.5">
          {times.map((t) => {
            const chosen = t === value;
            return (
              <button
                key={t}
                type="button"
                data-time={t}
                aria-pressed={chosen}
                onClick={() => pick(t)}
                className={cn("flex w-full items-center justify-between rounded-[8px] px-3 py-2 text-left text-[14px] tabular-nums", chosen ? "bg-navy font-extrabold text-white dark:bg-white dark:text-navy" : "font-semibold text-ink hover:bg-rowhover")}
              >
                <span>{timeText(t)}</span>
                {after && <span className={cn("text-[12.5px] font-medium", chosen ? "text-white/80 dark:text-navy/70" : "text-muted")}>{lasts(t)}</span>}
              </button>
            );
          })}
        </div>
      </Pop>
    </div>
  );
}

// ── Labelled rows, for reading a record ────────────────────────────────────

/** A list of DetailRows (a <dl>). */
export function DetailList({ className, children }: { className?: string; children: ReactNode }) {
  return <dl className={className}>{children}</dl>;
}

/** One labelled line: the label on the left (above it on a phone), the value beside it, a hairline between rows. */
export function DetailRow({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-0.5 border-b border-hairline py-2.5 last:border-b-0 sm:grid-cols-[132px_minmax(0,1fr)] sm:gap-4", className)}>
      <dt className="text-[13px] font-semibold text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-[14.5px] text-ink">{children}</dd>
    </div>
  );
}
