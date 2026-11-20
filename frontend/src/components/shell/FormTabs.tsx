import { useEffect, useRef, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";

/**
 * A form's header: its title and its tabs across the top, with its own links
 * at the right. Code forms (apps/AppHostPage.tsx) and basic forms
 * (screens/builtforms/FormHeader.tsx) both use it, so a form looks the same
 * whichever kind it is.
 */
export interface FormTab {
  to: string;
  label: ReactNode;
  /** Active only on exactly this path (the form's own page, so it isn't also lit on /entries). */
  end?: boolean;
  title?: string;
  tour?: string;
}

export function FormTabsHeader({
  title,
  tabs,
  showTabs,
  actions,
  className,
}: {
  title: string;
  tabs: FormTab[];
  /** false: just the title (one page, or a form locked for a resident). */
  showTabs: boolean;
  actions?: ReactNode;
  /** The header's width class, e.g. "max-w-[1080px]", so it lines up with the page below. */
  className?: string;
}) {
  // The current tab stays on screen when the row scrolls (a form's last tabs on a phone).
  const navRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    const show = () => navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    show();
    void document.fonts?.ready.then(show);
  }, [pathname]);

  // One grid, two arrangements. Phone: the title with the form's links on the first row and the
  // tabs across the full width below (beside the links they were cut off at "Repor").
  // Wider: the title on top, the tabs below it and the links at their right.
  return (
    <div className="flex-none border-b border-hairline bg-sidebar pt-safe-top md:bg-surface md:pt-5">
      <div
        className={cn(
          "mx-auto grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-3 md:px-7",
          "[grid-template-areas:'title_actions''tabs_tabs'] md:[grid-template-areas:'title_title''tabs_actions']",
          className
        )}
      >
        <div className="min-w-0 self-center [grid-area:title] md:self-end">
          <h1 className="hidden font-heading text-title font-extrabold text-ink md:block">{title}</h1>
          {/* On a phone the tabs alone don't say which form this is (Entries, Notifications…). */}
          <p className={cn("truncate px-4 font-heading text-lead font-extrabold text-ink md:hidden", showTabs ? "pt-1" : "py-2")}>{title}</p>
        </div>
        <div className="min-w-0 [grid-area:tabs]">
          {showTabs ? (
            // More tabs than room (Petty Cash has eight): the row scrolls sideways rather than running under the links.
            <nav
              ref={navRef}
              aria-label={title}
              data-tour="app-tabs"
              className="chiprow flex scroll-px-8 px-1.5 md:-mb-px md:mt-1 md:gap-1 md:overflow-x-auto md:overflow-y-hidden md:px-0 md:[scrollbar-width:none] md:[&::-webkit-scrollbar]:hidden"
            >
              {tabs.map((t) => (
                <NavLink
                  key={t.to}
                  to={t.to}
                  end={t.end}
                  title={t.title}
                  data-tour={t.tour}
                  className={({ isActive }) =>
                    cn(
                      "-mb-px flex min-h-[44px] shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 text-label font-semibold md:mb-0 md:min-h-[42px] md:px-3 md:text-body touch:min-h-11",
                      isActive ? "border-navy text-accent dark:border-white dark:text-white" : "border-transparent text-muted hover:text-ink"
                    )
                  }
                >
                  {t.label}
                </NavLink>
              ))}
            </nav>
          ) : (
            <div className="hidden h-3 md:block" />
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-3 self-center pr-3 [grid-area:actions] md:self-end md:pb-2 md:pr-0 touch:md:pb-0">{actions}</div>}
      </div>
    </div>
  );
}

/**
 * The small text links at the right of the header (Show me how, Share link, Edit).
 * On a phone or tablet each is a 44px target, even when only its icon shows.
 */
export const headerLinkClass =
  "inline-flex min-h-[32px] items-center gap-1 text-label font-semibold text-accent dark:text-white touch:min-h-11 touch:min-w-11 touch:justify-center";
