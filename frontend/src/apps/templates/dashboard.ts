/** A dashboard code form: a server action aggregates entries, a page charts them. */
export const DASHBOARD_TEMPLATE = (title: string): Record<string, string> => ({
  "form.json": JSON.stringify(
    {
      title,
      icon: "inbox",
      access: { roles: ["main_office", "site_admin", "site_manager"] },
      pages: [{ id: "overview", label: "Overview", file: "pages/overview.tsx" }],
      // To chart another form, add its slug here and set SOURCE in server/index.ts.
      reads: [],
    },
    null,
    2
  ),
  "server/index.ts": `import { defineServer } from "@lcs/server";

/** Another form's slug to chart (also list it in form.json "reads"), or "" for this form's own entries. */
const SOURCE = "";

export default defineServer({
  actions: {
    summary({ from, to }: { from: string; to: string }, ctx) {
      const api = SOURCE ? ctx.db.form(SOURCE).entries : ctx.db.entries;
      const rows = api.find({ from, to, limit: 5000 });
      const byDay: Record<string, number> = {};
      const bySite: Record<string, number> = {};
      const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
      const sites = new Map(ctx.roster.sites().map((s) => [s.id, s.name]));
      for (const e of rows) {
        const day = ctx.time.partsOf(e.occurredAt).day;
        byDay[day] = (byDay[day] ?? 0) + 1;
        const site = e.siteId ? sites.get(e.siteId) ?? "Other site" : "No site";
        bySite[site] = (bySite[site] ?? 0) + 1;
        const { weekday, hour } = ctx.time.partsOf(e.occurredAt);
        heat[(weekday + 1) % 7][hour]++; // HeatGrid rows run Sunday to Saturday
      }
      return { total: rows.length, byDay, bySite, heat, people: new Set(rows.map((r) => r.tenantId ?? r.createdById)).size };
    },
  },
});
`,
  "pages/overview.tsx": `import { useState } from "react";
import { actions, app, dates, useData } from "@lcs/sdk";
import { Button, Card, DateRangeBar, LoadingState, Page, PageHeader, presetRange } from "@lcs/ui";
import { DailyBars, HeatGrid, RankedBars, StatTile } from "@lcs/charts";
import { Download } from "lucide-react";

type Summary = { total: number; byDay: Record<string, number>; bySite: Record<string, number>; heat: number[][]; people: number };

export default function Overview() {
  const [range, setRange] = useState(() => presetRange("30d"));
  const { data, loading, error } = useData(() => actions.call<Summary>("summary", range), [range.from, range.to]);

  const days: string[] = [];
  for (let d = range.from; d <= range.to; d = dates.addDays(d, 1)) days.push(d);

  function exportCsv() {
    if (!data) return;
    const csv = ["Day,Entries", ...days.map((d) => \`\${d},\${data.byDay[d] ?? 0}\`)].join("\\n");
    app.download(\`summary-\${range.from}-\${range.to}.csv\`, csv, { mime: "text/csv" });
  }

  return (
    <Page>
      <PageHeader title="Overview" actions={<Button variant="secondary" onClick={exportCsv} disabled={!data}><Download className="h-4 w-4" /> CSV</Button>} />
      <DateRangeBar from={range.from} to={range.to} onChange={setRange} className="mb-4" />
      {error && <p className="text-status-redText">{error.message}</p>}
      {loading && !data ? <LoadingState /> : data && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile label="Entries" value={data.total.toLocaleString()} />
            <StatTile label="People" value={data.people.toLocaleString()} />
            <StatTile label="Per day" value={(data.total / Math.max(1, days.length)).toFixed(1)} />
          </div>
          <Card className="p-4">
            <p className="mb-3 font-heading text-[15px] font-extrabold text-ink">Entries per day</p>
            <DailyBars data={days.map((d) => ({ day: d, meals: data.byDay[d] ?? 0, entries: data.byDay[d] ?? 0, parts: { all: data.byDay[d] ?? 0 } }))} series={[{ key: "all", name: "Entries", slot: 0 }]} />
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-4">
              <p className="mb-3 font-heading text-[15px] font-extrabold text-ink">By site</p>
              <RankedBars rows={Object.entries(data.bySite).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }))} unit="entries" />
            </Card>
            <Card className="p-4">
              <p className="mb-3 font-heading text-[15px] font-extrabold text-ink">When</p>
              <HeatGrid heat={data.heat} />
            </Card>
          </div>
        </div>
      )}
    </Page>
  );
}
`,
});
