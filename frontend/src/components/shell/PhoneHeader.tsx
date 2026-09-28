import { MobileBackLink } from "./AppShell";
import { useInSectionTabs } from "./SectionTabs";

/**
 * The band every phone screen in the design wears: the sidebar fill, a hairline
 * under it, the status-bar inset above the title, and 16px gutters.
 *
 * It exists because the artboards are consistent about it and `PageHeader` is
 * not the same thing — that one is a heading inside a padded page, whereas this
 * is chrome that holds the top of the screen while the content scrolls under
 * it. Screens that need one render it as their own flex-none first child.
 */
export function PhoneHeader({
  title,
  subtitle,
  back,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  /** Where this screen was reached from — the phone's only way back out. */
  back?: { to: string; label: string };
  /** Trailing controls, on the title's row. */
  actions?: React.ReactNode;
  /** Anything below the title: a search field, a chip row. */
  children?: React.ReactNode;
}) {
  // Inside a tabbed section the tab strip above has taken the status-bar inset
  // and names the screen, so only the toolbar is left to draw.
  const inTabs = useInSectionTabs();
  if (inTabs) {
    if (!subtitle && !actions && !children) return null;
    return (
      <div className="flex-none border-b border-hairline bg-sidebar px-4 pb-3 pt-3 md:hidden">
        {(subtitle || actions) && (
          <div className="flex items-center gap-2.5">
            <p className="min-w-0 flex-1 text-[13px] text-muted">{subtitle}</p>
            {actions}
          </div>
        )}
        {children}
      </div>
    );
  }

  return (
    <div className="flex-none border-b border-hairline bg-sidebar px-4 pb-3 pt-safe-top md:hidden">
      {back && <MobileBackLink to={back.to} label={back.label} className="mb-0.5" />}
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <h1 className="text-[23px] font-heading font-extrabold text-ink">{title}</h1>
          {subtitle && <p className="mt-[3px] text-[13px] text-muted">{subtitle}</p>}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}
