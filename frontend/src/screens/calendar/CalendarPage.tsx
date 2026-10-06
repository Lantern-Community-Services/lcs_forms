import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, Filter, Plus, Tags } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useDeviceKind } from "@/lib/device";
import { SitePicker, useSiteSelection } from "@/lib/site";
import { api } from "@/lib/api";
import { calendarApi, useCalendar, useCalendarCategories, useCalendarMutation } from "@/lib/queries";
import { addDays, isDay } from "@/lib/recurrence";
import { addMonths, categoryColor, fetchRange, nyNowMinutes, nyToday, shortDay, startOfWeek, step, viewTitle, type CalendarView } from "@/lib/calendar";
import { readStoredJson, writeStorage } from "@/lib/storage";
import { cn, errorMessage } from "@/lib/utils";
import type { CalendarOccurrence, CalendarScope, CalendarSeries } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadingState, Spinner } from "@/components/ui/misc";
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { colorMap } from "./colors";
import { MonthCompact, MonthGrid } from "./MonthView";
import { TimeGrid } from "./TimeGrid";
import { AgendaList } from "./AgendaList";
import { EventDetail, ScopeDialog } from "./EventDetail";
import { EventEditor, type EditorTarget } from "./EventEditor";
import { CategoriesDialog } from "./CategoriesDialog";

const HIDDEN_KEY = "ln.calendar.hidden";
/** The filter's stand-in for "no category". */
const NONE = "none";
const VIEWS: Record<CalendarView, string> = { month: "Month", week: "Week", day: "Day", list: "List" };
const isView = (v: unknown): v is CalendarView => typeof v === "string" && v in VIEWS;

/**
 * The calendar. Everyone sees the events for every site and for the sites
 * they're at, filtered further by the site picker and by category. Admins
 * (calendar.manage) change anything; people with the "Can edit the calendar"
 * switch (calendar.edit) add events and change the ones for their own sites,
 * as each occurrence's canEdit says. Only Admins edit the categories.
 *
 * It opens on Week on a computer or an iPad. Month, week, day and list there;
 * month (with the chosen day's events under it), day and list on a phone,
 * where a week of columns would be too narrow to read, so a phone opens on
 * Month. The view and the day are in the URL (?view=month&date=2026-10-06), so
 * a link or a pull-to-refresh opens the same place.
 */
