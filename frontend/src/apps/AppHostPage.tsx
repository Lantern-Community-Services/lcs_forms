import { Suspense, useEffect, useState } from "react";
import { setNavMode } from "@/lib/shellNav";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { FormTabsHeader, headerLinkClass } from "@/components/shell/FormTabs";
import { Bell, CircleHelp, CloudOff, Code2, QrCode, RefreshCw } from "lucide-react";
import { codeFormTour, useFormTutorial } from "@/lib/tour/formTours";
import { setFrameTutorialStarter } from "@/lib/tour/frameBridge";
import { LoadingState, EmptyState } from "@/components/ui/misc";
import { Card } from "@/components/ui/card";
import { ApiError } from "@/lib/api";
import { useDeviceKind } from "@/lib/device";
import { useAuth } from "@/lib/auth";
import { lazyScreen } from "@/lib/lazyScreen";
import { cn, errorMessage } from "@/lib/utils";
import { AppFrame, type ConsoleLine } from "./AppFrame";
import { useAppRuntime, type PageWidth } from "./api";
import { LockFormButton, useLocked } from "@/components/shell/FormLock";
import { onQueueChange, queueStatus, type QueueStatus } from "./queue";
import { ExportEntriesButton } from "./ExportEntries";

/**
 * The form's Notifications tab: its routing (who's told about what), for
 * Admins. The editor is Admin's own, loaded only when the tab is opened, so
 * staff never download it. Page ids in form.json can't start with "_", so
 * this one never meets a form's own page.
 */
const ROUTING_PAGE = "_notifications";
const RoutingEditor = lazyScreen(() => import("@/screens/admin/Routing"), "RoutingEditor");

