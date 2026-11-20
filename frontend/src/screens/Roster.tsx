import { Fragment, memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Plus, Users } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { TenantStatusBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { AddResident } from "@/components/roster/AddResident";
import { HighAcuityFlag } from "@/components/roster/HighAcuity";
import { RosterExportButtons, RosterExportMenu } from "@/components/roster/RosterExport";
import { RemoveDialog } from "@/components/roster/RemoveDialog";
import { SendSiteToReview } from "@/components/roster/SendSiteToReview";
import { RemoveResidentIcon } from "@/components/roster/RemoveResidentIcon";
import { useRosterActions } from "@/components/roster/useRosterActions";
import { MoveInDialog, MoveOutDialog } from "@/components/residency/Dialogs";
import { useTenants } from "@/lib/queries";
import { SitePicker, useSiteSelection } from "@/lib/site";
import { useAuth } from "@/lib/auth";
import { fmtDay, shortRelation, useResidencyFor, useUnits, type UnitRow } from "@/lib/residency";
import { readStoredJson, writeStorage } from "@/lib/storage";
import { useSearchParam } from "@/lib/useSearchParam";
import { cn, formatDate, formatDay, relativeTime, tintFor, toggled } from "@/lib/utils";
import type { Tenant } from "@/lib/types";

/**
 * "all", "vacant": case management at supportive sites, where people are
 * assigned to units and a unit nobody lives in shows as vacant.
 */
type Tab = "all" | "active" | "vacant" | "attention" | "archived";

/** A line of the list: a resident, or a unit nobody lives in. */
type Row =
  | { kind: "tenant"; key: string; siteId: string; siteName: string; t: Tenant }
  | { kind: "vacant"; key: string; siteId: string; siteName: string; u: UnitRow };

const unitCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

const COLLAPSED_KEY = "ln.roster.collapsed";

/**
 * Rendering ~1,900 rows in one go blocked the main thread for half a second.
 * Instead the first screenful renders immediately (and slides in), and the rest
 * are appended a batch per frame, but only while the end of the list is within
 * reach of the screen (see useProgressiveCount). Building all of them anyway
 * came to ~46,000 elements: on an iPad that kept every tap waiting while it ran,
 * and made leaving the Roster slow.
 */
const FIRST_BATCH = 40;
const BATCH = 120;
/** How many of the first rows get the staggered entrance. More would just delay the last of them. */
const STAGGERED = 24;
const STAGGER_MS = 16;
const REVEAL_WIDTH = 88;
const FULL_SWIPE = 164;
const openSwipeRowClosers = new Map<string, () => void>();

function closeOpenSwipeRows(exceptId?: string) {
  for (const [id, close] of openSwipeRowClosers) if (id !== exceptId) close();
}

/** How close to the screen (px) the end of the list has to be for the next batch to be built. */
const BUILD_AHEAD = 1600;

/** `layout` changes when the list's height can change without a scroll (sites folded or unfolded): time to measure again. */
function useProgressiveCount(total: number, resetKey: string, sentinel: HTMLElement | null, layout: unknown) {
  const [state, setState] = useState({ key: resetKey, count: 1 });
  // Reset during render, not in an effect: an effect would let one full-size
  // render through first (the old count against the new list) — the very
  // freeze this exists to avoid.
  const count = state.key === resetKey ? state.count : 1;
  if (state.key !== resetKey) setState({ key: resetKey, count: 1 });

  // Paused while the end of what's built is far below the screen; scrolling
  // towards it (or the list or window changing size) resumes. Measured directly rather than with an
  // IntersectionObserver, whose callbacks wait for a rendered frame, and a
  // backgrounded or throttled page may not render one for a long time.
  const [paused, setPaused] = useState(false);
  const near = () => {
    if (!sentinel) return true;
    const root = sentinel.closest("main");
    const bottom = root ? root.getBoundingClientRect().bottom : window.innerHeight;
    return sentinel.getBoundingClientRect().top - bottom < BUILD_AHEAD;
  };
  useEffect(() => {
    if (count >= total) return;
    if (!near()) {
      setPaused(true);
      return;
    }
    if (paused) setPaused(false);
    return nextTask(() => setState((st) => ({ ...st, count: Math.min(total, st.count + 1) })));
  }, [count, total, paused, sentinel, layout]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!paused || !sentinel) return;
    const root = sentinel.closest("main") ?? window;
    const check = () => {
      if (near()) setPaused(false);
    };
    root.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    // Folding sites shrinks the list without any scroll: watch its size too.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(check);
    if (sentinel.parentElement) ro?.observe(sentinel.parentElement);
    return () => {
      root.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
      ro?.disconnect();
    };
  }, [paused, sentinel]); // eslint-disable-line react-hooks/exhaustive-deps
  return Math.min(count, total);
}

