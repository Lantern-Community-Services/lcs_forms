import { useState } from "react";
import { Link } from "react-router-dom";
import { Building2, Pencil, Plus, Wand2 } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { useToast } from "@/components/ui/toast";
import { MoveInDialog } from "@/components/residency/Dialogs";
import { SitePicker, useSiteSelection } from "@/lib/site";
import { useAuth } from "@/lib/auth";
import { fmtDay, residencyApi, shortRelation, useResidencyFor, useResidencyMeta, useResidencyRefresh, useUnits, type UnitRow } from "@/lib/residency";
import { cn, errorMessage } from "@/lib/utils";

/**
 * Each supportive site's units (case management): who lives in each, the empty
 * ones, and setting them up — one at a time, a pasted list, or from the unit
 * numbers already on the roster. Site Managers and Admins.
 */
export function UnitsPage() {
  const { can } = useAuth();
  const { codes, setCodes, selected, param } = useSiteSelection();
  const residencyFor = useResidencyFor();
  const unitSites = selected.filter((s) => residencyFor(s));
  const [retired, setRetired] = useState(false);
  const { data, isLoading } = useUnits(param, unitSites.length > 0, { retired });
  const manage = can("roster.archive") || can("sites.manage");
  const [editing, setEditing] = useState<{ siteCode: string; unit: UnitRow | null } | null>(null);
  const [bulkFor, setBulkFor] = useState<string | null>(null);
  const [moveInto, setMoveInto] = useState<UnitRow | null>(null);
  const toast = useToast();
  const refresh = useResidencyRefresh();
  const [seeding, setSeeding] = useState<string | null>(null);

  async function seed(code: string, name: string) {
    if (!window.confirm(`Set up ${name}'s units from its roster? A unit is made for every unit number on the roster, and each resident is linked to theirs (with their move-in date and the monthly and yearly checklist). Nothing is removed, and it's safe to run again.`)) return;
    setSeeding(code);
    try {
      const r = await residencyApi.seedUnits(code);
      await refresh();
      toast(`${name}: ${r.unitsAdded} new ${r.unitsAdded === 1 ? "unit" : "units"}, ${r.residentsLinked} ${r.residentsLinked === 1 ? "resident" : "residents"} linked.`);
    } catch (e) {
      toast(errorMessage(e, "Could not set up the units."), "error");
    } finally {
      setSeeding(null);
    }
  }

  return (
    <Page className="max-w-[980px]">
      <PageHeader
        title="Units"
        subtitle="Every unit at your supportive sites, who lives there, and which are vacant."
        actions={<SitePicker codes={codes} onChange={setCodes} className="w-full md:w-[260px]" />}
      />
      <label className="mb-3 flex items-center gap-2 text-label text-muted">
        <Switch checked={retired} onCheckedChange={setRetired} /> Show retired units
      </label>
      {unitSites.length === 0 ? (
        <EmptyState title="No units here" hint="Units are for supportive sites while case management is on. Pick a supportive site." icon={<Building2 className="h-8 w-8" />} />
      ) : isLoading || !data ? (
        <LoadingState />
      ) : (
        unitSites.map((site) => {
          const units = data.units.filter((u) => u.siteId === site.id);
          const meta = data.sites.find((s) => s.id === site.id);
          const vacant = units.filter((u) => u.active && u.vacant).length;
          return (
            <Card key={site.id} className="mb-4 overflow-hidden">
              <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block font-heading text-body-lg font-bold text-ink">{site.name}</span>
                  <span className="block text-micro text-muted">
                    {units.filter((u) => u.active).length} units · {vacant} vacant{meta?.households ? " · households" : ""}
                  </span>
                </span>
                {manage && (
                  <span className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => void seed(site.code, site.name)} disabled={seeding === site.code}>
                      <Wand2 className="h-3.5 w-3.5" /> {seeding === site.code ? "Setting up…" : "Set up from roster"}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setBulkFor(site.code)}><Plus className="h-3.5 w-3.5" /> Add many</Button>
                    <Button size="sm" onClick={() => setEditing({ siteCode: site.code, unit: null })}><Plus className="h-3.5 w-3.5" /> Add unit</Button>
                  </span>
                )}
              </div>
              {units.length === 0 ? (
                <p className="px-4 py-6 text-label text-muted">
                  No units yet. {manage ? "Set them up from the roster's unit numbers, paste a list, or add them one by one." : "A Site Manager sets them up."}
                </p>
              ) : (
                <ul>
                  {units.map((u) => (
                    <li key={u.id} className={cn("flex flex-wrap items-center gap-3 border-b border-hairline px-4 py-2.5 last:border-0", !u.active && "opacity-60")}>
                      <span className="w-[64px] shrink-0 font-heading text-body font-extrabold tabular text-ink">{u.label}</span>
                      <span className="min-w-0 flex-1 text-label">
                        {u.vacant ? (
                          <span className="italic text-muted">{u.active ? `Vacant${u.vacantSince ? ` since ${fmtDay(u.vacantSince)}` : ""}` : "Retired"}</span>
                        ) : (
                          u.occupants.map((o, i) => (
                            <span key={o.id}>
                              {i > 0 && ", "}
                              <Link to={`/tenants/${o.id}`} className="font-semibold text-accent hover:underline">{o.displayName}</Link>
                              {u.occupants.length > 1 && <span className="text-muted"> ({o.head ? "head" : shortRelation(o.relation)?.toLowerCase() ?? "member"})</span>}
                              {o.away && <span className="text-muted"> · away</span>}
                            </span>
                          ))
                        )}
                        <span className="block text-micro text-muted">{[u.unitType, u.program, u.notes].filter(Boolean).join(" · ")}</span>
                      </span>
                      <span className="flex gap-1.5">
                        {u.vacant && u.active && can("roster.edit") && (
                          <Button size="sm" variant="secondary" onClick={() => setMoveInto(u)}>Move in</Button>
                        )}
                        {manage && (
                          <Button size="sm" variant="ghost" onClick={() => setEditing({ siteCode: site.code, unit: u })} aria-label={`Edit unit ${u.label}`}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })
      )}
      {editing && <UnitDialog siteCode={editing.siteCode} unit={editing.unit} onClose={() => setEditing(null)} />}
      {bulkFor && <BulkDialog siteCode={bulkFor} onClose={() => setBulkFor(null)} />}
      {moveInto && selected.find((s) => s.id === moveInto.siteId) && (
        <MoveInDialog open onOpenChange={(o) => !o && setMoveInto(null)} site={selected.find((s) => s.id === moveInto.siteId)!} unit={moveInto} />
      )}
    </Page>
  );
}

function UnitDialog({ siteCode, unit, onClose }: { siteCode: string; unit: UnitRow | null; onClose: () => void }) {
  const toast = useToast();
  const refresh = useResidencyRefresh();
  const { data: meta } = useResidencyMeta();
  const [label, setLabel] = useState(unit?.label ?? "");
  const [unitType, setUnitType] = useState(unit?.unitType ?? "");
  const [program, setProgram] = useState(unit?.program ?? "");
  const [notes, setNotes] = useState(unit?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const programs = (meta?.programs ?? []).filter((p) => p.site === siteCode);

  async function save(active?: boolean) {
    setBusy(true);
    try {
      const body = { label: label.trim(), unitType: unitType || null, program: program || null, notes: notes.trim() || null };
      if (unit) await residencyApi.updateUnit(unit.id, { ...body, ...(active !== undefined ? { active } : {}) });
      else await residencyApi.createUnit({ site: siteCode, ...body });
      await refresh();
      toast(active === false ? `Retired ${unit?.label}.` : active === true ? `${unit?.label} is back.` : "Saved.");
      onClose();
    } catch (e) {
      toast(errorMessage(e, "Could not save."), "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <ResponsiveDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={unit ? `Unit ${unit.label}` : "Add a unit"}
      footer={
        <>
          {unit && (unit.active ? (
            <Button variant="outlineDanger" onClick={() => void save(false)} disabled={busy || !unit.vacant} title={unit.vacant ? undefined : "Someone lives here"} className="mr-auto">Retire</Button>
          ) : (
            <Button variant="secondary" onClick={() => void save(true)} disabled={busy} className="mr-auto">Bring back</Button>
          ))}
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !label.trim()}>{busy ? "Saving…" : "Save"}</Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Unit *"><Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="e.g. 4B" className="min-h-[44px]" autoFocus /></Field>
        <Field label="Type">
          <Select value={unitType} onChange={(e) => setUnitType(e.target.value)} placeholder="—" className="min-h-[44px]" options={(meta?.unitTypes ?? []).map((t) => ({ value: t, label: t }))} />
        </Field>
        {programs.length > 0 && (
          <Field label="Program" className="col-span-2" hint="Offered when someone moves in.">
            <Select value={program} onChange={(e) => setProgram(e.target.value)} placeholder="—" className="min-h-[44px]" options={programs.map((p) => ({ value: p.value, label: p.value }))} />
          </Field>
        )}
        <Field label="Notes" className="col-span-2"><Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} className="min-h-[44px]" placeholder="e.g. accessible, 3rd floor" /></Field>
        {unit && !unit.vacant && unit.active && <p className="col-span-2 text-micro text-muted">Someone lives here, so it can't be retired.</p>}
      </div>
    </ResponsiveDialog>
  );
}

function BulkDialog({ siteCode, onClose }: { siteCode: string; onClose: () => void }) {
  const toast = useToast();
  const refresh = useResidencyRefresh();
  const { data: meta } = useResidencyMeta();
  const [text, setText] = useState("");
  const [unitType, setUnitType] = useState("");
  const [busy, setBusy] = useState(false);
  const labels = text.split(/[\n,]+/).map((l) => l.trim()).filter(Boolean);
  async function save() {
    setBusy(true);
    try {
      const r = await residencyApi.bulkUnits({ site: siteCode, labels, unitType: unitType || null });
      await refresh();
      toast(`Added ${r.added} ${r.added === 1 ? "unit" : "units"}${r.skipped ? ` (${r.skipped} already there)` : ""}.`);
      onClose();
    } catch (e) {
      toast(errorMessage(e, "Could not add them."), "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <ResponsiveDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add many units"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !labels.length}>{busy ? "Adding…" : `Add ${labels.length || ""} ${labels.length === 1 ? "unit" : "units"}`}</Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Units" hint="One per line (or separated by commas), e.g. 1A, 1B, 2A. Ones the site already has are skipped.">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} />
        </Field>
        <Field label="Type for all of them">
          <Select value={unitType} onChange={(e) => setUnitType(e.target.value)} placeholder="—" className="min-h-[44px]" options={(meta?.unitTypes ?? []).map((t) => ({ value: t, label: t }))} />
        </Field>
      </div>
    </ResponsiveDialog>
  );
}
