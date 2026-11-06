import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, Download, FileSpreadsheet, FileText, Loader2, MessageSquare, Sheet as SheetIcon, SlidersHorizontal, Star, X } from "lucide-react";
import { Page } from "@/components/shell/AppShell";
import { BUILT_FORM_HEADER_WIDTH, BuiltFormHeader } from "./FormHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, SearchInput } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { ToneBadge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { fillApi, useEntries } from "@/lib/builder";
import { formatValue, isInputField, type Field } from "@/lib/formEngine";
import { cn, errorMessage, formatDateTime } from "@/lib/utils";

const PAGE = 50;
/** Keep in step with PDF_MAX_ENTRIES on the server. */
const PDF_MAX = 200;
const SELECT_MAX = 1000;

type Range = "any" | "today" | "7" | "30" | "month" | "custom";
type Status = "active" | "voided" | "all";
type FollowUp = "" | "open" | "done";
type Format = "csv" | "xlsx" | "pdf";
interface Sort { key: string; dir: "asc" | "desc" }
const NEWEST: Sort = { key: "createdAt", dir: "desc" };

const RANGES: { value: Range; label: string }[] = [
  { value: "any", label: "Any time" },
  { value: "today", label: "Today" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "month", label: "This month" },
  { value: "custom", label: "Custom dates…" },
];

const FORMATS: { format: Format; Icon: typeof FileText; label: string; hint: string }[] = [
  { format: "xlsx", Icon: FileSpreadsheet, label: "Excel", hint: "One row per entry, with filters" },
  { format: "csv", Icon: SheetIcon, label: "CSV", hint: "Plain spreadsheet data" },
  { format: "pdf", Icon: FileText, label: "PDF", hint: "Each entry laid out as its form" },
];

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** A preset's From/To (local days; the server reads them as New York days). */
function rangeDates(range: Range, from: string, to: string): { from: string; to: string } {
  const today = new Date();
  const back = (days: number) => iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - days));
  switch (range) {
    case "today": return { from: iso(today), to: "" };
    case "7": return { from: back(6), to: "" };
    case "30": return { from: back(29), to: "" };
    case "month": return { from: iso(new Date(today.getFullYear(), today.getMonth(), 1)), to: "" };
    case "custom": return { from, to };
    default: return { from: "", to: "" };
  }
}

