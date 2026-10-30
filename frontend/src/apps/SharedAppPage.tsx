import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { Card } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/misc";
import { ThemedLogo } from "@/components/shell/ThemedLogo";
import { errorMessage } from "@/lib/utils";
import { AppFrame } from "./AppFrame";
import { shareApi } from "./api";

/**
 * /s/<token> for a code form (form.json "shareLink"): its one page, not signed
 * in, with the Lantern logo above it and nothing of the app around it. The
 * frame answers only what a guest may ask (AppFrame GUEST_CALLS), through the
 * link's own API. The page can't go anywhere else: a navigation to another
 * page stays on this one, with its params, so it can show its own "thank you".
 */
export function SharedAppPage({ token }: { token: string }) {
  const { data: runtime, error, isLoading } = useQuery({
    queryKey: ["share-app", token],
    queryFn: () => shareApi.runtime(token),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const [params, setParams] = useState<Record<string, string>>({});

  if (isLoading) return <Shell><LoadingState /></Shell>;
  const page = runtime?.pages[0];
  if (error || !runtime || !page) {
    return (
      <Shell>
        <div className="mx-auto max-w-[780px] px-4 py-6">
          <Card className="p-8 text-center">
            <Lock className="mx-auto h-8 w-8 text-muted" />
            <p className="mt-3 font-heading text-[17px] font-extrabold text-ink">{errorMessage(error, "This link doesn't work any more.")}</p>
          </Card>
        </div>
      </Shell>
    );
  }
  return (
    <Shell title={runtime.form.title} sharedBy={runtime.share?.sharedBy}>
      <AppFrame
        runtime={runtime}
        slug={runtime.form.slug}
        draft={false}
        page={page.id}
        params={params}
        shareToken={token}
        onNavigate={(_p, prm) => setParams(prm)}
        onSetParams={setParams}
      />
    </Shell>
  );
}

function Shell({ title, sharedBy, children }: { title?: string; sharedBy?: string; children: React.ReactNode }) {
  return (
    <div className="app-height flex flex-col bg-surface">
      <header className="flex flex-none items-center gap-3 border-b border-hairline px-4 pb-2.5 pt-[max(10px,env(safe-area-inset-top))] md:px-7">
        <div className="flex h-8 shrink-0 [&_svg]:h-8 [&_svg]:w-auto"><ThemedLogo /></div>
        {title && (
          <div className="min-w-0 flex-1 text-right">
            <p className="truncate font-heading text-[15px] font-extrabold text-ink md:text-[17px]">{title}</p>
            {sharedBy && <p className="truncate text-micro text-muted">Shared by {sharedBy} · no sign-in needed</p>}
          </div>
        )}
      </header>
      <div className="mx-auto min-h-0 w-full max-w-[1024px] flex-1">{children}</div>
    </div>
  );
}
