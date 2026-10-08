import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { CalendarDays, ChevronRight, ExternalLink, Home, LayoutGrid, LogOut, Contact, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { Avatar } from "@/components/ui/avatar";
import { CountBadge } from "@/components/ui/badge";
import { SearchInput } from "@/components/ui/input";
import { formLinkIcon, isInternalForm } from "@/lib/formIcons";
import type { FormLink } from "@/lib/types";
import { ROSTER_URL, searchForms, shortFormName, useIsLit, useNavCatalog, useReviewCount, type NavForm } from "./navData";

/**
 * Phone and tablet navigation: a floating dock at the bottom, within thumb
 * reach, holding Home, the Roster, the Calendar and your pinned forms (a phone
 * has room for one only without the Roster); "All forms" opens the Launcher
 * above it. The desktop gets the sidebar instead (Sidebar.tsx).
 *
 * The dock sits in a band that is a flex sibling of <main>, not an overlay,
 * so <main>'s scroll region ends where the band begins and screens with their
 * own sticky footer (the bill review's approve bar) stack against it.
 */
export function Dock({ device, launcherOpen, onToggleLauncher, onCloseLauncher }: {
  device: "phone" | "tablet";
  launcherOpen: boolean;
  onToggleLauncher: () => void;
  onCloseLauncher: () => void;
}) {
  const { can } = useAuth();
  const reviewCount = useReviewCount();
  const { pinned } = useNavCatalog();
  const lit = useIsLit();
  const { pathname } = useLocation();
  const roster = can("roster.view");
  const phone = device === "phone";
  const navRef = useRef<HTMLElement>(null);
  const { width, height } = useSize(navRef);
  const [menuOpen, setMenuOpen] = useState(false);
  // Any navigation, the launcher opening, or Escape puts the menu away.
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => { if (launcherOpen) setMenuOpen(false); }, [launcherOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);
  // The launcher sizes itself around the dock (the phone sheet runs on under it).
  useEffect(() => {
    document.documentElement.style.setProperty("--dock-h", `${height}px`);
  }, [height]);
  // Gone with the dock, so a desktop window resized up from an iPad's width
  // doesn't leave toasts floating a dock's height off the bottom.
  useEffect(
    () => () => {
      document.documentElement.style.removeProperty("--dock-h");
    },
    []
  );
  // The account slot is always last: your avatar, opening the account menu.
  // A phone has five slots: Home, Roster, Calendar, All forms and the account
  // slot leave room for a pin only when there's no Roster. A tablet fits as
  // many pins as its width allows: ~6 on a portrait iPad, ~10 in landscape.
  const fixed = (roster ? 5 : 4); // Home, Roster, Calendar, All forms, the account slot
  const tabletPins = Math.max(2, Math.floor((width - TABLET_CHROME) / TABLET_SLOT) - fixed);
  const pins = pinned.slice(0, phone ? 5 - fixed : tabletPins);

  const home = <DockLink key="home" to="/forms" end label="Home" Icon={Home} active={!launcherOpen && pathname === "/forms"} phone={phone} onClick={onCloseLauncher} />;
  const rosterItem = roster && (
    <DockLink key="roster" to={ROSTER_URL} label="Roster" Icon={Contact} active={!launcherOpen && lit(ROSTER_URL)} count={reviewCount} phone={phone} onClick={onCloseLauncher} />
  );
  const calendarItem = (
    <DockLink key="calendar" to="/calendar" label="Calendar" Icon={CalendarDays} active={!launcherOpen && pathname.startsWith("/calendar")} phone={phone} onClick={onCloseLauncher} />
  );
  const all = (
    <DockButton key="all" label="All forms" Icon={LayoutGrid} active={launcherOpen} onClick={onToggleLauncher} phone={phone} expanded={launcherOpen} />
  );
  const account = (
    <DockAccount key="account" active={menuOpen || pathname === "/profile"} open={menuOpen} phone={phone} onClick={() => { onCloseLauncher(); setMenuOpen((o) => !o); }} />
  );
  const pinItems = pins.map((p) => <DockPin key={p.form.id} pin={p} active={!launcherOpen && isInternalForm(p.form.url) && lit(p.form.url)} phone={phone} onClick={onCloseLauncher} />);

  return (
    <nav
      ref={navRef}
      aria-label="Main"
      // While the launcher is open its scrim covers the whole screen and the dock
      // floats on top of it: the band goes clear, so there's no edge between the
      // dimmed page and a white strip.
      className={cn(
        "relative flex flex-none justify-center px-3 pb-safe-bottom pt-2 transition-colors duration-200 motion-reduce:transition-none",
        launcherOpen ? "z-50 bg-transparent" : "bg-surface"
      )}
    >
      {menuOpen && <AccountMenu phone={phone} onClose={() => setMenuOpen(false)} />}
      {phone ? (
        <div
          className="relative z-[45] grid w-full max-w-[480px] gap-0.5 rounded-[24px] border border-hairline bg-surface p-1.5 shadow-panel"
          style={{ gridTemplateColumns: `repeat(${[home, rosterItem, calendarItem, all, ...pinItems, account].filter(Boolean).length}, minmax(0, 1fr))` }}
        >
          {home}
          {rosterItem}
          {calendarItem}
          {all}
          {pinItems}
          {account}
        </div>
      ) : (
        <div className="relative z-[45] flex items-center gap-1 rounded-[26px] border border-hairline bg-surface p-2 shadow-panel">
          {home}
          {rosterItem}
          {calendarItem}
          {pinItems.length > 0 && <span className="mx-1 h-9 w-px bg-hairline" />}
          {pinItems}
          <span className="mx-1 h-9 w-px bg-hairline" />
          {all}
          <span className="mx-1 h-9 w-px bg-hairline" />
          {account}
        </div>
      )}
    </nav>
  );
}

/** One tablet dock item: its 78px width plus the 4px gap. */
const TABLET_SLOT = 82;
/** The band's side padding, the pill's padding and border, the two dividers, and breathing room at the screen's edges. */
const TABLET_CHROME = 24 + 18 + 18 + 48;

/** An element's size, kept current as the window resizes or rotates. */
function useSize(ref: React.RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize((s) => (s.width === el.offsetWidth && s.height === el.offsetHeight ? s : { width: el.offsetWidth, height: el.offsetHeight }));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

const itemClass = (active: boolean, phone: boolean) =>
  cn(
    "relative flex min-h-[56px] flex-col items-center justify-center gap-[3px] px-1 font-bold transition-colors",
    phone ? "rounded-[18px] text-[10.5px]" : "w-[78px] rounded-[18px] text-[11.5px]",
    active ? "bg-navy text-white dark:bg-navsel" : "text-muted hover:bg-navsel/60 hover:text-ink"
  );

function Badge({ count }: { count: number }) {
  return (
    <span
      aria-label={`${count} to review`}
      className="absolute right-[calc(50%-22px)] top-1 flex h-[17px] min-w-[17px] items-center justify-center rounded-pill bg-status-amberBg px-1 text-[10px] font-extrabold text-status-amberText"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** onClick closes the launcher: tapping the page you are already on changes no route, so nothing else would. */
function DockLink({ to, end, label, Icon, active, count = 0, phone, onClick }: { to: string; end?: boolean; label: string; Icon: React.ElementType; active: boolean; count?: number; phone: boolean; onClick: () => void }) {
  return (
    <NavLink to={to} end={end} onClick={onClick} className={itemClass(active, phone)}>
      <Icon className="h-[22px] w-[22px]" />
      <span className="max-w-full truncate">{label}</span>
      {count > 0 && <Badge count={count} />}
    </NavLink>
  );
}

function DockButton({ label, Icon, active, onClick, phone, expanded }: { label: string; Icon: React.ElementType; active: boolean; onClick: () => void; phone: boolean; expanded: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-expanded={expanded} aria-haspopup="dialog" className={itemClass(active, phone)}>
      <Icon className="h-[22px] w-[22px]" />
      <span className="max-w-full truncate">{label}</span>
    </button>
  );
}

/** The last dock slot: your avatar, opening the account menu. */
function DockAccount({ active, open, onClick, phone }: { active: boolean; open: boolean; onClick: () => void; phone: boolean }) {
  const { user } = useAuth();
  return (
    <button type="button" onClick={onClick} aria-expanded={open} aria-haspopup="dialog" className={itemClass(active, phone)}>
      <Avatar name={user?.name ?? "?"} color={user?.avatarColor} size={26} />
      <span className="max-w-full truncate">Profile</span>
    </button>
  );
}

/**
 * Who you are signed in as, with Profile & settings and Sign out. It opens
 * just above the dock, at its right end under the avatar; the dock stays above
 * the scrim so the next tap on it still goes where it says.
 */
function AccountMenu({ phone, onClose }: { phone: boolean; onClose: () => void }) {
  const { user, logout } = useAuth();
  return (
    <>
      <button type="button" tabIndex={-1} aria-label="Close" onClick={onClose} className="fixed inset-0 z-40 cursor-default" />
      <div
        role="dialog"
        aria-label="Account"
        className={cn(
          "absolute bottom-full z-50 mb-2 w-[min(300px,calc(100vw-24px))] overflow-hidden rounded-[18px] border border-hairline bg-surface shadow-panel",
          phone ? "right-3" : "right-6"
        )}
      >
        <div className="flex items-center gap-3 border-b border-hairline bg-sidebar px-4 py-3">
          <Avatar name={user?.name ?? "?"} color={user?.avatarColor} />
          <span className="min-w-0">
            <span className="block truncate text-[14px] font-bold text-ink">{user?.name}</span>
            <span className="block truncate text-micro text-muted">{user?.role?.name}</span>
          </span>
        </div>
        <NavLink to="/profile" onClick={onClose} className="flex min-h-[50px] items-center gap-3 border-b border-hairline px-4 text-[14px] font-semibold text-ink active:bg-rowhover">
          <span className="flex-1">Profile &amp; settings</span>
          <ChevronRight className="h-4 w-4 text-muted" />
        </NavLink>
        <button type="button" onClick={() => void logout()} className="flex min-h-[50px] w-full items-center gap-3 px-4 text-left text-[14px] font-semibold text-status-redText active:bg-rowhover">
          <LogOut className="h-[18px] w-[18px]" /> Sign out
        </button>
      </div>
    </>
  );
}

function DockPin({ pin, active, phone, onClick }: { pin: NavForm; active: boolean; phone: boolean; onClick: () => void }) {
  const { form, Icon } = pin;
  const body = (
    <>
      <Icon className="h-[22px] w-[22px]" />
      <span className="max-w-full truncate">{shortFormName(form.title)}</span>
    </>
  );
  return isInternalForm(form.url) ? (
    <NavLink to={form.url} onClick={onClick} title={form.title} className={itemClass(active, phone)}>{body}</NavLink>
  ) : (
    <a href={form.url} target="_blank" rel="noopener noreferrer" onClick={onClick} title={`${form.title} (opens in a new tab)`} className={itemClass(false, phone)}>{body}</a>
  );
}

/**
 * Every form, as an app drawer: icon tiles grouped by category. It
 * rises out of the dock: on a phone a sheet that runs on down behind the dock
 * to the bottom of the screen, on a tablet a panel just above it. The dock stays
 * on top and usable, so "All forms" closes it again.
 *
 * Mounted while open and for the length of the closing animation.
 */
const LAUNCHER_MS = 280;

export function Launcher({ device, open, onClose }: { device: "phone" | "tablet"; open: boolean; onClose: () => void }) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), LAUNCHER_MS);
    return () => window.clearTimeout(t);
  }, [open]);
  return mounted ? <LauncherPanel device={device} open={open} onClose={onClose} /> : null;
}

