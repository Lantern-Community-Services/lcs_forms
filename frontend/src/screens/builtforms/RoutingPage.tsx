import { Suspense } from "react";
import { Navigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { DesktopBackLink } from "@/components/shell/AppShell";
import { LoadingState } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { lazyScreen } from "@/lib/lazyScreen";
import { useDeviceKind } from "@/lib/device";

/**
 * A basic form's Notifications page (/f/<slug>/notifications, Admins). On a
 * computer it's the form editor's Notifications tab, so this sends you there;
 * the editor is desktop only, so on a phone or tablet the same editor shows
 * here. Code forms have it as a tab (apps/AppHostPage.tsx).
 */
const RoutingEditor = lazyScreen(() => import("@/screens/admin/Routing"), "RoutingEditor");

export function BuiltFormRoutingPage() {
  const { slug = "" } = useParams();
  const desktop = useDeviceKind() === "desktop";
  const { data, isLoading } = useQuery({ queryKey: ["routing", slug], queryFn: () => api.get<{ form: { id: string; kind: string } }>(`/routing/${slug}`), enabled: desktop });
  if (desktop && isLoading) return <LoadingState />;
  if (desktop && data?.form.kind === "basic") return <Navigate to={`/admin/builder/${data.form.id}?tab=notifications`} replace />;
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
