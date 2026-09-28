import { Link } from "react-router-dom";
import { ArrowRight, Layers, UserMinus, UserPlus, Users } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import { Card } from "@/components/ui/card";
import { CountBadge } from "@/components/ui/badge";
import { LoadingState } from "@/components/ui/misc";
import { useDashboard } from "@/lib/queries";
import { useAuth } from "@/lib/auth";
import { SitePicker, selectionLabel, useSiteSelection } from "@/lib/site";
import { cn, relativeTime } from "@/lib/utils";

export function DashboardPage() {
  const { user } = useAuth();
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
            subtitle={scope}
            actions={<SitePicker codes={codes} onChange={setCodes} className="w-[260px]" />}
          />
        </div>
        {isLoading || !data ? (
          <LoadingState />
        ) : (
          <>
            {data.totals.attention > 0 && (
              <Link
                to={`/roster/review${param ? `?site=${param}` : ""}`}
                className="page-list-item-enter mb-4 flex items-center gap-3 rounded-card border border-status-amberDot/40 bg-status-amberBg px-4 py-3.5 text-status-amberText"
              >
                <Layers className="h-5 w-5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-bold">{data.totals.attention} people to review</span>
                  <span className="block text-[12.5px] opacity-90">Not on any form in {data.attentionHours}+ hours. Swipe through them in a minute.</span>
                </span>
                <ArrowRight className="h-5 w-5 shrink-0" />
              </Link>
            )}

            <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Tile icon={Users} label="On roster" value={data.totals.active} />
              <Tile icon={Layers} label="To review" value={data.totals.attention} tone={data.totals.attention ? "amber" : undefined} to={`/roster/review${param ? `?site=${param}` : ""}`} />
              <Tile icon={UserPlus} label="Added · 7 days" value={data.totals.addedWeek} />
              <Tile icon={UserMinus} label="Removed · 7 days" value={data.totals.removedWeek} />
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
              <Card className="page-list-item-enter overflow-hidden">
                <div className="grid grid-cols-[minmax(0,1fr)_70px_80px] gap-2 border-b border-hairline px-4 py-2.5 text-micro font-bold uppercase tracking-[0.04em] text-muted md:grid-cols-[minmax(0,1fr)_80px_90px_70px_70px]">
                  <span>Site</span>
                  <span className="text-right">Roster</span>
                  <span className="text-right">Review</span>
                  <span className="hidden text-right md:block">+7d</span>
                  <span className="hidden text-right md:block">−7d</span>
                </div>
                <ul>
                  {data.sites.map((s) => (
                    <li key={s.id} className="border-b border-hairline last:border-0">
                      <Link
                        to={`/roster?site=${s.code}`}
                        className="grid min-h-[48px] grid-cols-[minmax(0,1fr)_70px_80px] items-center gap-2 px-4 hover:bg-rowhover md:grid-cols-[minmax(0,1fr)_80px_90px_70px_70px]"
                      >
                        <span className="truncate text-[13.5px] font-semibold text-ink">{s.name}</span>
                        <span className="text-right text-[13.5px] tabular text-ink">{s.activeCount}</span>
                        <span className="text-right">
                          {s.attentionCount > 0 ? (
                            <CountBadge count={s.attentionCount} className="px-2" />
                          ) : (
                            <span className="text-[13px] text-muted">—</span>
                          )}
                        </span>
                        <span className="hidden text-right text-[13px] tabular text-muted md:block">{s.addedWeek || "—"}</span>
                        <span className="hidden text-right text-[13px] tabular text-muted md:block">{s.removedWeek || "—"}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>

              <Card className="page-list-item-enter p-4" style={{ animationDelay: "50ms" }}>
                <div className="mb-3 flex items-center justify-between">
                  <p className="kicker">Recent changes</p>
                  <Link to="/roster/activity" className="text-[12.5px] font-semibold text-accent dark:text-white">All activity</Link>
                </div>
                {data.recent.length === 0 ? (
                  <p className="text-[13px] text-muted">Nothing yet.</p>
                ) : (
                  <ul className="space-y-3">
                    {data.recent.map((e) => (
                      <li key={e.id} className="text-[13px]">
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

function Tile({ icon: Icon, label, value, tone, to }: { icon: typeof Users; label: string; value: number; tone?: "amber"; to?: string }) {
  const inner = (
    <Card className={cn("page-list-item-enter h-full p-4", tone === "amber" && "border-status-amberDot/40")}>
      <p className="flex items-center gap-1.5 text-micro font-semibold text-muted">
        <Icon className="h-3.5 w-3.5" /> {label}
      </p>
      <p className={cn("mt-1 font-heading text-[26px] font-extrabold tabular", tone === "amber" ? "text-status-amberText" : "text-ink")}>
        {value.toLocaleString()}
      </p>
    </Card>
  );
  return to ? <Link to={to}>{inner}</Link> : inner;
}
