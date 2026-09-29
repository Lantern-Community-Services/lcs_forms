import { useEffect, useState } from "react";
import { setNavMode } from "@/lib/shellNav";
import { Link, NavLink, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CloudOff, Code2, RefreshCw } from "lucide-react";
import { LoadingState, EmptyState } from "@/components/ui/misc";
import { Card } from "@/components/ui/card";
import { ApiError } from "@/lib/api";
import { cn, errorMessage } from "@/lib/utils";
import { AppFrame, type ConsoleLine } from "./AppFrame";
import { useAppRuntime } from "./api";
import { onQueueChange, queueStatus, type QueueStatus } from "./queue";

/** A code form: its tabs across the top, the current page in a sandboxed frame below. */
export function AppHostPage() {
  const { slug = "", page } = useParams();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  // ?draft=1: the unsaved-to-live draft, for developers — what the code editor's device previews load.
  const draft = search.get("draft") === "1";
  const { data: runtime, isLoading, error } = useAppRuntime(slug, draft);
  // The page's sidebar preference (form.json "nav"), for as long as it's open.
  const navPref = runtime?.pages.find((p) => p.id === page)?.nav ?? null;
  useEffect(() => {
    setNavMode(navPref);
    return () => setNavMode(null);
  }, [navPref]);

  if (isLoading) return <LoadingState />;
  if (error || !runtime) {
    if (error instanceof ApiError && error.status === 401) return <Navigate to={`/signin?returnTo=${encodeURIComponent(`/apps/${slug}`)}`} replace />;
    return (
      <div className="p-6">
        <Card><EmptyState title={errorMessage(error, "This form isn't available.")} /></Card>
      </div>
    );
  }
  const visible = runtime.pages.filter((p) => !p.hidden);
  const current = runtime.pages.find((p) => p.id === page) ?? visible[0] ?? runtime.pages[0];
  if (!current) return <div className="p-6"><Card><EmptyState title="There's nothing here you can open." /></Card></div>;
  if (!page || page !== current.id) return <Navigate to={`/apps/${slug}/${current.id}${search.toString() ? `?${search}` : ""}`} replace />;

  const { draft: _draft, ...params } = Object.fromEntries(search.entries());
  const withDraft = (prm: Record<string, string>) => {
    const q = new URLSearchParams(prm);
    if (draft) q.set("draft", "1");
    const s = q.toString();
    return s ? `?${s}` : "";
  };
  // Inside the editor's device preview: send the page's console to the editor.
  const relay = draft && window.parent !== window
    ? (line: ConsoleLine) => window.parent.postMessage({ lcsConsole: line }, window.location.origin)
    : undefined;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-none border-b border-hairline bg-sidebar pt-safe-top md:bg-surface md:pt-5">
        <div className="mx-auto flex max-w-[1240px] items-end gap-3 md:px-7">
          <div className="min-w-0 flex-1">
            <h1 className="hidden font-heading text-[24px] font-extrabold text-ink md:block">{runtime.form.title}</h1>
            {visible.length > 1 ? (
              <nav aria-label={runtime.form.title} className="chiprow flex px-1.5 md:mt-1 md:gap-1 md:px-0">
                {visible.map((p) => (
                  <NavLink
                    key={p.id}
                    to={`/apps/${slug}/${p.id}${withDraft({})}`}
                    className={({ isActive }) =>
                      cn(
                        "-mb-px flex min-h-[44px] shrink-0 items-center whitespace-nowrap border-b-2 px-2.5 text-[13px] font-semibold md:min-h-[42px] md:px-3 md:text-[13.5px]",
                        isActive ? "border-navy text-accent dark:border-white dark:text-white" : "border-transparent text-muted hover:text-ink"
                      )
                    }
                  >
                    {p.label}
                  </NavLink>
                ))}
              </nav>
            ) : (
              <p className="px-4 pb-2 font-heading text-[18px] font-extrabold text-ink md:hidden">{runtime.form.title}</p>
            )}
            {visible.length <= 1 && <div className="hidden h-3 md:block" />}
          </div>
          <div className="flex items-center gap-2 pb-2 pr-3 md:pr-0">
            {draft && <span className="rounded-pill bg-status-violetBg px-2 py-0.5 text-micro font-bold text-status-violetText">Draft</span>}
            <QueueBadge slug={slug} />
            {runtime.canEdit && (
              <Link to={`/admin/apps/${runtime.form.id}`} className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-accent dark:text-white" title="Edit this code form">
                <Code2 className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Edit</span>
              </Link>
            )}
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <AppFrame
          runtime={runtime}
          slug={slug}
          draft={draft}
          page={current.id}
          params={params}
          onNavigate={(p, prm) => navigate(`/apps/${slug}/${p}${withDraft(prm)}`)}
          onSetParams={(prm) => setSearch(new URLSearchParams(withDraft(prm).slice(1)), { replace: true })}
          onConsole={relay}
        />
      </div>
    </div>
  );
}

/** Entries waiting on this device, or refused by the server. */
export function QueueBadge({ slug }: { slug: string }) {
  const [s, setS] = useState<QueueStatus | null>(null);
  useEffect(() => {
    const load = () => void queueStatus(slug).then(setS).catch(() => undefined);
    load();
    const off = onQueueChange(load);
    window.addEventListener("online", load);
    window.addEventListener("offline", load);
    return () => {
      off();
      window.removeEventListener("online", load);
      window.removeEventListener("offline", load);
    };
  }, [slug]);
  if (!s || (!s.pending && !s.failed.length && s.online)) return null;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-micro font-semibold", s.failed.length ? "bg-status-redBg text-status-redText" : "bg-status-amberBg text-status-amberText")}>
      {s.online ? <RefreshCw className={cn("h-3 w-3", s.syncing && "animate-spin")} /> : <CloudOff className="h-3 w-3" />}
      {s.failed.length ? `${s.failed.length} not saved` : s.pending ? `${s.pending} waiting to upload` : "Offline"}
    </span>
  );
}