/**
 * Run `fn` as its own task, after the browser has had a chance to paint.
 * A MessageChannel message, like React's scheduler uses: timers and rAF are
 * throttled to ~1/s in a background tab, which would leave the list half-built
 * for seconds when somebody switches back to it. Returns a canceller.
 */
function nextTask(fn: () => void): () => void {
  let live = true;
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    if (live) fn();
  };
  channel.port2.postMessage(null);
  return () => {
    live = false;
    channel.port1.close();
  };
}

/** Placeholder rows while the roster downloads — the shape of the list, shimmering. */
function RosterSkeleton() {
  return (
    <div className="border-y border-hairline bg-surface lg:rounded-card lg:border-x" aria-busy="true" aria-label="Loading roster">
      {Array.from({ length: 9 }, (_, i) => (
        <div
          key={i}
          className="page-list-item-enter flex items-center gap-3 border-b border-hairline px-4 py-3 last:border-0"
          style={{ animationDelay: `${i * 35}ms` }}
        >
          <span className="bill-skeleton-shimmer h-4 w-10 shrink-0 rounded-input" />
          <span className="min-w-0 flex-1 space-y-1.5">
            <span className="bill-skeleton-shimmer block h-3.5 rounded-input" style={{ width: `${46 + ((i * 37) % 30)}%` }} />
            <span className="bill-skeleton-shimmer block h-2.5 w-24 rounded-input" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Which site groups are folded, remembered per device. */
function useCollapsedSites() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const raw = readStoredJson(COLLAPSED_KEY);
    return new Set(Array.isArray(raw) ? raw : []);
  });
  useEffect(() => writeStorage(COLLAPSED_KEY, JSON.stringify([...collapsed])), [collapsed]);
  const toggle = useCallback((siteId: string) => setCollapsed((c) => toggled(c, siteId)), []);
  return { collapsed, setCollapsed, toggle };
}

/**
 * The living roster for whichever of my sites are selected — All by default.
 * The whole selection comes down in one request (every Lantern site together
 * is ~2,000 people) and search filters in memory, so typing is instant on a
 * phone with a weak signal in a stairwell. With more than one site in view the
 * list is grouped under a heading per site.
 */
export function RosterPage() {
  const { can } = useAuth();
  const { codes, setCodes, selected, sites, param, isLoading: sitesLoading } = useSiteSelection();
  const multiSite = selected.length > 1;
  // Case management at supportive sites: units, vacancies, move-ins.
  const residencyFor = useResidencyFor();
  const unitsMode = selected.some((s) => residencyFor(s));
  const [tabParam, setTab] = useSearchParam("tab");
  const wanted = (tabParam as Tab) || (unitsMode ? "all" : "active");
  // ?tab=attention from a link or bookmark is the plain roster for someone who doesn't review;
  // All and Vacant are the plain roster where there are no units.
  const tab: Tab =
    wanted === "attention" && !can("roster.archive") ? "active" : (wanted === "all" || wanted === "vacant") && !unitsMode ? "active" : wanted;
  const [q, setQ] = useState("");
  const query = useDeferredValue(q.trim().toLowerCase());
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Tenant | null>(null);
  const [movingOut, setMovingOut] = useState<Tenant | null>(null);
  const [moveInto, setMoveInto] = useState<UnitRow | null>(null);
  const { remove, restore, keep } = useRosterActions();
  // Rows are memoised (see RosterRow), so what they're handed must be stable —
  // a fresh function per render would re-render every row on every batch.
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  const onRestore = useCallback((t: Tenant) => void restoreRef.current(t), []);
  const keepRef = useRef(keep);
  keepRef.current = keep;
  // "Still here" straight from the row, for someone who needs a check-in.
  const onKeep = useCallback((t: Tenant) => void keepRef.current(t), []);
  const { collapsed, setCollapsed, toggle: toggleSite } = useCollapsedSites();
  const siteById = useMemo(() => new Map(selected.map((s) => [s.id, s])), [selected]);
  // Someone living in a unit moves out; anyone else is removed (a duplicate, a mistake).
  const unitsRef = useRef({ residencyFor, siteById });
  unitsRef.current = { residencyFor, siteById };
  const onRemove = useCallback((t: Tenant) => {
    const { residencyFor: on, siteById: by } = unitsRef.current;
    if (t.unitId && on(by.get(t.siteId))) setMovingOut(t);
    else setRemoving(t);
  }, []);

  // "attention" is a view of the active list, so it reuses that request.
  const { data, isLoading } = useTenants(param, tab === "archived" ? "archived" : "active", selected.length > 0);
  const all = data?.items ?? [];
  const { data: unitData } = useUnits(param, unitsMode && tab !== "archived");
  const vacantUnits = useMemo(() => (unitData?.units ?? []).filter((u) => u.vacant && siteById.has(u.siteId)), [unitData, siteById]);

  const rows = useMemo<Row[]>(() => {
    const match = (vals: (string | null | undefined)[]) => !query || vals.some((v) => v?.toLowerCase().includes(query));
    const people = (list: Tenant[]) =>
      list
        // An old name finds them too (formerNames, kept on each rename).
        .filter((t) => match([t.displayName, t.firstName, t.lastName, t.preferredName, t.unit, multiSite ? t.site?.name : null, ...(t.formerNames ?? [])]))
        .map((t): Row => ({ kind: "tenant", key: t.id, siteId: t.siteId, siteName: t.site?.name ?? siteById.get(t.siteId)?.name ?? "", t }));
    if (tab === "attention") return people(all.filter((t) => t.needsAttention));
    if (tab === "active" || tab === "archived") return people(all);
    const vacant = vacantUnits
      .filter((u) => match([u.label, "vacant", u.unitType, multiSite ? siteById.get(u.siteId)?.name : null]))
      .map((u): Row => ({ kind: "vacant", key: `unit:${u.id}`, siteId: u.siteId, siteName: siteById.get(u.siteId)?.name ?? "", u }));
    const list = tab === "vacant" ? vacant : [...people(all), ...vacant];
    // By site, then unit (anyone without one last), a head of household before
    // their household, then by name.
    const unitOf = (r: Row) => (r.kind === "vacant" ? r.u.label : r.t.unit);
    return list.sort(
      (a, b) =>
        unitCollator.compare(a.siteName, b.siteName) ||
        Number(!unitOf(a)) - Number(!unitOf(b)) ||
        unitCollator.compare(unitOf(a) ?? "", unitOf(b) ?? "") ||
        (a.kind === "tenant" && b.kind === "tenant"
          ? Number(Boolean(a.t.householdHeadId)) - Number(Boolean(b.t.householdHeadId)) || a.t.displayName.localeCompare(b.t.displayName)
          : Number(a.kind === "tenant") - Number(b.kind === "tenant"))
    );
  }, [all, tab, query, multiSite, vacantUnits, siteById]);

  // Grouped by site whenever more than one is in view. The archived tab is
  // sorted by removal date across sites, so it stays one flat list.
  const grouped = multiSite && tab !== "archived";
  const groups = useMemo(() => {
    const m = new Map<string, { count: number; attention: number }>();
    for (const r of rows) {
      const g = m.get(r.siteId) ?? { count: 0, attention: 0 };
      g.count++;
      if (r.kind === "tenant" && r.t.needsAttention) g.attention++;
      m.set(r.siteId, g);
    }
    return m;
  }, [rows]);
  const allFolded = grouped && [...groups.keys()].every((id) => collapsed.has(id));

  // The list, cut into chunks: the first screenful, then fixed-size batches.
  // Each chunk is a memoised component with a stable slice, so adding one makes
  // React compare a dozen chunks rather than ~1,900 rows. Site headings are
  // decided here, across chunk boundaries.
  const chunks = useMemo(() => {
    const out: { r: Row; heading: boolean; index: number }[][] = [];
    let size = FIRST_BATCH;
    for (let i = 0; i < rows.length; i += size, size = BATCH) {
      out.push(
        rows.slice(i, i + size).map((r, j) => ({
          r,
          index: i + j,
          heading: grouped && r.siteId !== rows[i + j - 1]?.siteId,
        }))
      );
    }
    return out;
  }, [rows, grouped]);
  // A search looks through folded sites too — hiding a match would read as "not found".
  const folded = useMemo(() => (grouped && !query ? collapsed : NO_SITES), [grouped, query, collapsed]);
  // Restart the progressive render whenever the list itself changes.
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const shownChunks = useProgressiveCount(chunks.length, `${param ?? "all"}|${tab}|${query}`, sentinel, folded);

  const onRoster = selected.reduce((n, s) => n + s.activeCount, 0);
  const attention = tab === "archived" ? selected.reduce((n, s) => n + s.attentionCount, 0) : all.filter((t) => t.needsAttention).length;

  const canAdd = can("roster.edit") && selected.length > 0;
  const reviews = can("roster.archive");
  // Exports and printouts are of exactly this: selection, tab and search (All and Vacant export the roster).
  const exportView = { site: param, status: tab === "all" || tab === "vacant" ? "active" : tab, q };
  const vacantCount = vacantUnits.length;
  const subtitle = selected.length
    ? `${onRoster.toLocaleString()} on roster${unitsMode ? ` · ${vacantCount} vacant` : ""}`
    : undefined;
  const tabs = (
    [
      ...(unitsMode ? [["all", "All", undefined]] : []),
      ["active", "On roster", onRoster],
      ...(unitsMode ? [["vacant", "Vacant", vacantCount]] : []),
      // Review: only for people who can Keep or Remove.
      // "Needs check-in", not a second "Review": the Review tab above is the one-at-a-time deck.
      ...(reviews ? [["attention", "Needs check-in", attention]] : []),
      ["archived", "Removed", undefined],
    ] as [Tab, string, number | undefined][]
  );

  const controls = (
    <>
      <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={unitsMode ? "Search name, unit or “vacant”" : "Search name or unit"} />
      {/* Five tabs don't fit a phone side by side: there they scroll; from a tablet up, they share the width. */}
      <div className="flex overflow-x-auto rounded-input bg-navsel/60 p-0.5 md:grid" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }} role="tablist">
        {tabs.map(([key, label, count]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              "flex min-h-[38px] shrink-0 grow items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] px-2.5 text-label font-bold transition-colors md:min-h-[30px] touch:min-h-11",
              tab === key ? "bg-surface text-ink shadow-sm dark:bg-strongline" : "text-muted hover:text-ink"
            )}
          >
            {label}
            {count !== undefined && count > 0 && (
              <span className={cn("tabular text-micro", key === "attention" ? "rounded-pill bg-status-amberBg px-1.5 font-bold text-status-amberText" : "text-muted")}>{count}</span>
            )}
          </button>
        ))}
      </div>
    </>
  );
  return (
    <div className="flex min-h-full flex-col">
      <PhoneHeader
        title="Roster"
        help={{ article: "roster", text: "The residents at your sites. Search by name or unit, and open someone for their details." }}
        subtitle={subtitle}
        actions={
          <div className="flex gap-2">
            <RosterExportMenu view={exportView} disabled={selected.length === 0} />
            {canAdd && (
              <Button onClick={() => setAdding(true)} className="min-h-[44px] px-3.5" aria-label="Add resident">
                <Plus className="h-5 w-5" /> Add
              </Button>
            )}
          </div>
        }
      >
        <div className="mt-3 flex flex-col gap-2.5">
          <SitePicker codes={codes} onChange={setCodes} />
          {controls}
        </div>
      </PhoneHeader>

      <Page className="w-full flex-1 !px-0 md:!px-7">
        <div className="hidden md:block">
          <PageHeader
            title="Roster"
            help={{ article: "roster", text: "The residents at your sites. Search by name or unit, and open someone for their details." }}
            subtitle={subtitle}
            actions={
              <>
                <SitePicker codes={codes} onChange={setCodes} className="w-[240px]" />
                {/* A computer gets Print and Export side by side; an iPad one "…" for both, as on a phone. */}
                <span className="contents touch:hidden"><RosterExportButtons view={exportView} disabled={selected.length === 0} /></span>
                <span className="hidden touch:contents"><RosterExportMenu view={exportView} disabled={selected.length === 0} /></span>
                {canAdd && (
                  <Button onClick={() => setAdding(true)}>
                    <Plus className="h-4 w-4" /> Add resident
                  </Button>
                )}
              </>
            }
          />
          <div className={cn("mb-4 grid gap-3", unitsMode ? "lg:grid-cols-[minmax(0,1fr)_520px]" : "lg:grid-cols-[minmax(0,1fr)_440px]")}>{controls}</div>
        </div>

        {tab === "attention" && selected.length === 1 && can("roster.archive") && !sitesLoading && !isLoading && (
          <SendSiteToReview site={selected[0]} onRoster={onRoster} />
        )}
        {sitesLoading || isLoading ? (
          <RosterSkeleton />
        ) : selected.length === 0 ? (
          <EmptyState title="No sites assigned" hint="You aren't assigned to any sites yet, so there's no roster to show. Ask an administrator to add you to one." icon={<Users className="h-8 w-8" />} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={query ? "Nobody matches" : tab === "archived" ? "Nobody removed yet" : tab === "attention" ? "Nobody to review" : tab === "vacant" ? "No vacant units" : "Nobody on this roster"}
            hint={query ? "Try a unit number or part of a name." : tab === "active" && canAdd ? "Tap Add to put the first person on." : undefined}
          />
        ) : (
          <>
          {grouped && (
            <div className="mb-2 flex items-center justify-between px-4 md:px-0">
              <span className="text-micro text-muted">
                {groups.size} sites{query ? " · showing matches in every site" : ""}
              </span>
              <button
                type="button"
                onClick={() =>
                  setCollapsed((c) => {
                    const next = new Set(c);
                    for (const id of groups.keys()) allFolded ? next.delete(id) : next.add(id);
                    return next;
                  })
                }
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-input px-2 text-label font-semibold text-accent hover:bg-subtle2 dark:text-white touch:min-h-11"
              >
                {allFolded ? <ChevronsUpDown className="h-4 w-4" /> : <ChevronsDownUp className="h-4 w-4" />}
                {allFolded ? "Expand all" : "Collapse all"}
              </button>
            </div>
          )}
          <Card className="rounded-none border-x-0 md:rounded-card md:border-x">
            {/* The table layout needs ~1000px; below that (phones and iPads in
                portrait) each row is the stacked list form. */}
            <div className="hidden grid-cols-[88px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_120px_32px] gap-3 border-b border-hairline px-4 py-2.5 text-caption font-semibold text-muted lg:grid">
              <span>Unit</span>
              <span>Name</span>
              <span>{tab === "archived" ? "Removed" : tab === "vacant" ? "Unit type" : "Last on a form"}</span>
              <span>{tab === "archived" ? "Reason" : tab === "vacant" ? "Vacant since" : "Moved in"}</span>
              <span>Status</span>
              <span />
            </div>
            <ul>
              {chunks.slice(0, shownChunks).map((chunk) => (
                <RosterChunk
                  key={chunk[0].r.key}
                  entries={chunk}
                  folded={folded}
                  groups={groups}
                  tab={tab}
                  multiSite={multiSite}
                  query={query}
                  canRestore={can("roster.restore")}
                  canArchive={can("roster.archive")}
                  onToggleSite={toggleSite}
                  onRemove={onRemove}
                  onRestore={onRestore}
                  onKeep={can("roster.edit") ? onKeep : undefined}
                  onMoveIn={can("roster.edit") ? setMoveInto : undefined}
                />
              ))}
            </ul>
            {/* The end of what's built: more is built as this nears the screen. */}
            <div ref={setSentinel} aria-hidden className="h-px" />
          </Card>
          </>
        )}
      </Page>

      {selected.length > 0 && <AddResident open={adding} onOpenChange={setAdding} sites={selected} />}
      {moveInto && siteById.get(moveInto.siteId) && (
        <MoveInDialog open onOpenChange={(o) => !o && setMoveInto(null)} site={siteById.get(moveInto.siteId)!} unit={moveInto} />
      )}
      {movingOut && (
        <MoveOutDialog
          open
          onOpenChange={(o) => !o && setMovingOut(null)}
          tenant={movingOut}
          awaySince={movingOut.awaySince}
          household={
            (unitData?.units ?? []).find((u) => u.id === movingOut.unitId)?.occupants ??
            [{ id: movingOut.id, displayName: movingOut.displayName, head: true, relation: null, away: false, highAcuity: false }]
          }
        />
      )}
      <RemoveDialog
        tenant={removing}
        onCancel={() => setRemoving(null)}
        onConfirm={async (reason, note) => {
          const t = removing!;
          setRemoving(null);
          await remove(t, reason, note);
        }}
      />
    </div>
  );
}