/** A built form's entries: search, filter, sort, tick, export. */
export function BuiltFormEntriesPage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [range, setRange] = useState<Range>("any");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [site, setSite] = useState("");
  const [status, setStatus] = useState<Status>("active");
  const [starred, setStarred] = useState(false);
  const [followUp, setFollowUp] = useState<FollowUp>("");
  const [sort, setSort] = useState<Sort>(NEWEST);
  const [page, setPage] = useState(0);
  // Ticked entries (kept across pages), or every entry the filters match.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [busy, setBusy] = useState<Format | null>(null);

  const { from, to } = rangeDates(range, customFrom, customTo);
  const filterQs = useMemo(() => {
    const p = new URLSearchParams({ status });
    if (q.trim()) p.set("q", q.trim());
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (site) p.set("site", site);
    if (starred) p.set("starred", "1");
    if (followUp) p.set("followUp", followUp);
    if (sort.key !== NEWEST.key || sort.dir !== NEWEST.dir) {
      p.set("sort", sort.key);
      p.set("dir", sort.dir);
    }
    return p.toString();
  }, [q, from, to, site, status, starred, followUp, sort]);
  const qs = `${filterQs}&take=${PAGE}&skip=${page * PAGE}`;
  const { data, isLoading, error } = useEntries(slug, qs);

  // A different set of entries: start the ticks and the page over (a new order keeps the ticks).
  const filterKey = filterQs.replace(/&?(sort|dir)=[^&]*/g, "");
  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
    setPage(0);
  }, [filterKey]);

  const columns: Field[] = useMemo(
    () => (data?.doc.fields ?? []).filter((f) => isInputField(f) && !["signature", "file", "code", "repeater", "likert", "hidden", "consent"].includes(f.type)).slice(0, 4),
    [data?.doc]
  );
  const siteOptions = data?.sites ?? [];
  const hasSites = siteOptions.length > 0 || data?.items.some((e) => e.site);
  // What was filled in when follow-ups were marked done (IT's new account, say): a column each, passwords never.
  const doneColumns = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of data?.items ?? []) for (const v of e.followUp?.values ?? []) if (!v.emailed && !seen.has(v.id)) seen.set(v.id, v.label);
    return [...seen].slice(0, 3).map(([id, label]) => ({ id, label }));
  }, [data?.items]);

  const sortOptions = useMemo(() => {
    const opts = [
      { value: "createdAt:desc", label: "Newest first" },
      { value: "createdAt:asc", label: "Oldest first" },
      ...(hasSites ? [{ value: "site:asc", label: "Site (A–Z)" }] : []),
      { value: "by:asc", label: "Submitted by (A–Z)" },
      ...columns.map((c) => ({ value: `field:${c.id}:asc`, label: `${c.label || c.id} (A–Z)` })),
    ];
    const current = `${sort.key}:${sort.dir}`;
    if (!opts.some((o) => o.value === current)) opts.push({ value: current, label: `${sortLabel(sort.key, columns)} (Z–A)` });
    return opts;
  }, [hasSites, columns, sort]);

  const moreCount = (status !== "active" ? 1 : 0) + (starred ? 1 : 0) + (followUp ? 1 : 0);
  const chips: { key: string; label: string; clear: () => void }[] = [];
  if (range !== "any") chips.push({ key: "range", label: range === "custom" ? `${from || "…"} – ${to || "…"}` : RANGES.find((r) => r.value === range)!.label, clear: () => setRange("any") });
  if (site) chips.push({ key: "site", label: siteOptions.find((s) => s.id === site)?.name ?? "Site", clear: () => setSite("") });
  if (status !== "active") chips.push({ key: "status", label: status === "voided" ? "Voided only" : "Active and voided", clear: () => setStatus("active") });
  if (followUp) chips.push({ key: "followUp", label: followUp === "open" ? "Follow-up open" : "Follow-up done", clear: () => setFollowUp("") });
  if (starred) chips.push({ key: "starred", label: "Starred", clear: () => setStarred(false) });
  const filtered = Boolean(q.trim()) || chips.length > 0;
  function clearAll() {
    setQ("");
    setRange("any");
    setCustomFrom("");
    setCustomTo("");
    setSite("");
    setStatus("active");
    setStarred(false);
    setFollowUp("");
  }

  function sortBy(key: string) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "createdAt" ? "desc" : "asc" }));
    setPage(0);
  }

  const pageIds = data?.items.map((e) => e.id) ?? [];
  const pageTicked = pageIds.filter((id) => allMatching || selected.has(id)).length;
  const total = data?.total ?? 0;
  const chosen = allMatching ? total : selected.size;

  function toggle(id: string, on: boolean) {
    if (allMatching) {
      // Unticking one of "all": fall back to this page's entries less that one.
      setAllMatching(false);
      setSelected(new Set(pageIds.filter((x) => x !== id)));
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) {
        if (next.size >= SELECT_MAX) {
          toast(`Tick up to ${SELECT_MAX.toLocaleString()} entries, or export everything the filters match.`, "error");
          return prev;
        }
        next.add(id);
      } else next.delete(id);
      return next;
    });
  }
  function togglePage(on: boolean) {
    if (allMatching && !on) {
      setAllMatching(false);
      setSelected(new Set());
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of pageIds) on ? next.add(id) : next.delete(id);
      return next;
    });
  }
  function clearSelection() {
    setSelected(new Set());
    setAllMatching(false);
  }

  async function exportAs(format: Format) {
    const count = chosen || total;
    if (format === "pdf" && count > PDF_MAX) {
      toast(`A PDF can hold up to ${PDF_MAX} entries. Tick the ones you need, or narrow the filters.`, "error");
      return;
    }
    setBusy(format);
    try {
      await fillApi.exportFile(slug, filterQs, format, !allMatching && selected.size ? [...selected] : undefined);
    } catch (e) {
      toast(errorMessage(e, "Export failed."), "error");
    } finally {
      setBusy(null);
    }
  }

  const header = <BuiltFormHeader slug={slug} fallback={data ? { title: data.form.title, id: data.form.id, isAdmin: data.isAdmin, canReadEntries: true } : undefined} />;
  if (error) return <>{header}<Page className={BUILT_FORM_HEADER_WIDTH}><Card><EmptyState title={errorMessage(error, "Couldn't load entries.")} /></Card></Page></>;
  if (isLoading || !data) return <>{header}<LoadingState /></>;
  const pages = Math.max(1, Math.ceil(data.total / PAGE));

  const exportMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={chosen ? "primary" : "secondary"} disabled={busy !== null || !total}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {chosen ? `Export ${chosen.toLocaleString()}` : "Export"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[250px]">
        <DropdownMenuLabel>{chosen ? `The ${chosen.toLocaleString()} selected` : filtered ? `All ${total.toLocaleString()} that match` : `All ${total.toLocaleString()} entries`}</DropdownMenuLabel>
        {FORMATS.map(({ format, Icon, label, hint }) => {
          const tooMany = format === "pdf" && (chosen || total) > PDF_MAX;
          return (
            <DropdownMenuItem key={format} onSelect={() => exportAs(format)} disabled={busy !== null} className="min-h-[44px] md:min-h-0">
              <Icon className="h-4 w-4 text-muted" />
              <span className="flex-1">
                <span className="block">{label}</span>
                <span className="block text-micro text-muted">{tooMany ? `Up to ${PDF_MAX} entries — tick the ones you need` : hint}</span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const SortHead = ({ k, children, className }: { k: string; children: React.ReactNode; className?: string }) => {
    const on = sort.key === k;
    return (
      <th className={cn("px-3 py-2.5", className)} aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
        <button type="button" onClick={() => sortBy(k)} className={cn("inline-flex max-w-full items-center gap-1 uppercase tracking-[0.04em] hover:text-ink", on && "text-ink")}>
          <span className="truncate">{children}</span>
          {on && (sort.dir === "asc" ? <ArrowUp className="h-3 w-3 shrink-0" /> : <ArrowDown className="h-3 w-3 shrink-0" />)}
        </button>
      </th>
    );
  };

  return (
    <>
    {header}
    <Page className={BUILT_FORM_HEADER_WIDTH}>
      {/* Search and filters */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput wrapperClassName="min-w-[220px] flex-[2_1_260px]" placeholder="Search answers or who submitted…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="min-w-[140px] flex-1 md:w-[150px] md:flex-none">
          <Select value={range} onChange={(e) => setRange(e.target.value as Range)} aria-label="When" options={RANGES} />
        </div>
        {hasSites && (
          <div className="min-w-[160px] flex-1 md:w-[190px] md:flex-none">
            <Select
              value={site}
              onChange={(e) => setSite(e.target.value)}
              aria-label="Site"
              options={[{ value: "", label: "All sites" }, ...siteOptions.map((s) => ({ value: s.id, label: `${s.name} (${s.count.toLocaleString()})` }))]}
            />
          </div>
        )}
        <div className="min-w-[160px] flex-1 md:w-[190px] md:flex-none">
          <Select
            value={`${sort.key}:${sort.dir}`}
            onChange={(e) => {
              const v = e.target.value;
              const at = v.lastIndexOf(":");
              setSort({ key: v.slice(0, at), dir: v.slice(at + 1) as "asc" | "desc" });
              setPage(0);
            }}
            aria-label="Sort"
            options={sortOptions}
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" aria-label="More filters">
              <SlidersHorizontal className="h-4 w-4" /> Filters
              {moreCount > 0 && <span className="ml-0.5 rounded-pill bg-navy px-1.5 text-micro font-bold text-white">{moreCount}</span>}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[220px]">
            <DropdownMenuLabel>Status</DropdownMenuLabel>
            {([["active", "Active"], ["voided", "Voided"], ["all", "Active and voided"]] as const).map(([v, label]) => (
              <DropdownMenuCheckboxItem key={v} checked={status === v} onCheckedChange={() => setStatus(v)}>
                <Check className={cn("h-4 w-4", status === v ? "text-accent" : "invisible")} /> {label}
              </DropdownMenuCheckboxItem>
            ))}
            {data.followUp && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Follow-up</DropdownMenuLabel>
                {([["", "Any"], ["open", "Open"], ["done", "Done"]] as const).map(([v, label]) => (
                  <DropdownMenuCheckboxItem key={v || "any"} checked={followUp === v} onCheckedChange={() => setFollowUp(v)}>
                    <Check className={cn("h-4 w-4", followUp === v ? "text-accent" : "invisible")} /> {label}
                  </DropdownMenuCheckboxItem>
                ))}
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={starred} onCheckedChange={(on) => setStarred(on === true)}>
              <Check className={cn("h-4 w-4", starred ? "text-accent" : "invisible")} /> Starred only
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {range === "custom" && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-muted">
          <label className="flex items-center gap-1.5">From <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="w-[160px]" /></label>
          <label className="flex items-center gap-1.5">to <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="w-[160px]" /></label>
        </div>
      )}

      {chips.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <span key={c.key} className="inline-flex min-h-[28px] items-center gap-1 rounded-pill border border-hairline bg-subtle pl-2.5 pr-1 text-[12.5px] text-ink">
              {c.label}
              <button type="button" onClick={c.clear} aria-label={`Remove ${c.label}`} className="rounded-pill p-0.5 text-muted hover:bg-rowhover hover:text-ink">
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
          <button type="button" onClick={clearAll} className="px-1.5 text-[12.5px] font-semibold text-accent hover:underline">Clear all</button>
        </div>
      )}

      {/* Count, or what's ticked; and Export */}
      <div className={cn("mb-3 mt-4 flex min-h-[40px] flex-wrap items-center gap-x-3 gap-y-2 rounded-card px-0", chosen > 0 && "border border-navy/30 bg-navsel px-3 py-1.5")}>
        {chosen > 0 ? (
          <p className="min-w-0 flex-1 text-[13.5px] text-ink">
            <span className="font-semibold">{chosen.toLocaleString()} selected</span>
            {!allMatching && selected.size < total && total <= SELECT_MAX * 50 && (
              <button type="button" onClick={() => { setAllMatching(true); setSelected(new Set()); }} className="ml-3 font-semibold text-accent hover:underline">
                Select all {total.toLocaleString()}{filtered ? " that match" : ""}
              </button>
            )}
            <button type="button" onClick={clearSelection} className="ml-3 font-semibold text-accent hover:underline">Clear</button>
          </p>
        ) : (
          <p className="min-w-0 flex-1 text-[13.5px] text-muted">
            {`${total.toLocaleString()} ${status === "voided" ? "voided " : ""}entr${total === 1 ? "y" : "ies"}${filtered ? " match" : ""}${data.reach === "own" ? " · yours, and any you were told about" : data.reach === "site" ? " · your sites' and your own" : ""}`}
          </p>
        )}
        {exportMenu}
      </div>

      {!data.items.length ? (
        <Card><EmptyState title="No entries" hint={filtered || status !== "active" ? "Nothing matches these filters." : "When people fill in the form, their answers show up here."} /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-left text-[13px]">
              <thead className="border-b border-hairline bg-subtle text-micro font-bold uppercase tracking-[0.04em] text-muted">
                <tr>
                  <th className="w-10 px-3 py-2.5">
                    <Checkbox
                      aria-label="Select this page"
                      checked={pageTicked === 0 ? false : pageTicked === pageIds.length ? true : "indeterminate"}
                      onCheckedChange={(on) => togglePage(on === true)}
                    />
                  </th>
                  <SortHead k="createdAt">Submitted</SortHead>
                  <SortHead k="by">By</SortHead>
                  {hasSites && <SortHead k="site">Site</SortHead>}
                  {columns.map((c) => <SortHead key={c.id} k={`field:${c.id}`} className="max-w-[220px]">{c.label || c.id}</SortHead>)}
                  {doneColumns.map((c) => <th key={`done:${c.id}`} className="max-w-[220px] truncate px-3 py-2.5" title="Filled in when the follow-up was marked done">{c.label}</th>)}
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {data.items.map((e) => {
                  const ticked = allMatching || selected.has(e.id);
                  return (
                    <tr key={e.id} onClick={() => navigate(`/f/${slug}/entries/${e.id}`)} className={cn("cursor-pointer border-b border-hairline last:border-0 hover:bg-rowhover", ticked && "bg-navsel/60", e.status === "voided" && "opacity-60")}>
                      <td className="px-3 py-2.5" onClick={(ev) => ev.stopPropagation()}>
                        <Checkbox aria-label="Select entry" checked={ticked} onCheckedChange={(on) => toggle(e.id, on === true)} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-ink">
                        {formatDateTime(e.createdAt)}
                        {e.starred && <Star className="ml-1.5 inline h-3.5 w-3.5 -translate-y-px fill-[#f5a524] text-[#f5a524]" aria-label="Starred" />}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-ink">{e.createdByName}</td>
                      {hasSites && <td className="whitespace-nowrap px-3 py-2.5 text-ink">{e.site?.name ?? "—"}</td>}
                      {columns.map((c) => <td key={c.id} className="max-w-[240px] truncate px-3 py-2.5 text-ink">{formatValue(c, e.values[c.id]) || <span className="text-muted">—</span>}</td>)}
                      {doneColumns.map((c) => {
                        const v = e.followUp?.values?.find((x) => x.id === c.id)?.value;
                        return <td key={`done:${c.id}`} className="max-w-[240px] truncate px-3 py-2.5 text-ink">{v || <span className="text-muted">—</span>}</td>;
                      })}
                      <td className="whitespace-nowrap px-3 py-2.5 text-right text-muted">
                        {e.status === "voided" && <ToneBadge tone="red">Void</ToneBadge>}
                        {e.followUp && <span className="ml-2"><ToneBadge tone={e.followUp.status === "open" ? "amber" : "green"}>{e.followUp.status === "open" ? "Open" : "Done"}</ToneBadge></span>}
                        {(e.noteCount ?? 0) > 0 && <span className="ml-2 inline-flex items-center gap-1 text-micro"><MessageSquare className="h-3.5 w-3.5" />{e.noteCount}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="md:hidden">
            {data.items.map((e) => {
              const ticked = allMatching || selected.has(e.id);
              return (
                <li key={e.id} className={cn("flex items-start border-b border-hairline last:border-0", ticked && "bg-navsel/60")}>
                  <label className="flex min-h-[44px] items-center py-3 pl-4 pr-1">
                    <Checkbox aria-label="Select entry" checked={ticked} onCheckedChange={(on) => toggle(e.id, on === true)} />
                  </label>
                  <Link to={`/f/${slug}/entries/${e.id}`} className={cn("block min-w-0 flex-1 py-3 pl-2 pr-4", e.status === "voided" && "opacity-60")}>
                    <div className="flex items-center gap-2">
                      {e.starred && <Star className="h-3.5 w-3.5 fill-[#f5a524] text-[#f5a524]" />}
                      <span className="flex-1 truncate text-[14px] font-semibold text-ink">{columns[0] ? formatValue(columns[0], e.values[columns[0].id]) || "—" : e.createdByName}</span>
                      {e.status === "voided" && <ToneBadge tone="red">Void</ToneBadge>}
                      {e.followUp && <ToneBadge tone={e.followUp.status === "open" ? "amber" : "green"}>{e.followUp.status === "open" ? "Open" : "Done"}</ToneBadge>}
                    </div>
                    <p className="mt-0.5 text-micro text-muted">{formatDateTime(e.createdAt)} · {e.createdByName}{e.site ? ` · ${e.site.name}` : ""}</p>
                    {doneColumns.some((c) => e.followUp?.values?.some((x) => x.id === c.id && x.value)) && (
                      <p className="mt-0.5 truncate text-micro text-ink">
                        {doneColumns.map((c) => ({ c, v: e.followUp?.values?.find((x) => x.id === c.id)?.value })).filter((x) => x.v).map((x) => `${x.c.label}: ${x.v}`).join(" · ")}
                      </p>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {pages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-3 text-[13px] text-muted">
          <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></Button>
          Page {page + 1} of {pages}
          <Button variant="secondary" size="sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></Button>
        </div>
      )}
    </Page>
    </>
  );
}

function sortLabel(key: string, columns: Field[]) {
  if (key === "createdAt") return "Submitted";
  if (key === "by") return "Submitted by";
  if (key === "site") return "Site";
  const c = columns.find((x) => `field:${x.id}` === key);
  return c ? c.label || c.id : "Column";
}
