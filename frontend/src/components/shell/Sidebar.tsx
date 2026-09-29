import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  Settings, FileText, ChevronLeft, ChevronRight, ExternalLink,
  LogOut, PanelLeftClose, PanelLeftOpen, Star,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ADMIN_AREA, useAuth } from "@/lib/auth";
import { usePrefs } from "@/lib/prefs";
import { Avatar } from "@/components/ui/avatar";
import { CountBadge } from "@/components/ui/badge";
import { useForms, useSites } from "@/lib/queries";
import { canOpenForm, formIcon, formLinkIcon, isInternalForm } from "@/lib/formIcons";
import type { FormCategory, FormLink } from "@/lib/types";
import { ThemedLogo } from "@/components/shell/ThemedLogo";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { useNavMode } from "@/lib/shellNav";
import { forcedDevice } from "@/lib/device";
import { readStorage, writeStorage } from "@/lib/storage";

const EXPANDED_WIDTH = 240;
const COLLAPSED_WIDTH = 64;
const DRILL_KEY = "ln.formDrill";
/** Drill id of the Favorites pseudo-type; can't collide with a category's cuid. */
const FAVORITES_ID = "favorites";
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

/** People waiting in the review queue across every site the user can see. */
export function useReviewCount(): number {
  const { can } = useAuth();
  const rosterUser = can("roster.view");
  const { data } = useSites(false, rosterUser);
  return rosterUser ? (data ?? []).reduce((n, s) => n + s.attentionCount, 0) : 0;
}

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

function NavItem({ to, label, Icon, collapsed, alsoActiveFor, count, end }: {
  to: string;
  label: string;
  Icon: React.ElementType;
  collapsed: boolean;
  /** Extra path prefixes that should light this item up. */
  alsoActiveFor?: string[];
  count?: number;
  end?: boolean;
}) {
  const { pathname } = useLocation();
  const alsoActive = alsoActiveFor?.some((p) => pathname.startsWith(p)) ?? false;
  const waiting = (count ?? 0) > 0;
  return (
    <NavLink to={to} end={end} title={collapsed ? label : undefined} className={({ isActive }) => itemClass(isActive || alsoActive, collapsed)}>
      {({ isActive }) => (
      <>
      <span className={iconBox(isActive || alsoActive, collapsed)}>
        <Icon className="h-[18px] w-[18px]" />
        {waiting && <WaitingDot collapsed={collapsed} />}
      </span>
      <span className={cn("flex shrink-0 items-center", TAIL_W, fade(collapsed))}>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {waiting && <CountBadge count={count!} max={999} className="mr-2" />}
      </span>
      </>
      )}
    </NavLink>
  );
}

/** Which form type the sidebar is drilled into, remembered per device. */
function useDrill() {
  const [drill, setDrill] = useState<string | null>(() => readStorage(DRILL_KEY) || null);
  useEffect(() => writeStorage(DRILL_KEY, drill || null), [drill]);
  return [drill, setDrill] as const;
}

/**
 * One form type on the top level: a row (open) or its icon (collapsed) that
 * drills into the type's forms, which then show the same way.
 */
function TypeRow({ category, Icon, collapsed, onOpen, buttonRef }: {
  category: FormCategory;
  Icon: React.ElementType;
  collapsed: boolean;
  onOpen: () => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onOpen}
      title={collapsed ? category.name : undefined}
      // The name wraps to a second line rather than truncating: "Client /
      // Tenant Serv…" loses the half that tells the types apart. Collapsed,
      // max-height clamps the row back to one icon's height.
      className={cn(
        itemClass(false, collapsed),
        "h-auto min-h-10 items-start transition-[max-height,background-color,color] duration-[240ms] motion-reduce:transition-none",
        EASE,
        collapsed ? "max-h-10" : "max-h-[72px]"
      )}
    >
      <span className={iconBox(false, collapsed)}><Icon className="h-[18px] w-[18px]" /></span>
      <span className={cn("w-[149px] shrink-0 py-[11px] text-left leading-[18px]", fade(collapsed))}>{category.name}</span>
      <span className={cn("flex h-10 w-5 shrink-0 items-center justify-center", fade(collapsed))}><ChevronRight className="h-4 w-4" /></span>
    </button>
  );
}