const NO_SITES: Set<string> = new Set();

/** One batch of the list. Re-renders only when its own rows, the folds or the tab change. */
const RosterChunk = memo(function RosterChunk({
  entries, folded, groups, tab, multiSite, query, canRestore, canArchive, onToggleSite, onRemove, onRestore, onKeep, onMoveIn,
}: {
  entries: { r: Row; heading: boolean; index: number }[];
  folded: Set<string>;
  groups: Map<string, { count: number; attention: number }>;
  tab: Tab;
  multiSite: boolean;
  /** The search, lower-cased, to say which old name a row matched. */
  query: string;
  canRestore: boolean;
  canArchive: boolean;
  onToggleSite: (siteId: string) => void;
  onRemove: (t: Tenant) => void;
  onRestore: (t: Tenant) => void;
  /** Confirm someone is still here, from their row (roster editors). */
  onKeep?: (t: Tenant) => void;
  /** Move someone into a vacant unit (roster editors). */
  onMoveIn?: (u: UnitRow) => void;
}) {
  return (
    <>
      {entries.map(({ r, heading, index }) => (
        <Fragment key={r.key}>
          {heading && (
            <SiteHeading
              siteId={r.siteId}
              name={r.siteName}
              folded={folded.has(r.siteId)}
              count={groups.get(r.siteId)?.count ?? 0}
              attention={(tab === "active" || tab === "all") && canArchive ? groups.get(r.siteId)?.attention ?? 0 : 0}
              noun={tab === "vacant" ? "vacant" : tab === "all" ? "listed" : (groups.get(r.siteId)?.count ?? 0) === 1 ? "resident" : "residents"}
              onToggle={onToggleSite}
            />
          )}
          {!folded.has(r.siteId) && r.kind === "vacant" && (
            <VacantRow u={r.u} enterDelay={index < STAGGERED ? index * STAGGER_MS : null} onMoveIn={onMoveIn} />
          )}
          {!folded.has(r.siteId) && r.kind === "tenant" && (
            <RosterRow
              t={r.t}
              tab={tab}
              multiSite={multiSite}
              formerly={query ? r.t.formerNames?.find((n) => n.toLowerCase().includes(query)) : undefined}
              // Only the first screenful slides in; rows appended after it are
              // below the fold and simply appear.
              enterDelay={index < STAGGERED ? index * STAGGER_MS : null}
              canRestore={canRestore}
              canArchive={canArchive}
              onRemove={onRemove}
              onRestore={onRestore}
              onKeep={onKeep}
            />
          )}
        </Fragment>
      ))}
    </>
  );
});

