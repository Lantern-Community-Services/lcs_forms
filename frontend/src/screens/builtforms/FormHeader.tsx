import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Bell, PencilRuler, QrCode } from "lucide-react";
import { FormTabsHeader, headerLinkClass, type FormTab } from "@/components/shell/FormTabs";
import { useLocked } from "@/components/shell/FormLock";
import { useAuth } from "@/lib/auth";
import { useFillForm } from "@/lib/builder";
import { useDeviceKind } from "@/lib/device";

/** Every basic-form tab lines up at this width, whichever tab is open (the code forms' "tablet"). */
export const BUILT_FORM_HEADER_WIDTH = "max-w-[1080px]";

/**
 * A basic form's title and tabs (Form, Entries, Notifications), the same bar
 * code forms have (apps/AppHostPage.tsx). What the person may open comes from
 * the form itself (/api/f/<slug>, cached with the fill page); `fallback` covers
 * a page that knows the form when that can't be read (entries someone may see
 * on a form they can't fill in).
 */
export function BuiltFormHeader({
  slug,
  actions,
  fallback,
}: {
  slug: string;
  /** Extra links before the usual ones (the fill page's "Show me how" and "Hide nav bar"; a basic form locks to its own page only). */
  actions?: ReactNode;
  fallback?: { title: string; id: string; isAdmin: boolean; canReadEntries: boolean };
}) {
  const { data } = useFillForm(slug);
  const { can } = useAuth();
  const locked = Boolean(useLocked());
  const desktop = useDeviceKind() === "desktop";

  const title = data?.doc.title ?? data?.form.title ?? fallback?.title ?? "";
  const formId = data?.form.id ?? fallback?.id;
  const isAdmin = (data?.isAdmin ?? fallback?.isAdmin ?? false) && can("forms.manage");
  const canReadEntries = data?.canReadEntries ?? fallback?.canReadEntries ?? false;
  const shareable = data?.doc.settings.access?.mode === "link" && Boolean(data.user);
  const status = data?.form.isDraft ? "Draft" : data && data.form.status !== "published" ? data.form.status[0].toUpperCase() + data.form.status.slice(1) : null;

  const tabs: FormTab[] = [
    { to: `/f/${slug}`, end: true, label: "Form", tour: "form-tab" },
    ...(canReadEntries ? [{ to: `/f/${slug}/entries`, label: data?.entriesReach && data.entriesReach !== "all" ? "Your entries" : "Entries", tour: "form-entries" }] : []),
    ...(isAdmin ? [{ to: `/f/${slug}/notifications`, title: "Who this form tells, and when (Admins only)", label: <><Bell className="h-3.5 w-3.5" /> Notifications</> }] : []),
  ];

  return (
    <FormTabsHeader
      title={title}
      className={BUILT_FORM_HEADER_WIDTH}
      showTabs={!locked && tabs.length > 1}
      tabs={tabs}
      actions={
        <>
          {status && <span className="rounded-pill bg-status-amberBg px-2 py-0.5 text-micro font-bold text-status-amberText">{status}</span>}
          {actions}
          {shareable && !locked && (
            <Link to={`/f/${slug}/share`} className={headerLinkClass} title="Your link and QR code: people without an account can fill this form in">
              <QrCode className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Share link</span>
            </Link>
          )}
          {isAdmin && desktop && formId && !locked && (
            <Link to={`/admin/builder/${formId}`} className={headerLinkClass} title="Edit this form in the form builder">
              <PencilRuler className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Edit</span>
            </Link>
          )}
        </>
      }
    />
  );
}
