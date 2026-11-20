import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ClipboardList, Plus } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, SearchInput, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { useToast } from "@/components/ui/toast";
import { MoveInDialog } from "@/components/residency/Dialogs";
import { SitePicker, useSiteSelection } from "@/lib/site";
import { useAuth } from "@/lib/auth";
import { fmtDay, todayLocal, useResidencyFor, useResidencyRefresh } from "@/lib/residency";
import {
  applicantsApi, useApplicantReport, useApplicants, useApplicantsMeta,
  type Applicant, type ApplicantDetails, type ApplicantReport, type ApplicantsMeta, type ApplicantStatus,
} from "@/lib/applicants";
import { useSearchParam } from "@/lib/useSearchParam";
import { cn, errorMessage } from "@/lib/utils";
import type { Site, Tenant } from "@/lib/types";

/**
 * Applicants (case management): people referred for a unit at a supportive
 * site, by stage — a board on a wide screen, a list on a phone or iPad — from the referral
 * to Accepted, when they go on the roster as not moved in yet and Move in takes
 * over. Closed ones (ineligible, rejected, declined, withdrawn, moved in) are
 * under Closed. Roster managers add and move them; people with client
 * information see them. A small report sits underneath.
 */

const OPEN_COLUMNS = ["referred", "eligibility_review", "eligible", "viewing_scheduled", "accepted"] as const;
const STATUSES: [ApplicantStatus, string][] = [
  ["open", "Open"],
  ["closed", "Closed"],
  ["all", "Everyone"],
];
const big = "min-h-[44px]";
const footBtn = "min-h-[48px] flex-1 md:h-9 md:min-h-0 md:flex-none";
type SiteChoice = Pick<Site, "id" | "code" | "name"> & { households?: boolean };

/** Accepted and waiting reads as "Waiting to move in" on its card and list heading. */
const columnLabel = (meta: ApplicantsMeta | undefined, key: string) =>
  key === "accepted" ? "Accepted, waiting to move in" : meta?.stages.find((s) => s.key === key)?.label ?? key;

/** MoveInDialog reads only a resident's id and name. */
const asResident = (r: { id: string; displayName: string }) => ({ id: r.id, displayName: r.displayName }) as Tenant;

