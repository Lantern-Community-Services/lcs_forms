import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/toast";
import { useSites, useTenants } from "@/lib/queries";
import {
  residencyApi, shortRelation, todayLocal, useResidencyMeta, useResidencyRefresh, useUnits,
  type Occupant, type UnitRow,
} from "@/lib/residency";
import { cn, errorMessage } from "@/lib/utils";
import type { Site, Tenant } from "@/lib/types";

/**
 * Moving people in, between units and out; away and back; household relations
 * (backend services/residency.ts). Each is a popup on a phone and a dialog on a
 * computer, like Remove.
 */

const big = "min-h-[44px]";
const footBtn = "min-h-[48px] flex-1 md:h-9 md:min-h-0 md:flex-none";

function Chips({ options, value, onChange, label }: { options: string[]; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={value === o}
          onClick={() => onChange(o)}
          className={cn(
            "min-h-[40px] rounded-pill border px-3.5 text-left text-[13px] font-semibold transition-colors",
            value === o ? "border-navy bg-navsel text-accent dark:text-white" : "border-hairline text-ink hover:bg-rowhover"
          )}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

const ErrorLine = ({ error }: { error: string | null }) =>
  error ? <p className="rounded-input bg-status-redBg px-3 py-2 text-[13px] text-status-redText">{error}</p> : null;

/** A unit as a choice: vacant, or (household sites) joining whoever lives there. */
function unitChoice(u: UnitRow, households: boolean) {
  if (u.vacant) return { value: u.id, label: `${u.label} — vacant${u.unitType ? ` · ${u.unitType}` : ""}` };
  const head = u.occupants.find((o) => o.head) ?? u.occupants[0];
  return { value: u.id, label: households ? `${u.label} — join ${head?.displayName}'s household` : `${u.label} — ${head?.displayName}` };
}

// ── Move in ──────────────────────────────────────────────────────────────

type Mover = { tenantId: string; relation: string };

/**
 * Move one person — or, at a household site, a household — into a unit. Opened
 * from a vacant unit (the unit is set), from someone not moved in (the person is
 * set), or from the roster.
 */
export function MoveInDialog({
  open, onOpenChange, site, unit, tenant,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  site: Pick<Site, "id" | "code" | "name"> & { households?: boolean };
  unit?: UnitRow | null;
  tenant?: Tenant | null;
}) {
  const toast = useToast();
  const refresh = useResidencyRefresh();
  const { data: meta } = useResidencyMeta(open);
  const { data: unitsData } = useUnits(site.code, open);
  const { data: roster } = useTenants(site.code, "active", open);
  const households = Boolean(site.households);
  const [unitId, setUnitId] = useState("");
  const [date, setDate] = useState(todayLocal());
  const [people, setPeople] = useState<Mover[]>([]);
  const [program, setProgram] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUnitId(unit?.id ?? "");
    setDate(todayLocal());
    setPeople([{ tenantId: tenant?.id ?? "", relation: "" }]);
    setProgram(unit?.program ?? "");
    setError(null);
  }, [open, unit, tenant]);

  const units = (unitsData?.units ?? []).filter((u) => u.siteId === site.id && u.active && (u.vacant || households));
  const chosenUnit = units.find((u) => u.id === unitId) ?? unit ?? null;
  const joining = Boolean(chosenUnit && !chosenUnit.vacant);
  // People on the roster who don't live in a unit: waiting to move in, or here from before units.
  const waiting = (roster?.items ?? []).filter((t) => !t.unitId).sort((a, b) => a.displayName.localeCompare(b.displayName));
  const programs = (meta?.programs ?? []).filter((p) => p.site === site.code);
  const needsRelation = (i: number) => households && (joining || i > 0);

  useEffect(() => {
    if (chosenUnit && !program) setProgram(chosenUnit.program ?? "");
  }, [chosenUnit]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (!unitId) return setError("Pick a unit.");
    const list = people.filter((p) => p.tenantId);
    if (!list.length) return setError("Pick who is moving in.");
    if (list.some((p, i) => needsRelation(i) && !p.relation)) return setError("Say how each household member is related to the head of household.");
    setBusy(true);
    setError(null);
    try {
      await residencyApi.moveIn(unitId, {
        date,
        people: list.map((p, i) => ({ tenantId: p.tenantId, relation: needsRelation(i) ? p.relation : null })),
        program: program || null,
      });
      await refresh();
      toast(`Moved ${list.length === 1 ? "them" : `${list.length} people`} into ${chosenUnit?.label ?? "the unit"}.`);
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e, "Could not move them in."));
    } finally {
      setBusy(false);
    }
  }

  const head = chosenUnit?.occupants.find((o) => o.head);
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Move in${tenant ? `: ${tenant.displayName}` : ""}`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} className={footBtn}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy} className={footBtn}>{busy ? "Moving in…" : "Move in"}</Button>
        </>
      }
    >
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Unit *" className="col-span-2 sm:col-span-1">
            <Select value={unitId} onChange={(e) => setUnitId(e.target.value)} placeholder="Pick a unit" className={big} disabled={Boolean(unit)}
              options={(unit && !units.some((u) => u.id === unit.id) ? [unit, ...units] : units).map((u) => unitChoice(u, households))} />
          </Field>
          <Field label="Move-in date *" className="col-span-2 sm:col-span-1">
            <Input type="date" value={date} max={todayLocal()} onChange={(e) => setDate(e.target.value)} className={big} />
          </Field>
        </div>
        {joining && head && <p className="text-[13px] text-muted">Joining {head.displayName}'s household. Say how each person is related to them.</p>}
        <div className="grid gap-2">
          {people.map((p, i) => (
            <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <Select
                value={p.tenantId}
                onChange={(e) => setPeople((ps) => ps.map((x, j) => (j === i ? { ...x, tenantId: e.target.value } : x)))}
                placeholder={i === 0 && !joining && households ? "Head of household" : "Who is moving in"}
                className={big}
                disabled={i === 0 && Boolean(tenant)}
                aria-label="Person"
                options={[
                  ...(tenant && i === 0 && !waiting.some((w) => w.id === tenant.id) ? [{ value: tenant.id, label: tenant.displayName }] : []),
                  ...waiting.filter((w) => w.id === p.tenantId || !people.some((x) => x.tenantId === w.id)).map((w) => ({ value: w.id, label: `${w.displayName}${w.movedIn === false ? " · not moved in" : ""}` })),
                ]}
              />
              {needsRelation(i) ? (
                <Select
                  value={p.relation}
                  onChange={(e) => setPeople((ps) => ps.map((x, j) => (j === i ? { ...x, relation: e.target.value } : x)))}
                  placeholder="Relation to head of household"
                  className={big}
                  aria-label="Relation to head of household"
                  options={(meta?.relations ?? []).filter((r) => r !== meta?.head).map((r) => ({ value: r, label: shortRelation(r) ?? r }))}
                />
              ) : (
                <span className="hidden self-center text-micro text-muted sm:block">{households ? "Head of household" : ""}</span>
              )}
              {i > 0 ? (
                <Button variant="ghost" size="icon" onClick={() => setPeople((ps) => ps.filter((_, j) => j !== i))} aria-label="Leave them out"><Trash2 className="h-4 w-4" /></Button>
              ) : <span />}
            </div>
          ))}
          {households && (
            <Button variant="secondary" size="sm" className="justify-self-start" onClick={() => setPeople((ps) => [...ps, { tenantId: "", relation: "" }])}>
              <Plus className="h-3.5 w-3.5" /> Add a household member
            </Button>
          )}
          {!waiting.length && !tenant && <p className="text-micro text-muted">Nobody on {site.name}'s roster is waiting to move in. Add them to the roster first.</p>}
        </div>
        {programs.length > 0 && (
          <Field label="Program">
            <Select value={program} onChange={(e) => setProgram(e.target.value)} placeholder="—" className={big} options={programs.map((p) => ({ value: p.value, label: p.value }))} />
          </Field>
        )}
        <p className="text-micro text-muted">Moving in starts their checklist: Initial Assessment and Face Sheet in 3 days, HMIS Project Start and Psychosocial in 30, a Housing Assessment every month.</p>
        <ErrorLine error={error} />
      </div>
    </ResponsiveDialog>
  );
}

// ── Transfer ─────────────────────────────────────────────────────────────

export function TransferDialog({
  open, onOpenChange, tenant, household,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tenant: Tenant;
  household: Occupant[];
}) {
  const toast = useToast();
  const refresh = useResidencyRefresh();
  const { data: meta } = useResidencyMeta(open);
  const { data: sites } = useSites();
  const unitSites = (sites ?? []).filter((s) => s.siteType === "supportive");
  const [siteCode, setSiteCode] = useState(tenant.site?.code ?? "");
  const { data: unitsData } = useUnits(siteCode || undefined, open && Boolean(siteCode));
  const site = unitSites.find((s) => s.code === siteCode);
  const isHead = household.length > 1 && !tenant.householdHeadId;
  const [unitId, setUnitId] = useState("");
  const [date, setDate] = useState(todayLocal());
  const [reason, setReason] = useState("");
  const [withHousehold, setWithHousehold] = useState(true);
  const [relation, setRelation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSiteCode(tenant.site?.code ?? "");
    setUnitId("");
    setDate(todayLocal());
    setReason(meta?.internalTransfer ?? "");
    setWithHousehold(true);
    setRelation("");
    setError(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const units = (unitsData?.units ?? []).filter((u) => u.siteId === site?.id && u.active && u.id !== tenant.unitId && (u.vacant || site?.households));
  const target = units.find((u) => u.id === unitId);
  const joining = Boolean(target && !target.vacant);

  async function save() {
    if (!unitId) return setError("Pick the unit they're moving to.");
    if (joining && !relation) return setError("Say how they're related to the head of that household.");
    setBusy(true);
    setError(null);
    try {
      await residencyApi.transfer(tenant.id, {
        toUnitId: unitId,
        date,
        reason: reason || null,
        withHousehold: isHead ? withHousehold : false,
        relations: joining ? { [tenant.id]: relation } : undefined,
      });
      await refresh();
      toast(`Moved to ${target?.label}${site && site.id !== tenant.siteId ? ` at ${site.name}` : ""}.`);
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e, "Could not move them."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Move ${tenant.displayName} to another unit`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} className={footBtn}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy} className={footBtn}>{busy ? "Moving…" : "Move"}</Button>
        </>
      }
    >
      <div className="grid gap-3">
        <p className="text-[13px] text-muted">Now in {tenant.unit ? `unit ${tenant.unit} at ` : ""}{tenant.site?.name}. They stay on the roster; their stay here ends and a new one starts.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Site" className="col-span-2 sm:col-span-1">
            <Select value={siteCode} onChange={(e) => { setSiteCode(e.target.value); setUnitId(""); }} className={big} options={unitSites.map((s) => ({ value: s.code, label: s.name }))} />
          </Field>
          <Field label="Unit *" className="col-span-2 sm:col-span-1">
            <Select value={unitId} onChange={(e) => setUnitId(e.target.value)} placeholder="Pick a unit" className={big} options={units.map((u) => unitChoice(u, Boolean(site?.households)))} />
          </Field>
          <Field label="Date *" className="col-span-2 sm:col-span-1">
            <Input type="date" value={date} max={todayLocal()} onChange={(e) => setDate(e.target.value)} className={big} />
          </Field>
          <Field label="Reason" className="col-span-2 sm:col-span-1">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={120} className={big} />
          </Field>
        </div>
        {joining && (
          <Field label={`Relation to ${target?.occupants.find((o) => o.head)?.displayName ?? "the head of household"} *`}>
            <Select value={relation} onChange={(e) => setRelation(e.target.value)} placeholder="—" className={big}
              options={(meta?.relations ?? []).filter((r) => r !== meta?.head).map((r) => ({ value: r, label: shortRelation(r) ?? r }))} />
          </Field>
        )}
        {isHead && (
          <label className="flex items-start gap-2 text-[13px]">
            <Checkbox checked={withHousehold} onCheckedChange={(v) => setWithHousehold(Boolean(v))} className="mt-0.5" />
            <span>Move the whole household ({household.filter((h) => h.id !== tenant.id).map((h) => h.displayName).join(", ")})</span>
          </label>
        )}
        <ErrorLine error={error} />
      </div>
    </ResponsiveDialog>
  );
}

