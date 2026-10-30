import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  Settings, Home, Contact, CalendarDays, Bell, CircleHelp, ExternalLink, LayoutGrid, LogOut, PanelLeftClose, PanelLeftOpen, Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ADMIN_AREA, isSiteSettingsOnly, useAuth } from "@/lib/auth";
import { usePrefs } from "@/lib/prefs";
import { Avatar } from "@/components/ui/avatar";
import { CountBadge, UnreadBubble } from "@/components/ui/badge";
import { SearchInput } from "@/components/ui/input";
import { isInternalForm } from "@/lib/formIcons";
import type { FormLink } from "@/lib/types";
import { ThemedLogo } from "@/components/shell/ThemedLogo";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { useNavMode } from "@/lib/shellNav";
import { useUnreadCount, useUrgentCount } from "@/lib/notifications";
import { isFormPath, MAX_NAV_PINS, ROSTER_URL, useIsLit, useNavCatalog, useReviewCount } from "./navData";
import { useGlobalSearch } from "./globalSearch";

const EXPANDED_WIDTH = 240;
const COLLAPSED_WIDTH = 64;
const EASE = "ease-[cubic-bezier(.2,.8,.2,1)]";

/*
 * Everything beside the icon column has a FIXED width sized to the open
 * sidebar (240 − 30 padding − 1 border = 209, less the 40px icon column = 169).
 * The aside's overflow clips it while collapsed. A label that followed the
 * width would re-wrap on every frame of the animation; a fixed one just gets
 * uncovered.
 */
const TAIL_W = "w-[169px]";

/** How far pins sit in under "All forms", and their narrower tail to match. */
const PIN_INDENT = "pl-7";
const PIN_TAIL_W = "w-[141px]";

/** Out fast before the width moves, back in only once there's room for it. */
const fade = (collapsed: boolean) =>
  cn(
    "transition-opacity motion-reduce:transition-none",
    collapsed ? "opacity-0 duration-[90ms]" : "opacity-100 duration-[180ms] delay-[120ms]"
  );

/**
 * The start of a group of nav items: its name when the sidebar is open, a
 * hairline when collapsed, so the grouping still reads at 64px wide. The two
 * cross-fade while the height eases between them.
 */
function SectionLabel({ label, collapsed }: { label: string; collapsed: boolean }) {
  return (
    <div className={cn("relative shrink-0 transition-[height] duration-[240ms] motion-reduce:transition-none", EASE, collapsed ? "h-[21px]" : "h-[35px]")}>
      <p className={cn("absolute bottom-1 left-2.5 whitespace-nowrap text-micro font-bold uppercase tracking-[0.04em] text-muted", fade(collapsed))}>{label}</p>
      <div className={cn("absolute inset-x-2 top-2.5 h-px bg-hairline transition-opacity duration-200", collapsed ? "opacity-100" : "opacity-0")} />
    </div>
  );
}

/** The amber dot on an icon with people waiting — the collapsed sidebar's stand-in for the count, which is clipped away. */
function WaitingDot({ collapsed }: { collapsed: boolean }) {
  return <span className={cn("absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-status-amberDot transition-opacity duration-200", collapsed ? "opacity-100" : "opacity-0")} />;
}

/*
 * Open, the highlight fills the row. Collapsed, the row runs on past the
 * sidebar's edge (see TAIL_W), so a row highlight would be cut off square on
 * the right; it moves onto the icon's own square instead (iconBox), rounded
 * all round.
 */
const itemClass = (active: boolean, collapsed = false) =>
  cn(
    "group/item flex h-10 w-full shrink-0 items-center overflow-hidden rounded-input text-[13.5px] font-semibold transition-colors",
    collapsed
      ? active ? "text-accent dark:text-white" : "text-muted hover:text-ink"
      : active ? "bg-navsel text-accent dark:text-white" : "text-muted hover:bg-navsel/60 hover:text-ink"
  );

const iconBox = (active: boolean, collapsed: boolean) =>
  cn(
    "relative flex h-10 w-10 shrink-0 items-center justify-center rounded-input transition-colors",
    collapsed && (active ? "bg-navsel" : "group-hover/item:bg-navsel/60")
  );

/** Rows whose label may wrap: "Metro Card Reconciliation Form (Reports)" cut to "Metro Card Reco…" is useless. Collapsed, max-height clamps them to one icon. */
const wrapRow = (collapsed: boolean) =>
  cn("h-auto min-h-10 items-start transition-[max-height,background-color,color] duration-[240ms] motion-reduce:transition-none", EASE, collapsed ? "max-h-10" : "max-h-[96px]");

