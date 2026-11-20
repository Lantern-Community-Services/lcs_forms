import { Link } from "react-router-dom";
import { ArrowRight, Layers } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import { Card } from "@/components/ui/card";
import { CountBadge } from "@/components/ui/badge";
import { LoadingState } from "@/components/ui/misc";
import { useDashboard } from "@/lib/queries";
import { useAuth } from "@/lib/auth";
import { SitePicker, selectionLabel, useSiteSelection } from "@/lib/site";
import { cn, relativeTime } from "@/lib/utils";
import { useDeviceKind } from "@/lib/device";

export function DashboardPage() {
  const { user, can } = useAuth();
  // The review queue is for people who can Keep or Remove: anyone else gets no review banner, tile or column.
  const reviews = can("roster.archive");
  const cols = reviews ? "grid-cols-[minmax(0,1fr)_76px_84px] md:grid-cols-[minmax(0,1fr)_84px_90px_96px_104px]" : "grid-cols-[minmax(0,1fr)_76px] md:grid-cols-[minmax(0,1fr)_84px_96px_104px]";
  const touch = useDeviceKind() !== "desktop";
  const { codes, setCodes, sites, param } = useSiteSelection();
  const { data, isLoading } = useDashboard(param);
  const first = user?.name.split(" ")[0];
  const scope = selectionLabel(codes, sites);

  return (
    <div className="flex min-h-full flex-col">
      <PhoneHeader title={`Hi ${first ?? ""}`} subtitle={scope}>
        <SitePicker codes={codes} onChange={setCodes} className="mt-3" />
      </PhoneHeader>
      <Page className="w-full">
        <div className="hidden md:block">
          <PageHeader
            title="Dashboard"
            help={{ article: "roster", text: "The numbers across your sites at a glance." }}
            subtitle={scope}
            actions={<SitePicker codes={codes} onChange={setCodes} className="w-[260px]" />}
          />
        </div>
        {isLoading || !data ? (
          <LoadingState />
        ) : (
          <>
            {reviews && data.totals.attention > 0 && (
              <Link
                to={`/roster/review${param ? `?site=${param}` : ""}`}
                className="page-list-item-enter mb-4 flex items-center gap-3 rounded-card border border-status-amberDot/40 bg-status-amberBg px-4 py-3.5 text-status-amberText"
              >
                <Layers className="h-5 w-5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-body-lg font-bold">{data.totals.attention} people to review</span>
                  <span className="block text-label opacity-90">Not on any form in {data.attentionHours}+ hours. {touch ? "Swipe through them in a minute." : "Go through them one at a time."}</span>
                </span>
                <ArrowRight className="h-5 w-5 shrink-0" />
              </Link>
            )}

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
              <Card className="page-list-item-enter overflow-hidden">
                <div className={cn("grid gap-2 border-b border-hairline px-4 py-2.5 text-caption font-semibold text-muted", cols)}>
                  <span>Site</span>
                  <span className="text-right">On roster</span>
                  {reviews && <span className="text-right">To review</span>}
                  <span className="hidden text-right md:block">Added, 7 days</span>
                  <span className="hidden text-right md:block">Removed, 7 days</span>
                </div>
                <ul>
                  {data.sites.length > 1 && (
                    <li className={cn("grid min-h-[44px] items-center gap-2 border-b border-hairline bg-subtle px-4", cols)}>
                      <span className="truncate text-body font-bold text-ink">All {data.sites.length} sites</span>
                      <span className="text-right text-body font-bold tabular text-ink">{data.totals.active.toLocaleString()}</span>
                      {reviews && <span className="text-right text-body font-bold tabular text-ink">{data.totals.attention || "—"}</span>}
                      <span className="hidden text-right text-label font-semibold tabular text-ink md:block">{data.totals.addedWeek || "—"}</span>
                      <span className="hidden text-right text-label font-semibold tabular text-ink md:block">{data.totals.removedWeek || "—"}</span>
                    </li>
                  )}
                  {data.sites.map((s) => (
                    <li key={s.id} className="border-b border-hairline last:border-0">
                      <Link
                        to={`/roster?site=${s.code}`}
                        className={cn("grid min-h-[48px] items-center gap-2 px-4 hover:bg-rowhover", cols)}
                      >
                        <span className="truncate text-body font-semibold text-ink">{s.name}</span>
                        <span className="text-right text-body tabular text-ink">{s.activeCount}</span>
                        {reviews && (
                          <span className="text-right">
                            {s.attentionCount > 0 ? (
                              <CountBadge count={s.attentionCount} className="px-2" />
                            ) : (
                              <span className="text-label text-muted">—</span>
                            )}
                          </span>
                        )}
                        <span className="hidden text-right text-label tabular text-muted md:block">{s.addedWeek || "—"}</span>
                        <span className="hidden text-right text-label tabular text-muted md:block">{s.removedWeek || "—"}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>

              <Card className="page-list-item-enter self-start p-4" style={{ animationDelay: "50ms" }}>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="kicker">Recent changes</h2>
                  <Link to="/roster/activity" className="-my-2 inline-flex min-h-[36px] items-center text-label font-semibold text-accent hover:underline dark:text-white touch:min-h-11">All activity</Link>
                </div>
                {data.recent.length === 0 ? (
                  <p className="text-label text-muted">Nothing yet. Moves, removals and edits show up here.</p>
                ) : (
                  <ul className="space-y-3">
                    {data.recent.map((e) => (
                      <li key={e.id} className="text-label">
                        {e.tenantId ? (
                          <Link to={`/tenants/${e.tenantId}`} className="text-ink hover:underline">{e.summary}</Link>
                        ) : (
                          <span className="text-ink">{e.summary}</span>
                        )}
                        <p className="text-micro text-muted">{e.actorName} · {relativeTime(e.createdAt)}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </>
        )}
      </Page>
    </div>
  );
}
