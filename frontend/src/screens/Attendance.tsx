import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, ClipboardCheck, Plus } from "lucide-react";
import { Page } from "@/components/shell/AppShell";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import { useInSectionTabs } from "@/components/shell/SectionTabs";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState, LoadMore, LoadingState } from "@/components/ui/misc";
import { AttendanceExportButtons, AttendanceExportMenu } from "@/components/attendance/AttendanceExport";
import { TakeAttendanceDialog } from "@/components/attendance/TakeAttendanceDialog";
import { useAttendanceList } from "@/lib/queries";
import { SitePicker, selectionLabel, useSiteSelection } from "@/lib/site";
import { useAuth } from "@/lib/auth";
import { useSearchParam } from "@/lib/useSearchParam";
import { errorMessage, relativeTime, toggled } from "@/lib/utils";
import type { AttendanceEvent } from "@/lib/types";

type Tab = "record" | "past";

/**
 * Record attendance (just the big "Take attendance" action) and Past
 * attendance (the filterable, multi-selectable history with print/export) as
 * two tabs — keeps the record flow from being crowded by controls that only
 * matter once there's history to sift through.
 */
export function AttendancePage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const inTabs = useInSectionTabs();
  const [tabParam, setTab] = useSearchParam("tab");
  const { codes, setCodes, selected, param, isLoading: sitesLoading } = useSiteSelection();
  const [q, setQ] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [taking, setTaking] = useState(false);
  const tab = (tabParam as Tab) || "record";
  const multiSite = selected.length > 1;
  const { data, isLoading, isError, error, hasNextPage, fetchNextPage, isFetchingNextPage } = useAttendanceList(
    param,
    q.trim(),
    tab === "past" && selected.length > 0
  );
  const items = data?.pages.flatMap((page) => page.items) ?? [];

  // A selection only makes sense against what's actually on screen.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [param, q, tab]);

  const canTake = can("roster.edit") && selected.length > 0;
  const hasSelection = selectedIds.size > 0;
  const exportView = { site: param, q: q.trim(), ids: hasSelection ? [...selectedIds] : undefined };
  const subtitle = selected.length ? selectionLabel(codes, selected) : undefined;

  function toggleOne(id: string) {
    setSelectedIds((prev) => toggled(prev, id));
  }

  function toggleAll() {
    setSelectedIds((prev) => (prev.size === items.length && items.length > 0 ? new Set() : new Set(items.map((e) => e.id))));
  }

  const search = <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title or description" />;

  const selectionBar = hasSelection && (
    <div className="flex items-center justify-between gap-3 rounded-input bg-navsel/60 px-3 py-2 text-[12.5px] font-semibold text-ink md:w-auto md:justify-start">
      <span>{selectedIds.size} selected</span>
      <button type="button" onClick={() => setSelectedIds(new Set())} className="text-accent dark:text-white">
        Clear
      </button>
    </div>
  );

  const backToRecord = (
    <button
      type="button"
      onClick={() => setTab("record")}
      className="-ml-2 inline-flex min-h-[36px] items-center gap-1 self-start px-2 text-[13px] font-semibold text-accent dark:text-white"
    >
      <ChevronLeft className="h-4 w-4" /> Record attendance
    </button>
  );

  return (
    <div className="flex min-h-full flex-col">
      <PhoneHeader
        title="Attendance"
        subtitle={tab === "past" ? subtitle : undefined}

        actions={
          tab === "past" ? (
            <div className="flex gap-2">
              <AttendanceExportMenu view={exportView} disabled={selected.length === 0} />
            </div>
          ) : undefined
        }
      >
        {tab === "past" && (
          <div className="mt-3 flex flex-col gap-2.5">
            {backToRecord}
            <SitePicker codes={codes} onChange={setCodes} />
            {search}
            {selectionBar}
          </div>
        )}
      </PhoneHeader>

      <Page className="w-full flex-1 !px-0 md:!px-7">
        <div className="hidden md:block">
          {tab === "past" && <div className="mb-2">{backToRecord}</div>}
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              {!inTabs && <h1 className="text-[23px] font-heading font-extrabold text-ink md:text-[24px]">Attendance</h1>}
              {tab === "past" && subtitle && <p className={`text-[13px] text-muted md:text-[13.5px] ${inTabs ? "" : "mt-1"}`}>{subtitle}</p>}
            </div>
            {tab === "past" && (
              <div className="flex flex-wrap items-center gap-2">
                <SitePicker codes={codes} onChange={setCodes} className="w-[240px]" />
                <AttendanceExportButtons view={exportView} disabled={selected.length === 0} />
              </div>
            )}
          </div>
          {tab === "past" && (
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <div className="min-w-[220px] flex-1">{search}</div>
              {selectionBar}
            </div>
          )}
        </div>

        {tab === "record" ? (
          <RecordAttendancePanel
            canTake={canTake}
            noSites={!sitesLoading && selected.length === 0}
            onTake={() => setTaking(true)}
            onViewPast={() => setTab("past")}
          />
        ) : sitesLoading || isLoading ? (
          <LoadingState />
        ) : isError ? (
          <EmptyState title="Could not load attendance" hint={errorMessage(error, "Try again in a moment.")} />
        ) : selected.length === 0 ? (
          <EmptyState title="No sites assigned" hint="You aren't assigned to any sites yet." icon={<ClipboardCheck className="h-8 w-8" />} />
        ) : items.length === 0 ? (
          <EmptyState
            title={q ? "No matching attendance" : "No attendance taken yet"}
            hint={q ? "Try a different title or description." : canTake ? "Switch to Record attendance to take the first one." : undefined}
            icon={<ClipboardCheck className="h-8 w-8" />}
          />
        ) : (
          <>
            <Card className="rounded-none border-x-0 md:rounded-card md:border-x">
              <div className="flex items-center gap-3 border-b border-hairline px-4 py-2">
                <Checkbox checked={items.length > 0 && selectedIds.size === items.length} onCheckedChange={toggleAll} aria-label="Select all" />
                <span className="text-micro font-semibold text-muted">Select all</span>
              </div>
              <ul>
                {items.map((e) => (
                  <AttendanceRow key={e.id} e={e} multiSite={multiSite} checked={selectedIds.has(e.id)} onToggle={() => toggleOne(e.id)} />
                ))}
              </ul>
            </Card>
            {hasNextPage && <LoadMore loading={isFetchingNextPage} onClick={() => void fetchNextPage()} />}
          </>
        )}
      </Page>

      <TakeAttendanceDialog
        open={taking}
        onOpenChange={setTaking}
        defaultSiteCode={selected.length === 1 ? selected[0].code : undefined}
        onSaved={(id) => navigate(`/roster/attendance/${id}`)}
      />
    </div>
  );
}