/** A site's heading in a grouped roster. Memoised for the same reason as RosterRow. */
const SiteHeading = memo(function SiteHeading({
  siteId, name, folded, count, attention, noun, onToggle,
}: {
  siteId: string;
  name: string;
  folded: boolean;
  count: number;
  attention: number;
  noun: string;
  onToggle: (siteId: string) => void;
}) {
  return (
    <li className="sticky top-0 z-[1] border-b border-hairline bg-subtle">
      <button
        type="button"
        onClick={() => onToggle(siteId)}
        aria-expanded={!folded}
        className="flex min-h-[44px] w-full items-center gap-2 px-4 text-left hover:bg-subtle2 lg:min-h-[34px] touch:min-h-11"
      >
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted transition-transform", folded && "-rotate-90")} />
        <span className="min-w-0 flex-1 truncate text-label font-bold text-ink">{name}</span>
        {attention > 0 && (
          <span className="shrink-0 rounded-pill bg-status-amberBg px-2 py-px text-micro font-bold text-status-amberText">{attention} to check</span>
        )}
        <span className="shrink-0 text-caption tabular text-muted">{count} {noun}</span>
      </button>
    </li>
  );
});

/**
 * One resident. Memoised: the list grows a batch at a time, and without this
 * every batch re-rendered every row already on screen — work that grew with the
 * square of the list and took seconds at ~1,900 people.
 */
