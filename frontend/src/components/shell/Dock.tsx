import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ExternalLink, Home, LayoutGrid, LogOut, Contact, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { Avatar } from "@/components/ui/avatar";
import { CountBadge } from "@/components/ui/badge";
import { SearchInput } from "@/components/ui/input";
import { isInternalForm } from "@/lib/formIcons";
import type { FormLink } from "@/lib/types";
import { searchForms, shortFormName, useIsLit, useNavCatalog, useReviewCount, type NavForm } from "./navData";

/**
 * Phone and tablet navigation: a floating dock at the bottom, within thumb
 * reach, holding Home, the Roster and your pinned forms; "All forms" opens the
 * Launcher above it. The desktop gets the sidebar instead (Sidebar.tsx).
 *
 * The dock sits in a band that is a flex sibling of <main>, not an overlay,
 * so <main>'s scroll region ends where the band begins and screens with their
 * own sticky footer (the bill review's approve bar) stack against it.
 */
export function Dock({ device, launcherOpen, onToggleLauncher }: {
  device: "phone" | "tablet";
  launcherOpen: boolean;
  onToggleLauncher: () => void;
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
  // A phone has five slots. A tablet fits as many pins as its width allows:
  // ~6 on a portrait iPad, ~10 in landscape.
  const fixed = roster ? 3 : 2;
  const tabletPins = Math.max(2, Math.floor((width - TABLET_CHROME) / TABLET_SLOT) - fixed);
  const pins = pinned.filter((p) => p.form.url !== "/roster").slice(0, phone ? (roster ? 2 : 3) : tabletPins);

  const home = <DockLink key="home" to="/forms" end label="Home" Icon={Home} active={!launcherOpen && pathname === "/forms"} phone={phone} />;
  const rosterItem = roster && (
    <DockLink key="roster" to="/roster" label="Roster" Icon={Contact} active={!launcherOpen && lit("/roster")} count={reviewCount} phone={phone} />
  );
  const all = (
    <DockButton key="all" label="All forms" Icon={LayoutGrid} active={launcherOpen} onClick={onToggleLauncher} phone={phone} expanded={launcherOpen} />
  );
  const pinItems = pins.map((p) => <DockPin key={p.form.id} pin={p} active={!launcherOpen && isInternalForm(p.form.url) && lit(p.form.url)} phone={phone} />);

  return (
    <nav
      ref={navRef}
      aria-label="Main"
      // While the launcher is open its scrim covers the whole screen and the dock
      // floats on top of it: the band goes clear, so there's no edge between the
      // dimmed page and a white strip.
      className={cn(
        "flex flex-none justify-center px-3 pb-safe-bottom pt-2 transition-colors duration-200 motion-reduce:transition-none",
        launcherOpen ? "relative z-50 bg-transparent" : "bg-surface"
      )}
    >
      {phone ? (
        <div
          className="grid w-full max-w-[480px] gap-0.5 rounded-[24px] border border-hairline bg-surface p-1.5 shadow-panel"
          style={{ gridTemplateColumns: `repeat(${[home, rosterItem, all, ...pinItems].filter(Boolean).length}, minmax(0, 1fr))` }}
        >
          {home}
          {rosterItem}
          {all}
          {pinItems}
        </div>
      ) : (
        <div className="flex items-center gap-1 rounded-[26px] border border-hairline bg-surface p-2 shadow-panel">
          {home}
          {rosterItem}
          {pinItems.length > 0 && <span className="mx-1 h-9 w-px bg-hairline" />}
          {pinItems}
          <span className="mx-1 h-9 w-px bg-hairline" />
          {all}
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

function DockLink({ to, end, label, Icon, active, count = 0, phone }: { to: string; end?: boolean; label: string; Icon: React.ElementType; active: boolean; count?: number; phone: boolean }) {
  return (
    <NavLink to={to} end={end} className={itemClass(active, phone)}>
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

function DockPin({ pin, active, phone }: { pin: NavForm; active: boolean; phone: boolean }) {
  const { form, Icon } = pin;
  const body = (
    <>
      <Icon className="h-[22px] w-[22px]" />
      <span className="max-w-full truncate">{shortFormName(form.title)}</span>
    </>
  );
  return isInternalForm(form.url) ? (
    <NavLink to={form.url} title={form.title} className={itemClass(active, phone)}>{body}</NavLink>
  ) : (
    <a href={form.url} target="_blank" rel="noopener noreferrer" title={`${form.title} (opens in a new tab)`} className={itemClass(false, phone)}>{body}</a>
  );
}

/**
 * Every form, as big tap targets grouped by category, plus your account. It
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
  const { user, logout } = useAuth();
  const { categories, pinned } = useNavCatalog();
  const reviewCount = useReviewCount();
  const lit = useIsLit();
  const [q, setQ] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const phone = device === "phone";

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
  const chip = (form: FormLink, key: string) => (
    <FormChip key={key} form={form} lit={isInternalForm(form.url) && lit(form.url)} count={form.url === "/roster" ? reviewCount : 0} onPick={onClose} />
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
        style={phone ? { paddingBottom: "var(--dock-h, 96px)" } : undefined}
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

        <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 scroll-thin", !phone && "md:px-6")}>
          {searching ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {results.map((r) => chip(r.form, r.form.id))}
              {results.length === 0 && <p className="py-2 text-[14px] text-muted">No forms match. Try a shorter word.</p>}
            </div>
          ) : (
            <div className={cn("grid gap-x-6 gap-y-5 pt-1", !phone && "grid-cols-2")}>
              {pinned.length > 0 && (
                <Group title="Pinned" className={cn(!phone && "col-span-2")}>
                  {pinned.map((p) => chip(p.form, `pin-${p.form.id}`))}
                </Group>
              )}
              {categories.map((c) => (
                <Group key={c.category.id} title={c.category.name} Icon={c.Icon}>
                  {c.forms.map((f) => chip(f, f.id))}
                </Group>
              ))}
            </div>
          )}
        </div>

        {/* You: profile and sign-out, which the dock has no room for. (No Admin: it is desktop only.) */}
        <div className={cn("flex flex-none items-center gap-2 border-t border-hairline bg-sidebar px-4 py-2.5", !phone && "md:px-6")}>
          <NavLink to="/profile" onClick={onClose} className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3">
            <Avatar name={user?.name ?? "?"} color={user?.avatarColor} />
            <span className="min-w-0">
              <span className="block truncate text-[14px] font-bold text-ink">{user?.name}</span>
              <span className="block truncate text-micro text-muted">{user?.role?.name}</span>
            </span>
          </NavLink>
          <button type="button" onClick={() => void logout()} aria-label="Sign out" title="Sign out" className="flex h-11 w-11 items-center justify-center rounded-input text-muted hover:bg-navsel/60 hover:text-ink">
            <LogOut className="h-[18px] w-[18px]" />
          </button>
        </div>
      </div>
    </div>
  );
}

function Group({ title, Icon, className, children }: { title: string; Icon?: React.ElementType; className?: string; children: React.ReactNode }) {
  return (
    <section className={className}>
      <h3 className="mb-2 flex items-center gap-2 text-micro font-extrabold uppercase tracking-[0.04em] text-muted">
        {Icon && (
          <span className="flex h-6 w-6 items-center justify-center rounded-[7px] bg-navy text-white dark:bg-navsel">
            <Icon className="h-3.5 w-3.5" />
          </span>
        )}
        {title}
      </h3>
      <div className="flex flex-wrap gap-2">{children}</div>
    </section>
  );
}

function FormChip({ form, lit, count, onPick }: { form: FormLink; lit: boolean; count: number; onPick: () => void }) {
  const className = cn(
    "flex min-h-[44px] items-center gap-2 rounded-[12px] border px-3.5 py-2 text-left text-[14px] font-bold leading-[18px] transition-colors",
    lit ? "border-navy bg-navy text-white dark:border-navsel dark:bg-navsel" : "border-hairline bg-surface text-ink hover:bg-navsel/60"
  );
  return isInternalForm(form.url) ? (
    <NavLink to={form.url} onClick={onPick} className={className}>
      {form.title}
      {count > 0 && <CountBadge count={count} max={999} label={`${count} to review`} />}
    </NavLink>
  ) : (
    <a href={form.url} target="_blank" rel="noopener noreferrer" onClick={onPick} title={`${form.title} (opens in a new tab)`} className={className}>
      {form.title}
      <ExternalLink className="h-3 w-3 shrink-0 opacity-50" aria-hidden />
    </a>
  );
}
