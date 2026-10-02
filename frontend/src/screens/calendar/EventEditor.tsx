import { useEffect, useMemo, useState } from "react";
import { Repeat } from "lucide-react";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { CheckboxList } from "@/components/ui/checkbox";
import { Field, Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { calendarApi, useCalendarCategories, useCalendarMutation, useSites } from "@/lib/queries";
import { addDays, canonicalRule, daysApart, presetKeyFor, repeatPresets, ruleProblem, type Recurrence } from "@/lib/recurrence";
import { categoryColor, longDay, minutesOf, timeOf } from "@/lib/calendar";
import type { CalendarEventInput, CalendarOccurrence, CalendarScope, CalendarSeries } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { CustomRepeat, EndFields, RepeatSummary, shapeFor, type EndDraft, type RuleShape } from "./RepeatFields";

/** What the editor is open on. */
export type EditorTarget =
  | { mode: "new"; day: string; /** Minutes past midnight, or null for all day. */ minutes: number | null }
  | { mode: "edit"; series: CalendarSeries; scope: CalendarScope; occ: CalendarOccurrence | null };

interface Draft {
  title: string;
  description: string;
  location: string;
  categoryId: string | null;
  allSites: boolean;
  siteIds: string[];
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  /** "none", one of repeatPresets' keys, or "custom". */
  repeatKey: string;
  custom: RuleShape;
  end: EndDraft;
}

const withoutEnd = ({ end: _end, ...shape }: Recurrence): RuleShape => shape;

function draftFor(target: EditorTarget): Draft {
  if (target.mode === "new") {
    const start = target.minutes ?? 9 * 60;
    return {
      title: "",
      description: "",
      location: "",
      categoryId: null,
      allSites: true,
      siteIds: [],
      allDay: target.minutes === null,
      startDate: target.day,
      startTime: timeOf(start),
      endDate: target.day,
      endTime: timeOf(Math.min(start + 60, 23 * 60 + 59)),
      repeatKey: "none",
      custom: shapeFor("weekly", target.day),
      end: { kind: "never", count: 10, until: addDays(target.day, 90) },
    };
  }
  const { series: s, scope, occ } = target;
  const rule = s.recurrence;
  // "This and following" starts from the chosen day, keeping the series' times;
  // "this" is the day as it stands, moved or not.
  const span = daysApart(s.startDate, s.endDate);
  const when =
    scope === "this" && occ
      ? { allDay: occ.allDay, startDate: occ.startDate, startTime: occ.startTime, endDate: occ.endDate, endTime: occ.endTime }
      : scope === "following" && occ
        ? { allDay: s.allDay, startDate: occ.date, startTime: s.startTime, endDate: addDays(occ.date, span), endTime: s.endTime }
        : { allDay: s.allDay, startDate: s.startDate, startTime: s.startTime, endDate: s.endDate, endTime: s.endTime };
  const text = scope === "this" && occ ? occ : s;
  return {
    title: text.title,
    description: text.description ?? "",
    location: text.location ?? "",
    categoryId: s.categoryId,
    allSites: s.allSites,
    siteIds: s.siteIds,
    allDay: when.allDay,
    startDate: when.startDate,
    startTime: when.startTime ?? "09:00",
    endDate: when.endDate,
    endTime: when.endTime ?? "10:00",
    repeatKey: presetKeyFor(when.startDate, rule),
    custom: rule ? withoutEnd(canonicalRule(s.startDate, rule)) : shapeFor("weekly", when.startDate),
    end: {
      kind: rule?.end.kind ?? "never",
      count: rule?.end.kind === "count" ? rule.end.count : 10,
      until: rule?.end.kind === "until" ? rule.end.date : addDays(when.startDate, 90),
    },
  };
}

function ruleOf(d: Draft): Recurrence | null {
  if (d.repeatKey === "none") return null;
  const end = d.end.kind === "count" ? { kind: "count" as const, count: d.end.count } : d.end.kind === "until" ? { kind: "until" as const, date: d.end.until } : { kind: "never" as const };
  const preset = d.repeatKey === "custom" ? null : repeatPresets(d.startDate).find((p) => p.key === d.repeatKey)?.rule;
  return { ...(preset ?? d.custom), end };
}

/** The first thing wrong with the draft, in words, or null. */
function problemOf(d: Draft, rule: Recurrence | null, scope: CalendarScope | null, splitDay: string | null): string | null {
  if (!d.title.trim()) return "Give the event a title.";
  if (!d.startDate || !d.endDate) return "Choose the days.";
  if (!d.allDay && (!d.startTime || !d.endTime)) return "Choose the times, or make it all day.";
  if (`${d.endDate} ${d.allDay ? "" : d.endTime}` < `${d.startDate} ${d.allDay ? "" : d.startTime}`) return "It can't end before it starts.";
  if (scope !== "this" && !d.allSites && d.siteIds.length === 0) return "Choose at least one site, or make it for every site.";
  if (scope === "following" && splitDay && d.startDate < splitDay) return `From this one on starts on or after ${longDay(splitDay)}.`;
  if (rule) return ruleProblem(d.startDate, rule);
  return null;
}

/**
 * Add or change an event. A new one opens on the day (and time) it was asked
 * for. A repeating one's "this event" edit changes only that day's title,
 * time, place and notes; its repeat, sites and category belong to the series.
 */
export function EventEditor({ target, onClose }: { target: EditorTarget | null; onClose: () => void }) {
  return target ? <EditorDialog key={target.mode === "new" ? `new-${target.day}-${target.minutes}` : `${target.series.id}-${target.scope}-${target.occ?.key}`} target={target} onClose={onClose} /> : null;
}

function EditorDialog({ target, onClose }: { target: EditorTarget; onClose: () => void }) {
  const toast = useToast();
  const { data: categories } = useCalendarCategories();
  const { data: sites } = useSites();
  const [draft, setDraft] = useState<Draft>(() => draftFor(target));
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const scope = target.mode === "edit" ? target.scope : null;
  const single = scope === "this" && target.mode === "edit" && Boolean(target.series.recurrence);
  const splitDay = target.mode === "edit" && scope === "following" ? target.occ?.date ?? null : null;
  const rule = useMemo(() => (single ? null : ruleOf(draft)), [draft, single]);
  const problem = problemOf(draft, rule, scope, splitDay);
  const presets = useMemo(() => repeatPresets(draft.startDate || "2026-01-01"), [draft.startDate]);
  useEffect(() => setError(null), [draft]);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  // Moving the start moves the end with it, keeping the length.
  const setStartDate = (startDate: string) =>
    setDraft((d) => {
      if (!startDate) return { ...d, startDate };
      const next = { ...d, startDate, endDate: addDays(startDate, Math.max(0, daysApart(d.startDate, d.endDate))) };
      // A quick choice that doesn't exist for the new day ("the last Friday") becomes the custom pattern it was.
      if (d.repeatKey !== "none" && d.repeatKey !== "custom" && !repeatPresets(startDate).some((p) => p.key === d.repeatKey)) {
        const old = repeatPresets(d.startDate).find((p) => p.key === d.repeatKey)?.rule;
        if (old) Object.assign(next, { repeatKey: "custom", custom: withoutEnd(old) });
      }
      if (next.end.until < startDate) next.end = { ...next.end, until: addDays(startDate, 90) };
      return next;
    });
  const setStartTime = (startTime: string) =>
    setDraft((d) => {
      if (!startTime || !d.startTime || !d.endTime) return { ...d, startTime };
      const length = daysApart(d.startDate, d.endDate) * 1440 + minutesOf(d.endTime) - minutesOf(d.startTime);
      const end = minutesOf(startTime) + Math.max(0, length);
      return { ...d, startTime, endDate: addDays(d.startDate, Math.floor(end / 1440)), endTime: timeOf(end % 1440) };
    });

  const save = useCalendarMutation(async (input: CalendarEventInput) =>
    target.mode === "new" ? calendarApi.create(input) : calendarApi.update(target.series.id, { scope: target.scope, date: target.occ?.date, event: input })
  );

  function submit() {
    setTouched(true);
    if (problem) return;
    const input: CalendarEventInput = {
      title: draft.title.trim(),
      description: draft.description.trim() || null,
      location: draft.location.trim() || null,
      categoryId: draft.categoryId,
      allSites: draft.allSites,
      siteIds: draft.allSites ? [] : draft.siteIds,
      allDay: draft.allDay,
      startDate: draft.startDate,
      startTime: draft.allDay ? null : draft.startTime,
      endDate: draft.endDate,
      endTime: draft.allDay ? null : draft.endTime,
      recurrence: single ? (target.mode === "edit" ? target.series.recurrence : null) : rule,
    };
    save.mutate(input, {
      onSuccess: () => {
        toast(target.mode === "new" ? `Added “${input.title}”` : "Saved");
        onClose();
      },
      onError: (e) => setError(errorMessage(e, "Couldn't save the event. Try again.")),
    });
  }

  const title = target.mode === "new" ? "New event" : single ? "Edit this event" : scope === "following" ? "Edit this and following" : "Edit event";

  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={title}
      dialogClassName="w-[min(680px,calc(100vw-2rem))]"
      dialogBodyClassName="max-h-[min(70vh,720px)] overflow-y-auto scroll-thin"
      footer={
        <>
          {(error || (touched && problem)) && <p className="mr-auto hidden text-[13px] font-semibold text-status-redText md:block">{error ?? problem}</p>}
          <Button variant="secondary" onClick={onClose} className="min-h-[48px] flex-1 md:min-h-0 md:flex-none">Cancel</Button>
          <Button onClick={submit} disabled={save.isPending} className="min-h-[48px] flex-1 md:min-h-0 md:flex-none">
            {save.isPending ? "Saving…" : target.mode === "new" ? "Add event" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-5 pb-2">
        {(error || (touched && problem)) && <p className="rounded-input bg-status-redBg px-3 py-2 text-[13px] font-semibold text-status-redText md:hidden">{error ?? problem}</p>}

        <Field label="Title">
          <Input
            value={draft.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="What's happening"
            maxLength={160}
            autoFocus={target.mode === "new"}
            className="min-h-[44px] text-[15px] font-semibold md:min-h-10"
          />
        </Field>

        {/* When */}
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <Label className="mb-0">When</Label>
            <label className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
              All day <Switch checked={draft.allDay} onCheckedChange={(allDay) => set({ allDay })} />
            </label>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <WhenField label="Starts" date={draft.startDate} time={draft.startTime} allDay={draft.allDay} onDate={setStartDate} onTime={setStartTime} />
            <WhenField label="Ends" date={draft.endDate} time={draft.endTime} allDay={draft.allDay} min={draft.startDate} onDate={(endDate) => set({ endDate })} onTime={(endTime) => set({ endTime })} />
          </div>
        </section>

        {/* Repeat */}
        {single && target.mode === "edit" ? (
          <p className="flex items-start gap-2 rounded-input bg-navsel/50 px-3 py-2.5 text-[13px] text-ink">
            <Repeat className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Part of a series ({target.series.repeatText}). These changes are for {target.occ ? longDay(target.occ.date) : "this day"} only. To change how it repeats, who it's for or its category, edit all events.
            </span>
          </p>
        ) : (
          <section className="space-y-3">
            <Field label="Repeat">
              <Select
                value={draft.repeatKey}
                onChange={(e) => {
                  const key = e.target.value;
                  // Custom starts from what was chosen, so it's a tweak rather than a blank.
                  const from = presets.find((p) => p.key === draft.repeatKey)?.rule;
                  set(key === "custom" ? { repeatKey: key, custom: from ? withoutEnd(canonicalRule(draft.startDate, from)) : draft.custom } : { repeatKey: key });
                }}
                className="min-h-[44px] md:min-h-9"
              >
                {presets.map((p) => (
                  <option key={p.key} value={p.key}>{p.label}</option>
                ))}
                <option value="custom">Custom…</option>
              </Select>
            </Field>
            {draft.repeatKey === "custom" && <CustomRepeat value={draft.custom} start={draft.startDate} onChange={(custom) => set({ custom })} />}
            {rule && (
              <>
                <EndFields value={draft.end} start={draft.startDate} onChange={(end) => set({ end })} />
                <RepeatSummary rule={rule} start={draft.startDate} problem={draft.startDate ? ruleProblem(draft.startDate, rule) : null} />
              </>
            )}
          </section>
        )}

        {!single && (
          <>
            {/* Who sees it */}
            <section className="space-y-2">
              <Label>Who it's for</Label>
              <div role="radiogroup" className="grid grid-cols-2 gap-2">
                <Choice on={draft.allSites} onClick={() => set({ allSites: true })} title="Every site" hint="Everyone sees it" />
                <Choice on={!draft.allSites} onClick={() => set({ allSites: false })} title="Chosen sites" hint={draft.allSites ? "Only people at those sites" : `${draft.siteIds.length} chosen`} />
              </div>
              {!draft.allSites && (
                <CheckboxList
                  options={(sites ?? []).map((s) => ({ value: s.id, label: s.name }))}
                  value={draft.siteIds}
                  onChange={(siteIds) => set({ siteIds })}
                  className="max-h-[220px] overflow-y-auto scroll-thin"
                />
              )}
            </section>

            {/* Category */}
            <section>
              <Label>Category</Label>
              <div className="flex flex-wrap gap-1.5">
                <CategoryChip on={draft.categoryId === null} color={categoryColor(null)} label="None" onClick={() => set({ categoryId: null })} />
                {(categories ?? []).map((c) => (
                  <CategoryChip key={c.id} on={draft.categoryId === c.id} color={categoryColor(c.colorSlot)} label={c.name} onClick={() => set({ categoryId: c.id })} />
                ))}
              </div>
            </section>
          </>
        )}

        <Field label="Location">
          <Input value={draft.location} onChange={(e) => set({ location: e.target.value })} placeholder="Room, building or address" maxLength={200} className="min-h-[44px] md:min-h-9" />
        </Field>
        <Field label="Notes">
          <Textarea value={draft.description} onChange={(e) => set({ description: e.target.value })} placeholder="Anything people should know" maxLength={4000} rows={4} />
        </Field>
      </div>
    </ResponsiveDialog>
  );
}

function WhenField({
  label, date, time, allDay, min, onDate, onTime,
}: {
  label: string;
  date: string;
  time: string;
  allDay: boolean;
  min?: string;
  onDate: (v: string) => void;
  onTime: (v: string) => void;
}) {
  return (
    <div>
      <p className="mb-1 text-[12px] font-semibold text-muted">{label}</p>
      <div className="flex gap-2">
        <Input type="date" value={date} min={min} onChange={(e) => onDate(e.target.value)} aria-label={`${label} day`} className="min-h-[44px] min-w-0 flex-1 md:min-h-9" />
        {!allDay && <Input type="time" step={300} value={time} onChange={(e) => onTime(e.target.value)} aria-label={`${label} time`} className="min-h-[44px] w-[128px] md:min-h-9" />}
      </div>
    </div>
  );
}

function Choice({ on, onClick, title, hint }: { on: boolean; onClick: () => void; title: string; hint: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cn("rounded-input border px-3 py-2 text-left transition-colors", on ? "border-navy bg-navsel/60 dark:border-white/60" : "border-hairline hover:bg-rowhover")}
    >
      <span className="block text-[13.5px] font-semibold text-ink">{title}</span>
      <span className="block text-micro text-muted">{hint}</span>
    </button>
  );
}

function CategoryChip({ on, color, label, onClick }: { on: boolean; color: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-[36px] items-center gap-1.5 rounded-pill border px-3 text-[12.5px] transition-colors md:min-h-[32px]",
        on ? "border-navy bg-navsel font-bold text-accent dark:border-white/60 dark:text-white" : "border-hairline bg-surface font-medium text-ink hover:bg-navsel/60"
      )}
    >
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      {label}
    </button>
  );
}