function NavItem({ to, label, Icon, collapsed, end, lit, count, tour }: {
  to: string;
  label: string;
  Icon: React.ElementType;
  collapsed: boolean;
  end?: boolean;
  /** Overrides the link's own idea of "here", e.g. the Roster is also lit on a resident's page. */
  lit?: boolean;
  /** Amber count, e.g. people waiting in the Roster's review queue. */
  count?: number;
  /** Its name for the welcome tour (lib/tour/siteTour.ts). */
  tour?: string;
}) {
  const waiting = (count ?? 0) > 0;
  return (
    <NavLink to={to} end={end} data-tour={tour} title={collapsed ? label : undefined} className={({ isActive }) => itemClass(lit ?? isActive, collapsed)}>
      {({ isActive }) => (
        <>
          <span className={iconBox(lit ?? isActive, collapsed)}>
            <Icon className="h-[18px] w-[18px]" />
            {waiting && <WaitingDot collapsed={collapsed} />}
          </span>
          <span className={cn("flex items-center gap-2 pr-2", TAIL_W, fade(collapsed))}>
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {waiting && <CountBadge count={count!} max={999} label={`${count} to review`} className="shrink-0" />}
          </span>
        </>
      )}
    </NavLink>
  );
}

/**
 * One form: with its icon (Pinned, search results) or, inside an open
 * category, as an indented line of text. Internal forms are links in the app;
 * the rest still live on WordPress and open in a new tab.
 */
function FormRow({ form, Icon, subtitle, collapsed, lit, count, indented }: {
  form: FormLink;
  Icon?: React.ElementType;
  /** A second line, e.g. the category in search results. */
  subtitle?: string;
  collapsed: boolean;
  lit: boolean;
  /** Amber count, e.g. people waiting in the Roster's review queue. */
  count?: number;
  /** A pin, sitting in under "All forms" (PinThread). */
  indented?: boolean;
}) {
  const internal = isInternalForm(form.url);
  const waiting = (count ?? 0) > 0;
  const className = cn(itemClass(lit, collapsed), wrapRow(collapsed), !lit && "font-medium", !Icon && "text-[13px]");
  const body = (
    <>
      {Icon && (
        <span className={iconBox(lit, collapsed)}>
          <Icon className="h-[18px] w-[18px]" />
          {waiting && <WaitingDot collapsed={collapsed} />}
        </span>
      )}
      <span className={cn("flex items-start gap-2 py-[11px] pr-2 text-left leading-[18px]", Icon ? cn("shrink-0", indented ? PIN_TAIL_W : TAIL_W) : "min-w-0 flex-1 pl-2.5", fade(collapsed))}>
        <span className="min-w-0 flex-1">
          {form.title}
          {subtitle && <span className="mt-0.5 block text-micro font-medium text-muted">{subtitle}</span>}
        </span>
        {waiting && <CountBadge count={count!} max={999} label={`${count} to review`} className="shrink-0" />}
        {!internal && <ExternalLink className="mt-1 h-3 w-3 shrink-0 opacity-50" aria-hidden />}
      </span>
    </>
  );
  return internal ? (
    <NavLink to={form.url} title={collapsed ? form.title : undefined} className={className}>{body}</NavLink>
  ) : (
    <a href={form.url} target="_blank" rel="noopener noreferrer" title={`${form.title} (opens in a new tab)`} className={className}>{body}</a>
  );
}

/**
 * The sidebar's collapsed state.
 *
 * A form beside a 240px sidebar in a portrait-shaped window gets barely two
 * thirds of it, so inside a form there the sidebar folds to its icons on its
 * own. Expanding it then is a peek, not a change of the saved preference: it
 * folds again on the next navigation, and the preference is still what the
 * catalog and wider windows use. (Tablets don't get the sidebar at all: they
 * get the dock, see Dock.tsx.)
 */
function useCollapsed() {
  const { collapsed: preferred, toggleCollapsed } = usePrefs();
  const { pathname } = useLocation();
  const portrait = useMediaQuery("(min-width: 768px) and (orientation: portrait)");
  const wide = useMediaQuery("(min-width: 768px)");
  // A code form's page can ask for more (or less) folding than the default.
  const mode = useNavMode() ?? "auto";
  const auto = isFormPath(pathname) && (mode === "always" ? wide : mode === "never" ? false : portrait);
  const [peek, setPeek] = useState(false);
  useEffect(() => setPeek(false), [pathname, auto]);
  return auto
    ? { collapsed: !peek, expand: () => setPeek(true), toggleCollapsed: () => setPeek((p) => !p) }
    : { collapsed: preferred, expand: () => preferred && toggleCollapsed(), toggleCollapsed };
}