function RecordAttendancePanel({
  canTake,
  noSites,
  onTake,
  onViewPast,
}: {
  canTake: boolean;
  noSites: boolean;
  onTake: () => void;
  onViewPast: () => void;
}) {
  return (
    <div className="flex min-h-[55vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-navsel/60 text-accent dark:text-white">
        <ClipboardCheck className="h-8 w-8" />
      </div>
      <div className="max-w-[360px]">
        <h2 className="text-[19px] font-heading font-extrabold text-ink">Take attendance</h2>
        <p className="mt-1.5 text-[14px] text-muted">Start a roll call for one of your sites — mark who's here and capture signatures as you go.</p>
      </div>
      {noSites ? (
        <p className="text-[13px] text-muted">You aren't assigned to any sites yet.</p>
      ) : (
        <Button onClick={onTake} disabled={!canTake} className="min-h-[52px] px-8 text-[15px]">
          <Plus className="h-5 w-5" /> Take attendance
        </Button>
      )}
      <button type="button" onClick={onViewPast} className="inline-flex items-center gap-1 text-[13.5px] font-semibold text-accent dark:text-white">
        View past attendance <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}

function AttendanceRow({ e, multiSite, checked, onToggle }: { e: AttendanceEvent; multiSite: boolean; checked: boolean; onToggle: () => void }) {
  return (
    <li className="flex items-center gap-3 border-b border-hairline px-4 py-3 last:border-0 hover:bg-rowhover">
      <Checkbox checked={checked} onCheckedChange={onToggle} aria-label={`Select ${e.title}`} />
      <Link to={`/roster/attendance/${e.id}`} className="flex min-w-0 flex-1 items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14.5px] font-semibold text-ink">{e.title}</span>
          <span className="block truncate text-micro text-muted">
            {multiSite ? `${e.site.name} · ` : ""}
            {relativeTime(e.occurredAt)} · {e.createdByName}
          </span>
        </span>
        <span className="shrink-0 text-right text-micro text-muted">
          <span className="block font-semibold tabular text-ink">{e.presentCount} present</span>
          <span className="block tabular">{e.signedCount} signed</span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
      </Link>
    </li>
  );
}
