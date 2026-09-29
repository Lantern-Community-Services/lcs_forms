import { useState } from "react";
import { AlertTriangle, BarChart3, Download, Printer } from "lucide-react";
import { actions, app, roster, useData } from "@lcs/sdk";
import { Avatar, Button, Card, DateRangeBar, EmptyState, LoadingState, Page, PageHeader, Select, presetRange } from "@lcs/ui";
import { DailyBars, HeatGrid, Legend, RankedBars, SITE_TYPE, StatTile, siteTypeOf, slotColor } from "@lcs/charts";
import type { Report } from "../lib/types";

/** Hot Foods at a glance: headline numbers, meals per day, by site, by meal type, when, and who recorded them. */

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

export default function Reports() {
  const [range, setRange] = useState(() => presetRange("30d"));
  const [site, setSite] = useState("");
  const { data: sites } = useData(() => roster.sites(), []);
  const { data: r, loading, error } = useData(() => actions.call<Report>("report", { ...range, sites: site ? [site] : undefined }), [range.from, range.to, site]);

  function exportCsv() {
    if (!r) return;
    const lines = [
      ["Day", "Entries", ...r.series.map((s) => s.name), "Meals"].join(","),
      ...r.byDay.map((d) => [d.day, d.entries, ...r.series.map((s) => d.parts[s.key] ?? 0), d.meals].join(",")),
    ];
    app.download(`hot-foods-report-${r.from}-to-${r.to}.csv`, lines.join("\n"), { mime: "text/csv" });
  }

  return (
    <Page>
      <PageHeader
        title="Reports"
        actions={
          <>
            <div className="w-[200px]"><Select value={site} onChange={(e) => setSite(e.target.value)} options={[{ value: "", label: "All my sites" }, ...(sites ?? []).map((s) => ({ value: s.code, label: s.name }))]} /></div>
            <Button variant="secondary" onClick={() => app.print()}><Printer className="h-4 w-4" /> Print</Button>
            <Button onClick={exportCsv} disabled={!r}><Download className="h-4 w-4" /> CSV</Button>
          </>
        }
      />
      <DateRangeBar from={range.from} to={range.to} onChange={setRange} className="mb-5 print:hidden" />
      {error ? <EmptyState title="Could not build the report" hint={error.message} /> : loading && !r ? <LoadingState label="Building the report…" /> : !r ? null : (
        <div className={`space-y-4 transition-opacity ${loading ? "opacity-60" : ""}`}>
          {r.truncated && <p className="rounded-input bg-status-amberBg px-3 py-2 text-[13px] text-status-amberText">This range has more entries than one report reads (20,000). Pick a shorter range for exact numbers.</p>}
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5 md:gap-3">
            <StatTile label="Meals served" value={fmt(r.totals.meals)} />
            <StatTile label="Residents served" value={fmt(r.totals.residents)} />
            <StatTile label="Entries" value={fmt(r.totals.entries)} />
            <StatTile label="Meals per day" value={(Math.round(r.totals.avgMealsPerDay * 10) / 10).toLocaleString()} hint={`over ${r.totals.days} day${r.totals.days === 1 ? "" : "s"}`} />
            <StatTile
              label="Over-limit"
              value={fmt(r.totals.overrides)}
              hint={r.totals.voided ? `${fmt(r.totals.voided)} voided, not counted` : "entries with a reason"}
              {...(r.totals.overrides > 0 ? { accent: "rgb(var(--st-amber-dot))", icon: <AlertTriangle className="h-3.5 w-3.5 text-status-amberText" /> } : {})}
            />
          </div>
          {r.totals.entries === 0 ? (
            <EmptyState title="Nothing recorded in this range" hint="Try a longer range or other sites." icon={<BarChart3 className="h-8 w-8" />} />
          ) : (
            <>
              <Section title="Meals per day"><DailyBars data={r.byDay} series={r.series} /></Section>
              <div className="grid gap-4 lg:grid-cols-2">
                {r.sites.length > 1 && (
                  <Section title="Meals by site">
                    <SiteTypeLegend types={r.bySite.filter((s) => s.meals > 0).map((s) => s.siteType)} />
                    <RankedBars rows={r.bySite.filter((s) => s.meals > 0).map((s) => ({ name: s.name, value: s.meals, note: `${siteTypeOf(s.siteType).label} · ${fmt(s.residents)} residents`, color: siteTypeOf(s.siteType).color }))} unit="meals" limit={10} />
                  </Section>
                )}
                <Section title="Meals by type"><RankedBars rows={r.byItem.map((i) => ({ name: i.name, value: i.quantity, color: slotColor(i.slot) }))} unit="meals" /></Section>
                <Section title="When meals are served"><HeatGrid heat={r.heat} /></Section>
                <Section title="Entries by staff member">
                  <RankedBars rows={r.byStaff.map((s) => ({ name: s.name, value: s.entries, lead: <Avatar name={s.name} size={22} className="text-[9px]" /> }))} unit="entries" limit={8} />
                </Section>
              </div>
            </>
          )}
        </div>
      )}
    </Page>
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

function SiteTypeLegend({ types }: { types: string[] }) {
  const present = (Object.keys(SITE_TYPE) as (keyof typeof SITE_TYPE)[]).filter((t) => types.some((x) => siteTypeOf(x) === SITE_TYPE[t]));
  if (present.length < 2) return null;
  return <Legend className="mb-3" items={present.map((t) => ({ label: SITE_TYPE[t].label, color: SITE_TYPE[t].color }))} />;
}