/**
 * Swipe on the sidebar: left folds it to its icons, right opens it. Touch only
 * (a mouse drag would fight text selection), and only a mostly-horizontal
 * gesture, so scrolling the nav vertically is unaffected.
 */
function useSwipeToggle(collapsed: boolean, toggleCollapsed: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      start.current = e.pointerType === "touch" ? { x: e.clientX, y: e.clientY } : null;
    },
    onPointerUp: (e: React.PointerEvent) => {
      const s = start.current;
      start.current = null;
      if (!s) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (dx < 0 && !collapsed) toggleCollapsed();
      else if (dx > 0 && collapsed) toggleCollapsed();
    },
    onPointerCancel: () => {
      start.current = null;
    },
  };
}

/**
 * The desktop sidebar: search, Home, Calendar, Pinned, then every category as a
 * one-level accordion. Phones and tablets get the dock instead (Dock.tsx).
 */
export function Sidebar() {
  const { user, logout, can } = useAuth();
  const { collapsed, expand, toggleCollapsed } = useCollapsed();
  const swipe = useSwipeToggle(collapsed, toggleCollapsed);
  const reviewCount = useReviewCount();
  const unread = useUnreadCount();
  const urgent = useUrgentCount();
  const { categories, pinned: allPinned } = useNavCatalog();
  const pinned = allPinned.slice(0, MAX_NAV_PINS);
  const lit = useIsLit();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [q, setQ] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const focusSearch = useRef(false);
  const isAdmin = ADMIN_AREA.some(can);
  // A Site Manager's admin is just their sites' people: "Site settings".
  const siteSettingsOnly = isSiteSettingsOnly(can);

  const countFor = (form: FormLink) => (form.url === ROSTER_URL ? reviewCount : 0);
  // The Forms page stays lit inside any form it lists, so you can see where you came from.
  const formsLit = pathname === "/forms" || (isFormPath(pathname) && !lit(ROSTER_URL) && !pinned.some((p) => lit(p.form.url)));

  // Picking a result (or going anywhere) ends the search.
  useEffect(() => setQ(""), [pathname]);

  // Ctrl/⌘ K: straight to the search, unfolding the sidebar if it has to.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      // The code editor has its own use for the chord.
      if ((e.target as HTMLElement | null)?.closest?.(".cm-editor")) return;
      e.preventDefault();
      openSearch();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const openSearch = () => {
    if (collapsed) {
      focusSearch.current = true;
      expand();
    } else {
      searchRef.current?.focus();
    }
  };
  useEffect(() => {
    if (!collapsed && focusSearch.current) {
      focusSearch.current = false;
      searchRef.current?.focus({ preventScroll: true });
    }
  }, [collapsed]);

  const hits = useGlobalSearch(q, categories);
  const searching = !collapsed && q.trim() !== "";
  const nothing = !hits.pages.length && !hits.forms.length && !hits.residents.length;
  const openResult = () => {
    const first = hits.first;
    if (!first) return;
    if (first.external) window.open(first.to, "_blank", "noopener,noreferrer");
    else navigate(first.to);
    setQ("");
  };

  return (
    <aside
      {...swipe}
      data-tour="nav"
      style={{ width: collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH, touchAction: "pan-y" }}
      // `hidden md:flex` as well as AppShell's choice, so even the very first
      // paint on a phone (before the device is known) never shows it.
      className={cn(
        "hidden h-full shrink-0 flex-col overflow-hidden border-r border-hairline bg-sidebar py-5 transition-[width,padding] duration-[240ms] motion-reduce:transition-none md:flex",
        EASE,
        collapsed ? "px-3" : "px-[15px]"
      )}
    >
      {/* Brand lockup */}
      <div className="mb-4 flex shrink-0 items-center">
        <span className="flex h-11 w-10 shrink-0 items-center justify-center">
          <ThemedLogo />
        </span>
        <div className={cn("flex shrink-0 items-center gap-3 whitespace-nowrap", fade(collapsed))}>
          {/* ml-3 pairs with the gap-3 so the rule sits centred in the space
              between the mark and the wordmark. */}
          <span className="ml-3 h-9 w-[1.5px] shrink-0 bg-hairline" />
          <span className="font-heading text-[21px] font-extrabold text-accent dark:text-white">Forms</span>
        </div>
      </div>

      {/* Search: the field when open, its icon when collapsed. Both stay
          mounted so the height doesn't jump as the sidebar folds. */}
      <div data-tour="nav-search" className="relative mb-2 h-10 shrink-0">
        <button
          type="button"
          onClick={openSearch}
          title="Search (Ctrl K)"
          aria-label="Search"
          tabIndex={collapsed ? undefined : -1}
          aria-hidden={collapsed ? undefined : true}
          className={cn(itemClass(false, true), "absolute inset-0 transition-opacity duration-200", collapsed ? "opacity-100" : "pointer-events-none opacity-0")}
        >
          <span className={iconBox(false, true)}><Search className="h-[18px] w-[18px]" /></span>
        </button>
        <div className={cn("absolute inset-y-0 left-0 w-[209px]", fade(collapsed), collapsed && "pointer-events-none")} aria-hidden={collapsed || undefined}>
          <SearchInput
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") openResult();
              else if (e.key === "Escape") {
                setQ("");
                e.currentTarget.blur();
              }
            }}
            tabIndex={collapsed ? -1 : undefined}
            placeholder="Search"
            aria-label="Search screens, forms and residents"
            className="h-10 min-h-10 bg-surface pr-14 text-[13.5px] md:min-h-10"
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-hairline px-1.5 py-px font-body text-[10.5px] font-bold text-muted">Ctrl K</kbd>
        </div>
      </div>

      {/* -mx/px: room for the scrollbar without shifting the items. */}
      <nav aria-label="Main" className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-1 scroll-thin">
        {searching ? (
          <>
            {hits.pages.length > 0 && (
              <>
                <SectionLabel label="Screens" collapsed={false} />
                {hits.pages.map((p) => (
                  <NavItem key={p.to} to={p.to} label={p.label} Icon={p.Icon} collapsed={false} />
                ))}
              </>
            )}
            {hits.forms.length > 0 && (
              <>
                <SectionLabel label={hits.forms.length === 1 ? "1 form" : `${hits.forms.length} forms`} collapsed={false} />
                {hits.forms.map((r) => (
                  <FormRow key={r.form.id} form={r.form} Icon={r.Icon} subtitle={r.category.name} collapsed={false} lit={lit(r.form.url)} count={countFor(r.form)} />
                ))}
              </>
            )}
            {hits.residents.length > 0 && (
              <>
                <SectionLabel label={hits.residentTotal === 1 ? "1 resident" : `${hits.residentTotal} residents`} collapsed={false} />
                {hits.residents.map((t) => (
                  <NavLink key={t.id} to={`/tenants/${t.id}`} className={({ isActive }) => cn(itemClass(isActive), wrapRow(false), "font-medium")}>
                    <span className="min-w-0 flex-1 py-2 pl-2.5 pr-2 leading-[18px]">
                      {t.displayName}
                      <span className="mt-0.5 block text-micro font-medium text-muted">{[t.unit && `Unit ${t.unit}`, t.site?.name].filter(Boolean).join(" · ")}</span>
                    </span>
                  </NavLink>
                ))}
                {hits.residentTotal > hits.residents.length && (
                  <p className="px-2.5 py-1.5 text-[12px] text-muted">Keep typing to narrow it down, or search the Roster.</p>
                )}
              </>
            )}
            {nothing && <p className="px-2.5 py-2 text-[13px] text-muted">Nothing matches. Try a shorter word.</p>}
          </>
        ) : (
          <>
            <NavItem to="/home" label="Home" Icon={Home} collapsed={collapsed} end tour="nav-home" />
            {can("roster.view") && <NavItem to={ROSTER_URL} label="Roster" Icon={Contact} collapsed={collapsed} lit={lit(ROSTER_URL)} count={reviewCount} tour="nav-roster" />}
            <NavItem to="/calendar" label="Calendar" Icon={CalendarDays} collapsed={collapsed} tour="nav-calendar" />

            {/* The forms: the whole catalog, then your pins under it. */}
            <div className="mx-2 my-2.5 h-px shrink-0 bg-hairline" />
            <NavItem to="/forms" label="All forms" Icon={LayoutGrid} collapsed={collapsed} lit={formsLit} tour="nav-forms" />
            {pinned.length > 0 && (
              <div className={cn("relative flex shrink-0 flex-col gap-0.5 transition-[padding] duration-[240ms] motion-reduce:transition-none", EASE, collapsed ? "pl-0" : PIN_INDENT)}>
                {/* One line down from the "All forms" icon beside the pins; gone when collapsed, where they line up with everything else. */}
                <span aria-hidden className={cn("pointer-events-none absolute -top-0.5 bottom-2 left-[19px] w-[1.5px] rounded-full bg-muted/35", fade(collapsed))} />
                {pinned.map((p) => (
                  <FormRow key={p.form.id} form={p.form} Icon={p.Icon} collapsed={collapsed} lit={lit(p.form.url)} count={countFor(p.form)} indented />
                ))}
              </div>
            )}
          </>
        )}
      </nav>

      {/* Help: a guide for your role and each feature (screens/Help.tsx). */}
      <div className="mt-2 shrink-0">
        <NavItem to="/help" label="Help" Icon={CircleHelp} collapsed={collapsed} tour="nav-help" />
      </div>

      {/* Notifications, just above you: the bell carries the unread bubble open or collapsed. */}
      <NavLink
        to="/notifications"
        data-tour="nav-notifications"
        title={collapsed ? (unread ? `Notifications (${unread} unread${urgent ? `, ${urgent} urgent` : ""})` : "Notifications") : undefined}
        aria-label={unread ? `Notifications, ${unread} unread${urgent ? `, ${urgent} urgent` : ""}` : "Notifications"}
        className={({ isActive }) => cn(itemClass(isActive, collapsed))}
      >
        {({ isActive }) => (
          <>
            <span className={iconBox(isActive, collapsed)}>
              <Bell className="h-[18px] w-[18px]" />
              <UnreadBubble count={unread} urgent={urgent} className="right-0.5 top-0.5 ring-sidebar" />
            </span>
            <span className={cn("whitespace-nowrap", fade(collapsed))}>Notifications</span>
          </>
        )}
      </NavLink>

      {isAdmin && (
        <div className="shrink-0">
          {siteSettingsOnly ? (
            <NavItem to="/admin/people" label="Site settings" Icon={Settings} collapsed={collapsed} tour="nav-admin" />
          ) : (
            <NavItem to="/admin" label="Admin" Icon={Settings} collapsed={collapsed} tour="nav-admin" />
          )}
        </div>
      )}

      {/* Collapse toggle */}
      <button
        onClick={toggleCollapsed}
        title={collapsed ? "Expand" : "Collapse"}
        className="mb-3 flex h-10 w-full shrink-0 items-center overflow-hidden rounded-input text-[12.5px] font-semibold text-muted transition-colors hover:bg-navsel/60 hover:text-ink"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center">
          {collapsed ? <PanelLeftOpen className="h-[18px] w-[18px]" /> : <PanelLeftClose className="h-[18px] w-[18px]" />}
        </span>
        <span className={cn("whitespace-nowrap", fade(collapsed))}>Collapse</span>
      </button>

      {/* You: the whole chip opens Profile & settings; sign out sits apart at its end. */}
      <div className="-mx-1 shrink-0 border-t border-hairline px-1 pt-3">
        <div className="flex w-full items-center">
          <NavLink
            to="/profile"
            data-tour="nav-profile"
            title={collapsed ? `${user?.name} · Profile & settings` : "Profile & settings"}
            className={({ isActive }) =>
              cn(
                "flex min-w-0 items-center overflow-hidden rounded-input py-1.5 transition-colors",
                collapsed ? "w-10 shrink-0" : "flex-1",
                isActive ? "bg-navsel" : "hover:bg-navsel/60"
              )
            }
          >
            <span className="flex w-10 shrink-0 justify-center">
              <Avatar name={user?.name ?? "?"} color={user?.avatarColor} />
            </span>
            {/* Hidden, not unmounted, while collapsed, so the name doesn't re-wrap as the width moves. */}
            <span className={cn("min-w-0 flex-1 pr-2", fade(collapsed))} aria-hidden={collapsed || undefined}>
              <span className="block truncate text-[13px] font-semibold leading-tight text-ink">{user?.name}</span>
              <span className="mt-0.5 block truncate text-micro leading-tight text-muted">{user?.role?.name}</span>
            </span>
          </NavLink>
          {!collapsed && (
            <button
              onClick={() => logout()}
              title="Sign out"
              aria-label="Sign out"
              className={cn("ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-input text-muted transition-colors hover:bg-status-redBg hover:text-status-redText", fade(collapsed))}
            >
              <LogOut className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
