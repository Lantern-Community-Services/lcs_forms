import { AlertTriangle, BarChart3 } from "lucide-react";
import { Page } from "@/components/shell/AppShell";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import { Card } from "@/components/ui/card";
import { Avatar, AVATAR_DEFAULT } from "@/components/ui/avatar";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { DailyBars, HeatGrid, Legend, RankedBars, SITE_TYPE, siteTypeOf, slotColor, StatTile } from "@/components/hotfoods/Charts";
import { DateRangeBar, rangeLabel, useDateRange } from "@/components/hotfoods/DateRange";
import { HotFoodsExportButtons, HotFoodsExportMenu } from "@/components/hotfoods/HotFoodsExport";
import { useHotFoodReport, type HotFoodView } from "@/lib/queries";
import { SitePicker, selectionLabel, useSiteSelection } from "@/lib/site";
import { errorMessage } from "@/lib/utils";

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

/**
 * Hot Foods at a glance for any sites and dates: headline numbers, meals per
 * day, by site, by meal type, when meals are served, and who recorded them.
 * Print / Export produce the same report as a PDF (charts included) or an
 * Excel workbook with one sheet per breakdown.
 */
export function HotFoodsReportsPage() {
  const { codes, setCodes, selected, param, isLoading: sitesLoading } = useSiteSelection();
  const { from, to, preset, setRange } = useDateRange("30d");
  const view: HotFoodView = { site: param, from, to };
  const { data: r, isLoading, isError, error, isFetching } = useHotFoodReport(view, selected.length > 0);
  const subtitle = `${selected.length ? selectionLabel(codes, selected) : ""} · ${rangeLabel(from, to)}`;

  return (
    <div className="flex min-h-full flex-col">
      <PhoneHeader title="Reports" subtitle={subtitle} actions={<HotFoodsExportMenu kind="report" view={view} disabled={selected.length === 0} />}>
        <div className="mt-3 flex flex-col gap-2.5">
          <SitePicker codes={codes} onChange={setCodes} />
          <DateRangeBar from={from} to={to} preset={preset} onChange={setRange} />
        </div>
      </PhoneHeader>

      <Page className="w-full flex-1">
        <div className="hidden md:block">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <p className="text-[13.5px] text-muted">{subtitle}</p>
            <div className="flex flex-wrap items-center gap-2">
              <SitePicker codes={codes} onChange={setCodes} className="w-[240px]" />
              <HotFoodsExportButtons kind="report" view={view} disabled={selected.length === 0} />
            </div>
          </div>
          <DateRangeBar from={from} to={to} preset={preset} onChange={setRange} className="mb-5" />
        </div>

        {sitesLoading || isLoading ? (
          <LoadingState label="Building the report…" />
        ) : isError ? (
          <EmptyState title="Could not build the report" hint={errorMessage(error, "Try again in a moment.")} />
        ) : selected.length === 0 ? (
          <EmptyState title="No sites assigned" hint="You aren't assigned to any sites yet." />
        ) : !r ? null : (
          <div className={`space-y-4 transition-opacity ${isFetching ? "opacity-60" : ""}`}>
            <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5 md:gap-3">
              <StatTile label="Meals served" value={fmt(r.totals.meals)} />
              <StatTile label="Residents served" value={fmt(r.totals.residents)} />
              <StatTile label="Entries" value={fmt(r.totals.entries)} />
              <StatTile label="Meals per day" value={(Math.round(r.totals.avgMealsPerDay * 10) / 10).toLocaleString()} hint={`over ${r.totals.days} day${r.totals.days === 1 ? "" : "s"}`} />
              <StatTile
                label="Over-limit"
                value={fmt(r.totals.overrides)}
                hint={r.totals.voided ? `${fmt(r.totals.voided)} voided, not counted` : "entries with a reason"}
                {...(r.totals.overrides > 0 ? { accent: "rgb(var(--st-amber-dot))", icon: <AlertTriangle className="h-3.5 w-3.5 text-status-amberText" aria-label="Warning" /> } : {})}
              />
            </div>

            {r.totals.entries === 0 ? (
              <EmptyState title="Nothing recorded in this range" hint="Try a longer range or other sites." icon={<BarChart3 className="h-8 w-8" />} />
            ) : (
              <>
                <Section title="Meals per day">
                  <DailyBars data={r.byDay} series={r.series} />
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[12.5px] font-semibold text-accent dark:text-white">Show as a table</summary>
                    <div className="mt-2 max-h-[260px] overflow-y-auto scroll-thin">
                      <table className="w-full text-[12.5px]">
                        <thead className="sticky top-0 bg-surface text-left text-muted">
                          <tr>
                            <th className="py-1 font-semibold">Day</th>
                            <th className="py-1 text-right font-semibold">Entries</th>
                            {r.series.length > 1 && r.series.map((s) => <th key={s.key} className="py-1 text-right font-semibold">{s.name}</th>)}
                            <th className="py-1 text-right font-semibold">Meals</th>
                          </tr>
                        </thead>
                        <tbody className="tabular text-ink">
                          {r.byDay.map((d) => (
                            <tr key={d.day} className="border-t border-hairline">
                              <td className="py-1">{new Date(`${d.day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })}</td>
                              <td className="py-1 text-right">{d.entries}</td>
                              {r.series.length > 1 && r.series.map((s) => <td key={s.key} className="py-1 text-right">{d.parts[s.key] ?? 0}</td>)}
                              <td className="py-1 text-right font-semibold">{d.meals}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </Section>

                <div className="grid gap-4 lg:grid-cols-2">
                  {r.sites.length > 1 && (
                    <Section title="Meals by site">
                      <SiteTypeLegend types={r.bySite.filter((s) => s.meals > 0).map((s) => s.siteType)} />
                      <RankedBars
                        rows={r.bySite.filter((s) => s.meals > 0).map((s) => ({ name: s.name, value: s.meals, note: `${siteTypeOf(s.siteType).label} · ${fmt(s.residents)} residents`, color: siteTypeOf(s.siteType).color }))}
                        unit="meals"
                        limit={10}
                      />
                    </Section>
                  )}
                  <Section title="Meals by type">
                    <RankedBars rows={r.byItem.map((i) => ({ name: i.name, value: i.quantity, color: slotColor(i.slot) }))} unit="meals" />
                  </Section>
                  <Section title="When meals are served">
                    <HeatGrid heat={r.heat} />
                  </Section>
                  <Section title="Entries by staff member">
                    <RankedBars
                      rows={r.byStaff.map((s) => ({
                        name: s.name,
                        value: s.entries,
                        // Exactly the color of their avatar, including its default for people who haven't picked one.
                        color: s.avatarColor || AVATAR_DEFAULT,
                        lead: <Avatar name={s.name} color={s.avatarColor} size={22} className="text-[9px]" />,
                      }))}
                      unit="entries"
                      limit={8}
                    />
                  </Section>
                </div>
              </>
            )}
          </div>
        )}
      </Page>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-4 md:p-5">
      <h2 className="mb-3 text-[14.5px] font-bold text-ink">{title}</h2>
      {children}
    </Card>
  );
}

/** Only the site types actually on the chart; one type needs no legend (the notes name it). */
function SiteTypeLegend({ types }: { types: string[] }) {
  const present = (Object.keys(SITE_TYPE) as (keyof typeof SITE_TYPE)[]).filter((t) => types.some((x) => siteTypeOf(x) === SITE_TYPE[t]));
  if (present.length < 2) return null;
  return <Legend className="mb-3" items={present.map((t) => ({ label: SITE_TYPE[t].label, color: SITE_TYPE[t].color }))} />;
}