// ── Move out ─────────────────────────────────────────────────────────────

export function MoveOutDialog({
  open, onOpenChange, tenant, household, awaySince, onTransfer,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tenant: Tenant;
  household: Occupant[];
  /** Away and not coming back: the vacancy date starts from when they were last seen. */
  awaySince?: string | null;
  onTransfer?: () => void;
}) {
  const toast = useToast();
  const refresh = useResidencyRefresh();
  const { data: meta } = useResidencyMeta(open);
  const others = household.filter((h) => h.id !== tenant.id);
  const isHead = others.length > 0 && !tenant.householdHeadId;
  const [date, setDate] = useState(todayLocal());
  const [reason, setReason] = useState("");
  const [destination, setDestination] = useState("");
  const [addr, setAddr] = useState({ line1: "", line2: "", city: "", state: "New York", zip: "" });
  const [note, setNote] = useState("");
  const [also, setAlso] = useState<Set<string>>(new Set());
  const [newHeadId, setNewHeadId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDate(awaySince ? awaySince.slice(0, 10) : todayLocal());
    setReason("");
    setDestination("");
    setAddr({ line1: "", line2: "", city: "", state: "New York", zip: "" });
    setNote("");
    setAlso(new Set(isHead ? others.map((o) => o.id) : []));
    setNewHeadId("");
    setError(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const staying = others.filter((o) => !also.has(o.id));
  const needsNewHead = isHead && staying.length > 0;

  async function save() {
    if (!reason) return setError("Pick why they're moving out.");
    if (needsNewHead && !newHeadId) return setError("Choose who becomes head of household.");
    setBusy(true);
    setError(null);
    try {
      const forwarding = Object.fromEntries(Object.entries(addr).filter(([k, v]) => v.trim() && !(k === "state" && !addr.line1 && !addr.city)));
      await residencyApi.moveOut(tenant.id, {
        date,
        reason,
        destination: destination || null,
        forwardingAddress: Object.keys(forwarding).length ? forwarding : null,
        note: note.trim() || null,
        alsoIds: [...also],
        newHeadId: needsNewHead ? newHeadId : null,
      });
      await refresh();
      toast(`Moved out${also.size ? ` with ${also.size} household ${also.size === 1 ? "member" : "members"}` : ""}. The unit is free.`);
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e, "Could not move them out."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Move out: ${tenant.displayName}`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} className={footBtn}>Cancel</Button>
          <Button variant="danger" onClick={() => void save()} disabled={busy} className={footBtn}>{busy ? "Moving out…" : "Move out"}</Button>
        </>
      }
    >
      <div className="grid gap-3">
        <p className="text-[13px] text-muted">
          {tenant.unit ? `Unit ${tenant.unit} · ` : ""}{tenant.site?.name}. Their stay ends, they come off the roster, the unit shows as vacant, and the HMIS exit assessment is added to the checklist.
        </p>
        <Field label="Move-out date *">
          <Input type="date" value={date} max={todayLocal()} onChange={(e) => setDate(e.target.value)} className={cn(big, "sm:w-56")} />
        </Field>
        <div>
          <p className="mb-2 text-[12px] font-semibold text-muted">Reason *</p>
          <Chips options={meta?.moveOutReasons ?? []} value={reason} onChange={setReason} label="Reason" />
          {onTransfer && (
            <button type="button" onClick={() => { onOpenChange(false); onTransfer(); }} className="mt-2 text-micro font-semibold text-accent hover:underline">
              Moving to another of our units? Transfer instead
            </button>
          )}
        </div>
        <Field label="Where they went (HUD exit destination)">
          <Select value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="—" className={big} options={(meta?.exitDestinations ?? []).map((d) => ({ value: d, label: d }))} />
        </Field>
        <details className="rounded-input border border-hairline px-3 py-2">
          <summary className="cursor-pointer text-[13px] font-semibold text-ink">Forwarding address</summary>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Input placeholder="Street address" value={addr.line1} onChange={(e) => setAddr({ ...addr, line1: e.target.value })} className={cn(big, "col-span-2")} />
            <Input placeholder="Apt, suite (optional)" value={addr.line2} onChange={(e) => setAddr({ ...addr, line2: e.target.value })} className={cn(big, "col-span-2")} />
            <Input placeholder="City" value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} className={big} />
            <Select value={addr.state} onChange={(e) => setAddr({ ...addr, state: e.target.value })} className={big} options={(meta?.states ?? ["New York"]).map((s) => ({ value: s, label: s }))} />
            <Input placeholder="ZIP" inputMode="numeric" value={addr.zip} onChange={(e) => setAddr({ ...addr, zip: e.target.value })} className={big} />
          </div>
        </details>
        {others.length > 0 && (
          <div className="rounded-input border border-hairline px-3 py-2">
            <p className="text-[13px] font-semibold text-ink">Household members leaving too</p>
            <div className="mt-1.5 grid gap-1.5">
              {others.map((o) => (
                <label key={o.id} className="flex items-center gap-2 text-[13px]">
                  <Checkbox
                    checked={also.has(o.id)}
                    onCheckedChange={(v) => setAlso((s) => { const n = new Set(s); if (v) n.add(o.id); else n.delete(o.id); return n; })}
                  />
                  {o.displayName}<span className="text-muted">· {shortRelation(o.relation)}</span>
                </label>
              ))}
            </div>
            {needsNewHead && (
              <Field label="Who becomes head of household? *" className="mt-2">
                <Select value={newHeadId} onChange={(e) => setNewHeadId(e.target.value)} placeholder="—" className={big} options={staying.map((s) => ({ value: s.id, label: s.displayName }))} />
              </Field>
            )}
          </div>
        )}
        <Field label="Note">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        </Field>
        <ErrorLine error={error} />
      </div>
    </ResponsiveDialog>
  );
}

// ── Away / back ──────────────────────────────────────────────────────────

export function AwayDialog({ open, onOpenChange, tenant }: { open: boolean; onOpenChange: (o: boolean) => void; tenant: Tenant }) {
  const toast = useToast();
  const refresh = useResidencyRefresh();
  const { data: meta } = useResidencyMeta(open);
  const [lastSeen, setLastSeen] = useState(todayLocal());
  const [reason, setReason] = useState("");
  const [detail, setDetail] = useState("");
  const [expected, setExpected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) { setLastSeen(todayLocal()); setReason(""); setDetail(""); setExpected(""); setError(null); }
  }, [open]);

  async function save() {
    if (!reason) return setError("Pick why they're away.");
    if (reason === "Other" && !detail.trim()) return setError("Say where they are.");
    setBusy(true);
    setError(null);
    try {
      await residencyApi.away(tenant.id, { lastSeen, reason, detail: detail.trim() || null, expectedReturn: expected || null });
      await refresh();
      toast(`${tenant.displayName} is marked away. They're out of review until they're back.`);
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e, "Could not save."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${tenant.displayName} is away`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} className={footBtn}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy} className={footBtn}>{busy ? "Saving…" : "Mark away"}</Button>
        </>
      }
    >
      <div className="grid gap-3">
        <p className="text-[13px] text-muted">Out of the building for a while — in hospital, with family, in detox. They keep their unit. If they won't be back, move them out instead.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Last seen *"><Input type="date" value={lastSeen} max={todayLocal()} onChange={(e) => setLastSeen(e.target.value)} className={big} /></Field>
          <Field label="Expected back"><Input type="date" value={expected} min={lastSeen} onChange={(e) => setExpected(e.target.value)} className={big} /></Field>
        </div>
        <div>
          <p className="mb-2 text-[12px] font-semibold text-muted">Why *</p>
          <Chips options={meta?.awayReasons ?? []} value={reason} onChange={setReason} label="Why they're away" />
        </div>
        <Field label={reason === "Other" ? "Where are they? *" : "Details"}>
          <Input value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={1000} className={big} placeholder="e.g. which hospital" />
        </Field>
        <ErrorLine error={error} />
      </div>
    </ResponsiveDialog>
  );
}

