import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { Dock, Launcher } from "./Dock";
import { PullToRefresh } from "./PullToRefresh";
import { useDeviceKind } from "@/lib/device";
import { useInSectionTabs } from "./SectionTabs";
import { useAuth } from "@/lib/auth";
import { startHotFoodsSync } from "@/lib/hotFoodsQueue";
import { startAppQueue } from "@/apps/queue";
import { useCascade } from "@/lib/cascade";
import { cn } from "@/lib/utils";

/**
 * Full-page shell.
 *
 * Desktop: fixed sidebar beside a scrollable main column. Phone and tablet: the
 * sidebar is gone and the same main column sits above the dock. The dock is a flex
 * sibling rather than a fixed overlay, so `<main>`'s own scroll region ends
 * exactly where the bar begins — screens with their own sticky footer (the
 * bill review's approve bar) then stack against it correctly, which they cannot
 * do against something floating outside the layout.
 */
export function AppShell() {
  // Hot Foods entries saved on this device keep uploading whichever screen
  // is open, not only while Record is.
  const qc = useQueryClient();
  const { user } = useAuth();
  useEffect(() => {
    startHotFoodsSync(qc, user?.id ?? null);
    startAppQueue(user?.id ?? null);
    return () => {
      startHotFoodsSync(qc, null);
      startAppQueue(null);
    };
  }, [qc, user?.id]);

  const device = useDeviceKind();
  const touch = device !== "desktop";
  const [launcher, setLauncher] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setLauncher(false), [pathname, touch]);
  const closeLauncher = useCallback(() => setLauncher(false), []);
  const mainRef = useRef<HTMLElement>(null);
  // Anything on a screen marked enter-up arrives from the top down.
  useCascade(mainRef);

  // The shell is fixed, so the window itself should never be scrolled. iOS
  // still scrolls it to keep a focused field above the keyboard, and doesn't
  // always scroll it back when the keyboard goes; then taps land off target
  // (hit-testing follows the shifted page, the drawing doesn't). Put it back
  // whenever nothing is being typed into.
  useEffect(() => {
    const typing = () => Boolean(document.activeElement?.closest?.("input, textarea, select, [contenteditable]"));
    const reset = () => {
      if ((window.scrollY || window.scrollX) && !typing()) window.scrollTo(0, 0);
    };
    const later = () => window.setTimeout(reset, 120);
    window.addEventListener("scroll", reset, { passive: true });
    window.addEventListener("focusout", later);
    window.visualViewport?.addEventListener("resize", later);
    return () => {
      window.removeEventListener("scroll", reset);
      window.removeEventListener("focusout", later);
      window.visualViewport?.removeEventListener("resize", later);
    };
  }, []);

  return (
    <div
      // Pinned to the screen. Sized as 100dvh in the normal flow, iPad Safari
      // could still scroll the page under it (its toolbar showing or hiding, a
      // rubber-band drag, a scrollIntoView or focus reaching past <main>), and
      // the dock rode down with it. Fixed, there is no page to scroll; and an
      // overflow-hidden box can still be scrolled by script, so any scroll that
      // does land on it is put straight back.
      onScroll={(e) => {
        const el = e.currentTarget;
        if (el.scrollTop || el.scrollLeft) el.scrollTo(0, 0);
      }}
      className={cn("fixed inset-0 flex flex-col overflow-hidden overscroll-none bg-appbg", !touch && "md:flex-row")}
    >
      {!touch && <Sidebar />}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {/* scrollbar-gutter keeps the scrollbar's space reserved even when the
            page is short, so content doesn't jump sideways when a list grows or
            shrinks past the fold (collapsing roster sites, filtering). */}
        <main ref={mainRef} className="min-h-0 flex-1 overflow-y-auto scroll-thin bg-surface [scrollbar-gutter:stable]">
          <Outlet />
        </main>
        {/* Installed to the home screen there's no reload button: pull down from the top instead. */}
        {touch && <PullToRefresh scrollRef={mainRef} />}
      </div>
      {touch && <Launcher device={device} open={launcher} onClose={closeLauncher} />}
      {touch && <Dock device={device} launcherOpen={launcher} onToggleLauncher={() => setLauncher((o) => !o)} />}
    </div>
  );
}

/**
 * Standard page container.
 *
 * The phone gutter is 16px against the desktop's 28px — at 402px wide, 28px a
 * side spends a seventh of the screen on margin.
 */
export function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={`mx-auto max-w-[1240px] px-4 py-4 md:px-7 md:py-7 ${className ?? ""}`}>{children}</div>;
}

/**
 * The way back out of a screen the phone reaches through More.
 *
 * Phone-only: on desktop the sidebar is permanently on screen, so the same link
 * would be a second, redundant route to a destination already one click away.
 */
export function MobileBackLink({ to, label, className }: { to: string; label: string; className?: string }) {
  return (
    <Link
      to={to}
      className={cn("-ml-2 inline-flex min-h-[44px] items-center gap-1.5 px-2 text-[13.5px] font-semibold text-accent dark:text-white md:hidden", className)}
    >
      <ChevronLeft className="h-[17px] w-[17px]" /> {label}
    </Link>
  );
}

/**
 * The way back above a detail screen's content, desktop only — on a phone the
 * screen's PhoneHeader carries it instead.
 */
export function DesktopBackLink({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) {
  return (
    <Link
      to={to}
      className={cn("-ml-2 mb-2 hidden min-h-[36px] items-center gap-1 px-2 text-[13px] font-semibold text-accent dark:text-white md:inline-flex", className)}
    >
      <ChevronLeft className="h-4 w-4" /> {children}
    </Link>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  // Inside a tabbed section the active tab is the title (see SectionTabs).
  const inTabs = useInSectionTabs();
  if (inTabs && !subtitle && !actions) return null;
  return (
    <div className={`mb-4 flex flex-wrap justify-between gap-3 md:mb-6 md:gap-4 ${inTabs ? "items-center" : "items-start"}`}>
      <div className="min-w-0">
        {!inTabs && <h1 className="text-[23px] font-heading font-extrabold text-ink md:text-[24px]">{title}</h1>}
        {subtitle && <p className={`text-[13px] text-muted md:text-[13.5px] ${inTabs ? "" : "mt-1"}`}>{subtitle}</p>}
      </div>
      {/* Wraps rather than running off the edge when the column is narrow
          (an iPad in portrait beside the sidebar). */}
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
