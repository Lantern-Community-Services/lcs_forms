import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, Filter, Mail, Plus, Tags } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useNavCatalog } from "@/components/shell/navData";
import { useDeviceKind } from "@/lib/device";
import { SitePicker, useSiteSelection } from "@/lib/site";
import { api } from "@/lib/api";
import { calendarApi, useCalendar, useCalendarCategories, useCalendarMutation, useOutlookPrefs } from "@/lib/queries";
import { addDays, isDay } from "@/lib/recurrence";
import { addMonths, categoryColor, fetchRange, formatTime, longDay, nyNowMinutes, nyToday, shortDay, startOfWeek, step, timeOf, viewTitle, type CalendarView } from "@/lib/calendar";
import { readStoredJson, writeStorage } from "@/lib/storage";
import { cn, errorMessage } from "@/lib/utils";
import type { CalendarOccurrence, CalendarScope, CalendarSeries } from "@/lib/types";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState, LoadingState, Spinner } from "@/components/ui/misc";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { colorMap } from "./colors";
import { MonthCompact, MonthGrid } from "./MonthView";
import { TimeGrid } from "./TimeGrid";
import { AgendaList } from "./AgendaList";
import { EventDetail, ScopeDialog } from "./EventDetail";
import { EventEditor, type EditorTarget } from "./EventEditor";
import { CategoriesDialog } from "./CategoriesDialog";
import { OutlookDialog } from "./OutlookDialog";
import { useTour } from "@/lib/tour/TourProvider";
import { PageHelp } from "@/components/PageHelp";

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
  // Everyone else asks for an event through the Event Requests code form, when
  // it's published and theirs to open; the event lands here once it's approved.
  // They get New event and drag out times all the same, and are asked to request it.
  const { categories: navCategories } = useNavCatalog();
  const requestForm = canAdd ? undefined : navCategories.flatMap((c) => c.forms).find((f) => /^\/apps\/events(\/|$)/.test(f.url));
  const canStart = canAdd || Boolean(requestForm);
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
  const [requestFor, setRequestFor] = useState<RequestSlot | null>(null);
  // "Add to my Outlook": asked once, the first time someone opens the calendar.
  const { data: outlook } = useOutlookPrefs();
  const [showOutlook, setShowOutlook] = useState(false);
  const [askedOutlook, setAskedOutlook] = useState(false);
  // Not in the middle of the welcome tour: it asks once the tour is over.
  const touring = Boolean(useTour().active);
  useEffect(() => {
    if (outlook && !outlook.answered && !askedOutlook && !touring) {
      setAskedOutlook(true);
      setShowOutlook(true);
    }
  }, [outlook, askedOutlook, touring]);
  const outlookButton = (
    <Button data-tour="calendar-outlook" variant="secondary" size={phone ? "icon" : "md"} onClick={() => setShowOutlook(true)} aria-label="Add to my Outlook" title="Add to my Outlook" className={phone ? "h-9 w-9" : undefined}>
      <Mail className="h-4 w-4" />
      {!phone && "Outlook"}
    </Button>
  );
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

  const newAt = (day: string, minutes: number | null, endMinutes?: number) =>
    canAdd ? setEditor({ mode: "new", day, minutes, endMinutes }) : setRequestFor({ day, minutes, endMinutes });
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
      else if (k === "n" && canStart) newEvent();
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
    <div role="tablist" aria-label="View" data-tour="calendar-views" className="flex rounded-input border border-hairline bg-surface p-0.5">
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
            onNew={canStart ? (day) => newAt(day, 9 * 60) : undefined}
          />
        </div>
      );
    if (view === "month")
      return <MonthGrid anchor={anchor} today={today} items={items} colors={colors} onOpen={setOpen} onDay={(date) => go({ view: "day", date })} onNew={canStart ? (day) => newAt(day, null) : undefined} />;
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
          onNewAt={canStart ? (day, minutes, end) => newAt(day, minutes < 0 ? null : minutes, end) : undefined}
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
        <div data-tour="calendar-header" className="flex-none border-b border-hairline bg-sidebar px-4 pb-2.5 pt-safe-top">
          <div className="flex items-center gap-2">
            <h1 className="text-[23px] font-heading font-extrabold text-ink">Calendar</h1>
            <PageHelp article="calendar">Events for every site and for yours. Admins, and anyone they let edit the calendar, add them.</PageHelp>
            <span className="flex-1" />
            {isFetching && <Spinner className="h-4 w-4" />}
            {outlookButton}
            <Button variant="secondary" size="sm" onClick={() => go({ date: today })} className="h-9">Today</Button>
            {canStart && (
              <Button data-tour="calendar-new" size="icon" onClick={newEvent} aria-label="New event" className="h-9 w-9">
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
        <div data-tour="calendar-header" className="flex-none border-b border-hairline px-4 pb-3 pt-safe-top md:px-7 md:pt-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-[24px] font-heading font-extrabold text-ink">Calendar</h1>
            <PageHelp article="calendar">Events for every site and for yours. Admins, and anyone they let edit the calendar, add them.</PageHelp>
            <div className="flex items-center gap-1">
              <Button variant="secondary" size="sm" onClick={() => go({ date: today })} title={device === "desktop" ? "Today (T)" : undefined}>Today</Button>
              {arrows}
            </div>
            <h2 className="min-w-0 text-[17px] font-bold text-ink">{title}</h2>
            {isFetching && <Spinner className="h-4 w-4" />}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <SitePicker codes={codes} onChange={setCodes} counts={false} className="w-[220px]" />
              <CategoryFilterMenu options={filterOptions} hidden={hidden} onChange={setHidden} />
              {outlookButton}
              {viewSwitch}
              {manage && (
                <Button variant="secondary" size="icon" onClick={() => setShowCategories(true)} title="Event categories" aria-label="Event categories">
                  <Tags className="h-4 w-4" />
                </Button>
              )}
              {canStart && (
                <Button data-tour="calendar-new" onClick={newEvent} title={device === "desktop" ? "New event (N)" : undefined}>
                  <Plus className="h-4 w-4" /> New event
                </Button>
              )}
            </div>
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
      <OutlookDialog open={showOutlook} onClose={() => setShowOutlook(false)} />
      {manage && <CategoriesDialog open={showCategories} onClose={() => setShowCategories(false)} />}
      {requestForm && <RequestPrompt slot={requestFor} formUrl={requestForm.url} onClose={() => setRequestFor(null)} />}
    </div>
  );
}