function LauncherPanel({ device, open, onClose }: { device: "phone" | "tablet"; open: boolean; onClose: () => void }) {
  // Mounts in its closed position; once that has been laid out (the forced
  // read below), flipping to open runs the transition from there. A read
  // rather than requestAnimationFrame, which never fires in a hidden tab.
  const [entered, setEntered] = useState(false);
  const shown = open && entered;
  const { categories, pinned } = useNavCatalog();
  const reviewCount = useReviewCount();
  const lit = useIsLit();
  const [q, setQ] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const phone = device === "phone";
  const swipe = useSwipeDown(dialogRef, listRef, onClose);

  // Focus moves into the sheet (not the search: on a phone that would throw
  // the keyboard up over it) and back to where it was on close.
  useEffect(() => {
    void dialogRef.current?.offsetHeight;
    setEntered(true);
  }, []);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      before?.focus?.({ preventScroll: true });
    };
  }, [onClose]);

  const results = searchForms(categories, q);
  const searching = q.trim() !== "";
  const tile = (form: FormLink, Icon: React.ElementType, key: string) => (
    <AppTile key={key} form={form} Icon={Icon} lit={isInternalForm(form.url) && lit(form.url)} count={form.url === ROSTER_URL ? reviewCount : 0} onPick={onClose} />
  );

  return (
    <div
      className={cn("fixed inset-0 z-40 flex items-end justify-center", !phone && "px-6 pt-10")}
      style={{ paddingBottom: phone ? undefined : "calc(var(--dock-h, 96px) + 4px)" }}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close"
        onClick={onClose}
        className={cn("absolute inset-0 bg-black/40 transition-opacity duration-[280ms] motion-reduce:transition-none", shown ? "opacity-100" : "opacity-0")}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="All forms"
        tabIndex={-1}
        {...swipe.handlers}
        style={{
          ...(phone ? { paddingBottom: "var(--dock-h, 96px)" } : {}),
          // While a finger drags it down it follows the finger, no easing.
          ...(swipe.offset > 0 ? { transform: `translateY(${swipe.offset}px)`, transition: "none" } : {}),
        }}
        className={cn(
          "relative flex w-full flex-col overflow-hidden bg-surface shadow-panel outline-none",
          "transition-[transform,opacity] duration-[280ms] ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none",
          phone ? "max-h-[94%] rounded-t-[24px]" : "max-h-full max-w-[760px] origin-bottom rounded-[20px]",
          // Phone: slides up from the bottom edge. Tablet: rises and grows out of the dock.
          shown ? "translate-y-0 scale-100 opacity-100" : phone ? "translate-y-full" : "translate-y-8 scale-[0.96] opacity-0"
        )}
      >
        <div className={cn("flex-none px-4 pb-3", phone ? "pt-2.5" : "pt-5 md:px-6")}>
          {phone && <span className="mx-auto mb-2.5 block h-[5px] w-10 rounded-pill bg-hairline" aria-hidden />}
          <div className="mb-3 flex items-center gap-2">
            <h2 className="flex-1 font-heading text-[21px] font-extrabold text-ink">All forms</h2>
            <button type="button" onClick={onClose} aria-label="Close" className="flex h-10 w-10 items-center justify-center rounded-full bg-navsel/70 text-ink">
              <X className="h-[18px] w-[18px]" />
            </button>
          </div>
          <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a form" aria-label="Find a form" />
        </div>

        <div ref={listRef} className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 scroll-thin", !phone && "md:px-6")}>
          {searching ? (
            results.length > 0 ? (
              <div className={cn(TILE_GRID, "pt-1")}>{results.map((r) => tile(r.form, r.Icon, r.form.id))}</div>
            ) : (
              <p className="py-2 text-[14px] text-muted">No forms match. Try a shorter word.</p>
            )
          ) : (
            <div className="grid gap-y-6 pt-1">
              {pinned.length > 0 && (
                <Group title="Pinned">
                  {pinned.map((p) => tile(p.form, p.Icon, `pin-${p.form.id}`))}
                </Group>
              )}
              {categories.map((c) => (
                <Group key={c.category.id} title={c.category.name} Icon={c.Icon}>
                  {c.forms.map((f) => tile(f, formLinkIcon(f, c.category.icon || "folder"), f.id))}
                </Group>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The launcher's app-drawer grid: every tile the same width whatever its name,
 * as many to a row as fit (4 on a phone, 6–7 on a tablet).
 */
const TILE_GRID = "grid grid-cols-[repeat(auto-fill,minmax(76px,1fr))] gap-x-2 gap-y-4";

/**
 * Swipe down to put the launcher away, like a system sheet: from anywhere on
 * it while its list is scrolled to the top (otherwise the swipe scrolls the
 * list). Far enough, or a quick flick, closes it; anything less springs back.
 */
function useSwipeDown(sheetRef: React.RefObject<HTMLDivElement | null>, listRef: React.RefObject<HTMLDivElement | null>, onClose: () => void) {
  const [offset, setOffset] = useState(0);
  const drag = useRef<{ y: number; t: number; armed: boolean; active: boolean } | null>(null);
  // Once the sheet is following the finger, the list mustn't rubber-band too.
  // React's touch listeners are passive, so this one is added by hand.
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const stop = (e: TouchEvent) => {
      if (drag.current?.active) e.preventDefault();
    };
    el.addEventListener("touchmove", stop, { passive: false });
    return () => el.removeEventListener("touchmove", stop);
  }, [sheetRef]);
  const handlers = {
    onTouchStart(e: React.TouchEvent) {
      if (e.touches.length !== 1) return;
      const inList = listRef.current?.contains(e.target as Node) ?? false;
      drag.current = { y: e.touches[0].clientY, t: e.timeStamp, armed: !inList || (listRef.current?.scrollTop ?? 0) <= 0, active: false };
    },
    onTouchMove(e: React.TouchEvent) {
      const d = drag.current;
      if (!d?.armed) return;
      const dy = e.touches[0].clientY - d.y;
      // Moving up first means scrolling the list: leave it to the browser.
      if (!d.active && dy < -4) {
        d.armed = false;
        return;
      }
      if (!d.active && dy > 8) d.active = true;
      if (d.active) setOffset(Math.max(0, dy));
    },
    onTouchEnd(e: React.TouchEvent) {
      const d = drag.current;
      drag.current = null;
      if (!d?.active) return;
      const dy = (e.changedTouches[0]?.clientY ?? d.y) - d.y;
      const speed = dy / Math.max(1, e.timeStamp - d.t);
      setOffset(0);
      if (dy > 110 || (dy > 30 && speed > 0.6)) onClose();
    },
    onTouchCancel() {
      drag.current = null;
      setOffset(0);
    },
  };
  return { offset, handlers };
}

function Group({ title, Icon, children }: { title: string; Icon?: React.ElementType; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-micro font-extrabold uppercase tracking-[0.04em] text-muted">
        {Icon && (
          <span className="flex h-6 w-6 items-center justify-center rounded-[7px] bg-navy text-white dark:bg-navsel">
            <Icon className="h-3.5 w-3.5" />
          </span>
        )}
        {title}
      </h3>
      <div className={TILE_GRID}>{children}</div>
    </section>
  );
}

/** A form as a home-screen app: a square icon with its name underneath, at most two lines. */
function AppTile({ form, Icon, lit, count, onPick }: { form: FormLink; Icon: React.ElementType; lit: boolean; count: number; onPick: () => void }) {
  const internal = isInternalForm(form.url);
  const className = "group flex min-w-0 flex-col items-center gap-1.5 rounded-[14px] px-0.5 py-1 text-center outline-none focus-visible:ring-2 focus-visible:ring-accent";
  const body = (
    <>
      <span
        className={cn(
          "relative flex h-[58px] w-[58px] items-center justify-center rounded-[16px] transition-colors",
          lit ? "bg-navy text-white dark:bg-accent" : "bg-navsel text-accent group-hover:bg-navsel/70 group-active:scale-95 dark:text-white"
        )}
      >
        <Icon className="h-[26px] w-[26px]" />
        {count > 0 && (
          <span className="absolute -right-1.5 -top-1.5">
            <CountBadge count={count} max={99} label={`${count} to review`} />
          </span>
        )}
        {!internal && (
          <span className="absolute -bottom-1 -right-1 flex h-[18px] w-[18px] items-center justify-center rounded-full border border-hairline bg-surface text-muted" aria-hidden>
            <ExternalLink className="h-2.5 w-2.5" />
          </span>
        )}
      </span>
      <span className={cn("line-clamp-2 w-full break-words text-[12px] leading-[15px] text-ink", lit ? "font-extrabold" : "font-semibold")}>
        {shortFormName(form.title)}
      </span>
    </>
  );
  return internal ? (
    <NavLink to={form.url} onClick={onPick} title={form.title} className={className}>{body}</NavLink>
  ) : (
    <a href={form.url} target="_blank" rel="noopener noreferrer" onClick={onPick} title={`${form.title} (opens in a new tab)`} className={className}>{body}</a>
  );
}