const RosterRow = memo(function RosterRow({
  t, tab, multiSite, formerly, enterDelay, canRestore, canArchive, onRemove, onRestore, onKeep,
}: {
  t: Tenant;
  tab: Tab;
  multiSite: boolean;
  /** The old name the search matched, shown so it's clear why they're listed. */
  formerly?: string;
  enterDelay: number | null;
  canRestore: boolean;
  canArchive: boolean;
  onRemove: (t: Tenant) => void;
  onRestore: (t: Tenant) => void;
  onKeep?: (t: Tenant) => void;
}) {
  const [offset, setOffset] = useState(0);
  // Someone who needs a check-in gets "Still here" on their row (phone and iPad list),
  // unless they're away or not moved in yet (out of review).
  const quickKeep = Boolean(onKeep) && t.needsAttention && canArchive && tab !== "archived" && t.movedIn !== false && !t.awaySince;
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{ x: number; y: number; base: number; id: number; axis: "x" | "y" | null } | null>(null);
  const offsetRef = useRef(0);
  const suppressClick = useRef(false);
  const swipable = tab !== "archived" && canArchive;

  function setSlide(value: number) {
    offsetRef.current = value;
    setOffset(value);
  }
  useEffect(() => {
    const close = () => setSlide(0);
    openSwipeRowClosers.set(t.id, close);
    return () => { if (openSwipeRowClosers.get(t.id) === close) openSwipeRowClosers.delete(t.id); };
  }, [t.id]);
  function pointerDown(event: React.PointerEvent<HTMLLIElement>) {
    if (!swipable || window.matchMedia("(min-width: 1024px)").matches) return;
    // Close any other revealed action as soon as the next row is pressed,
    // without waiting to decide whether the gesture becomes a swipe.
    closeOpenSwipeRows(t.id);
    if ((event.target as HTMLElement).closest("button")) return;
    gesture.current = { x: event.clientX, y: event.clientY, base: offsetRef.current, id: event.pointerId, axis: null };
  }
  function pointerMove(event: React.PointerEvent<HTMLLIElement>) {
    const g = gesture.current;
    if (!g || event.pointerId !== g.id) return;
    const dx = event.clientX - g.x;
    const dy = event.clientY - g.y;
    if (!g.axis) {
      if (Math.hypot(dx, dy) < 10) return;
      g.axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? "x" : "y";
      if (g.axis === "x") {
        setDragging(true);
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Browser may decline capture. */ }
      }
    }
    if (g.axis !== "x") return;
    suppressClick.current = true;
    setSlide(Math.max(-220, Math.min(0, g.base + dx)));
  }
  function pointerEnd(event: React.PointerEvent<HTMLLIElement>, cancelled = false) {
    const g = gesture.current;
    if (!g || event.pointerId !== g.id) return;
    gesture.current = null;
    setDragging(false);
    if (g.axis !== "x") return;
    const distance = offsetRef.current;
    const fullySwiped = !cancelled && distance <= -FULL_SWIPE;
    const reveal = !cancelled && !fullySwiped && distance <= -REVEAL_WIDTH / 2;
    if (reveal || fullySwiped) closeOpenSwipeRows(t.id);
    setSlide(cancelled ? g.base : fullySwiped ? 0 : reveal ? -REVEAL_WIDTH : 0);
    if (fullySwiped) onRemove(t);
    // A pointer gesture can synthesize a click on the resident link afterward.
    window.setTimeout(() => { suppressClick.current = false; }, 0);
  }

  return (
    <li
      className={cn("roster-row relative overflow-hidden border-b border-hairline last:border-0", swipable && "select-none lg:select-text", enterDelay !== null && "page-list-item-enter")}
      style={enterDelay !== null ? { animationDelay: `${enterDelay}ms` } : undefined}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={(event) => pointerEnd(event)}
      onPointerCancel={(event) => pointerEnd(event, true)}
      onDragStart={(event) => event.preventDefault()}
      onClickCapture={(event) => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }}
    >
      {swipable && <button type="button" onClick={() => { closeOpenSwipeRows(); setSlide(0); onRemove(t); }} aria-label={`Remove ${t.displayName} from roster`} aria-hidden={offset > -REVEAL_WIDTH / 2} tabIndex={offset > -REVEAL_WIDTH / 2 ? -1 : 0} className={cn("absolute inset-y-0 right-0 flex w-[88px] items-center justify-center bg-status-redBg text-caption font-bold text-status-redText lg:hidden", offset > -REVEAL_WIDTH / 2 && "pointer-events-none")}>
        Remove
      </button>}
      <div className="group relative flex items-center gap-3 bg-surface px-4 py-2.5 hover:bg-rowhover lg:grid lg:grid-cols-[88px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_120px_32px] touch:lg:grid-cols-[88px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_120px_124px] lg:py-2" style={{ transform: `translateX(${offset}px)`, transition: dragging ? "none" : "transform 180ms ease-out", touchAction: swipable ? "pan-y" : undefined }}>
        {/* Below lg the unit sits in a pill (the column reads at a glance); the desktop table keeps plain text. */}
        {quickKeep && <span className="pointer-events-none absolute inset-0 -z-10 bg-status-amberBg/45 lg:hidden" aria-hidden />}
        <span className="flex w-[44px] shrink-0 justify-center lg:block lg:w-auto">
          {t.householdHeadId && tab !== "archived" ? (
            <span className="font-heading text-body font-extrabold text-muted">↳</span>
          ) : (
            <span className="inline-flex h-7 min-w-[40px] items-center justify-center rounded-[6px] bg-subtle px-1.5 font-heading text-label font-extrabold tabular text-ink lg:h-auto lg:min-w-0 lg:justify-start lg:bg-transparent lg:p-0 lg:text-body">
              {t.unit ?? "—"}
            </span>
          )}
        </span>
        <Link to={`/tenants/${t.id}`} draggable={false} className="flex min-w-0 flex-1 items-center gap-3 after:absolute after:inset-0 lg:flex-none lg:gap-2.5">
          <Avatar name={t.displayName} color={tintFor(t.id)} size={34} className="hidden md:inline-flex lg:hidden" />
          <Avatar name={t.displayName} color={tintFor(t.id)} size={30} className="hidden lg:inline-flex" />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-body-lg font-semibold text-ink lg:text-body">{t.displayName}</span>
              {t.highAcuity && <HighAcuityFlag />}
              {tab !== "archived" && t.movedIn === false && <span className="shrink-0 rounded-pill bg-status-amberBg px-1.5 py-px text-micro font-bold text-status-amberText">Not moved in</span>}
              {tab !== "archived" && t.awaySince && <span className="shrink-0 rounded-pill bg-subtle2 px-1.5 py-px text-micro font-bold text-ink" title={t.awayReason ?? undefined}>Away</span>}
              {t.needsAttention && canArchive && <span className="h-2 w-2 shrink-0 rounded-full bg-status-amberDot lg:hidden" aria-label="Needs check-in" />}
            </span>
            {tab !== "archived" && t.householdHeadId && (
              <span className="block truncate text-micro text-muted">{shortRelation(t.householdRelation) ?? "Household member"}</span>
            )}
            <span className={cn("block truncate text-caption lg:hidden", quickKeep ? "font-semibold text-status-amberText" : "text-muted")}>
              {quickKeep
                ? "Needs a check-in"
                : tab === "archived"
                ? `${multiSite ? `${t.site?.name} · ` : ""}Removed ${formatDate(t.archivedAt)} · ${t.archiveReason ?? ""}`
                : t.lastActivityAt
                  ? `On a form ${relativeTime(t.lastActivityAt)}`
                  : t.preferredName
                    ? `${t.firstName} ${t.lastName}`
                    : t.moveInDate && t.movedIn !== false
                      ? `Moved in ${formatDay(t.moveInDate)}`
                      : `Added ${formatDate(t.createdAt)}`}
            </span>
            {t.preferredName && <span className="hidden truncate text-micro text-muted lg:block">{t.firstName} {t.lastName}</span>}
            {formerly && <span className="block truncate text-micro text-muted">Formerly {formerly}</span>}
          </span>
        </Link>
        <span className="hidden truncate text-label text-muted lg:block">
          {tab === "archived" ? formatDate(t.archivedAt) : t.lastActivityAt ? relativeTime(t.lastActivityAt) : "—"}
        </span>
        <span className="hidden truncate text-label text-muted lg:block">
          {tab === "archived" ? t.archiveReason : t.movedIn === false ? "—" : formatDay(t.moveInDate)}
        </span>
        <span className="hidden lg:flex lg:items-center">
          <TenantStatusBadge status={t.status} needsAttention={t.needsAttention && canArchive} />
        </span>
        <span className="relative z-[1] flex shrink-0 items-center gap-1">
          {tab === "archived" ? (
            canRestore && (
              <Button size="sm" variant="ghost" onClick={() => onRestore(t)} className="min-h-[40px] lg:min-h-0">
                Restore
              </Button>
            )
          ) : (
            <>
              {/* Phone and iPad list: "Still here" when they need a check-in, else a plain way in.
                  Removing is a swipe, or the resident's page: not a trash can on every row. */}
              {quickKeep ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => { closeOpenSwipeRows(); onKeep!(t); }}
                  aria-label={`${t.displayName} is still here`}
                  className="min-h-[40px] border-status-greenDot/40 bg-status-greenBg text-status-greenText hover:bg-status-greenBg lg:hidden touch:min-h-11 touch:lg:inline-flex"
                >
                  <CheckCircle2 className="h-4 w-4" /> Still here
                </Button>
              ) : (
                <ChevronRight className="h-4 w-4 text-muted lg:hidden" aria-hidden />
              )}
              {/* Desktop table: Remove on hover. A touch screen has no hover, so it gets the arrow instead. */}
              {canArchive ? (
                <button
                  onClick={() => { closeOpenSwipeRows(); onRemove(t); }}
                  title="Remove from roster"
                  aria-label={`Remove ${t.displayName} from roster`}
                  className="hidden h-8 w-8 items-center justify-center rounded-input text-muted opacity-0 transition-opacity hover:bg-status-redBg hover:text-status-redText group-hover:opacity-100 lg:flex touch:hidden"
                >
                  <RemoveResidentIcon className="h-5 w-5" />
                </button>
              ) : (
                <ChevronRight className="hidden h-4 w-4 text-muted lg:block touch:hidden" aria-hidden />
              )}
              {!quickKeep && <ChevronRight className="hidden h-4 w-4 text-muted touch:lg:block" aria-hidden />}
            </>
          )}
        </span>
      </div>
    </li>
  );
});