/** A time someone without calendar rights picked: minutes null for all day. */
type RequestSlot = { day: string; minutes: number | null; endMinutes?: number };

/**
 * Only Admins and calendar editors put events on the calendar themselves.
 * Anyone else who picks a time (New event, a click or a drag) is asked to
 * request it, and the request form opens on that day and time.
 */
function RequestPrompt({ slot, formUrl, onClose }: { slot: RequestSlot | null; formUrl: string; onClose: () => void }) {
  const start = slot?.minutes ?? null;
  const end = start === null ? null : Math.min(slot?.endMinutes ?? start + 60, 23 * 60 + 59);
  const when = slot ? `${longDay(slot.day)} · ${start === null || end === null ? "All day" : `${formatTime(timeOf(start))} – ${formatTime(timeOf(end))}`}` : "";
  const query = slot ? new URLSearchParams(start === null || end === null ? { date: slot.day, allDay: "1" } : { date: slot.day, start: timeOf(start), end: timeOf(end) }) : null;
  const to = `${formUrl.replace(/^(\/apps\/[^/?#]+).*$/, "$1")}/new?${query ?? ""}`;
  return (
    <ResponsiveDialog
      open={slot !== null}
      onOpenChange={(open) => !open && onClose()}
      title="Request an event"
      dialogClassName="w-[min(440px,calc(100vw-2rem))]"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} className="min-h-[44px] flex-1 md:min-h-0 md:flex-none">Cancel</Button>
          <Link to={to} onClick={onClose} className={cn(buttonVariants(), "min-h-[44px] flex-1 md:min-h-0 md:flex-none")}>
            Fill out the request
          </Link>
        </>
      }
    >
      <p className="rounded-input bg-subtle px-3 py-2.5 text-[14px] font-bold text-ink">{when}</p>
      <p className="mt-3 text-[13.5px] text-muted">
        Events go on the calendar through Event Requests. The form opens on this day and time; once it's sent, the event shows here marked Needs approval until it's approved.
      </p>
    </ResponsiveDialog>
  );
}

type FilterOption = { key: string; name: string; color: string };