/**
 * The second level: one type's forms, with the way back up. Built on the same
 * 40px icon column as the top level, so collapsed it's a column of the forms'
 * own icons under a back arrow, and the form you're in stays lit.
 */
function TypePane({ category, Icon, forms, reviewCount, collapsed, onBack, backRef }: {
  category: FormCategory;
  Icon: React.ElementType;
  forms: FormCategory["forms"];
  /** Shown on the Roster link: people waiting in its review queue. */
  reviewCount: number;
  collapsed: boolean;
  onBack: () => void;
  backRef: React.Ref<HTMLButtonElement>;
}) {
  const { pathname } = useLocation();
  // Long form names wrap rather than truncate ("Metro Card Reconciliation Form
  // (Reports)" cut to "Metro Card Reco…" is useless); collapsed, max-height
  // clamps each row back to one icon's height.
  const rowClass = (active: boolean) =>
    cn(
      itemClass(active, collapsed),
      "h-auto min-h-10 items-start font-medium transition-[max-height,background-color,color] duration-[240ms] motion-reduce:transition-none",
      EASE,
      active && "font-semibold",
      collapsed ? "max-h-10" : "max-h-[96px]"
    );
  const label = "w-[169px] shrink-0 py-[11px] pr-2 text-left leading-[18px]";
  const lit = (url: string) => pathname === url || pathname.startsWith(`${url}/`) || (url === "/roster" && isRosterPath(pathname));
  return (
    <div className="w-[209px] shrink-0">
      <button ref={backRef} type="button" onClick={onBack} title={collapsed ? "All form types" : undefined} aria-label="All form types" className={itemClass(false, collapsed)}>
        <span className={iconBox(false, collapsed)}><ChevronLeft className="h-[18px] w-[18px]" /></span>
        <span className={cn("whitespace-nowrap", fade(collapsed))}>All form types</span>
      </button>
      <div className="mb-1 flex items-start border-b border-hairline pb-2 pt-1 text-ink dark:text-white" title={collapsed ? category.name : undefined}>
        <span className="relative flex h-10 w-10 shrink-0 items-center justify-center">
          <Icon className="h-[18px] w-[18px]" />
          {/* Collapsed, the name is hidden: an underline marks this icon as the
              heading of the icons below, not one more link. */}
          <span className={cn("absolute bottom-0.5 left-1/2 h-[2px] w-5 -translate-x-1/2 rounded-pill bg-current transition-opacity duration-200", collapsed ? "opacity-100" : "opacity-0")} />
        </span>
        <h2 className={cn("min-w-0 flex-1 pr-2 pt-2.5 font-heading text-[15px] font-extrabold leading-5", fade(collapsed))}>{category.name}</h2>
      </div>
      <ul className="space-y-px pb-2">
        {forms.map((f) => {
          const FormIcon = formLinkIcon(f, category.icon || "folder");
          const waiting = f.url === "/roster" && reviewCount > 0;
          return (
            <li key={f.id}>
              {isInternalForm(f.url) ? (
                <NavLink
                  to={f.url}
                  end
                  title={collapsed ? f.title : undefined}
                  // The Roster link is the roster's only way in from the sidebar,
                  // so it stays lit on every roster tab and resident page; a
                  // rebuilt form stays lit on its own tabs (/forms/hot-foods/…).
                  className={rowClass(lit(f.url))}
                >
                  <span className={iconBox(lit(f.url), collapsed)}>
                    <FormIcon className="h-[18px] w-[18px]" />
                    {waiting && <WaitingDot collapsed={collapsed} />}
                  </span>
                  <span className={cn(label, "flex items-start gap-2", fade(collapsed))}>
                    <span className="min-w-0 flex-1">{f.title}</span>
                    {waiting && <CountBadge count={reviewCount} max={999} label={`${reviewCount} to review`} className="shrink-0" />}
                  </span>
                </NavLink>
              ) : (
                <a href={f.url} target="_blank" rel="noopener noreferrer" title={`${f.title} (opens in a new tab)`} className={cn(rowClass(false), "group/link")}>
                  <span className={iconBox(false, collapsed)}><FormIcon className="h-[18px] w-[18px]" /></span>
                  <span className={cn(label, "flex items-start gap-2", fade(collapsed))}>
                    <span className="min-w-0 flex-1">{f.title}</span>
                    <ExternalLink className="mt-1 h-3 w-3 shrink-0 opacity-50 group-hover/link:opacity-100" aria-hidden />
                  </span>
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const isRosterPath = (pathname: string) => pathname.startsWith("/roster") || pathname.startsWith("/tenants");
/** Inside a form rather than on the catalog or an admin screen: built-in forms, the Roster, built forms and code forms. */
const isFormPath = (pathname: string) =>
  pathname.startsWith("/forms/") || pathname.startsWith("/f/") || pathname.startsWith("/apps/") || isRosterPath(pathname);

/**
 * The sidebar's collapsed state.
 *
 * An iPad in portrait has 820px to share, and a form beside a 240px sidebar
 * gets barely two thirds of it, so inside a form there the sidebar folds to
 * its icons on its own. Expanding it then is a peek, not a change of the saved
 * preference: it folds again on the next navigation (picking a form from it
 * included), and the preference is still what the catalog and landscape use.
 */
function useCollapsed() {
  const { collapsed: preferred, toggleCollapsed } = usePrefs();
  const { pathname } = useLocation();
  const portraitTablet = useMediaQuery("(min-width: 768px) and (orientation: portrait)");
  const wide = useMediaQuery("(min-width: 768px)");
  // A tablet: a coarse pointer, or a device preview frame standing in for an iPad.
  const tablet = useMediaQuery("(min-width: 768px) and (pointer: coarse)") || (forcedDevice() === "tablet" && wide);
  // A code form's page can ask for more (or less) folding than the default.
  const mode = useNavMode() ?? "auto";
  const auto =
    isFormPath(pathname) &&
    (mode === "always" ? wide : mode === "tablet" ? tablet || portraitTablet : mode === "never" ? false : portraitTablet);
  const [peek, setPeek] = useState(false);
  useEffect(() => setPeek(false), [pathname, auto]);
  return auto
    ? { collapsed: !peek, toggleCollapsed: () => setPeek((p) => !p) }
    : { collapsed: preferred, toggleCollapsed };
}

export function Sidebar() {
  const { user, logout, can } = useAuth();
  const { collapsed, toggleCollapsed } = useCollapsed();
  const reviewCount = useReviewCount();
  const { data: catalog } = useForms();
  const [drill, setDrill] = useDrill();
  // The type the second pane shows. It outlives `drill` so the pane keeps its
  // content while it slides back out, instead of blanking mid-animation.
  const [shown, setShown] = useState(drill);
  const isAdmin = ADMIN_AREA.some(can);

  // Types with nothing this person may open are left out entirely.
  const categoryTypes = (catalog?.categories ?? [])
    .map((category) => ({
      category,
      Icon: formIcon(category.icon),
      forms: category.forms.filter((f) => canOpenForm(f.url, can)),
    }))
    .filter((t) => t.forms.length > 0);
  // Favorites leads the list as a type of its own, in the order they were starred.
  const byId = new Map(categoryTypes.flatMap((t) => t.forms.map((f) => [f.id, f] as const)));
  const favoriteForms = (catalog?.favorites ?? []).map((id) => byId.get(id)).filter((f): f is FormLink => Boolean(f));
  const types = favoriteForms.length > 0
    ? [{ category: { id: FAVORITES_ID, name: "Favorites", icon: "", sortOrder: -1, forms: favoriteForms }, Icon: Star, forms: favoriteForms }, ...categoryTypes]
    : categoryTypes;
  const shownType = types.find((t) => t.category.id === shown);
  const drilled = !!drill && types.some((t) => t.category.id === drill);

  // Inside a form, the sidebar shows that form's type, so the forms next to it
  // are one tap away (and, collapsed, it's their icons rather than the types').
  // A type already showing the form (Favorites, say) is left alone.
  const { pathname } = useLocation();
  const inType = (t: (typeof types)[number]) =>
    t.forms.some((f) => isInternalForm(f.url) && (pathname === f.url || pathname.startsWith(`${f.url}/`) || (f.url === "/roster" && isRosterPath(pathname))));
  const hereType = isFormPath(pathname) ? categoryTypes.find(inType) : undefined;
  // On arriving at a form only (a new path, or the catalog loading), so the
  // back arrow still takes you up to the types while you stay in the form.
  useEffect(() => {
    if (!hereType || types.some((t) => t.category.id === drill && inType(t))) return;
    setShown(hereType.category.id);
    setDrill(hereType.category.id);
  }, [pathname, hereType?.category.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus follows the slide, so a keyboard user lands on Back after drilling
  // in and on the type they came from after going back.
  const backRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    // preventScroll: the panes sit side by side in an overflow-hidden track,
    // and letting the browser scroll it to the focused element would knock the
    // track out of line with its transform.
    (target === "back" ? backRef.current : rowRefs.current.get(target))?.focus({ preventScroll: true });
  }, [drill]);

  const openType = (id: string) => {
    pendingFocus.current = "back";
    setShown(id);
    setDrill(id);
  };
  const goBack = () => {
    pendingFocus.current = drill;
    setDrill(null);
  };

  return (
    <aside
      style={{ width: collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH }}
      // Hidden on a phone: most of a 402px viewport, and the bottom tab bar
      // covers the same destinations. `hidden md:flex` rather than a conditional
      // render so the collapse preference survives a rotation without the whole
      // aside remounting.
      className={cn(
        "hidden h-full shrink-0 flex-col overflow-hidden border-r border-hairline bg-sidebar py-5 transition-[width,padding] duration-[240ms] motion-reduce:transition-none md:flex",
        EASE,
        collapsed ? "px-3" : "px-[15px]"
      )}
    >
      {/* Brand lockup */}
      <div className="mb-5 flex shrink-0 items-center">
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

      {/* Two panes side by side in a track twice the nav's width: the top
          level, and one type's forms. Drilling in slides the track by one pane.
          -mx/px: room for the scrollbar without shifting the items. */}
      <nav className="relative -mx-1 min-h-0 flex-1 overflow-hidden">
        <div className={cn("flex h-full w-[200%] transition-transform duration-300 motion-reduce:transition-none", EASE, drilled && "-translate-x-1/2")}>
          <div inert={drilled} className="flex h-full w-1/2 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-1 scroll-thin">
            <NavItem to="/forms" label="All forms" Icon={FileText} collapsed={collapsed} end />

            {types.length > 0 && <SectionLabel label="Forms by type" collapsed={collapsed} />}
            {types.map(({ category, Icon }) => (
              <TypeRow
                key={category.id}
                category={category}
                Icon={Icon}
                collapsed={collapsed}
                onOpen={() => openType(category.id)}
                buttonRef={(el) => {
                  if (el) rowRefs.current.set(category.id, el);
                  else rowRefs.current.delete(category.id);
                }}
              />
            ))}

            {isAdmin && (
              <>
                <div className="mx-2 my-2.5 h-px shrink-0 bg-hairline" />
                <NavItem to="/admin" label="Admin" Icon={Settings} collapsed={collapsed} />
              </>
            )}
          </div>

          <div inert={!drilled} className="h-full w-1/2 overflow-y-auto overflow-x-hidden px-1 scroll-thin">
            {shownType && <TypePane category={shownType.category} Icon={shownType.Icon} forms={shownType.forms} reviewCount={reviewCount} collapsed={collapsed} onBack={goBack} backRef={backRef} />}
          </div>
        </div>
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
