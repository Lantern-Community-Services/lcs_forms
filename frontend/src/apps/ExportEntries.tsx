import { useState } from "react";
import { Download, FileSpreadsheet, FileText, Loader2, Printer, Sheet as SheetIcon } from "lucide-react";
import { headerLinkClass } from "@/components/shell/FormTabs";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useFileExport, type ExportFormat } from "@/lib/exportPipeline";
import { useSites } from "@/lib/queries";

/**
 * Every code form's Export button (the header, beside Show me how): its entries as CSV, Excel or a PDF,
 * for a date range and site. The server builds the file (GET /api/apps/:slug/entries-export,
 * apps/entryExport.ts): each entry as its paper form when the form has one, else its saved answers.
 * Someone who can't read everyone's entries on the form gets the ones the form shows them.
 */

const nyToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const daysAgo = (n: number) => {
  const d = new Date(`${nyToday()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

const FORMATS: { format: ExportFormat; Icon: typeof FileText; label: string; hint: string }[] = [
  { format: "pdf", Icon: FileText, label: "PDF", hint: "Each entry on its own page" },
  { format: "xlsx", Icon: FileSpreadsheet, label: "Excel", hint: "One row per entry" },
  { format: "csv", Icon: SheetIcon, label: "CSV", hint: "Plain spreadsheet data" },
];

export function ExportEntriesButton({ slug, title, canReadAll, paper }: { slug: string; title: string; canReadAll: boolean; paper: boolean }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(nyToday());
  const [site, setSite] = useState("");
  const [mine, setMine] = useState(false);
  const { data: sites } = useSites(false, open);
  // Without the form's own layout, only those who read everyone's get everyone's.
  const ownOnly = !paper && !canReadAll;

  const exporter = useFileExport((format, inline) => {
    const q = new URLSearchParams({ format });
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    if (site) q.set("site", site);
    if (mine || ownOnly) q.set("mine", "1");
    if (inline) q.set("inline", "1");
    return `/api/apps/${encodeURIComponent(slug)}/entries-export?${q}`;
  });
  const { busy } = exporter;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={headerLinkClass} title="Export this form's entries: PDF, Excel or CSV">
        <Download className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Export</span>
      </button>
      <ResponsiveDialog
        open={open}
        onOpenChange={setOpen}
        title={`Export ${title}`}
        footer={
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => void exporter.print()} disabled={busy !== null} className="min-h-[44px] md:min-h-0">
              {busy === "print" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />} Print
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-[13px] font-semibold text-ink">
              From
              <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-[13px] font-semibold text-ink">
              To
              <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              { label: "Last 30 days", from: daysAgo(29) },
              { label: "Last 90 days", from: daysAgo(89) },
              { label: "This year", from: `${nyToday().slice(0, 4)}-01-01` },
              { label: "Everything", from: "" },
            ].map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setFrom(p.from);
                  setTo(p.from ? nyToday() : "");
                }}
                className="min-h-[32px] rounded-pill border border-hairline px-3 text-[12.5px] font-semibold text-ink hover:bg-navsel"
              >
                {p.label}
              </button>
            ))}
          </div>
          <label className="flex flex-col gap-1 text-[13px] font-semibold text-ink">
            Site
            <Select value={site} onChange={(e) => setSite(e.target.value)} placeholder="All my sites" options={(sites ?? []).map((s) => ({ value: s.code, label: s.name }))} />
          </label>
          {ownOnly ? (
            <p className="text-[13px] text-muted">This form only lets you export the entries you filed.</p>
          ) : (
            <label className="flex items-center gap-2 text-[13.5px] text-ink">
              <Checkbox checked={mine} onCheckedChange={(v) => setMine(v === true)} /> Only entries I filed
            </label>
          )}
          <div className="flex flex-col gap-2">
            {FORMATS.map(({ format, Icon, label, hint }) => (
              <button
                key={format}
                type="button"
                disabled={busy !== null}
                onClick={() => void exporter.download(format)}
                className="flex min-h-[52px] items-center gap-3 rounded-card border border-hairline px-3 text-left hover:bg-navsel disabled:opacity-60"
              >
                {busy === format ? <Loader2 className="h-5 w-5 animate-spin text-muted" /> : <Icon className="h-5 w-5 text-muted" />}
                <span className="flex-1">
                  <span className="block text-[14px] font-semibold text-ink">{label}</span>
                  <span className="block text-[12.5px] text-muted">{format === "pdf" && paper ? "Each entry as its paper form" : hint}</span>
                </span>
                <Download className="h-4 w-4 text-muted" />
              </button>
            ))}
          </div>
          <p className="text-[12px] text-muted">A PDF holds up to 300 entries. Exports may contain resident information: keep them private.</p>
        </div>
      </ResponsiveDialog>
    </>
  );
}
