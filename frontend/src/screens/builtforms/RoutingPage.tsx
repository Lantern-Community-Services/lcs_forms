import { Suspense } from "react";
import { useParams } from "react-router-dom";
import { DesktopBackLink } from "@/components/shell/AppShell";
import { LoadingState } from "@/components/ui/misc";
import { lazyScreen } from "@/lib/lazyScreen";

/**
 * A basic form's Notifications page (/f/<slug>/notifications, Admins): its
 * routing, reached from the form and its entries. The editor is Admin's own,
 * loaded only here. Code forms have the same as a tab (apps/AppHostPage.tsx).
 */
const RoutingEditor = lazyScreen(() => import("@/screens/admin/Routing"), "RoutingEditor");

export function BuiltFormRoutingPage() {
  const { slug = "" } = useParams();
  return (
    <>
      <div className="mx-auto max-w-[920px] px-4 pt-4 md:px-7 md:pt-7">
        <DesktopBackLink to={`/f/${slug}`}>Back to the form</DesktopBackLink>
      </div>
      <Suspense fallback={<LoadingState />}>
        <RoutingEditor formId={slug} inForm />
      </Suspense>
    </>
  );
}