/**
 * Categories named "Group: kind" (the Integrated Services ones) listed together
 * under their group; the rest one by one, in the calendar's order.
 */
function groupOptions(options: FilterOption[]): { label: string | null; options: FilterOption[] }[] {
  const out: { label: string | null; options: FilterOption[] }[] = [];
  for (const o of options) {
    const at = o.name.indexOf(": ");
    const label = at > 0 ? o.name.slice(0, at) : null;
    const group = label ? out.find((g) => g.label === label) : undefined;
    if (group) group.options.push(o);
    else out.push({ label, options: [o] });
  }
  // A group of one is just a row.
  return out.map((g) => (g.label && g.options.length === 1 ? { label: null, options: g.options } : g));
}

/** The category's mark: filled when shown, a ring when hidden, half when some of a group are. */
function FilterDot({ color, state }: { color: string; state: "on" | "off" | "some" }) {
  const background = state === "on" ? color : state === "some" ? `linear-gradient(90deg, ${color} 50%, transparent 50%)` : "transparent";
  return <span aria-hidden className="h-3 w-3 shrink-0 rounded-full" style={{ background, boxShadow: `inset 0 0 0 1.5px ${color}` }} />;
}

/**
 * On a computer or an iPad: one Categories button, and the categories in a
 * menu under it, each with Only to see just that one. A group's row turns all
 * of its kinds on or off. The menu stays open while you pick.
 */
function CategoryFilterMenu({ options, hidden, onChange }: { options: FilterOption[]; hidden: Set<string>; onChange: (next: Set<string>) => void }) {
  const off = options.filter((o) => hidden.has(o.key)).length;
  const show = (keys: string[], on: boolean) => {
    const next = new Set(hidden);
    for (const k of keys) {
      if (on) next.delete(k);
      else next.add(k);
    }
    onChange(next);
  };
  const only = (keys: string[]) => onChange(new Set(options.filter((o) => !keys.includes(o.key)).map((o) => o.key)));
  const keep = (e: Event) => e.preventDefault();

  const row = (key: string, keys: string[], label: string, color: string, indent = false) => {
    const shown = keys.filter((k) => !hidden.has(k)).length;
    const state = shown === keys.length ? "on" : shown === 0 ? "off" : "some";
    return (
      <div key={key} className="group flex items-center">
        <DropdownMenuCheckboxItem
          checked={state === "on" ? true : state === "off" ? false : "indeterminate"}
          onCheckedChange={() => show(keys, state !== "on")}
          onSelect={keep}
          className={cn("min-w-0 flex-1", indent && "pl-7")}
        >
          <FilterDot color={color} state={state} />
          <span className={cn("truncate", state === "off" && "text-muted line-through decoration-muted/60")}>{label}</span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuItem
          onSelect={(e) => {
            keep(e);
            only(keys);
          }}
          aria-label={`Show only ${label}`}
          className="shrink-0 px-2 text-[12px] font-semibold text-accent opacity-0 focus:opacity-100 group-hover:opacity-100 dark:text-white [@media(hover:none)]:opacity-100"
        >
          Only
        </DropdownMenuItem>
      </div>
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          aria-label={off ? `Categories, ${options.length - off} of ${options.length} shown` : undefined}
          className={cn(off > 0 && "border-navy bg-navsel text-accent dark:text-white")}
        >
          <Filter className="h-4 w-4" /> Categories
          {off > 0 && (
            <span className="rounded-pill bg-navy px-1.5 text-[11.5px] font-bold tabular-nums text-white dark:bg-white dark:text-navy">
              {options.length - off}/{options.length}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[min(70vh,560px)] w-[320px] overflow-auto">
        <DropdownMenuLabel>Show categories</DropdownMenuLabel>
        {groupOptions(options).map((g) =>
          g.label ? (
            <div key={`group:${g.label}`}>
              {row(`group:${g.label}`, g.options.map((o) => o.key), g.label, g.options[0].color)}
              {g.options.map((o) => row(o.key, [o.key], o.name.slice(g.label!.length + 2), o.color, true))}
            </div>
          ) : (
            row(g.options[0].key, [g.options[0].key], g.options[0].name, g.options[0].color)
          )
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            keep(e);
            onChange(new Set());
          }}
          disabled={off === 0}
          className="font-semibold"
        >
          Show all
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