export function ReturnedDialog({ open, onOpenChange, tenant, since }: { open: boolean; onOpenChange: (o: boolean) => void; tenant: Tenant; since?: string | null }) {
  const toast = useToast();
  const refresh = useResidencyRefresh();
  const [date, setDate] = useState(todayLocal());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setDate(todayLocal()); setError(null); } }, [open]);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await residencyApi.returned(tenant.id, date);
      await refresh();
      toast(`Welcome back, ${tenant.displayName}.`);
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e, "Could not save."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${tenant.displayName} is back`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} className={footBtn}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy} className={footBtn}>{busy ? "Saving…" : "They're back"}</Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Back on"><Input type="date" value={date} min={since?.slice(0, 10)} max={todayLocal()} onChange={(e) => setDate(e.target.value)} className={cn(big, "sm:w-56")} /></Field>
        <ErrorLine error={error} />
      </div>
    </ResponsiveDialog>
  );
}

// ── Household ────────────────────────────────────────────────────────────

/** A member's relation to their head of household, or making them head. */
export function HouseholdDialog({ open, onOpenChange, member, head }: { open: boolean; onOpenChange: (o: boolean) => void; member: Occupant | null; head: Occupant | null }) {
  const toast = useToast();
  const refresh = useResidencyRefresh();
  const { data: meta } = useResidencyMeta(open);
  const [mode, setMode] = useState<"relation" | "head">("relation");
  const [relation, setRelation] = useState("");
  const [former, setFormer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open && member) { setMode("relation"); setRelation(member.relation ?? ""); setFormer(""); setError(null); } }, [open, member]);
  const relations = useMemo(() => (meta?.relations ?? []).filter((r) => r !== meta?.head).map((r) => ({ value: r, label: shortRelation(r) ?? r })), [meta]);
  if (!member) return null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (mode === "head") {
        if (!former) throw new Error(`Say how ${head?.displayName ?? "the current head"} is related to ${member!.displayName}.`);
        await residencyApi.household(member!.id, { makeHead: true, formerHeadRelation: former });
      } else {
        if (!relation) throw new Error("Pick a relation.");
        await residencyApi.household(member!.id, { relation });
      }
      await refresh();
      toast("Household updated.");
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e, "Could not save."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={member.displayName}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} className={footBtn}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy} className={footBtn}>{busy ? "Saving…" : "Save"}</Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Chips options={["Relation to head", "Make head of household"]} value={mode === "head" ? "Make head of household" : "Relation to head"} onChange={(v) => setMode(v === "Make head of household" ? "head" : "relation")} label="What to change" />
        {mode === "relation" ? (
          <Field label={`Relation to ${head?.displayName ?? "the head of household"}`}>
            <Select value={relation} onChange={(e) => setRelation(e.target.value)} placeholder="—" className={big} options={relations} />
          </Field>
        ) : (
          <Field label={`${head?.displayName ?? "The current head"} becomes ${member.displayName}'s…`}>
            <Select value={former} onChange={(e) => setFormer(e.target.value)} placeholder="—" className={big} options={relations} />
          </Field>
        )}
        <ErrorLine error={error} />
      </div>
    </ResponsiveDialog>
  );
}
