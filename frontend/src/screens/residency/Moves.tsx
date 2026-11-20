import { useState } from "react";
import { BarChart3, Download, FileArchive } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { errorMessage } from "@/lib/utils";
import { SitePicker, useSiteSelection } from "@/lib/site";
import { fmtDay, todayLocal, useResidencyFor, useResidencyReport, type ResidencyReport } from "@/lib/residency";

const yearAgo = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "—");
const monthName = (m: string) => new Date(`${m}-01T12:00:00`).toLocaleDateString("en-US", { month: "short", year: "numeric" });

/**
 * Move-ins and move-outs (case management): by month and site, why people left
 * and where they went, how long they stayed, the units empty now, and how much
 * of the checklist got done on time. Downloadable as a spreadsheet (CSV), and
 * for people who see client information, as HUD's HMIS CSV files (HmisExport).
 */
export function MovesPage() {
  const { codes, setCodes, selected, param } = useSiteSelection();
  const residencyFor = useResidencyFor();
  const on = selected.some((s) => residencyFor(s));
  const [from, setFrom] = useState(yearAgo());
  const [to, setTo] = useState(todayLocal());
  const { data, isLoading } = useResidencyReport(param, from, to, on && from <= to);
  const { can } = useAuth();
  const supportive = selected.filter((s) => residencyFor(s));

  return (
    <Page className="max-w-[1040px]">
      <PageHeader
        title="Move-ins & move-outs"
        subtitle="Who arrived and left, why, how long they stayed, the units empty now, and the checklist done on time."
        actions={<SitePicker codes={codes} onChange={setCodes} className="w-full md:w-[260px]" />}
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="From"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="min-h-[40px]" /></Field>
        <Field label="To"><Input type="date" value={to} min={from} max={todayLocal()} onChange={(e) => setTo(e.target.value)} className="min-h-[40px]" /></Field>
        {data && (
          <Button variant="secondary" onClick={() => download(data)} className="min-h-[40px]">
            <Download className="h-4 w-4" /> Spreadsheet (CSV)
          </Button>
        )}
      </div>
      {!on ? (
        <EmptyState title="Nothing to report here" hint="Move-ins and move-outs are for supportive sites while case management is on." icon={<BarChart3 className="h-8 w-8" />} />
      ) : isLoading || !data ? (
        <LoadingState />
      ) : (
        <div className="grid gap-4">
          {can("clients.view") && <HmisExport from={from} to={to} sites={supportive} canSsn={can("clients.ssn")} />}
          <Report r={data} />
        </div>
      )}
    </Page>
  );
}

/**
 * HUD's HMIS CSV files for the dates and sites above, as one zip to upload to
 * the CoC's HMIS (backend services/hmisExport.ts). Client information, so only
 * for people who see it; whole SSNs only for Admins, and only when ticked.
 */
