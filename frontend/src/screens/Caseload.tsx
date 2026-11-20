import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { ClipboardList, UserRoundCheck, Users } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { SectionTabsLayout } from "@/components/shell/SectionTabs";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "@/components/ui/select";
import { Tag } from "@/components/ui/badge";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { TaskLine } from "@/components/residency/ResidencyCards";
import { useAuth } from "@/lib/auth";
import {
  caseloadApi,
  useCaseload,
  useCaseloadLeads,
  useCaseloadTasks,
  useShowCaseload,
  useUnassigned,
  type CaseloadLead,
  type CaseloadResident,
  type TaskWhen,
  type UnassignedSite,
} from "@/lib/caseload";
import { fmtDay, useResidencyRefresh } from "@/lib/residency";
import { SitePicker, useSiteSelection } from "@/lib/site";
import { useSearchParam } from "@/lib/useSearchParam";
import { cn, errorMessage, formatDate } from "@/lib/utils";

/**
 * Caseload (PlanStreet's "My Activities"): the residents you're case lead for,
 * the paperwork they're owed as one to-do list, and, for Site Managers and
 * Admins, the residents nobody leads yet. Case management only. A manager can
 * look at another case lead's caseload (?lead=), which the tabs carry along.
 */
export function CaseloadSection() {
  const { can } = useAuth();
  const show = useShowCaseload();
  const [lead] = useSearchParam("lead");
  const { data } = useCaseload(lead, show);
  if (!show) return <Navigate to="/" replace />;
  const qs = lead ? `?${new URLSearchParams({ lead })}` : "";
  return (
    <SectionTabsLayout
      title="Caseload"
      tabs={[
        { to: `/caseload${qs}`, label: "Residents", end: true },
        { to: `/caseload/tasks${qs}`, label: "To do", count: data?.totals.overdue },
        ...(can("roster.archive") ? [{ to: "/caseload/unassigned", label: "Unassigned" }] : []),
      ]}
    />
  );
}

/** A Site Manager's or Admin's choice of whose caseload to look at. */
function LeadPicker({ lead }: { lead: CaseloadLead | undefined }) {
  const [, setLead] = useSearchParam("lead");
  const { user } = useAuth();
  const { data } = useCaseloadLeads(true);
  const others = (data ?? []).filter((u) => u.id !== user?.id);
  // Someone not in the list (no longer at these sites) still shows as chosen.
  if (lead && !lead.self && !others.some((u) => u.id === lead.id)) others.unshift({ id: lead.id, name: lead.name, title: null, residents: 0 });
  return (
    <Select
      value={lead && !lead.self ? lead.id : ""}
      onChange={(e) => setLead(e.target.value || null)}
      aria-label="Whose caseload"
      className="w-full md:w-[260px]"
      options={[{ value: "", label: "My caseload" }, ...others.map((u) => ({ value: u.id, label: u.residents ? `${u.name} (${u.residents})` : u.name }))]}
    />
  );
}

const SORTS = [
  ["name", "Name"],
  ["overdue", "Most overdue first"],
  ["contact", "Longest since contact"],
] as const;

function sorted(rows: CaseloadResident[], sort: string) {
  const out = [...rows];
  if (sort === "overdue") out.sort((a, b) => b.tasks.overdue - a.tasks.overdue || (a.tasks.oldestOverdue?.dueOn ?? "~").localeCompare(b.tasks.oldestOverdue?.dueOn ?? "~"));
  if (sort === "contact") out.sort((a, b) => (a.lastContact?.at ?? "").localeCompare(b.lastContact?.at ?? ""));
  return out;
}