/** A unit nobody lives in: vacant since when, and Move in. */
const VacantRow = memo(function VacantRow({ u, enterDelay, onMoveIn }: { u: UnitRow; enterDelay: number | null; onMoveIn?: (u: UnitRow) => void }) {
  return (
    <li
      className={cn("border-b border-hairline last:border-0", enterDelay !== null && "page-list-item-enter")}
      style={enterDelay !== null ? { animationDelay: `${enterDelay}ms` } : undefined}
    >
      <div className="flex items-center gap-3 bg-surface px-4 py-2.5 lg:grid lg:grid-cols-[88px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_120px_32px] touch:lg:grid-cols-[88px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_120px_124px] lg:py-2">
        <span className="w-[44px] shrink-0 text-center font-heading text-label font-extrabold tabular text-muted lg:w-auto lg:text-left lg:text-body">{u.label}</span>
        <span className="min-w-0 flex-1 lg:flex-none">
          <span className="block truncate text-body-lg font-semibold italic text-muted lg:text-body">Vacant</span>
          <span className="block truncate text-micro text-muted lg:hidden">
            {[u.unitType, u.vacantSince ? `since ${fmtDay(u.vacantSince)}` : null].filter(Boolean).join(" · ") || "Nobody lives here"}
          </span>
        </span>
        <span className="hidden truncate text-label text-muted lg:block">{u.unitType ?? "—"}</span>
        <span className="hidden truncate text-label text-muted lg:block">{u.vacantSince ? fmtDay(u.vacantSince) : "—"}</span>
        {/* Status column: Move in for roster editors, otherwise a plain "Vacant". */}
        <span className="flex shrink-0 items-center lg:col-span-2">
          {onMoveIn ? (
            <Button size="sm" variant="secondary" onClick={() => onMoveIn(u)} className="min-h-[40px] lg:min-h-0" aria-label={`Move someone into ${u.label}`}>
              Move in
            </Button>
          ) : (
            <span className="rounded-pill border border-hairline px-2 py-0.5 text-micro font-bold text-muted">Vacant</span>
          )}
        </span>
      </div>
    </li>
  );
});