export function CalendarPage() {
  const { can } = useAuth();
  const manage = can("calendar.manage");
  // Admins, and anyone with the switch (for their own sites; the server checks each event).
  const canAdd = manage || can("calendar.edit");
  const device = useDeviceKind();
  const phone = device === "phone";
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const today = nyToday();

  const wanted = params.get("view");
  const chosen: CalendarView = isView(wanted) ? wanted : phone ? "month" : "week";
  const view: CalendarView = phone && chosen === "week" ? "day" : chosen;
  const dateParam = params.get("date");
  const anchor = isDay(dateParam) ? dateParam : today;

  const go = (next: { view?: CalendarView; date?: string }) => {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next.view) p.set("view", next.view);
        if (next.date) {
          if (next.date === nyToday()) p.delete("date");
          else p.set("date", next.date);
        }
        return p;
      },
      { replace: true }
    );
  };

  const { codes, setCodes, param: siteParam } = useSiteSelection();
  const range = fetchRange(anchor);
  const { data, isLoading, isError, error, isFetching } = useCalendar(range.from, range.to, siteParam);
  const { data: categories } = useCalendarCategories();
  const colors = useMemo(() => colorMap(categories), [categories]);

  // Categories switched off in the filter, remembered per device.
  const [hidden, setHidden] = useState<Set<string>>(() => {
    const saved = readStoredJson(HIDDEN_KEY);
    return new Set(Array.isArray(saved) ? saved.filter((x): x is string => typeof x === "string") : []);
  });
  useEffect(() => writeStorage(HIDDEN_KEY, JSON.stringify([...hidden])), [hidden]);
  const filterKey = (o: CalendarOccurrence) => (o.categoryId && colors.has(o.categoryId) ? o.categoryId : NONE);
  const items = useMemo(() => (data?.items ?? []).filter((o) => !hidden.has(filterKey(o))), [data, hidden, colors]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Opening, editing, deleting ──
  const [open, setOpen] = useState<CalendarOccurrence | null>(null);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [scopeFor, setScopeFor] = useState<{ action: "edit" | "delete"; occ: CalendarOccurrence } | null>(null);
  const [showCategories, setShowCategories] = useState(false);
  const fail = (e: unknown, fallback: string) => toast(errorMessage(e, fallback), "error");

  async function startEdit(occ: CalendarOccurrence, scope: CalendarScope) {
    try {
      const series = await qc.fetchQuery({
        queryKey: ["calendar", "series", occ.eventId],
        queryFn: () => api.get<CalendarSeries>(`/calendar/events/${occ.eventId}`),
        staleTime: 0,
      });
      setOpen(null);
      setEditor({ mode: "edit", series, scope: series.recurrence ? scope : "all", occ });
    } catch (e) {
      fail(e, "Couldn't open the event. Try again.");
    }
  }

  const restore = useCalendarMutation(({ id, date }: { id: string; date: string }) => calendarApi.restore(id, date));
  const remove = useCalendarMutation(({ occ, scope }: { occ: CalendarOccurrence; scope: CalendarScope }) => calendarApi.remove(occ.eventId, scope, occ.date));
  function doDelete(occ: CalendarOccurrence, scope: CalendarScope) {
    remove.mutate(
      { occ, scope },
      {
        onSuccess: () => {
          setOpen(null);
          if (scope === "this") {
            toast(`Removed “${occ.title}” on ${shortDay(occ.date)}`, "success", {
              action: { label: "Undo", onClick: () => restore.mutate({ id: occ.eventId, date: occ.date }, { onError: (e) => fail(e, "Couldn't put it back.") }) },
            });
          } else {
            toast(scope === "following" ? `Removed “${occ.title}” from ${shortDay(occ.date)} on` : `Deleted “${occ.title}”`);
          }
        },
        onError: (e) => fail(e, "Couldn't delete the event. Try again."),
      }
    );
  }

  const onEdit = (occ: CalendarOccurrence) => {
    if (!occ.repeats) return void startEdit(occ, "all");
    setOpen(null);
    setScopeFor({ action: "edit", occ });
  };
  const onDelete = (occ: CalendarOccurrence) => {
    if (occ.repeats) {
      setOpen(null);
      setScopeFor({ action: "delete", occ });
    } else if (window.confirm(`Delete “${occ.title}”?`)) {
      doDelete(occ, "all");
    }
  };

  const newAt = (day: string, minutes: number | null) => setEditor({ mode: "new", day, minutes });
  const newEvent = () => newAt(anchor, anchor === today ? Math.min(23 * 60, Math.ceil((nyNowMinutes() + 1) / 60) * 60) : 9 * 60);

  // ── Keys, on a computer: arrows move, T is today, M W D L pick the view, N adds ──
  useEffect(() => {
    if (device !== "desktop") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable]") || document.querySelector('[role="dialog"]')) return;
      const k = e.key.toLowerCase();
      if (e.key === "ArrowLeft") go({ date: step(view, anchor, -1) });
      else if (e.key === "ArrowRight") go({ date: step(view, anchor, 1) });
      else if (k === "t") go({ date: today });
      else if (k === "m") go({ view: "month" });
      else if (k === "w") go({ view: "week" });
      else if (k === "d") go({ view: "day" });
      else if (k === "l") go({ view: "list" });
      else if (k === "n" && canAdd) newEvent();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // A phone has no room for "Wednesday, October 14".
  const title = phone && view === "day" ? shortDay(anchor) : viewTitle(view, anchor, today);
  const arrows = (
    <div className="flex items-center">
      <button type="button" onClick={() => go({ date: step(view, anchor, -1) })} aria-label="Earlier" className="flex h-9 w-9 items-center justify-center rounded-full text-ink hover:bg-navsel/60">
        <ChevronLeft className="h-5 w-5" />
      </button>
      <button type="button" onClick={() => go({ date: step(view, anchor, 1) })} aria-label="Later" className="flex h-9 w-9 items-center justify-center rounded-full text-ink hover:bg-navsel/60">
        <ChevronRight className="h-5 w-5" />
      </button>
    </div>
  );
  const viewSwitch = (
    <div role="tablist" aria-label="View" className="flex rounded-input border border-hairline bg-surface p-0.5">
      {(Object.keys(VIEWS) as CalendarView[])
        .filter((v) => !(phone && v === "week"))
        .map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => go({ view: v })}
            className={cn(
              "min-h-[34px] rounded-[5px] px-3 text-[13px] font-semibold transition-colors md:min-h-[30px]",
              view === v ? "bg-navy text-white dark:bg-navsel" : "text-muted hover:text-ink"
            )}
          >
            {VIEWS[v]}
          </button>
        ))}
    </div>
  );
  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const filterOptions = [...(categories ?? []).map((c) => ({ key: c.id, name: c.name, color: categoryColor(c.colorSlot) })), { key: NONE, name: "No category", color: categoryColor(null) }];

  const content = (() => {
    if (isLoading && !data) return <LoadingState label="Loading the calendar…" />;
    if (isError && !data) return <EmptyState icon={<CalendarDays className="h-8 w-8" />} title="Couldn't load the calendar" hint={errorMessage(error, "Try again in a moment.")} />;
    if (view === "month" && phone)
      return (
        <div className="h-full overflow-y-auto scroll-thin">
          <MonthCompact
            anchor={anchor}
            today={today}
            items={items}
            colors={colors}
            onOpen={setOpen}
            onPick={(date) => go({ date })}
            onSwipe={(dir) => go({ date: addMonths(anchor, dir) })}
            onNew={canAdd ? (day) => newAt(day, 9 * 60) : undefined}
          />
        </div>
      );
    if (view === "month")
      return <MonthGrid anchor={anchor} today={today} items={items} colors={colors} onOpen={setOpen} onDay={(date) => go({ view: "day", date })} onNew={canAdd ? (day) => newAt(day, null) : undefined} />;
    if (view === "week" || view === "day") {
      const days = view === "day" ? [anchor] : Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i));
      return (
        <TimeGrid
          days={days}
          today={today}
          items={items}
          colors={colors}
          onOpen={setOpen}
          onDay={view === "week" ? (date) => go({ view: "day", date }) : undefined}
          onNewAt={canAdd ? (day, minutes) => newAt(day, minutes < 0 ? null : minutes) : undefined}
        />
      );
    }
    return (
      <div className="h-full overflow-y-auto scroll-thin">
        <AgendaList anchor={anchor} today={today} items={items} colors={colors} onOpen={setOpen} />
      </div>
    );
  })();

  return (
    <div data-fit-screen className="flex h-full min-h-0 flex-col">
      {phone ? (
        <div className="flex-none border-b border-hairline bg-sidebar px-4 pb-2.5 pt-safe-top">
          <div className="flex items-center gap-2">
            <h1 className="flex-1 text-[23px] font-heading font-extrabold text-ink">Calendar</h1>
            {isFetching && <Spinner className="h-4 w-4" />}
            <Button variant="secondary" size="sm" onClick={() => go({ date: today })} className="h-9">Today</Button>
            {canAdd && (
              <Button size="icon" onClick={newEvent} aria-label="New event" className="h-9 w-9">
                <Plus className="h-5 w-5" />
              </Button>
            )}
          </div>
          <div className="mt-2 flex items-center gap-1">
            {arrows}
            <h2 className="min-w-0 flex-1 truncate text-[15px] font-bold text-ink">{title}</h2>
            {viewSwitch}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <SitePicker codes={codes} onChange={setCodes} counts={false} className="flex-1" />
            <PhoneCategoryFilter options={filterOptions} hidden={hidden} onToggle={toggle} onShowAll={() => setHidden(new Set())} />
          </div>
        </div>
      ) : (
        <div className="flex-none border-b border-hairline px-4 pb-3 pt-safe-top md:px-7 md:pt-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-[24px] font-heading font-extrabold text-ink">Calendar</h1>
            <div className="flex items-center gap-1">
              <Button variant="secondary" size="sm" onClick={() => go({ date: today })} title={device === "desktop" ? "Today (T)" : undefined}>Today</Button>
              {arrows}
            </div>
            <h2 className="min-w-0 text-[17px] font-bold text-ink">{title}</h2>
            {isFetching && <Spinner className="h-4 w-4" />}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <SitePicker codes={codes} onChange={setCodes} counts={false} className="w-[220px]" />
              {viewSwitch}
              {manage && (
                <Button variant="secondary" size="icon" onClick={() => setShowCategories(true)} title="Event categories" aria-label="Event categories">
                  <Tags className="h-4 w-4" />
                </Button>
              )}
              {canAdd && (
                <Button onClick={newEvent} title={device === "desktop" ? "New event (N)" : undefined}>
                  <Plus className="h-4 w-4" /> New event
                </Button>
              )}
            </div>
          </div>
          <div className="chiprow -mx-1 mt-3 flex gap-1.5 px-1">
            {filterOptions.map((c) => (
              <FilterChip key={c.key} on={!hidden.has(c.key)} color={c.color} label={c.name} onClick={() => toggle(c.key)} />
            ))}
            {hidden.size > 0 && (
              <button type="button" onClick={() => setHidden(new Set())} className="shrink-0 px-2 text-[12.5px] font-semibold text-accent dark:text-white">
                Show all
              </button>
            )}
          </div>
        </div>
      )}

      <div className="relative min-h-0 flex-1">{content}</div>

      <EventDetail occ={open} today={today} colors={colors} onClose={() => setOpen(null)} onEdit={onEdit} onDelete={onDelete} />
      <ScopeDialog
        action={scopeFor?.action ?? null}
        onClose={() => setScopeFor(null)}
        onPick={(scope) => {
          const s = scopeFor;
          setScopeFor(null);
          if (!s) return;
          if (s.action === "edit") void startEdit(s.occ, scope);
          else doDelete(s.occ, scope);
        }}
      />
      <EventEditor target={editor} onClose={() => setEditor(null)} />
      {manage && <CategoriesDialog open={showCategories} onClose={() => setShowCategories(false)} />}
    </div>
  );
}