/** The residents tab: who you lead, where they live, what's due and when someone last saw them. */
export function CaseloadPage() {
  const [lead] = useSearchParam("lead");
  const [sortParam, setSort] = useSearchParam("sort");
  const sort = SORTS.some(([k]) => k === sortParam) ? sortParam! : "name";
  const { data, isLoading, error } = useCaseload(lead);
  const who = data?.lead;

  return (
    <Page className="max-w-[1000px]">
      <PageHeader
        title="Caseload"
        subtitle={who && !who.self ? `Residents ${who.name} is case lead for, at your sites.` : "The residents you're case lead for: where they live, what paperwork is due, and their last contact note."}
        actions={data?.can.pickLead ? <LeadPicker lead={who} /> : undefined}
      />
      {error ? (
        <EmptyState title="Couldn't load the caseload" hint={errorMessage(error, "Try again in a moment.")} />
      ) : isLoading || !data ? (
        <LoadingState />
      ) : data.residents.length === 0 ? (
        <EmptyState
          icon={<Users className="h-8 w-8" />}
          title={who?.self ? "Nobody on your caseload yet" : `${who?.name} has nobody here`}
          hint={who?.self ? "Residents show here once their client information names you as case lead." : "Nobody at your sites names them as case lead."}
        />
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <p className="flex-1 text-micro text-muted">
              {[
                `${data.totals.residents} ${data.totals.residents === 1 ? "resident" : "residents"}`,
                data.totals.overdue ? `${data.totals.overdue} ${data.totals.overdue === 1 ? "task" : "tasks"} overdue` : null,
                data.totals.away ? `${data.totals.away} away` : null,
                data.totals.noRecentContact ? `${data.totals.noRecentContact} with no contact note in 30 days` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <Select value={sort} onChange={(e) => setSort(e.target.value === "name" ? null : e.target.value)} aria-label="Sort" className="w-[200px]" options={SORTS.map(([value, label]) => ({ value, label }))} />
          </div>
          <Card className="px-4">
            <ul className="divide-y divide-hairline">
              {sorted(data.residents, sort).map((r) => (
                <ResidentRow key={r.id} r={r} />
              ))}
            </ul>
          </Card>
        </>
      )}
    </Page>
  );
}

function ResidentRow({ r }: { r: CaseloadResident }) {
  const { overdue, oldestOverdue, next } = r.tasks;
  return (
    <li className="grid gap-x-4 gap-y-1.5 py-3 sm:grid-cols-[minmax(0,1fr)_200px_180px]">
      <div className="min-w-0">
        <span className="flex flex-wrap items-center gap-1.5">
          <Link to={`/tenants/${r.id}`} className="text-body font-semibold text-accent hover:underline dark:text-white">{r.displayName}</Link>
          {r.away && <Tag tone="amber" title={r.away.reason ?? undefined}>Away</Tag>}
          {r.highAcuity && <Tag tone="red">High acuity</Tag>}
          {!r.movedIn && <Tag tone="neutral">Not moved in</Tag>}
        </span>
        <span className="block text-micro text-muted">
          {[r.site.name, r.unit && `Unit ${r.unit}`, r.movedInOn && `Moved in ${fmtDay(r.movedInOn)}`].filter(Boolean).join(" · ")}
        </span>
        {r.away && (
          <span className="block text-micro text-status-amberText">
            Away since {fmtDay(r.away.since)}{r.away.reason ? ` · ${r.away.reason}` : ""}
          </span>
        )}
      </div>
      <div className="text-label leading-[17px]">
        {overdue > 0 ? (
          <span className="font-semibold text-status-redText">
            {overdue} overdue{oldestOverdue ? ` · ${oldestOverdue.label} was due ${fmtDay(oldestOverdue.dueOn)}` : ""}
          </span>
        ) : next ? (
          <span className="text-ink">Next: {next.label}, {fmtDay(next.dueOn)}</span>
        ) : (
          <span className="text-muted">No paperwork open</span>
        )}
        {overdue > 0 && next && <span className="block text-muted">Next: {next.label}, {fmtDay(next.dueOn)}</span>}
      </div>
      <div className="text-label leading-[17px]">
        {r.lastContact ? (
          <Link to={`/f/${r.lastContact.formSlug}/entries/${r.lastContact.entryId}`} className="hover:underline">
            <span className="text-ink">Last contact {formatDate(r.lastContact.at)}</span>
            <span className="block text-muted">{r.lastContact.byName}</span>
          </Link>
        ) : (
          <span className="text-muted">No contact notes yet</span>
        )}
      </div>
    </li>
  );
}

const GROUPS: [TaskWhen, string, string][] = [
  ["overdue", "Overdue", "Past their due date."],
  ["week", "This week", "Due in the next 7 days."],
  ["later", "Later", "Coming up after that."],
];

/** The to-do list: every open checklist task for the caseload, overdue first. */
export function CaseloadTasksPage() {
  const { can } = useAuth();
  const [lead] = useSearchParam("lead");
  const { data: caseload } = useCaseload(lead);
  const { data, isLoading, error } = useCaseloadTasks(lead);
  const tick = can("roster.edit") || can("clients.edit");
  const who = data?.lead;
  const items = data?.items ?? [];

  return (
    <Page className="max-w-[860px]">
      <PageHeader
        title="To do"
        subtitle={who && !who.self ? `Paperwork owed by the residents ${who.name} is case lead for.` : "Paperwork owed by the residents you're case lead for. Open the form to do it; it ticks itself off when filed."}
        actions={caseload?.can.pickLead ? <LeadPicker lead={caseload.lead} /> : undefined}
      />
      {error ? (
        <EmptyState title="Couldn't load the to-do list" hint={errorMessage(error, "Try again in a moment.")} />
      ) : isLoading || !data ? (
        <LoadingState />
      ) : items.length === 0 ? (
        <EmptyState icon={<ClipboardList className="h-8 w-8" />} title="Nothing to do" hint="No paperwork is open for this caseload." />
      ) : (
        GROUPS.map(([when, title, hint]) => {
          const rows = items.filter((t) => t.when === when);
          if (!rows.length) return null;
          return (
            <section key={when} className="mb-5">
              <h2 className={cn("mb-1 font-heading text-[16px] font-extrabold", when === "overdue" ? "text-status-redText" : "text-ink")}>
                {title} <span className="text-label font-semibold text-muted">· {rows.length}</span>
              </h2>
              <p className="mb-2 text-micro text-muted">{hint}</p>
              <Card className="px-4">
                <ul className="divide-y divide-hairline">
                  {rows.map((t) => (
                    <TaskLine key={t.id} task={t} canTick={tick} showResident formLink />
                  ))}
                </ul>
              </Card>
            </section>
          );
        })
      )}
    </Page>
  );
}

/** Site Managers and Admins: residents at their sites with no case lead, and assigning one. */
export function UnassignedPage() {
  const { can } = useAuth();
  const manager = can("roster.archive");
  const { codes, setCodes, param } = useSiteSelection();
  const { data, isLoading, error } = useUnassigned(param, manager);
  if (!manager) return <Navigate to="/caseload" replace />;
  const sites = (data?.sites ?? []).filter((s) => s.residents.length > 0);

  return (
    <Page className="max-w-[860px]">
      <PageHeader
        title="Unassigned"
        subtitle="Residents nobody is case lead for yet. Tick them, pick who leads them, and assign."
        actions={<SitePicker codes={codes} onChange={setCodes} className="w-full md:w-[260px]" />}
      />
      {error ? (
        <EmptyState title="Couldn't load the list" hint={errorMessage(error, "Try again in a moment.")} />
      ) : isLoading || !data ? (
        <LoadingState />
      ) : data.sites.length === 0 ? (
        <EmptyState title="No supportive sites here" hint="Case leads are assigned at supportive sites. Pick one above." />
      ) : sites.length === 0 ? (
        <EmptyState icon={<UserRoundCheck className="h-8 w-8" />} title="Everyone has a case lead" />
      ) : (
        sites.map((s) => <UnassignedSiteCard key={s.id} site={s} />)
      )}
    </Page>
  );
}

function UnassignedSiteCard({ site }: { site: UnassignedSite }) {
  const toast = useToast();
  const refresh = useResidencyRefresh();
  const [picked, setPicked] = useState<string[]>([]);
  const [leadId, setLeadId] = useState("");
  const [busy, setBusy] = useState(false);
  // Only people still on the list (an assign, or someone else's, takes them off).
  const chosen = picked.filter((id) => site.residents.some((r) => r.id === id));
  const all = chosen.length === site.residents.length;

  async function assign() {
    if (!leadId || !chosen.length) return;
    setBusy(true);
    try {
      const r = await caseloadApi.assign(leadId, chosen);
      await refresh();
      setPicked([]);
      const done = `${r.lead.name} is now case lead for ${r.assigned.length} ${r.assigned.length === 1 ? "resident" : "residents"}.`;
      if (r.skipped.length) toast(`${done} Not changed: ${r.skipped.map((x) => `${x.name ?? "someone"} (${x.reason})`).join("; ")}`, r.assigned.length ? undefined : "error");
      else toast(done);
    } catch (e) {
      toast(errorMessage(e, "Couldn't assign."), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-center gap-3 border-b border-hairline px-4 py-3">
        <Checkbox
          checked={all ? true : chosen.length ? "indeterminate" : false}
          onCheckedChange={(v) => setPicked(v === true ? site.residents.map((r) => r.id) : [])}
          aria-label={`Select everyone at ${site.name}`}
        />
        <h2 className="flex-1 font-heading text-body-lg font-extrabold text-ink">{site.name}</h2>
        <span className="text-micro text-muted">{site.residents.length} without a case lead</span>
      </div>
      <ul className="divide-y divide-hairline px-4">
        {site.residents.map((r) => (
          <li key={r.id}>
            <label className="flex min-h-[44px] cursor-pointer items-center gap-3 py-2">
              <Checkbox
                checked={chosen.includes(r.id)}
                onCheckedChange={(v) => setPicked((p) => (v === true ? [...p, r.id] : p.filter((x) => x !== r.id)))}
                aria-label={`Select ${r.displayName}`}
              />
              <span className="min-w-0 flex-1">
                <span className="text-body font-semibold text-ink">{r.displayName}</span>
                {r.away && <Tag tone="amber" className="ml-1.5">Away</Tag>}
                {!r.movedIn && <Tag tone="neutral" className="ml-1.5">Not moved in</Tag>}
                <span className="block text-micro text-muted">{[r.unit && `Unit ${r.unit}`, r.movedInOn && `Moved in ${fmtDay(r.movedInOn)}`].filter(Boolean).join(" · ") || "No unit"}</span>
              </span>
              <Link to={`/tenants/${r.id}`} className="text-label font-semibold text-accent hover:underline dark:text-white" onClick={(e) => e.stopPropagation()}>Open</Link>
            </label>
          </li>
        ))}
      </ul>
      {/* Stays in view at the bottom of the screen while a long list is scrolled. */}
      {chosen.length > 0 && (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 rounded-b-card border-t border-hairline bg-subtle px-4 py-3">
          <span className="text-label font-semibold text-ink">{chosen.length} selected</span>
          <Select
            value={leadId}
            onChange={(e) => setLeadId(e.target.value)}
            placeholder="Pick a case lead"
            aria-label="Case lead"
            className="w-[240px]"
            options={site.leads.map((u) => ({ value: u.id, label: u.title ? `${u.name} · ${u.title}` : u.name }))}
          />
          <Button size="sm" onClick={() => void assign()} disabled={!leadId || busy}>{busy ? "Assigning…" : "Assign"}</Button>
        </div>
      )}
    </Card>
  );
}
