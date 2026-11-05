import { Suspense } from "react";
import { useParams } from "react-router-dom";
import { LoadingState } from "@/components/ui/misc";
import { lazyScreen } from "@/lib/lazyScreen";
import { BuiltFormHeader } from "./FormHeader";

/**
 * A basic form's Notifications tab (/f/<slug>/notifications, Admins): who the
 * form tells, and when. The same editor as a code form's Notifications tab
 * (apps/AppHostPage.tsx) and the form builder's, under the form's own tabs.
 */
const RoutingEditor = lazyScreen(() => import("@/screens/admin/Routing"), "RoutingEditor");

export function BuiltFormRoutingPage() {
  const { slug = "" } = useParams();
  return (
    <>
      <BuiltFormHeader slug={slug} />
      <Suspense fallback={<LoadingState />}>
        <RoutingEditor formId={slug} inForm />
      </Suspense>
    </>
  );
}
