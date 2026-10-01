import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  Settings, Home, ChevronDown, ChevronRight, ExternalLink, LogOut, PanelLeftClose, PanelLeftOpen, Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ADMIN_AREA, useAuth } from "@/lib/auth";
import { usePrefs } from "@/lib/prefs";
import { Avatar } from "@/components/ui/avatar";
import { CountBadge } from "@/components/ui/badge";
import { SearchInput } from "@/components/ui/input";
import { isInternalForm } from "@/lib/formIcons";
import type { FormLink } from "@/lib/types";
import { ThemedLogo } from "@/components/shell/ThemedLogo";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { useNavMode } from "@/lib/shellNav";
import { readStorage, writeStorage } from "@/lib/storage";
import { isFormPath, searchForms, useIsLit, useNavCatalog, useReviewCount, type NavCategory } from "./navData";

const EXPANDED_WIDTH = 240;
const COLLAPSED_WIDTH = 64;
/** Which categories are open in the accordion, remembered per device. */
const OPEN_KEY = "ln.navOpen";
const EASE = "ease-[cubic-bezier(.2,.8,.2,1)]";

/*
 * Everything beside the icon column has a FIXED width sized to the open
 * sidebar (240 − 30 padding − 1 border = 209, less the 40px icon column = 169).
 * The aside's overflow clips it while collapsed. A label that followed the
 * width would re-wrap on every frame of the animation; a fixed one just gets
 * uncovered.
 */
const TAIL_W = "w-[169px]";

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

