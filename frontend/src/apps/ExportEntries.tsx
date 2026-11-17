import { useEffect, useState } from "react";
import { Download, FileSpreadsheet, FileText, Loader2, Printer, Sheet as SheetIcon } from "lucide-react";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Chip } from "@/components/ui/chip";
import { useFileExport, type ExportFormat } from "@/lib/exportPipeline";
import { SitePicker } from "@/lib/site";
import type { ExportSettings } from "./api";

/**
 * A code form's entries as CSV, Excel or a PDF. The form opens it from its own list page
 * (app.exportEntries in @lcs/sdk, usually the Export button of @lcs/components/ExportControls), starting
 * from the filters that page has picked. What it offers is the form's own: form.json "export"
 * (backend/src/apps/exportSettings.ts) — dates, sites, "only mine", search, voided, the form's own filters
 * on its data, the formats and Print. The server builds the file (GET /api/apps/:slug/entries-export,
 * apps/entryExport.ts): each entry as its paper form when the form has one, else its saved answers.
 * Someone who can't read everyone's entries on the form gets the ones the form shows them.
 */

const nyToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const daysAgo = (n: number) => {
  const d = new Date(`${nyToday()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

type Preset = NonNullable<Exclude<ExportSettings["dates"], false>>["default"];
/** A date preset's From (To is today; "all" is no limit either way). */
const presetFrom = (p: Preset): string =>
  p === "7d" ? daysAgo(6) : p === "90d" ? daysAgo(89) : p === "month" ? `${nyToday().slice(0, 8)}01` : p === "year" ? `${nyToday().slice(0, 4)}-01-01` : p === "all" ? "" : daysAgo(29);
const PRESET_BUTTONS: { key: Preset; label: string }[] = [
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "year", label: "This year" },
  { key: "all", label: "Everything" },
];

const FORMATS: Record<ExportFormat, { Icon: typeof FileText; label: string; hint: string }> = {
  pdf: { Icon: FileText, label: "PDF", hint: "Each entry on its own page" },
  xlsx: { Icon: FileSpreadsheet, label: "Excel", hint: "One row per entry" },
  csv: { Icon: SheetIcon, label: "CSV", hint: "Plain spreadsheet data" },
};

type FilterValue = string[] | boolean;

/** Where the dialog starts (app.exportEntries(preset)): the page's own filters. "" for a date = no limit. */
export interface ExportPreset {
  from?: string;
  to?: string;
  sites?: string[];
  mine?: boolean;
  search?: string;
  voided?: boolean;
  /** form.json export.filters by id: a value or values, or true for a check filter. */
  filters?: Record<string, FilterValue>;
}

/** A page's preset, as sent through the frame: anything malformed is dropped. */
export function readPreset(v: unknown): ExportPreset {
  const p = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const day = (x: unknown) => (x === "" ? "" : isDay(x) ? x : undefined);
  const site = typeof p.sites === "string" ? p.sites.split(",") : Array.isArray(p.sites) ? p.sites : [];
  const filters: Record<string, FilterValue> = {};
  if (p.filters && typeof p.filters === "object" && !Array.isArray(p.filters)) {
    for (const [k, x] of Object.entries(p.filters as Record<string, unknown>).slice(0, 8)) {
      if (typeof x === "boolean") filters[k] = x;
      else if (typeof x === "string" || typeof x === "number") filters[k] = String(x) ? [String(x).slice(0, 100)] : [];
      else if (Array.isArray(x)) filters[k] = x.filter((s) => typeof s === "string" || typeof s === "number").map((s) => String(s).slice(0, 100)).slice(0, 60);
    }
  }
  return {
    from: day(p.from),
    to: day(p.to),
    sites: site.filter((s): s is string => typeof s === "string" && /^[a-z0-9-]{1,80}$/.test(s)).slice(0, 100),
    mine: p.mine === true,
    search: typeof p.search === "string" ? p.search.slice(0, 120) : undefined,
    voided: p.voided === true,
    filters,
  };
}

/** A filter's starting value: the page's, else form.json's default, else nothing. */
function startOf(f: NonNullable<ExportSettings["filters"]>[number], preset?: ExportPreset): FilterValue {
  const given = preset?.filters?.[f.id];
  const raw = given !== undefined ? given : f.default;
  if (f.type === "check") return raw === true;
  const vals = typeof raw === "string" ? (raw ? [raw] : []) : Array.isArray(raw) ? raw : [];
  const known = vals.filter((v) => f.options?.some((o) => o.value === v));
  return f.type === "select" ? known.slice(0, 1) : known;
}

export function ExportEntriesDialog({
  slug,
  title,
  canReadAll,
  paper,
  settings,
  open,
  onOpenChange,
  preset,
}: {
  slug: string;
  title: string;
  canReadAll: boolean;
  paper: boolean;
  settings?: ExportSettings | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset?: ExportPreset;
}) {
  const s = settings ?? {};
  const showDates = s.dates !== false;
  const datePreset = s.dates ? s.dates.default : undefined;
  const filterDefs = s.filters ?? [];
  const formats = (s.formats?.length ? s.formats : (["pdf", "xlsx", "csv"] as ExportFormat[])).filter((f, i, a) => a.indexOf(f) === i);

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sites, setSites] = useState<string[]>([]);
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState("");
  const [voided, setVoided] = useState(false);
  const [filters, setFilters] = useState<Record<string, FilterValue>>({});
  // Each opening starts from what the page has picked (or form.json's defaults).
  useEffect(() => {
    if (!open) return;
    setFrom(preset?.from ?? presetFrom(datePreset));
    setTo(preset?.to ?? (datePreset === "all" ? "" : nyToday()));
    setSites(s.sites === false ? [] : preset?.sites ?? []);
    setMine(s.mine === false ? false : preset?.mine ?? false);
    setSearch(s.search ? preset?.search ?? "" : "");
    setVoided(s.voided ? preset?.voided ?? false : false);
    setFilters(Object.fromEntries(filterDefs.map((f) => [f.id, startOf(f, preset)])));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Without the form's own layout, only those who read everyone's get everyone's.
  const ownOnly = !paper && !canReadAll;

  const exporter = useFileExport((format, inline) => {
    const q = new URLSearchParams({ format });
    if (showDates && from) q.set("from", from);
    if (showDates && to) q.set("to", to);
    if (sites.length) q.set("site", sites.join(","));
    if (mine || ownOnly) q.set("mine", "1");
    if (search.trim()) q.set("search", search.trim());
    if (voided) q.set("includeVoided", "1");
    const picked = Object.fromEntries(Object.entries(filters).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v)));
    if (Object.keys(picked).length) q.set("filters", JSON.stringify(picked));
    if (inline) q.set("inline", "1");
    return `/api/apps/${encodeURIComponent(slug)}/entries-export?${q}`;
  });
  const { busy } = exporter;
  const setFilter = (id: string, v: FilterValue) => setFilters((cur) => ({ ...cur, [id]: v }));

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={s.title ?? `Export ${title}`}
      footer={
        s.print === false ? undefined : (
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => void exporter.print()} disabled={busy !== null} className="min-h-[44px] md:min-h-0">
              {busy === "print" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />} Print
            </Button>
          </div>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {showDates && (
          <>
            {s.dates && s.dates.label && <p className="-mb-2 text-[13px] font-semibold text-ink">{s.dates.label}</p>}
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
              {PRESET_BUTTONS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => {
                    setFrom(presetFrom(p.key));
                    setTo(p.key === "all" ? "" : nyToday());
                  }}
                  className="min-h-[32px] rounded-pill border border-hairline px-3 text-[12.5px] font-semibold text-ink hover:bg-navsel"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </>
        )}
        {/* Hidden for someone with one site: there's nothing to pick. */}
        {s.sites !== false && <SitePicker codes={sites} onChange={setSites} counts={false} office />}
        {s.search && (
          <label className="flex flex-col gap-1 text-[13px] font-semibold text-ink">
            Containing
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="A name, a word…" maxLength={120} />
          </label>
        )}
        {filterDefs.map((f) =>
          f.type === "check" ? (
            <label key={f.id} className="flex items-center gap-2 text-[13.5px] text-ink">
              <Checkbox checked={filters[f.id] === true} onCheckedChange={(v) => setFilter(f.id, v === true)} /> {f.label}
            </label>
          ) : f.type === "select" ? (
            <label key={f.id} className="flex flex-col gap-1 text-[13px] font-semibold text-ink">
              {f.label}
              <Select
                value={(filters[f.id] as string[] | undefined)?.[0] ?? ""}
                onChange={(e) => setFilter(f.id, e.target.value ? [e.target.value] : [])}
                placeholder="Any"
                options={f.options ?? []}
              />
            </label>
          ) : (
            <div key={f.id} className="flex flex-col gap-1.5">
              <span className="text-[13px] font-semibold text-ink">{f.label}</span>
              <div className="flex flex-wrap gap-1.5">
                {(f.options ?? []).map((o) => {
                  const cur = (filters[f.id] as string[] | undefined) ?? [];
                  const on = cur.includes(o.value);
                  return (
                    <Chip key={o.value} active={on} onClick={() => setFilter(f.id, on ? cur.filter((v) => v !== o.value) : [...cur, o.value])}>
                      {o.label}
                    </Chip>
                  );
                })}
              </div>
            </div>
          )
        )}
        {s.mine !== false &&
          (ownOnly ? (
            <p className="text-[13px] text-muted">This form only lets you export the entries you filed.</p>
          ) : (
            <label className="flex items-center gap-2 text-[13.5px] text-ink">
              <Checkbox checked={mine} onCheckedChange={(v) => setMine(v === true)} /> Only entries I filed
            </label>
          ))}
        {s.voided && (
          <label className="flex items-center gap-2 text-[13.5px] text-ink">
            <Checkbox checked={voided} onCheckedChange={(v) => setVoided(v === true)} /> Include voided entries
          </label>
        )}
        <div className="flex flex-col gap-2">
          {formats.map((format) => {
            const { Icon, label, hint } = FORMATS[format];
            return (
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
            );
          })}
        </div>
        {s.note && <p className="text-[13px] text-ink">{s.note}</p>}
        <p className="text-[12px] text-muted">{formats.includes("pdf") ? "A PDF holds up to 300 entries. " : ""}Exports may contain resident information: keep them private.</p>
      </div>
    </ResponsiveDialog>
  );
}