function FilterChip({ on, color, label, onClick }: { on: boolean; color: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      title={on ? `Hide ${label}` : `Show ${label}`}
      className={cn(
        "inline-flex min-h-[32px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border px-3 text-[12.5px] font-semibold transition-colors",
        on ? "border-hairline bg-surface text-ink hover:bg-navsel/60" : "border-dashed border-hairline bg-transparent text-muted line-through decoration-muted/60"
      )}
    >
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: on ? color : "transparent", boxShadow: on ? undefined : `inset 0 0 0 1.5px ${color}` }} />
      {label}
    </button>
  );
}

/** On a phone the categories fold into one button and a sheet. */
function PhoneCategoryFilter({
  options, hidden, onToggle, onShowAll,
}: {
  options: { key: string; name: string; color: string }[];
  hidden: Set<string>;
  onToggle: (key: string) => void;
  onShowAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const off = options.filter((o) => hidden.has(o.key)).length;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-input border px-3 text-[13.5px] font-semibold",
          off ? "border-navy bg-navsel text-accent dark:text-white" : "border-hairline bg-surface text-ink"
        )}
      >
        <Filter className="h-4 w-4" /> {off ? `${options.length - off} of ${options.length}` : "Categories"}
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent aria-describedby={undefined}>
          <SheetHeader title="Show categories" />
          <SheetBody className="px-2">
            {options.map((o) => (
              <button key={o.key} type="button" onClick={() => onToggle(o.key)} aria-pressed={!hidden.has(o.key)} className="flex min-h-[48px] w-full items-center gap-3 rounded-input px-2 text-left text-[15px] font-semibold text-ink active:bg-rowhover">
                <span className="h-3.5 w-3.5 rounded-full" style={{ background: hidden.has(o.key) ? "transparent" : o.color, boxShadow: `inset 0 0 0 2px ${o.color}` }} />
                <span className={cn("flex-1", hidden.has(o.key) && "text-muted line-through")}>{o.name}</span>
              </button>
            ))}
          </SheetBody>
          <SheetFooter>
            <Button variant="secondary" onClick={onShowAll} className="min-h-[48px] flex-1">Show all</Button>
            <Button onClick={() => setOpen(false)} className="min-h-[48px] flex-1">Done</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
