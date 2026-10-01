import { Fragment, memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Plus, Users } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { CountBadge, TenantStatusBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { AddResident } from "@/components/roster/AddResident";
import { RosterExportButtons, RosterExportMenu } from "@/components/roster/RosterExport";
import { RemoveDialog } from "@/components/roster/RemoveDialog";
import { RemoveResidentIcon } from "@/components/roster/RemoveResidentIcon";
import { useRosterActions } from "@/components/roster/useRosterActions";
import { useTenants } from "@/lib/queries";
import { SitePicker, selectionLabel, useSiteSelection } from "@/lib/site";
import { useAuth } from "@/lib/auth";
import { readStoredJson, writeStorage } from "@/lib/storage";
import { useSearchParam } from "@/lib/useSearchParam";
import { cn, formatDate, relativeTime, tintFor, toggled } from "@/lib/utils";
import type { Tenant } from "@/lib/types";

type Tab = "active" | "attention" | "archived";

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
const REMOVE_ICON_FADE_DISTANCE = 44;
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
  const [tabParam, setTab] = useSearchParam("tab");
  const tab = (tabParam as Tab) || "active";
  const [q, setQ] = useState("");
  const query = useDeferredValue(q.trim().toLowerCase());
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Tenant | null>(null);
  const { remove, restore } = useRosterActions();
  // Rows are memoised (see RosterRow), so what they're handed must be stable —
  // a fresh function per render would re-render every row on every batch.
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  const onRestore = useCallback((t: Tenant) => void restoreRef.current(t), []);
  const { collapsed, setCollapsed, toggle: toggleSite } = useCollapsedSites();

  // "attention" is a view of the active list, so it reuses that request.
  const { data, isLoading } = useTenants(param, tab === "archived" ? "archived" : "active", selected.length > 0);
  const all = data?.items ?? [];

  const rows = useMemo(() => {
    const base = tab === "attention" ? all.filter((t) => t.needsAttention) : all;
    if (!query) return base;
    return base.filter((t) =>
      [t.displayName, t.firstName, t.lastName, t.preferredName, t.unit, multiSite ? t.site?.name : null].some((v) =>
        v?.toLowerCase().includes(query)
      )
    );
  }, [all, tab, query, multiSite]);

  // Grouped by site whenever more than one is in view. The archived tab is
  // sorted by removal date across sites, so it stays one flat list.
  const grouped = multiSite && tab !== "archived";
  const groups = useMemo(() => {
    const m = new Map<string, { count: number; attention: number }>();
    for (const t of rows) {
      const g = m.get(t.siteId) ?? { count: 0, attention: 0 };
      g.count++;
      if (t.needsAttention) g.attention++;
      m.set(t.siteId, g);
    }
    return m;
  }, [rows]);
  const allFolded = grouped && [...groups.keys()].every((id) => collapsed.has(id));

  // The list, cut into chunks: the first screenful, then fixed-size batches.
  // Each chunk is a memoised component with a stable slice, so adding one makes
  // React compare a dozen chunks rather than ~1,900 rows. Site headings are
  // decided here, across chunk boundaries.
  const chunks = useMemo(() => {
    const out: { t: Tenant; heading: boolean; index: number }[][] = [];
    let size = FIRST_BATCH;
    for (let i = 0; i < rows.length; i += size, size = BATCH) {
      out.push(
        rows.slice(i, i + size).map((t, j) => ({
          t,
          index: i + j,
          heading: grouped && t.siteId !== rows[i + j - 1]?.siteId,
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
  // Exports and printouts are of exactly this: selection, tab and search.
  const exportView = { site: param, status: tab, q };
  const subtitle = selected.length ? `${selectionLabel(codes, sites)} · ${onRoster.toLocaleString()} on roster` : undefined;

  const controls = (
    <>
      <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or unit" />
      <div className="grid grid-cols-3 rounded-input bg-navsel/60 p-0.5" role="tablist">
        {(
          [
            ["active", "On roster", onRoster],
            ["attention", "Review", attention],
            ["archived", "Removed", undefined],
          ] as [Tab, string, number | undefined][]
        ).map(([key, label, count]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              "flex min-h-[38px] items-center justify-center gap-1.5 rounded-[5px] px-2 text-[12.5px] font-bold transition-colors md:min-h-[30px]",
              tab === key ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
            )}
          >
            {label}
            {count !== undefined && count > 0 && (
              <span className={cn("tabular text-micro", key === "attention" ? "text-status-amberText" : "text-muted")}>{count}</span>
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
            subtitle={subtitle}
            actions={
              <>
                <SitePicker codes={codes} onChange={setCodes} className="w-[240px]" />
                <RosterExportButtons view={exportView} disabled={selected.length === 0} />
                {canAdd && (
                  <Button onClick={() => setAdding(true)}>
                    <Plus className="h-4 w-4" /> Add resident
                  </Button>
                )}
              </>
            }
          />
          <div className="mb-4 grid grid-cols-[minmax(0,1fr)_340px] gap-3">{controls}</div>
        </div>

        {sitesLoading || isLoading ? (
          <RosterSkeleton />
        ) : selected.length === 0 ? (
          <EmptyState title="No sites assigned" hint="You aren't assigned to any sites yet, so there's no roster to show. Ask an administrator to add you to one." icon={<Users className="h-8 w-8" />} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={query ? "Nobody matches" : tab === "archived" ? "Nobody removed yet" : tab === "attention" ? "Nobody to review" : "Nobody on this roster"}
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
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-input px-2 text-[12.5px] font-semibold text-accent hover:bg-subtle2 dark:text-white"
              >
                {allFolded ? <ChevronsUpDown className="h-4 w-4" /> : <ChevronsDownUp className="h-4 w-4" />}
                {allFolded ? "Expand all" : "Collapse all"}
              </button>
            </div>
          )}
          <Card className="rounded-none border-x-0 md:rounded-card md:border-x">
            {/* The table layout needs ~1000px; below that (phones and iPads in
                portrait) each row is the stacked list form. */}
            <div className="hidden grid-cols-[88px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_120px_32px] gap-3 border-b border-hairline px-4 py-2.5 text-micro font-bold uppercase tracking-[0.04em] text-muted lg:grid">
              <span>Unit</span>
              <span>Name</span>
              <span>{tab === "archived" ? "Removed" : "Last on a form"}</span>
              <span>{tab === "archived" ? "Reason" : "Moved in"}</span>
              <span>Status</span>
              <span />
            </div>
            <ul>
              {chunks.slice(0, shownChunks).map((chunk) => (
                <RosterChunk
                  key={chunk[0].t.id}
                  entries={chunk}
                  folded={folded}
                  groups={groups}
                  tab={tab}
                  multiSite={multiSite}
                  canRestore={can("roster.restore")}
                  canArchive={can("roster.archive")}
                  onToggleSite={toggleSite}
                  onRemove={setRemoving}
                  onRestore={onRestore}
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
  entries, folded, groups, tab, multiSite, canRestore, canArchive, onToggleSite, onRemove, onRestore,
}: {
  entries: { t: Tenant; heading: boolean; index: number }[];
  folded: Set<string>;
  groups: Map<string, { count: number; attention: number }>;
  tab: Tab;
  multiSite: boolean;
  canRestore: boolean;
  canArchive: boolean;
  onToggleSite: (siteId: string) => void;
  onRemove: (t: Tenant) => void;
  onRestore: (t: Tenant) => void;
}) {
  return (
    <>
      {entries.map(({ t, heading, index }) => (
        <Fragment key={t.id}>
          {heading && (
            <SiteHeading
              siteId={t.siteId}
              name={t.site?.name ?? ""}
              folded={folded.has(t.siteId)}
              count={groups.get(t.siteId)?.count ?? 0}
              attention={tab === "active" ? groups.get(t.siteId)?.attention ?? 0 : 0}
              onToggle={onToggleSite}
            />
          )}
          {!folded.has(t.siteId) && (
            <RosterRow
              t={t}
              tab={tab}
              multiSite={multiSite}
              // Only the first screenful slides in; rows appended after it are
              // below the fold and simply appear.
              enterDelay={index < STAGGERED ? index * STAGGER_MS : null}
              canRestore={canRestore}
              canArchive={canArchive}
              onRemove={onRemove}
              onRestore={onRestore}
            />
          )}
        </Fragment>
      ))}
    </>
  );
});

/** A site's heading in a grouped roster. Memoised for the same reason as RosterRow. */
const SiteHeading = memo(function SiteHeading({
  siteId, name, folded, count, attention, onToggle,
}: {
  siteId: string;
  name: string;
  folded: boolean;
  count: number;
  attention: number;
  onToggle: (siteId: string) => void;
}) {
  return (
    <li className="sticky top-0 z-[1] border-b border-hairline bg-subtle">
      <button
        type="button"
        onClick={() => onToggle(siteId)}
        aria-expanded={!folded}
        className="flex min-h-[44px] w-full items-center gap-2 px-4 text-left hover:bg-subtle2 lg:min-h-[34px]"
      >
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted transition-transform", folded && "-rotate-90")} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-bold uppercase tracking-[0.04em] text-muted">{name}</span>
        {attention > 0 && <CountBadge count={attention} className="shrink-0 py-0" />}
        <span className="shrink-0 text-micro tabular text-muted">{count}</span>
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
  t, tab, multiSite, enterDelay, canRestore, canArchive, onRemove, onRestore,
}: {
  t: Tenant;
  tab: Tab;
  multiSite: boolean;
  enterDelay: number | null;
  canRestore: boolean;
  canArchive: boolean;
  onRemove: (t: Tenant) => void;
  onRestore: (t: Tenant) => void;
}) {
  const [offset, setOffset] = useState(0);
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
      {swipable && <button type="button" onClick={() => { closeOpenSwipeRows(); setSlide(0); onRemove(t); }} aria-label={`Remove ${t.displayName} from roster`} aria-hidden={offset > -REVEAL_WIDTH / 2} tabIndex={offset > -REVEAL_WIDTH / 2 ? -1 : 0} className={cn("absolute inset-y-0 right-0 flex w-[88px] items-center justify-center bg-status-redBg text-[12px] font-bold text-status-redText lg:hidden", offset > -REVEAL_WIDTH / 2 && "pointer-events-none")}>
        Remove
      </button>}
      <div className="group relative flex items-center gap-3 bg-surface px-4 py-2.5 hover:bg-rowhover lg:grid lg:grid-cols-[88px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_120px_32px] lg:py-2" style={{ transform: `translateX(${offset}px)`, transition: dragging ? "none" : "transform 180ms ease-out", touchAction: swipable ? "pan-y" : undefined }}>
        <span className="w-[52px] shrink-0 text-center font-heading text-[14px] font-extrabold tabular text-ink lg:w-auto lg:text-left lg:text-[13.5px]">
          {t.unit ?? "—"}
        </span>
        <Link to={`/tenants/${t.id}`} draggable={false} className="flex min-w-0 flex-1 items-center gap-2.5 lg:flex-none">
          <Avatar name={t.displayName} color={tintFor(t.id)} size={30} className="hidden lg:inline-flex" />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[14.5px] font-semibold text-ink lg:text-[13.5px]">{t.displayName}</span>
              {t.needsAttention && <span className="h-2 w-2 shrink-0 rounded-full bg-status-amberDot lg:hidden" aria-label="Needs review" />}
            </span>
            <span className="block truncate text-micro text-muted lg:hidden">
              {tab === "archived"
                ? `${multiSite ? `${t.site?.name} · ` : ""}Removed ${formatDate(t.archivedAt)} · ${t.archiveReason ?? ""}`
                : t.lastActivityAt
                  ? `On a form ${relativeTime(t.lastActivityAt)}`
                  : t.preferredName
                    ? `${t.firstName} ${t.lastName}`
                    : `Added ${formatDate(t.createdAt)}`}
            </span>
            {t.preferredName && <span className="hidden truncate text-micro text-muted lg:block">{t.firstName} {t.lastName}</span>}
          </span>
        </Link>
        <span className="hidden truncate text-[13px] text-muted lg:block">
          {tab === "archived" ? formatDate(t.archivedAt) : t.lastActivityAt ? relativeTime(t.lastActivityAt) : "—"}
        </span>
        <span className="hidden truncate text-[13px] text-muted lg:block">
          {tab === "archived" ? t.archiveReason : formatDate(t.moveInDate)}
        </span>
        <span className="hidden lg:block">
          <TenantStatusBadge status={t.status} needsAttention={t.needsAttention} />
        </span>
        <span className="flex shrink-0 items-center">
          {tab === "archived" ? (
            canRestore && (
              <Button size="sm" variant="ghost" onClick={() => onRestore(t)} className="min-h-[40px] lg:min-h-0">
                Restore
              </Button>
            )
          ) : canArchive ? (
            <button
              onClick={() => { closeOpenSwipeRows(); onRemove(t); }}
              title="Remove from roster"
              className="flex h-10 w-10 items-center justify-center rounded-input text-muted opacity-[var(--swipe-opacity)] transition-opacity hover:bg-status-redBg hover:text-status-redText lg:h-8 lg:w-8 lg:opacity-0 lg:group-hover:opacity-100"
              style={{ "--swipe-opacity": Math.max(0, 1 - Math.abs(offset) / REMOVE_ICON_FADE_DISTANCE) } as React.CSSProperties}
            >
              <RemoveResidentIcon className="h-5 w-5" />
            </button>
          ) : (
            <ChevronRight className="h-4 w-4 text-muted" />
          )}
        </span>
      </div>
    </li>
  );
});