/** A code form: its tabs across the top, the current page in a sandboxed frame below. */
export function AppHostPage() {
  const { slug = "", page } = useParams();
  const { can } = useAuth();
  // Handed to a resident (lib/formLock.ts): only the page they're on — no other tabs, Notifications or Edit.
  const locked = Boolean(useLocked());
  const canRoute = can("forms.manage") && !locked;
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  // The code editor is desktop only, so no way into it elsewhere.
  const desktop = useDeviceKind() === "desktop";
  const canOpenEditor = desktop;
  // ?draft=1: the unsaved-to-live draft, for developers — what the code editor's device previews load.
  const draft = search.get("draft") === "1";
  const { data: runtime, isLoading, error } = useAppRuntime(slug, draft);
  // The page's sidebar preference (form.json "nav"), for as long as it's open.
  const navPref = runtime?.pages.find((p) => p.id === page)?.nav ?? null;
  useEffect(() => {
    setNavMode(navPref);
    return () => setNavMode(null);
  }, [navPref]);

  // The form's tutorial (form.json "tutorial"): the first time someone opens it, from "Show me how",
  // and from the page itself (tutorial.start() in @lcs/sdk). A draft's only runs on request, unrecorded.
  const tutorial = useFormTutorial({
    formId: runtime?.form.id ?? null,
    tutorial: runtime?.tutorial,
    ready: Boolean(runtime),
    preview: draft,
    scope: (p) => p === `/apps/${slug}` || p.startsWith(`/apps/${slug}/`),
    build: (record) =>
      runtime?.tutorial
        ? codeFormTour({
            formId: runtime.form.id,
            slug,
            title: runtime.form.title,
            draft,
            pages: runtime.pages,
            tutorial: runtime.tutorial,
            roleKey: runtime.user.roleKey,
            userName: runtime.user.name,
            record,
          })
        : null,
  });
  const startTutorial = tutorial.start;
  useEffect(() => setFrameTutorialStarter(startTutorial), [startTutorial]);

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
  const onRouting = canRoute && page === ROUTING_PAGE;
  const current = runtime.pages.find((p) => p.id === page) ?? visible[0] ?? runtime.pages[0];
  if (!current) return <div className="p-6"><Card><EmptyState title="There's nothing here you can open." /></Card></div>;
  if (!onRouting && (!page || page !== current.id)) return <Navigate to={`/apps/${slug}/${current.id}${search.toString() ? `?${search}` : ""}`} replace />;

  const { draft: _draft, ...params } = Object.fromEntries(search.entries());
  const withDraft = (prm: Record<string, string>) => {
    const q = new URLSearchParams(prm);
    if (draft) q.set("draft", "1");
    const s = q.toString();
    return s ? `?${s}` : "";
  };
  // Inside the editor's device preview: send the page's console to the editor.
  // On a desktop the page sits in a centered column (form.json "width"). The title and tabs keep one
  // width for the whole form, its widest page's, so switching tabs never moves them.
  const width = onRouting ? "wide" : desktop ? (current.width ?? "tablet") : "full";
  const headerWidth = desktop ? widestHeader(runtime.pages.map((p) => p.width ?? "tablet")) : "full";
  const relay = draft && window.parent !== window
    ? (line: ConsoleLine) => window.parent.postMessage({ lcsConsole: line }, window.location.origin)
    : undefined;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <FormTabsHeader
        title={runtime.form.title}
        className={HEADER_WIDTH[headerWidth]}
        showTabs={!locked && (visible.length > 1 || canRoute)}
        tabs={[
          ...visible.map((p) => ({ to: `/apps/${slug}/${p.id}${withDraft({})}`, label: p.label, tour: `app-tab-${p.id}` })),
          ...(canRoute
            ? [{ to: `/apps/${slug}/${ROUTING_PAGE}${withDraft({})}`, title: "Who this form tells, and when (Admins only)", label: <><Bell className="h-3.5 w-3.5" /> Notifications</> }]
            : []),
        ]}
        actions={
          <>
            {draft && <span className="rounded-pill bg-status-violetBg px-2 py-0.5 text-micro font-bold text-status-violetText">Draft</span>}
            <QueueBadge slug={slug} />
            {tutorial.available && (
              <button type="button" data-tour="app-help" onClick={() => tutorial.start()} className={headerLinkClass} title="Show me how this form works">
                <CircleHelp className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Show me how</span>
              </button>
            )}
            {runtime.shareable && !locked && (
              <Link to={`/f/${slug}/share`} className={headerLinkClass} title="Your link and QR code: people without an account can fill this form in">
                <QrCode className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Share link</span>
              </Link>
            )}
            {!draft && !locked && !runtime.user.guest && (
              <ExportEntriesButton slug={slug} title={runtime.form.title} canReadAll={Boolean(runtime.canReadAll)} paper={Boolean(runtime.paperExport)} />
            )}
            {!draft && !locked && <LockFormButton base={`/apps/${slug}`} title={runtime.form.title} />}
            {runtime.canEdit && canOpenEditor && !locked && (
              <Link to={`/admin/apps/${runtime.form.id}`} className={headerLinkClass} title="Edit this code form">
                <Code2 className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Edit</span>
              </Link>
            )}
          </>
        }
      />
      {onRouting ? (
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          <Suspense fallback={<LoadingState />}>
            <RoutingEditor formId={runtime.form.id} inForm />
          </Suspense>
        </div>
      ) : (
      /* Like the Roster: the page sits straight on the white main area, in a centered column — no sheet edges or shadow. */
      <div className={cn("mx-auto min-h-0 w-full flex-1", FRAME_WIDTH[width])}>
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
      )}
    </div>
  );
}

// The tabs row keeps its side padding, so it's 56px (md:px-7) wider than the page below to line up with it.
const FRAME_WIDTH: Record<PageWidth, string> = { narrow: "max-w-[760px]", tablet: "max-w-[1024px]", wide: "max-w-[1240px]", full: "" };
const HEADER_WIDTH: Record<PageWidth, string> = { narrow: "max-w-[816px]", tablet: "max-w-[1080px]", wide: "max-w-[1296px]", full: "max-w-[1240px]" };
/** Narrowest to widest header (a full page's header stops at 1240px, short of a wide page's). */
const HEADER_ORDER: PageWidth[] = ["narrow", "tablet", "full", "wide"];
const widestHeader = (widths: PageWidth[]) => widths.reduce((a, b) => (HEADER_ORDER.indexOf(b) > HEADER_ORDER.indexOf(a) ? b : a), "narrow" as PageWidth);

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
