import { useMemo, useState } from "react";
import { AlertTriangle, Download, Printer } from "lucide-react";
import { app, dates, entries, roster, useData, type Entry } from "@lcs/sdk";
import { Button, Card, DateRangeBar, EmptyState, LoadingState, Modal, Page, PageHeader, SearchInput, Select, Textarea, ToneBadge, presetRange } from "@lcs/ui";
import type { MealEntry } from "../lib/types";

/** Every Hot Foods entry the person may see: filter, search, open one, void it, export what's shown. */

const PAGE = 100;
const LIST_FIELDS = ["items", "mealCount", "tenantName", "unit", "notes"];
const meals = (e: Entry<MealEntry>) => (e.data.items ?? []).map((i) => `${i.quantity} ${i.itemName}`).join(", ");

export default function Entries() {
  const [range, setRange] = useState(() => presetRange("7d"));
  const [site, setSite] = useState("");
  const [status, setStatus] = useState<"active" | "voided" | "all">("active");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);
  const { data: sites } = useData(() => roster.sites(), []);
  const query = { from: range.from, to: range.to, site: site || undefined, status, search: search.trim() || undefined, limit, fields: LIST_FIELDS };
  const { data, loading, error, refresh } = useData(() => entries.list<MealEntry>(query), [range.from, range.to, site, status, search, limit]);
  const totals = useMemo(() => ({ meals: (data?.items ?? []).filter((e) => e.status === "active").reduce((n, e) => n + (e.data.mealCount ?? 0), 0) }), [data]);

  function exportCsv() {
    if (!data) return;
    const esc = (s: unknown) => { const t = String(s ?? ""); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const rows = data.items.map((e) => [dates.format(e.occurredAt, "datetime"), e.site?.name, e.data.tenantName, e.data.unit, meals(e), e.data.mealCount, e.createdByName, e.overrideReason, e.status, e.voidReason, e.data.notes].map(esc).join(","));
    app.download(`hot-foods-${range.from}-to-${range.to}.csv`, ["When,Site,Resident,Room,Meals,Meal count,Recorded by,Over-limit reason,Status,Void reason,Notes", ...rows].join("\n"), { mime: "text/csv" });
  }

  return (
    <Page>
      <PageHeader
        title="Entries"
        subtitle={data ? `${data.total.toLocaleString()} entr${data.total === 1 ? "y" : "ies"} · ${totals.meals.toLocaleString()} meals shown` : undefined}
        actions={
          <>
            <Button variant="secondary" onClick={() => app.print()}><Printer className="h-4 w-4" /> Print</Button>
            <Button onClick={exportCsv} disabled={!data?.items.length}><Download className="h-4 w-4" /> CSV</Button>
          </>
        }
      />
      <div className="mb-4 space-y-3 print:hidden">
        <DateRangeBar from={range.from} to={range.to} onChange={(r) => { setRange(r); setLimit(PAGE); }} />
        <div className="flex flex-wrap gap-2">
          <SearchInput wrapperClassName="min-w-[220px] flex-1" placeholder="Search resident, staff or notes" value={search} onChange={(e) => { setSearch(e.target.value); setLimit(PAGE); }} />
          <div className="w-[200px]"><Select value={site} onChange={(e) => setSite(e.target.value)} options={[{ value: "", label: "All my sites" }, ...(sites ?? []).map((s) => ({ value: s.code, label: s.name }))]} /></div>
          <div className="w-[130px]"><Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} options={[{ value: "active", label: "Active" }, { value: "voided", label: "Voided" }, { value: "all", label: "All" }]} /></div>
        </div>
      </div>

      {error ? <Card><EmptyState title={error.message} /></Card> : loading && !data ? <LoadingState /> : !data?.items.length ? (
        <Card><EmptyState title="No entries" hint="Nothing matches these filters." /></Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-hairline bg-subtle text-micro font-bold uppercase tracking-[0.04em] text-muted">
              <tr>
                <th className="px-3 py-2.5">When</th>
                <th className="px-3 py-2.5">Resident</th>
                <th className="hidden px-3 py-2.5 md:table-cell">Site</th>
                <th className="px-3 py-2.5">Meals</th>
                <th className="hidden px-3 py-2.5 lg:table-cell">Recorded by</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {data.items.map((e) => (
                <tr key={e.id} onClick={() => setOpen(e.id)} className={`cursor-pointer border-b border-hairline last:border-0 hover:bg-rowhover ${e.status === "voided" ? "opacity-55" : ""}`}>
                  <td className="whitespace-nowrap px-3 py-2.5 text-ink">{dates.format(e.occurredAt, "datetime")}</td>
                  <td className="px-3 py-2.5"><span className="font-semibold text-ink">{e.data.tenantName}</span>{e.data.unit && <span className="text-muted"> · {e.data.unit}</span>}</td>
                  <td className="hidden px-3 py-2.5 text-ink md:table-cell">{e.site?.name}</td>
                  <td className="px-3 py-2.5 text-ink">{meals(e)}</td>
                  <td className="hidden px-3 py-2.5 text-ink lg:table-cell">{e.createdByName}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right">
                    {e.overrideReason && <span title={e.overrideReason}><ToneBadge tone="amber">Over limit</ToneBadge></span>}
                    {e.status === "voided" && <ToneBadge tone="red">Void</ToneBadge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {data && data.items.length < data.total && (
        <div className="mt-3 flex justify-center print:hidden"><Button variant="secondary" onClick={() => setLimit((l) => l + PAGE)}>Show more ({data.total - data.items.length} left)</Button></div>
      )}
      {open && <EntryModal id={open} onClose={() => setOpen(null)} onChanged={refresh} />}
    </Page>
  );
}

function EntryModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { data: e, error } = useData(() => entries.get<MealEntry>(id), [id]);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>, done: string) {
    setBusy(true);
    try {
      await fn();
      app.toast(done);
      onChanged();
      onClose();
    } catch (err) {
      app.toast(err instanceof Error ? err.message : "That didn't work.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={e ? e.data.tenantName : "Entry"}
      subtitle={e ? `${dates.format(e.occurredAt, "datetime")} · ${e.site?.name ?? ""}` : undefined}
      footer={
        e && (
          <>
            {e.status === "active" && !voiding && <Button variant="outlineDanger" onClick={() => setVoiding(true)}>Void</Button>}
            {e.status === "voided" && <Button variant="secondary" disabled={busy} onClick={() => run(() => entries.restore(e.id), "Restored.")}>Restore</Button>}
            {voiding && <Button variant="danger" disabled={busy || reason.trim().length < 3} onClick={() => run(() => entries.void(e.id, reason.trim()), "Voided.")}>Void entry</Button>}
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </>
        )
      }
    >
      {error ? <p className="text-status-redText">{error.message}</p> : !e ? <LoadingState /> : (
        <div className="space-y-3 text-[14px]">
          <dl className="grid grid-cols-[120px_1fr] gap-y-1.5">
            <dt className="text-muted">Room</dt><dd className="text-ink">{e.data.unit ?? "—"}</dd>
            <dt className="text-muted">Meals</dt><dd className="text-ink">{meals(e)}</dd>
            <dt className="text-muted">Recorded by</dt><dd className="text-ink">{e.createdByName}</dd>
            {e.data.notes && <><dt className="text-muted">Note</dt><dd className="text-ink">{e.data.notes}</dd></>}
          </dl>
          {e.overrideReason && <p className="flex items-start gap-2 rounded-input bg-status-amberBg px-3 py-2 text-[13px] text-status-amberText"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> Over the limit: {e.overrideReason}</p>}
          {e.status === "voided" && <p className="rounded-input bg-status-redBg px-3 py-2 text-[13px] text-status-redText">Voided by {e.voidedByName}: {e.voidReason}</p>}
          {e.data.signature && <img src={e.data.signature} alt="Signature" className="h-32 w-full rounded-card border border-hairline bg-white object-contain" />}
          {voiding && <Textarea autoFocus value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="Why is it being voided? (e.g. entered twice)" />}
        </div>
      )}
    </Modal>
  );
}