function NavItem({ to, label, Icon, collapsed, end }: { to: string; label: string; Icon: React.ElementType; collapsed: boolean; end?: boolean }) {
  return (
    <NavLink to={to} end={end} title={collapsed ? label : undefined} className={({ isActive }) => itemClass(isActive, collapsed)}>
      {({ isActive }) => (
        <>
          <span className={iconBox(isActive, collapsed)}><Icon className="h-[18px] w-[18px]" /></span>
          <span className={cn("truncate", TAIL_W, fade(collapsed))}>{label}</span>
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
function FormRow({ form, Icon, subtitle, collapsed, lit, count }: {
  form: FormLink;
  Icon?: React.ElementType;
  /** A second line, e.g. the category in search results. */
  subtitle?: string;
  collapsed: boolean;
  lit: boolean;
  /** Amber count, e.g. people waiting in the Roster's review queue. */
  count?: number;
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
      <span className={cn("flex items-start gap-2 py-[11px] pr-2 text-left leading-[18px]", Icon ? cn("shrink-0", TAIL_W) : "min-w-0 flex-1 pl-2.5", fade(collapsed))}>
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

/** A category in the accordion: opens in place, so its forms never slide out of view. */
function CategoryRow({ type, open, here, collapsed, onToggle }: {
  type: NavCategory;
  open: boolean;
  /** The form on screen is one of this category's. */
  here: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { category, Icon } = type;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={collapsed ? undefined : open}
      title={collapsed ? category.name : undefined}
      className={cn(itemClass(here && collapsed, collapsed), wrapRow(collapsed), here && "text-ink")}
    >
      <span className={iconBox(here && collapsed, collapsed)}><Icon className="h-[18px] w-[18px]" /></span>
      <span className={cn("w-[149px] shrink-0 py-[11px] text-left leading-[18px]", fade(collapsed))}>
        {category.name}
        {/* Closed over the form you're in: a dot says it's in here. */}
        {here && !open && <span className="mb-px ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle dark:bg-white" />}
      </span>
      <span className={cn("flex h-10 w-5 shrink-0 items-center justify-center", fade(collapsed))}>
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </span>
    </button>
  );
}

/** Open categories, remembered per device. */
function useOpenCategories() {
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(readStorage(OPEN_KEY) ?? "[]");
      return new Set(Array.isArray(saved) ? saved.filter((v): v is string => typeof v === "string") : []);
    } catch {
      return new Set();
    }
  });
  useEffect(() => writeStorage(OPEN_KEY, JSON.stringify([...open])), [open]);
  const set = (id: string, value: boolean) =>
    setOpen((prev) => {
      if (prev.has(id) === value) return prev;
      const next = new Set(prev);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  return [open, set] as const;
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
 * The desktop sidebar: search, Home, Pinned, then every category as a
 * one-level accordion. Phones and tablets get the dock instead (Dock.tsx).
 */
export function Sidebar() {
  const { user, logout, can } = useAuth();
  const { collapsed, expand, toggleCollapsed } = useCollapsed();
  const swipe = useSwipeToggle(collapsed, toggleCollapsed);
  const reviewCount = useReviewCount();
  const { categories, pinned } = useNavCatalog();
  const lit = useIsLit();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useOpenCategories();
  const [q, setQ] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const focusSearch = useRef(false);
  const isAdmin = ADMIN_AREA.some(can);

  const countFor = (form: FormLink) => (form.url === "/roster" ? reviewCount : 0);
  const hereId = categories.find((c) => c.forms.some((f) => isInternalForm(f.url) && lit(f.url)))?.category.id;

  // Arriving at a form opens its category, so the forms beside it are in view.
  // Only on arrival: closing it again while you stay is left alone.
  useEffect(() => {
    if (hereId) setOpen(hereId, true);
  }, [pathname, hereId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Picking a form (or going anywhere) ends the search.
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

  const results = searchForms(categories, q);
  const searching = !collapsed && q.trim() !== "";
  const openResult = () => {
    const first = results[0]?.form;
    if (!first) return;
    if (isInternalForm(first.url)) navigate(first.url);
    else window.open(first.url, "_blank", "noopener,noreferrer");
    setQ("");
  };

  // Collapsed, a category is just an icon: tapping it unfolds the sidebar with that category open.
  const toggleCategory = (id: string) => {
    if (collapsed) {
      setOpen(id, true);
      expand();
    } else {
      setOpen(id, !open.has(id));
    }
  };

  return (
    <aside
      {...swipe}
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
      <div className="relative mb-2 h-10 shrink-0">
        <button
          type="button"
          onClick={openSearch}
          title="Find a form (Ctrl K)"
          aria-label="Find a form"
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
            placeholder="Find a form"
            aria-label="Find a form"
            className="h-10 min-h-10 bg-surface pr-14 text-[13.5px] md:min-h-10"
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-hairline px-1.5 py-px font-body text-[10.5px] font-bold text-muted">Ctrl K</kbd>
        </div>
      </div>

      {/* -mx/px: room for the scrollbar without shifting the items. */}
      <nav aria-label="Main" className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-1 scroll-thin">
        {searching ? (
          <>
            <SectionLabel label={results.length === 1 ? "1 form" : `${results.length} forms`} collapsed={false} />
            {results.map((r) => (
              <FormRow key={r.form.id} form={r.form} Icon={r.Icon} subtitle={r.category.name} collapsed={false} lit={lit(r.form.url)} count={countFor(r.form)} />
            ))}
            {results.length === 0 && <p className="px-2.5 py-2 text-[13px] text-muted">No forms match. Try a shorter word.</p>}
          </>
        ) : (
          <>
            <NavItem to="/forms" label="Home" Icon={Home} collapsed={collapsed} end />

            {pinned.length > 0 && (
              <>
                <SectionLabel label="Pinned" collapsed={collapsed} />
                {pinned.map((p) => (
                  <FormRow key={p.form.id} form={p.form} Icon={p.Icon} collapsed={collapsed} lit={lit(p.form.url)} count={countFor(p.form)} />
                ))}
              </>
            )}

            {categories.length > 0 && <SectionLabel label="All forms" collapsed={collapsed} />}
            {categories.map((c) => {
              const isOpen = open.has(c.category.id) && !collapsed;
              return (
                <div key={c.category.id} className="shrink-0">
                  <CategoryRow
                    type={c}
                    open={open.has(c.category.id)}
                    here={hereId === c.category.id}
                    collapsed={collapsed}
                    onToggle={() => toggleCategory(c.category.id)}
                  />
                  {isOpen && (
                    <ul className="mb-1 ml-5 space-y-px border-l border-hairline pl-1.5">
                      {c.forms.map((f) => (
                        <li key={f.id}>
                          <FormRow form={f} collapsed={false} lit={lit(f.url)} count={countFor(f)} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}

            {isAdmin && (
              <>
                <div className="mx-2 my-2.5 h-px shrink-0 bg-hairline" />
                <NavItem to="/admin" label="Admin" Icon={Settings} collapsed={collapsed} />
              </>
            )}
          </>
        )}
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={toggleCollapsed}
        title={collapsed ? "Expand" : "Collapse"}
        className="mb-2 mt-2 flex h-10 w-full shrink-0 items-center overflow-hidden rounded-input text-[12.5px] font-semibold text-muted transition-colors hover:bg-navsel/60 hover:text-ink"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center">
          {collapsed ? <PanelLeftOpen className="h-[18px] w-[18px]" /> : <PanelLeftClose className="h-[18px] w-[18px]" />}
        </span>
        <span className={cn("whitespace-nowrap", fade(collapsed))}>Collapse</span>
      </button>

      {/* User chip */}
      <div className="w-full shrink-0 overflow-hidden border-t border-hairline pt-3">
        <div className="flex w-full items-center">
          <NavLink to="/profile" title={collapsed ? user?.name : undefined} className="flex h-8 w-10 shrink-0 items-center justify-center"><Avatar name={user?.name ?? "?"} color={user?.avatarColor} /></NavLink>
          {/* Hidden, not unmounted, while collapsed: taken out of the tab order
              so focus can't land on something clipped out of view. */}
          <div className={cn("flex shrink-0 items-center", TAIL_W, fade(collapsed))} aria-hidden={collapsed || undefined}>
            <div className="min-w-0 flex-1">
              <NavLink to="/profile" tabIndex={collapsed ? -1 : undefined} className="block truncate text-[13px] font-semibold text-ink hover:text-accent dark:hover:text-white">{user?.name}</NavLink>
              <p className="truncate text-micro text-muted">{user?.role?.name}</p>
            </div>
            <button onClick={() => logout()} title="Sign out" tabIndex={collapsed ? -1 : undefined} className="shrink-0 text-muted hover:text-ink"><LogOut className="h-4 w-4" /></button>
          </div>
        </div>
      </div>
    </aside>
  );
}
