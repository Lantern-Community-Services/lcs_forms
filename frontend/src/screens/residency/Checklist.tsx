import { CalendarClock } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { TaskLine } from "@/components/residency/ResidencyCards";
import { SitePicker, useSiteSelection } from "@/lib/site";
import { useAuth } from "@/lib/auth";
import { fmtDay, useResidencyFor, useTasks } from "@/lib/residency";
import { useSearchParam } from "@/lib/useSearchParam";
import { cn } from "@/lib/utils";

const VIEWS = [
  ["due", "Due soon"],
  ["overdue", "Overdue"],
  ["open", "All open"],
  ["done", "Done"],
] as const;

/**
 * The move-in checklist across residents: what's overdue, what's due in the
 * next two weeks, everything open, and what was done lately. "Only mine": the
 * residents you're case lead for (client information's case lead).
 */
export function ChecklistPage() {
  const { can } = useAuth();
  const { codes, setCodes, selected, param } = useSiteSelection();
  const residencyFor = useResidencyFor();
  const on = selected.some((s) => residencyFor(s));
  const [viewParam, setView] = useSearchParam("view");
  const view = VIEWS.some(([k]) => k === viewParam) ? viewParam! : "due";
  const [mineParam, setMine] = useSearchParam("mine");
  const mine = mineParam === "1";
  const { data, isLoading } = useTasks(param, view, mine, on);
  const tick = can("roster.edit") || can("clients.edit");
  const items = data?.items ?? [];
  const overdue = items.filter((t) => (t.overdueDays ?? 0) > 0).length;

  return (
    <Page className="max-w-[860px]">
      <PageHeader
        title="Checklist"
        subtitle="Paperwork each resident is owed since moving in: assessments, face sheets, monthly housing assessments."
        actions={<SitePicker codes={codes} onChange={setCodes} className="w-full md:w-[260px]" />}
      />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="grid grid-cols-4 rounded-input bg-navsel/60 p-0.5" role="tablist">
          {VIEWS.map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={view === k}
              onClick={() => setView(k)}
              className={cn("min-h-[36px] rounded-[5px] px-3 text-[12.5px] font-bold", view === k ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink")}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-[13px] text-muted">
          <Switch checked={mine} onCheckedChange={(v) => setMine(v ? "1" : "")} /> Only residents I'm case lead for
        </label>
      </div>
      {!on ? (
        <EmptyState title="No checklist here" hint="The checklist is for supportive sites while case management is on." icon={<CalendarClock className="h-8 w-8" />} />
      ) : isLoading || !data ? (
        <LoadingState />
      ) : items.length === 0 ? (
        <EmptyState title={view === "done" ? "Nothing done in the last 90 days" : "Nothing due"} hint={mine ? "Turn off “Only residents I'm case lead for” to see everyone." : undefined} />
      ) : (
        <>
          <p className="mb-2 text-micro text-muted">
            {items.length} {items.length === 1 ? "item" : "items"}{view !== "done" && overdue ? ` · ${overdue} overdue` : ""}
          </p>
          <Card className="px-4">
            <ul className="divide-y divide-hairline">
              {view === "done"
                ? items.map((t) => (
                    <li key={t.id} className="py-2.5 text-[13px]">
                      <span className="font-semibold text-ink">{t.resident?.displayName}</span>
                      <span className="text-muted"> · {t.label}</span>
                      <span className="block text-micro text-muted">
                        {t.status === "skipped" ? "Not needed" : "Done"} {fmtDay(t.doneOn)}{t.doneByName ? ` by ${t.doneByName}` : ""} · was due {fmtDay(t.dueOn)}{t.note ? ` · ${t.note}` : ""}
                      </span>
                    </li>
                  ))
                : items.map((t) => <TaskLine key={t.id} task={t} canTick={tick} showResident />)}
            </ul>
          </Card>
        </>
      )}
    </Page>
  );
}
