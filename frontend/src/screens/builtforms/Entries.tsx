import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Download, ExternalLink, MessageSquare, Star } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Page, PageHeader, DesktopBackLink } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, SearchInput } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { ToneBadge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { fillApi, useEntries } from "@/lib/builder";
import { formatValue, isInputField, type Field } from "@/lib/formEngine";
import { useDeviceKind } from "@/lib/device";
import { cn, errorMessage, formatDateTime } from "@/lib/utils";

const PAGE = 50;

/** A built form's entries: filter, search, star, export. */
export function BuiltFormEntriesPage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  // The builder is desktop only, so no way into it elsewhere.
  const canOpenBuilder = useDeviceKind() === "desktop";
  const toast = useToast();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState("active");
  const [starred, setStarred] = useState(false);
  const [page, setPage] = useState(0);

  const filterQs = useMemo(() => {
    const p = new URLSearchParams({ status });
    if (q.trim()) p.set("q", q.trim());
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (starred) p.set("starred", "1");
    return p.toString();
  }, [q, from, to, status, starred]);
  const qs = `${filterQs}&take=${PAGE}&skip=${page * PAGE}`;
  const { data, isLoading, error } = useEntries(slug, qs);

  const columns: Field[] = useMemo(
    () => (data?.doc.fields ?? []).filter((f) => isInputField(f) && !["signature", "file", "code", "repeater", "likert", "hidden", "consent"].includes(f.type)).slice(0, 4),
    [data?.doc]
  );
  const hasSites = data?.items.some((e) => e.site);

  async function exportAs(format: "csv" | "xlsx") {
    try {
      await fillApi.exportFile(slug, filterQs, format);
    } catch (e) {
      toast(errorMessage(e, "Export failed."), "error");
    }
  }

  async function toggleStar(id: string, on: boolean) {
    await fillApi.star(slug, id, on);
    await qc.invalidateQueries({ queryKey: ["fill", slug] });
  }

  if (error) return <Page><Card><EmptyState title={errorMessage(error, "Couldn't load entries.")} /></Card></Page>;
  if (isLoading || !data) return <LoadingState />;
  const pages = Math.max(1, Math.ceil(data.total / PAGE));

  return (
    <Page>
      <DesktopBackLink to={`/f/${slug}`}>{data.form.title}</DesktopBackLink>
      <PageHeader
        title={`${data.form.title}: entries`}
        subtitle={`${data.total.toLocaleString()} ${status === "voided" ? "voided " : ""}entr${data.total === 1 ? "y" : "ies"}${q || from || to || starred ? " match" : ""}`}
        actions={
          <>
            <Link to={`/f/${slug}`}><Button variant="secondary"><ExternalLink className="h-4 w-4" /> Open form</Button></Link>
            {data.isAdmin && canOpenBuilder && <Link to={`/admin/builder/${data.form.id}`}><Button variant="secondary">Edit form</Button></Link>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button><Download className="h-4 w-4" /> Export</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => exportAs("xlsx")}>Excel (.xlsx)</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => exportAs("csv")}>CSV</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <SearchInput wrapperClassName="min-w-[220px] flex-1" placeholder="Search answers or who submitted…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
        <label className="text-micro font-semibold text-muted">From<Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} className="mt-0.5 w-[150px]" /></label>
        <label className="text-micro font-semibold text-muted">To<Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} className="mt-0.5 w-[150px]" /></label>
        <div className="w-[130px]">
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }} options={[{ value: "active", label: "Active" }, { value: "voided", label: "Voided" }, { value: "all", label: "All" }]} />
        </div>
        <Button variant={starred ? "primary" : "secondary"} onClick={() => { setStarred(!starred); setPage(0); }} aria-pressed={starred}>
          <Star className={cn("h-4 w-4", starred && "fill-current")} /> Starred
        </Button>
      </div>

      {!data.items.length ? (
        <Card><EmptyState title="No entries" hint={q || from || to || starred || status !== "active" ? "Nothing matches these filters." : "When people fill in the form, their answers show up here."} /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-left text-[13px]">
              <thead className="border-b border-hairline bg-subtle text-micro font-bold uppercase tracking-[0.04em] text-muted">
                <tr>
                  <th className="w-9 px-3 py-2.5" />
                  <th className="px-3 py-2.5">Submitted</th>
                  <th className="px-3 py-2.5">By</th>
                  {hasSites && <th className="px-3 py-2.5">Site</th>}
                  {columns.map((c) => <th key={c.id} className="max-w-[220px] truncate px-3 py-2.5">{c.label || c.id}</th>)}
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {data.items.map((e) => (
                  <tr key={e.id} onClick={() => navigate(`/f/${slug}/entries/${e.id}`)} className={cn("cursor-pointer border-b border-hairline last:border-0 hover:bg-rowhover", e.status === "voided" && "opacity-60")}>
                    <td className="px-3 py-2.5" onClick={(ev) => ev.stopPropagation()}>
                      <button onClick={() => toggleStar(e.id, !e.starred)} aria-label={e.starred ? "Unstar" : "Star"} className="rounded p-0.5">
                        <Star className={cn("h-4 w-4", e.starred ? "fill-[#f5a524] text-[#f5a524]" : "text-strongline")} />
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-ink">{formatDateTime(e.createdAt)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-ink">{e.createdByName}</td>
                    {hasSites && <td className="whitespace-nowrap px-3 py-2.5 text-ink">{e.site?.name ?? "—"}</td>}
                    {columns.map((c) => <td key={c.id} className="max-w-[240px] truncate px-3 py-2.5 text-ink">{formatValue(c, e.values[c.id]) || <span className="text-muted">—</span>}</td>)}
                    <td className="whitespace-nowrap px-3 py-2.5 text-right text-muted">
                      {e.status === "voided" && <ToneBadge tone="red">Void</ToneBadge>}
                      {(e.noteCount ?? 0) > 0 && <span className="ml-2 inline-flex items-center gap-1 text-micro"><MessageSquare className="h-3.5 w-3.5" />{e.noteCount}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="md:hidden">
            {data.items.map((e) => (
              <li key={e.id} className="border-b border-hairline last:border-0">
                <Link to={`/f/${slug}/entries/${e.id}`} className={cn("block px-4 py-3", e.status === "voided" && "opacity-60")}>
                  <div className="flex items-center gap-2">
                    {e.starred && <Star className="h-3.5 w-3.5 fill-[#f5a524] text-[#f5a524]" />}
                    <span className="flex-1 text-[14px] font-semibold text-ink">{columns[0] ? formatValue(columns[0], e.values[columns[0].id]) || "—" : e.createdByName}</span>
                    {e.status === "voided" && <ToneBadge tone="red">Void</ToneBadge>}
                  </div>
                  <p className="mt-0.5 text-micro text-muted">{formatDateTime(e.createdAt)} · {e.createdByName}{e.site ? ` · ${e.site.name}` : ""}</p>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {pages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-3 text-[13px] text-muted">
          <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft className="h-4 w-4" /></Button>
          Page {page + 1} of {pages}
          <Button variant="secondary" size="sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}><ChevronRight className="h-4 w-4" /></Button>
        </div>
      )}
    </Page>
  );
}

