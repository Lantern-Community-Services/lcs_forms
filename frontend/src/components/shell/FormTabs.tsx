import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
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
  return (
    <div className="flex-none border-b border-hairline bg-sidebar pt-safe-top md:bg-surface md:pt-5">
      <div className={cn("mx-auto flex items-end gap-3 md:px-7", className)}>
        <div className="min-w-0 flex-1">
          <h1 className="hidden font-heading text-[24px] font-extrabold text-ink md:block">{title}</h1>
          {showTabs ? (
            <nav aria-label={title} data-tour="app-tabs" className="chiprow flex px-1.5 md:mt-1 md:gap-1 md:px-0">
              {tabs.map((t) => (
                <NavLink
                  key={t.to}
                  to={t.to}
                  end={t.end}
                  title={t.title}
                  data-tour={t.tour}
                  className={({ isActive }) =>
                    cn(
                      "-mb-px flex min-h-[44px] shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 text-[13px] font-semibold md:min-h-[42px] md:px-3 md:text-[13.5px]",
                      isActive ? "border-navy text-accent dark:border-white dark:text-white" : "border-transparent text-muted hover:text-ink"
                    )
                  }
                >
                  {t.label}
                </NavLink>
              ))}
            </nav>
          ) : (
            <p className="px-4 pb-2 font-heading text-[18px] font-extrabold text-ink md:hidden">{title}</p>
          )}
          {!showTabs && <div className="hidden h-3 md:block" />}
        </div>
        {actions && <div className="flex items-center gap-2 pb-2 pr-3 md:pr-0">{actions}</div>}
      </div>
    </div>
  );
}

/** The small text links at the right of the header (Show me how, Share link, Edit). */
export const headerLinkClass = "inline-flex min-h-[32px] items-center gap-1 text-[12.5px] font-semibold text-accent dark:text-white";
