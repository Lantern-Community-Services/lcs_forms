import { createContext, useContext, useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";
import { CountBadge } from "@/components/ui/badge";

/**
 * True inside a tabbed section (the Roster). The tab strip already names the
 * screen, so PageHeader and PhoneHeader drop their own title there and keep
 * only the subtitle and the toolbar (site picker, export, add).
 */
const InSectionTabs = createContext(false);
export const useInSectionTabs = () => useContext(InSectionTabs);

export interface SectionTab {
  to: string;
  label: string;
  /** Match this path exactly — the section's first tab, whose path prefixes the others. */
  end?: boolean;
  /** Amber count pill, e.g. people waiting in the review queue. */
  count?: number;
}

/**
 * One sidebar destination holding several screens as tabs.
 *
 * Desktop: the section title with an underline tab row beneath it. Phone: the
 * tab row alone, scrolling sideways if it has to, carrying the status-bar inset
 * that each screen's PhoneHeader would otherwise have taken.
 */
export function SectionTabsLayout({ title, tabs }: { title: string; tabs: SectionTab[] }) {
  // Five tabs are wider than a phone, so the row scrolls; keep the current one
  // on screen when it's one of the last (arriving on Overview from a link).
  const navRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  // A screen marked data-fit-screen (Hot Foods Record) is held to the viewport
  // and scrolls inside itself, so the section stops at the viewport too.
  return (
    <div className="flex min-h-full flex-col has-[[data-fit-screen]]:h-full">
      <div className="flex-none border-b border-hairline bg-sidebar pt-safe-top md:bg-surface md:pt-6">
        <div className="mx-auto max-w-[1240px] md:px-7">
          <h1 className="hidden text-[24px] font-heading font-extrabold text-ink md:block">{title}</h1>
          <nav ref={navRef} aria-label={title} className="chiprow flex px-1.5 md:mt-2 md:gap-1 md:px-0">
            {tabs.map((t) => (
              <NavLink
                key={t.to}
                to={t.to}
                end={t.end}
                className={({ isActive }) =>
                  cn(
                    "-mb-px flex min-h-[44px] shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 text-[13px] font-semibold transition-colors md:min-h-[42px] md:px-3 md:text-[13.5px]",
                    isActive ? "border-navy text-accent dark:border-white dark:text-white" : "border-transparent text-muted hover:text-ink"
                  )
                }
              >
                {t.label}
                {(t.count ?? 0) > 0 && <CountBadge count={t.count!} max={999} />}
              </NavLink>
            ))}
          </nav>
        </div>
      </div>
      <InSectionTabs.Provider value={true}>
        {/* Each screen's root is `min-h-full`, which has no height to resolve
            against in here — so it's stretched as a flex item instead, and the
            review deck still gets the rest of the viewport. */}
        <div className="flex min-h-0 flex-1 flex-col [&>*]:flex-1">
          <Outlet />
        </div>
      </InSectionTabs.Provider>
    </div>
  );
}