export function ApplicantsPage() {
  const { can } = useAuth();
  const { codes, setCodes, selected, param } = useSiteSelection();
  const residencyFor = useResidencyFor();
  const sites = selected.filter((s) => residencyFor(s));
  const allowed = can("roster.edit") || can("clients.view");
  const on = sites.length > 0 && allowed;
  const [statusParam, setStatus] = useSearchParam("status");
  const status: ApplicantStatus = statusParam === "closed" || statusParam === "all" ? statusParam : "open";
  const [stageParam, setStage] = useSearchParam("stage");
  const [programParam, setProgram] = useSearchParam("program");
  const [q, setQ] = useState("");
  const { data, isLoading } = useApplicants(param, status, on);
  const { data: meta } = useApplicantsMeta(on);
  const { data: report } = useApplicantReport(param, on);
  const manage = data?.can.manage ?? can("roster.edit");
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [movingIn, setMovingIn] = useState<{ siteId: string; resident: Tenant } | null>(null);

  const items = useMemo(() => {
    const query = q.trim().toLowerCase();
    return (data?.items ?? []).filter(
      (a) =>
        (!stageParam || a.stage === stageParam) &&
        (!programParam || a.program === programParam) &&
        (!query || [a.displayName, a.firstName, a.lastName, a.referralAgency, a.phone].some((v) => v?.toLowerCase().includes(query)))
    );
  }, [data, stageParam, programParam, q]);
  const programs = (meta?.programs ?? []).filter((p) => sites.some((s) => s.code === p.site));
  const multiSite = sites.length > 1;
  const showing = items.find((a) => a.id === openId) ?? (data?.items ?? []).find((a) => a.id === openId) ?? null;
  const siteOf = (id: string) => sites.find((s) => s.id === id) ?? selected.find((s) => s.id === id);

  return (
    <Page className="max-w-[1280px]">
      <PageHeader
        title="Applicants"
        subtitle="People referred for a unit, from the referral to moving in."
        actions={
          <>
            <SitePicker codes={codes} onChange={setCodes} className="w-full md:w-[260px]" />
            {on && manage && (
              <Button onClick={() => setAdding(true)} className="min-h-[44px] md:min-h-0">
                <Plus className="h-4 w-4" /> Add applicant
              </Button>
            )}
          </>
        }
      />
      {!on ? (
        <EmptyState
          title="No applicants here"
          hint={allowed ? "Applicants are for supportive sites while case management is on. Pick a supportive site." : "Applicants are for people who manage the roster or see client information."}
          icon={<ClipboardList className="h-8 w-8" />}
        />
      ) : (
        <>
          {report && <Tiles r={report} />}
          {/* A phone stacks the filters, full width; wider screens put them on one line. */}
          <div className="mb-3 grid gap-2 md:flex md:flex-wrap md:items-center">
            <div className="grid grid-cols-3 rounded-input bg-navsel/60 p-0.5" role="tablist">
              {STATUSES.map(([k, label]) => (
                <button
                  key={k}
                  role="tab"
                  aria-selected={status === k}
                  onClick={() => setStatus(k === "open" ? null : k)}
                  className={cn("min-h-[36px] rounded-[5px] px-3 text-[12.5px] font-bold", status === k ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink")}
                >
                  {label}
                </button>
              ))}
            </div>
            <Select
              value={stageParam ?? ""}
              onChange={(e) => setStage(e.target.value || null)}
              placeholder="Every stage"
              aria-label="Stage"
              className="min-h-[40px] md:w-[190px]"
              options={(meta?.stages ?? []).map((s) => ({ value: s.key, label: s.label }))}
            />
            {programs.length > 0 && (
              <Select
                value={programParam ?? ""}
                onChange={(e) => setProgram(e.target.value || null)}
                placeholder="Every program"
                aria-label="Program"
                className="min-h-[40px] md:w-[260px]"
                options={programs.map((p) => ({ value: p.value, label: p.value }))}
              />
            )}
            <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or who referred them" wrapperClassName="min-w-0 md:min-w-[200px] md:flex-1" />
          </div>

          {isLoading || !data ? (
            <LoadingState />
          ) : items.length === 0 ? (
            <EmptyState
              title={q || stageParam || programParam ? "Nobody matches" : status === "closed" ? "Nobody closed yet" : "No open applicants"}
              hint={!q && !stageParam && status === "open" && manage ? "Add someone when a referral comes in." : undefined}
            />
          ) : (
            <>
              {data.truncated && <p className="mb-2 text-micro text-status-amberText">Showing the first 1,000. Pick a site or a stage to see the rest.</p>}
              {status === "open" && !stageParam && (
                <Board items={items} meta={meta} multiSite={multiSite} onOpen={setOpenId} className="hidden xl:grid" />
              )}
              <Grouped items={items} meta={meta} multiSite={multiSite} onOpen={setOpenId} className={status === "open" && !stageParam ? "xl:hidden" : undefined} />
            </>
          )}

          {report && <ReportTable r={report} />}
        </>
      )}

      {adding && <DetailsDialog sites={sites} meta={meta} onClose={() => setAdding(false)} onSaved={(a) => setOpenId(a.id)} />}
      {showing && (
        <ApplicantDialog
          a={showing}
          meta={meta}
          sites={sites}
          manage={manage}
          onClose={() => setOpenId(null)}
          onMoveIn={(resident) => {
            setOpenId(null);
            setMovingIn({ siteId: showing.siteId, resident });
          }}
        />
      )}
      {movingIn && siteOf(movingIn.siteId) && (
        <MoveInDialog open onOpenChange={(o) => !o && setMovingIn(null)} site={siteOf(movingIn.siteId)!} tenant={movingIn.resident} />
      )}
    </Page>
  );
}

// ── Board and list ───────────────────────────────────────────────────────

/** Longest at their stage first: they're the ones to chase. */
const byWait = (a: Applicant, b: Applicant) => b.daysInStage - a.daysInStage || a.displayName.localeCompare(b.displayName);

function Board({ items, meta, multiSite, onOpen, className }: { items: Applicant[]; meta?: ApplicantsMeta; multiSite: boolean; onOpen: (id: string) => void; className?: string }) {
  return (
    <div className={cn("mb-4 grid-cols-5 gap-3", className)}>
      {OPEN_COLUMNS.map((key) => {
        const list = items.filter((a) => a.stage === key).sort(byWait);
        return (
          <div key={key} className="min-w-0 overflow-hidden rounded-card bg-subtle p-2">
            <p className="mb-2 flex items-center justify-between gap-2 px-1 text-[12px] font-bold uppercase tracking-[0.04em] text-muted">
              <span className="truncate" title={columnLabel(meta, key)}>{meta?.stages.find((s) => s.key === key)?.label ?? key}</span>
              <span className="tabular">{list.length}</span>
            </p>
            <div className="grid min-w-0 gap-2">
              {list.map((a) => (
                <button key={a.id} type="button" onClick={() => onOpen(a.id)} className="min-w-0 rounded-input border border-hairline bg-surface p-2.5 text-left hover:border-strongline hover:bg-rowhover">
                  <span className="block truncate text-[13.5px] font-semibold text-ink">{a.displayName}</span>
                  <CardLines a={a} multiSite={multiSite} />
                </button>
              ))}
              {!list.length && <p className="px-1 py-2 text-micro text-muted">Nobody</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** What a card or row says under the name. */
function CardLines({ a, multiSite }: { a: Applicant; multiSite: boolean }) {
  const stale = a.open && a.daysInStage > 30;
  return (
    <>
      {(multiSite || a.program) && <span className="block truncate text-micro text-muted">{[multiSite ? a.siteName : null, a.program].filter(Boolean).join(" · ")}</span>}
      <span className="block truncate text-micro text-muted">
        {a.referralDate ? `Referred ${fmtDay(a.referralDate)}` : "Referred"}
        {a.referralSource ? ` · ${a.referralSource}` : ""}
      </span>
      {a.stage === "viewing_scheduled" && a.viewingDate && <span className="block text-micro font-semibold text-ink">Viewing {fmtDay(a.viewingDate)}</span>}
      {!a.open && (
        <span className="block truncate text-micro text-muted">
          {a.outcome}
          {a.outcomeReason ? `: ${a.outcomeReason}` : ""} · {fmtDay(a.outcome === "Moved in" ? a.resident?.moveInDate : a.stageDate)}
        </span>
      )}
      {a.open && (
        <span className={cn("block text-micro", stale ? "font-semibold text-status-amberText" : "text-muted")}>
          {a.daysInStage === 0 ? "Today" : `${a.daysInStage} ${a.daysInStage === 1 ? "day" : "days"}`} at this stage
        </span>
      )}
    </>
  );
}

/** Phones, and closed ones: a list headed by stage (or outcome), with counts. */
function Grouped({ items, meta, multiSite, onOpen, className }: { items: Applicant[]; meta?: ApplicantsMeta; multiSite: boolean; onOpen: (id: string) => void; className?: string }) {
  const groups = useMemo(() => {
    const keyOf = (a: Applicant) => (a.open ? a.stage : a.stage === "accepted" ? `accepted:${a.outcome}` : a.stage);
    const order = (meta?.stages ?? []).map((s) => s.key);
    const m = new Map<string, Applicant[]>();
    for (const a of items) m.set(keyOf(a), [...(m.get(keyOf(a)) ?? []), a]);
    return [...m.entries()]
      .map(([key, list]) => ({
        key,
        label: key.startsWith("accepted:") ? key.slice("accepted:".length) : columnLabel(meta, key),
        list: list.sort(list[0].open ? byWait : (x, y) => y.stageDate.localeCompare(x.stageDate)),
      }))
      .sort((x, y) => order.indexOf(x.key.split(":")[0]) - order.indexOf(y.key.split(":")[0]) || x.label.localeCompare(y.label));
  }, [items, meta]);
  return (
    <Card className={cn("mb-4 overflow-hidden", className)}>
      <ul>
        {groups.map((g) => (
          <li key={g.key}>
            <p className="flex items-center justify-between border-b border-hairline bg-subtle px-4 py-2 text-[12px] font-bold uppercase tracking-[0.04em] text-muted">
              <span>{g.label}</span>
              <span className="tabular">{g.list.length}</span>
            </p>
            <ul className="divide-y divide-hairline">
              {g.list.map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => onOpen(a.id)} className="flex min-h-[52px] w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-rowhover">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-semibold text-ink">{a.displayName}</span>
                      <CardLines a={a} multiSite={multiSite} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ── Report ───────────────────────────────────────────────────────────────

function Tiles({ r }: { r: ApplicantReport }) {
  const waiting = r.bySite.reduce((n, s) => n + Number(s.waiting ?? 0), 0);
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
      <Tile label="Open applicants" value={r.open} />
      <Tile label="Waiting to move in" value={waiting} />
      <Tile
        className="col-span-2 md:col-span-1"
        label="Referral to move-in"
        value={r.referralToMoveIn.medianDays === null ? "—" : `${r.referralToMoveIn.medianDays} days`}
        hint={r.referralToMoveIn.count ? `Median, ${r.referralToMoveIn.count} moved in this past year` : "Nobody moved in from here this past year"}
      />
    </div>
  );
}

function Tile({ label, value, hint, className }: { label: string; value: React.ReactNode; hint?: string; className?: string }) {
  return (
    <Card className={cn("min-w-0 p-3", className)}>
      <p className="text-micro font-semibold text-muted">{label}</p>
      <p className="mt-0.5 font-heading text-[20px] font-extrabold tabular text-ink">{value}</p>
      {hint && <p className="text-micro text-muted">{hint}</p>}
    </Card>
  );
}

function ReportTable({ r }: { r: ApplicantReport }) {
  if (!r.bySite.length) return null;
  const head = ["Site", ...r.columns.map((c) => c.label), "Open", "Days to move in"];
  return (
    <Card className="p-4">
      <p className="kicker mb-1">Open applicants by site</p>
      <p className="mb-2 text-micro text-muted">Days to move in: the median from referral to moving in, for people who moved in from {fmtDay(r.from)} to {fmtDay(r.to)}.</p>
      {/* No width of its own (w-0), so the table scrolls here on a phone instead of widening the page. */}
      <div className="mt-2 w-0 min-w-full overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-hairline text-micro uppercase tracking-[0.04em] text-muted">
              {head.map((h, i) => <th key={h} className={`py-1.5 pr-3 font-bold ${i > 0 ? "text-right" : ""}`}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {r.bySite.map((s) => (
              <tr key={s.siteId} className="border-b border-hairline last:border-0">
                <td className="py-1.5 pr-3 text-ink">{s.siteName}</td>
                {r.columns.map((c) => <td key={c.key} className="py-1.5 pr-3 text-right tabular">{s[c.key] ?? 0}</td>)}
                <td className="py-1.5 pr-3 text-right font-semibold tabular">{s.open}</td>
                <td className="py-1.5 pr-3 text-right tabular">{s.medianDays === null ? "—" : `${s.medianDays}${s.movedIn ? ` (${s.movedIn})` : ""}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── One applicant ────────────────────────────────────────────────────────

type Mode = null | "edit" | "move" | "close" | "accept";

function ApplicantDialog({
  a, meta, sites, manage, onClose, onMoveIn,
}: {
  a: Applicant;
  meta?: ApplicantsMeta;
  sites: SiteChoice[];
  manage: boolean;
  onClose: () => void;
  onMoveIn: (resident: Tenant) => void;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const accepted = a.stage === "accepted";
  const closed = !a.open && !accepted;
  const canAccept = (meta?.acceptFrom ?? []).includes(a.stage);
  const waiting = accepted && a.resident?.status === "active" && !a.resident.movedIn;

  if (mode === "edit") return <DetailsDialog a={a} sites={sites} meta={meta} onClose={() => setMode(null)} />;
  if (mode === "move" || mode === "close") return <StageDialog a={a} meta={meta} closing={mode === "close"} onClose={() => setMode(null)} />;
  if (mode === "accept") return <AcceptDialog a={a} onClose={() => setMode(null)} onMoveIn={onMoveIn} />;

  const rows: [string, React.ReactNode][] = [
    ["Site", a.siteName],
    ["Program", a.program],
    ["Date of birth", a.dateOfBirth ? `${fmtDay(a.dateOfBirth)}${a.age !== null ? ` (${a.age})` : ""}` : null],
    ["Phone", a.phone],
    ["Email", a.email],
    ["Referral", [a.referralSource, a.referralAgency, a.referralDate ? fmtDay(a.referralDate) : null].filter(Boolean).join(" · ") || null],
    ["Eligibility notes", a.eligibilityNotes],
  ];
  return (
    <ResponsiveDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={a.displayName}
      footer={
        manage ? (
          // Up to four buttons: two by two on a phone.
          <div className="grid w-full grid-cols-2 gap-2 md:flex md:w-auto md:justify-end">
            {!accepted && <Button variant="secondary" onClick={() => setMode("edit")} className={footBtn}>Edit</Button>}
            {a.open && !accepted && <Button variant="outlineDanger" onClick={() => setMode("close")} className={footBtn}>Close…</Button>}
            {!accepted && <Button variant="secondary" onClick={() => setMode("move")} className={footBtn}>{closed ? "Reopen…" : "Move to…"}</Button>}
            {a.open && !accepted && (
              <Button onClick={() => setMode("accept")} disabled={!canAccept} title={canAccept ? undefined : "Mark them eligible first"} className={footBtn}>Accept</Button>
            )}
            {waiting && a.resident && <Button onClick={() => onMoveIn(asResident(a.resident!))} className={cn(footBtn, "col-span-2")}>Move in</Button>}
          </div>
        ) : undefined
      }
    >
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className={cn("rounded-pill px-2 py-0.5 text-micro font-bold", a.open ? "bg-navsel text-accent dark:text-white" : accepted ? "bg-status-greenBg text-status-greenText" : "bg-status-redBg text-status-redText")}>
            {a.open ? (accepted ? "Accepted, waiting to move in" : a.stageLabel) : a.outcome}
          </span>
          <span className="text-muted">
            since {fmtDay(accepted && a.resident?.movedIn ? a.resident.moveInDate : a.stageDate)}
            {a.outcomeReason ? ` · ${a.outcomeReason}` : ""}
            {a.stage === "viewing_scheduled" && a.viewingDate ? ` · viewing ${fmtDay(a.viewingDate)}` : ""}
          </span>
        </div>
        {a.resident && (
          <p className="text-[13px]">
            On the roster as <Link to={`/tenants/${a.resident.id}`} className="font-semibold text-accent hover:underline">{a.resident.displayName}</Link>
            {a.resident.status !== "active" ? " (removed)" : a.resident.movedIn ? `, moved in ${fmtDay(a.resident.moveInDate)}` : ", not moved in yet"}.
          </p>
        )}
        {!manage && a.open && !accepted && <p className="text-micro text-muted">Only people who manage the roster move applicants along.</p>}
        <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className={cn("min-w-0 break-words", v ? "text-ink" : "text-muted")}>{v || "—"}</dd>
            </div>
          ))}
        </dl>
        <div>
          <p className="kicker mb-1.5">History</p>
          <ol className="grid gap-2 border-l border-hairline pl-3">
            {a.history.map((h) => (
              <li key={h.id} className="text-[13px]">
                <span className="font-semibold text-ink">{h.label}</span>
                <span className="text-muted"> · {fmtDay(h.date)} · {h.byName}</span>
                {(h.viewingDate || h.reason || h.note) && (
                  <span className="block text-micro text-muted">{[h.viewingDate ? `Viewing ${fmtDay(h.viewingDate)}` : null, h.reason, h.note].filter(Boolean).join(" · ")}</span>
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </ResponsiveDialog>
  );
}

/** At the end of a long form: brought into view, or a phone would never show it. */
function ErrorLine({ error }: { error: string | null }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [error]);
  return error ? <p ref={ref} role="alert" className="rounded-input bg-status-redBg px-3 py-2 text-[13px] text-status-redText">{error}</p> : null;
}

/** Add an applicant, or change one's details. */
function DetailsDialog({ a, sites, meta, onClose, onSaved }: { a?: Applicant; sites: SiteChoice[]; meta?: ApplicantsMeta; onClose: () => void; onSaved?: (a: Applicant) => void }) {
  const toast = useToast();
  const refresh = useResidencyRefresh();
  const startSite = a ? sites.find((s) => s.id === a.siteId)?.code ?? "" : sites.length === 1 ? sites[0].code : "";
  const [site, setSite] = useState(startSite);
  const [f, setF] = useState<ApplicantDetails>(() => ({
    firstName: a?.firstName ?? "",
    middleName: a?.middleName ?? "",
    lastName: a?.lastName ?? "",
    preferredName: a?.preferredName ?? "",
    dateOfBirth: a?.dateOfBirth ?? "",
    phone: a?.phone ?? "",
    email: a?.email ?? "",
    program: a?.program ?? "",
    referralSource: a?.referralSource ?? "",
    referralAgency: a?.referralAgency ?? "",
    referralDate: a?.referralDate ?? (a ? "" : todayLocal()),
    eligibilityNotes: a?.eligibilityNotes ?? "",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof ApplicantDetails) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const programs = (meta?.programs ?? []).filter((p) => p.site === site);
  // A program belongs to a building: changing the site drops one that isn't the new site's.
  useEffect(() => {
    if (f.program && !programs.some((p) => p.value === f.program)) setF((x) => ({ ...x, program: "" }));
  }, [site]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (!site) return setError("Pick a site.");
    if (!f.firstName.trim()) return setError("First name is required.");
    setBusy(true);
    setError(null);
    // Blanks clear a field.
    const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === "string" && !v.trim() ? (k === "lastName" ? "" : null) : v])) as unknown as ApplicantDetails;
    try {
      const saved = a ? await applicantsApi.update(a.id, { ...body, version: a.version, site }) : await applicantsApi.add({ ...body, site });
      await refresh();
      toast(a ? "Saved." : `Added ${saved.displayName}.`);
      onClose();
      onSaved?.(saved);
    } catch (e) {
      setError(errorMessage(e, "Could not save."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ResponsiveDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={a ? `Edit ${a.displayName}` : "Add an applicant"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} className={footBtn}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy} className={footBtn}>{busy ? "Saving…" : a ? "Save" : "Add"}</Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Site *" className="col-span-2">
          <Select value={site} onChange={(e) => setSite(e.target.value)} placeholder="Pick a site" className={big} options={sites.map((s) => ({ value: s.code, label: s.name }))} />
        </Field>
        <Field label="First name *"><Input value={f.firstName} onChange={set("firstName")} maxLength={80} className={big} autoFocus={!a} /></Field>
        <Field label="Last name"><Input value={f.lastName ?? ""} onChange={set("lastName")} maxLength={80} className={big} /></Field>
        <Field label="Middle name"><Input value={f.middleName ?? ""} onChange={set("middleName")} maxLength={80} className={big} /></Field>
        <Field label="Goes by"><Input value={f.preferredName ?? ""} onChange={set("preferredName")} maxLength={80} className={big} /></Field>
        <Field label="Date of birth"><Input type="date" value={f.dateOfBirth ?? ""} max={todayLocal()} onChange={set("dateOfBirth")} className={big} /></Field>
        <Field label="Phone"><Input type="tel" value={f.phone ?? ""} onChange={set("phone")} maxLength={40} className={big} /></Field>
        <Field label="Email" className="col-span-2"><Input type="email" value={f.email ?? ""} onChange={set("email")} maxLength={200} className={big} /></Field>
        {programs.length > 0 && (
          <Field label="Program" className="col-span-2">
            <Select value={f.program ?? ""} onChange={set("program")} placeholder="—" className={big} options={programs.map((p) => ({ value: p.value, label: p.value }))} />
          </Field>
        )}
        <Field label="Referral source">
          <Select value={f.referralSource ?? ""} onChange={set("referralSource")} placeholder="—" className={big} options={(meta?.referralSources ?? []).map((s) => ({ value: s, label: s }))} />
        </Field>
        <Field label="Referral date"><Input type="date" value={f.referralDate ?? ""} max={todayLocal()} onChange={set("referralDate")} className={big} /></Field>
        <Field label="Referred by" hint="The agency, worker or contact." className="col-span-2">
          <Input value={f.referralAgency ?? ""} onChange={set("referralAgency")} maxLength={255} className={big} />
        </Field>
        <Field label="Eligibility notes" className="col-span-2">
          <Textarea value={f.eligibilityNotes ?? ""} onChange={set("eligibilityNotes")} maxLength={4000} rows={3} />
        </Field>
        <div className="col-span-2"><ErrorLine error={error} /></div>
      </div>
    </ResponsiveDialog>
  );
}

function StageChips({ options, value, onChange, label }: { options: { key: string; label: string; hint?: string }[]; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={value === o.key}
          title={o.hint}
          onClick={() => onChange(o.key)}
          className={cn(
            "min-h-[40px] rounded-pill border px-3.5 text-left text-[13px] font-semibold transition-colors",
            value === o.key ? "border-navy bg-navsel text-accent dark:text-white" : "border-hairline text-ink hover:bg-rowhover"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Move along (or back), reopen, or close with a reason. */
function StageDialog({ a, meta, closing, onClose }: { a: Applicant; meta?: ApplicantsMeta; closing: boolean; onClose: () => void }) {
  const toast = useToast();
  const refresh = useResidencyRefresh();
  const options = (meta?.stages ?? []).filter((s) => (closing ? s.group === "closed" : s.group === "open" && (s.key !== a.stage || s.key === "viewing_scheduled")));
  const [stage, setStage] = useState("");
  const [date, setDate] = useState(todayLocal());
  const [viewingDate, setViewingDate] = useState(a.viewingDate ?? "");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasons = closing && stage ? meta?.closeReasons[stage] ?? [] : [];
  const hint = meta?.stages.find((s) => s.key === stage)?.hint;

  async function save() {
    if (!stage) return setError(closing ? "Pick how it ended." : "Pick a stage.");
    if (stage === "viewing_scheduled" && !viewingDate) return setError("Pick the day they're seeing the unit.");
    if (closing && !reason) return setError("Pick why.");
    if (reason === "Other" && !note.trim()) return setError("Say why in the note.");
    setBusy(true);
    setError(null);
    try {
      const saved = await applicantsApi.move(a.id, { version: a.version, stage, date, viewingDate: stage === "viewing_scheduled" ? viewingDate : null, reason: closing ? reason : null, note: note.trim() || null });
      await refresh();
      toast(`${saved.displayName}: ${saved.open ? saved.stageLabel : saved.outcome}.`);
      onClose();
    } catch (e) {
      setError(errorMessage(e, "Could not save."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ResponsiveDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={closing ? `Close: ${a.displayName}` : `${a.open ? "Move" : "Reopen"}: ${a.displayName}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} className={footBtn}>Cancel</Button>
          <Button variant={closing ? "danger" : "primary"} onClick={() => void save()} disabled={busy} className={footBtn}>{busy ? "Saving…" : closing ? "Close application" : "Save"}</Button>
        </>
      }
    >
      <div className="grid gap-3">
        <p className="text-[13px] text-muted">Now: {a.open ? a.stageLabel : a.outcome}, since {fmtDay(a.stageDate)}.</p>
        <StageChips options={options} value={stage} onChange={(v) => { setStage(v); setReason(""); }} label={closing ? "How it ended" : "Stage"} />
        {hint && <p className="text-micro text-muted">{hint}</p>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="On" className="col-span-2 sm:col-span-1">
            <Input type="date" value={date} max={todayLocal()} onChange={(e) => setDate(e.target.value)} className={big} />
          </Field>
          {stage === "viewing_scheduled" && (
            <Field label="Viewing on *" className="col-span-2 sm:col-span-1">
              <Input type="date" value={viewingDate} onChange={(e) => setViewingDate(e.target.value)} className={big} />
            </Field>
          )}
          {closing && stage && (
            <Field label="Why *" className="col-span-2 sm:col-span-1">
              <Select value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Pick a reason" className={big} options={reasons.map((r) => ({ value: r, label: r }))} />
            </Field>
          )}
        </div>
        <Field label={reason === "Other" ? "Note *" : "Note"}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={2} />
        </Field>
        <ErrorLine error={error} />
      </div>
    </ResponsiveDialog>
  );
}

/** Accept: onto the roster, not moved in yet; then offer Move in. */
function AcceptDialog({ a, onClose, onMoveIn }: { a: Applicant; onClose: () => void; onMoveIn: (resident: Tenant) => void }) {
  const toast = useToast();
  const refresh = useResidencyRefresh();
  const [date, setDate] = useState(todayLocal());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resident, setResident] = useState<Tenant | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await applicantsApi.accept(a.id, { version: a.version, date, note: note.trim() || null });
      await refresh();
      toast(`${a.displayName} is on the roster.`);
      setResident(r.resident);
    } catch (e) {
      setError(errorMessage(e, "Could not accept them."));
    } finally {
      setBusy(false);
    }
  }
  if (resident) {
    return (
      <ResponsiveDialog
        open
        onOpenChange={(o) => !o && onClose()}
        title="Accepted"
        footer={
          <>
            <Button variant="secondary" onClick={onClose} className={footBtn}>Not yet</Button>
            <Button onClick={() => onMoveIn(resident)} className={footBtn}>Move in now</Button>
          </>
        }
      >
        <p className="text-[13.5px] text-ink">
          {a.displayName} is on {a.siteName}'s roster, not moved in yet. Move them into a unit now, or later from the roster or this page.
        </p>
      </ResponsiveDialog>
    );
  }
  return (
    <ResponsiveDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Accept ${a.displayName}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} className={footBtn}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy} className={footBtn}>{busy ? "Accepting…" : "Accept"}</Button>
        </>
      }
    >
      <div className="grid gap-3">
        <p className="text-[13.5px] text-ink">
          They go on {a.siteName}'s roster as not moved in yet. Their date of birth, phone, email, program and referral are copied into their client information.
        </p>
        <Field label="Accepted on">
          <Input type="date" value={date} max={todayLocal()} onChange={(e) => setDate(e.target.value)} className={big} />
        </Field>
        <Field label="Note">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={2} />
        </Field>
        <ErrorLine error={error} />
      </div>
    </ResponsiveDialog>
  );
}