function HmisExport({ from, to, sites, canSsn }: { from: string; to: string; sites: { code: string; name: string }[]; canSsn: boolean }) {
  const toast = useToast();
  const [ssn, setSsn] = useState(false);
  const [busy, setBusy] = useState(false);
  const where = sites.length === 1 ? sites[0].name : `${sites.length} sites`;

  async function run() {
    setBusy(true);
    try {
      await api.download("/residency/hmis-export", { from, to, sites: sites.map((s) => s.code), includeSsn: canSsn && ssn }, `hmis-csv-${from}-to-${to}.zip`);
      toast("HMIS files downloaded.");
    } catch (e) {
      toast(errorMessage(e, "Couldn't make the HMIS files."), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <p className="kicker mb-1">HMIS export</p>
      <p className="text-[13px] text-muted">
        HUD's HMIS CSV files (FY2026) for {where}, {fmtDay(from)} to {fmtDay(to)}: clients, enrollments and exits, income and benefits, health
        and disabilities, in one zip to upload to the CoC's HMIS. Each export is logged.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-4">
        {canSsn && (
          <label className="flex items-center gap-2 text-[13px]">
            <Checkbox checked={ssn} onCheckedChange={(v) => setSsn(v === true)} />
            Include whole Social Security Numbers
          </label>
        )}
        <Button variant="secondary" onClick={run} disabled={busy || !sites.length || from > to} className="min-h-[40px]">
          <FileArchive className="h-4 w-4" /> {busy ? "Making the files…" : "Download HMIS files (zip)"}
        </Button>
      </div>
    </Card>
  );
}

function Report({ r }: { r: ResidencyReport }) {
  const totals = r.bySite.reduce(
    (t, s) => ({ units: t.units + s.units, vacant: t.vacant + s.vacant, moveIns: t.moveIns + s.moveIns, moveOuts: t.moveOuts + s.moveOuts, waiting: t.waiting + s.waiting, away: t.away + s.away }),
    { units: 0, vacant: 0, moveIns: 0, moveOuts: 0, waiting: 0, away: 0 }
  );
  const c = r.checklist;
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Tile label="Moved in" value={totals.moveIns} />
        <Tile label="Moved out" value={totals.moveOuts} />
        <Tile label="Vacant now" value={`${totals.vacant} of ${totals.units}`} />
        <Tile label="Waiting to move in" value={totals.waiting} />
        <Tile label="Away now" value={totals.away} />
        <Tile label="Median stay" value={r.lengthOfStay.medianDays === null ? "—" : `${r.lengthOfStay.medianDays} days`} hint={r.lengthOfStay.count ? `${r.lengthOfStay.count} who left` : undefined} />
      </div>

      <Section title="By site">
        <Table
          head={["Site", "Units", "Vacant", "Moved in", "Moved out", "Waiting", "Away"]}
          rows={r.bySite.map((s) => [s.siteName, s.units, s.vacant, s.moveIns, s.moveOuts, s.waiting, s.away])}
        />
      </Section>

      <Section title="By month">
        {r.months.length ? (
          <Table head={["Month", "Moved in", "Transferred in", "Moved out", "Transferred out"]} rows={r.months.map((m) => [monthName(m.month), m.moveIns, m.transfersIn, m.moveOuts, m.transfersOut])} />
        ) : <p className="text-[13px] text-muted">No moves in these dates.</p>}
      </Section>

      <div className="grid gap-4 md:grid-cols-2">
        <Section title="Why they moved out">
          {r.reasons.length ? <Table head={["Reason", "People"]} rows={r.reasons.map((x) => [x.label, x.count])} /> : <p className="text-[13px] text-muted">Nobody moved out.</p>}
        </Section>
        <Section title="Where they went (HUD)">
          {r.destinations.length ? <Table head={["Destination", "People"]} rows={r.destinations.map((x) => [x.label, x.count])} /> : <p className="text-[13px] text-muted">Nobody moved out.</p>}
        </Section>
      </div>

      <Section title="Checklist done on time" note={`Due in these dates: ${c.due}. Done on time ${pct(c.onTime, c.due)}, late ${pct(c.late, c.due)}, still open ${pct(c.missing, c.due)}${c.skipped ? `, not needed ${c.skipped}` : ""}.`}>
        {c.byTask.length ? (
          <Table head={["Paperwork", "Due", "On time", "Still open"]} rows={c.byTask.map((t) => [t.label, t.due, `${t.onTime} (${pct(t.onTime, t.due)})`, t.missing])} />
        ) : <p className="text-[13px] text-muted">Nothing was due.</p>}
      </Section>

      <Section title="Vacant units now">
        {r.vacancies.length ? (
          <Table head={["Site", "Unit", "Type", "Vacant since", "Days"]} rows={r.vacancies.map((v) => [v.siteName, v.label, v.unitType ?? "—", fmtDay(v.vacantSince), v.days ?? "—"])} />
        ) : <p className="text-[13px] text-muted">No vacant units.</p>}
      </Section>
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <Card className="p-3">
      <p className="text-micro font-semibold text-muted">{label}</p>
      <p className="mt-0.5 font-heading text-[20px] font-extrabold tabular text-ink">{value}</p>
      {hint && <p className="text-micro text-muted">{hint}</p>}
    </Card>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <Card className="p-4">
      <p className="kicker mb-1">{title}</p>
      {note && <p className="mb-2 text-micro text-muted">{note}</p>}
      <div className="mt-2 overflow-x-auto">{children}</div>
    </Card>
  );
}

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full text-left text-[13px]">
      <thead>
        <tr className="border-b border-hairline text-micro uppercase tracking-[0.04em] text-muted">
          {head.map((h, i) => <th key={h} className={`py-1.5 pr-3 font-bold ${i > 0 ? "text-right" : ""}`}>{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-hairline last:border-0">
            {r.map((c, j) => <td key={j} className={`py-1.5 pr-3 ${j > 0 ? "text-right tabular" : "text-ink"}`}>{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Every table, one after another, as a CSV the person saves. */
function download(r: ResidencyReport) {
  const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const block = (title: string, head: string[], rows: (string | number | null)[][]) => [q(title), head.map(q).join(","), ...rows.map((x) => x.map(q).join(",")), ""].join("\r\n");
  const csv = [
    block(`Move-ins and move-outs, ${r.from} to ${r.to}`, ["Site", "Units", "Vacant", "Moved in", "Moved out", "Waiting", "Away"], r.bySite.map((s) => [s.siteName, s.units, s.vacant, s.moveIns, s.moveOuts, s.waiting, s.away])),
    block("By month", ["Month", "Moved in", "Transferred in", "Moved out", "Transferred out"], r.months.map((m) => [m.month, m.moveIns, m.transfersIn, m.moveOuts, m.transfersOut])),
    block("Move-out reasons", ["Reason", "People"], r.reasons.map((x) => [x.label, x.count])),
    block("Exit destinations", ["Destination", "People"], r.destinations.map((x) => [x.label, x.count])),
    block("Checklist", ["Paperwork", "Due", "On time", "Still open"], r.checklist.byTask.map((t) => [t.label, t.due, t.onTime, t.missing])),
    block("Vacant units", ["Site", "Unit", "Type", "Vacant since", "Days"], r.vacancies.map((v) => [v.siteName, v.label, v.unitType, v.vacantSince, v.days])),
  ].join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `move-ins-and-move-outs-${r.from}-to-${r.to}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
