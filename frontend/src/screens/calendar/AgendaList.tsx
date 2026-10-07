import { CalendarDays, MapPin, Plus, Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import { addDays, daysApart } from "@/lib/recurrence";
import { firstOfMonth, formatTime, lastOfMonth, longDay, relativeDayName, shortDay } from "@/lib/calendar";
import type { CalendarOccurrence } from "@/lib/types";
import { EmptyState } from "@/components/ui/misc";
import { colorOf, type ColorOf } from "./colors";

/** The month `anchor` is in as a list: each day with something on, and what. */
export function AgendaList({
  anchor, today, items, colors, onOpen,
}: {
  anchor: string;
  today: string;
  items: CalendarOccurrence[];
  colors: ColorOf;
  onOpen: (o: CalendarOccurrence) => void;
}) {
  const from = firstOfMonth(anchor);
  const to = lastOfMonth(anchor);
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const withItems = days
    .map((day) => ({ day, items: items.filter((o) => o.startDate <= day && o.endDate >= day) }))
    .filter((d) => d.items.length > 0);

  if (withItems.length === 0) {
    return <EmptyState icon={<CalendarDays className="h-8 w-8" />} title="Nothing on the calendar this month" hint="Use the arrows to look at another month." />;
  }
  return (
    <div className="mx-auto w-full max-w-[860px] space-y-5 px-4 py-4 md:px-7">
      {withItems.map((d) => (
        <AgendaDay key={d.day} day={d.day} today={today} items={d.items} colors={colors} onOpen={onOpen} />
      ))}
    </div>
  );
}

/** One day's events, all-day ones first. */
export function AgendaDay({
  day, today, items, colors, onOpen, onNew, showEmpty = false,
}: {
  day: string;
  today: string;
  items: CalendarOccurrence[];
  colors: ColorOf;
  onOpen: (o: CalendarOccurrence) => void;
  /** Admins: add an event on this day. */
  onNew?: (day: string) => void;
  /** Say so when the day is empty (the phone's chosen day), rather than leaving it blank. */
  showEmpty?: boolean;
}) {
  const relative = relativeDayName(day, today);
  const sorted = [...items].sort((a, b) => Number(b.allDay || b.startDate < day) - Number(a.allDay || a.startDate < day) || (a.startTime ?? "").localeCompare(b.startTime ?? ""));
  return (
    <section>
      <h2 className={cn("mb-2 flex items-baseline gap-2 text-[13px] font-extrabold", day === today ? "text-accent dark:text-white" : "text-ink")}>
        <span>{relative ? `${relative} · ${shortDay(day)}` : longDay(day)}</span>
        {onNew && (
          <button type="button" onClick={() => onNew(day)} className="ml-auto inline-flex min-h-[36px] items-center gap-1 text-[13px] font-semibold text-accent dark:text-white">
            <Plus className="h-4 w-4" /> Add
          </button>
        )}
      </h2>
      {sorted.length === 0 && showEmpty && <p className="rounded-card border border-dashed border-hairline px-4 py-5 text-center text-[13.5px] text-muted">Nothing on this day.</p>}
      <ul className="overflow-hidden rounded-card border border-hairline bg-surface empty:hidden">
        {sorted.map((o) => (
          <AgendaRow key={o.key} occ={o} day={day} colors={colors} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

function AgendaRow({ occ, day, colors, onOpen }: { occ: CalendarOccurrence; day: string; colors: ColorOf; onOpen: (o: CalendarOccurrence) => void }) {
  const color = colorOf(colors, occ.categoryId);
  const multi = occ.startDate !== occ.endDate;
  const time = occ.allDay
    ? "All day"
    : occ.startDate === day && occ.endDate === day
      ? `${formatTime(occ.startTime!)} – ${formatTime(occ.endTime!)}`
      : occ.startDate === day
        ? `From ${formatTime(occ.startTime!)}`
        : occ.endDate === day
          ? `Until ${formatTime(occ.endTime!)}`
          : "All day";
  const where = occ.allSites ? null : occ.sites.map((s) => s.name).join(", ");
  return (
    <li className="border-b border-hairline last:border-b-0">
      <button type="button" onClick={() => onOpen(occ)} className="flex w-full items-stretch gap-3 px-3 py-2.5 text-left hover:bg-rowhover md:px-4">
        <span className="w-[92px] shrink-0 pt-px text-[12.5px] font-semibold tabular text-muted md:w-[110px]">
          {time}
          {multi && <span className="block text-micro font-medium">Day {daysApart(occ.startDate, day) + 1} of {daysApart(occ.startDate, occ.endDate) + 1}</span>}
        </span>
        <span className={cn("w-1 shrink-0 rounded-pill", occ.pending && "opacity-50")} style={{ background: color.solid }} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[14.5px] font-semibold text-ink">
            <span className="truncate">{occ.title}</span>
            {occ.repeats && <Repeat className="h-3.5 w-3.5 shrink-0 text-muted" aria-label="Repeats" />}
          </span>
          {(occ.location || where || color.name || occ.pending) && (
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-micro text-muted">
              {occ.pending && <span className="font-semibold text-status-amberText">Needs approval</span>}
              {color.name && <span>{color.name}</span>}
              {occ.location && (
                <span className="inline-flex items-center gap-0.5">
                  <MapPin className="h-3 w-3" /> {occ.location}
                </span>
              )}
              {where && <span>{where}</span>}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
