import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Eye, EyeOff, IdCard, Pencil, Plus, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { clientApi, useCaseLeadChoices, useClientFields, useClientProfile } from "@/lib/queries";
import { cn, errorMessage, formatDateTime } from "@/lib/utils";
import type { ClientField, ClientFieldsMeta, ClientProfile, ClientSection, ClientValue, ContactRow, TenantDetail } from "@/lib/types";

/**
 * Client information on a resident's page: what PlanStreet keeps on a case
 * (backend services/clientFields.ts draws the sections). Shown only while the
 * clientInfo setting is on and to people with clients.view; each section opens
 * on its own and is edited on its own, so a long record never turns into one
 * giant form and two people editing different sections rarely collide.
 */
export function ClientInfoCard({ tenant }: { tenant: TenantDetail }) {
  const { can } = useAuth();
  const allowed = can("clients.view");
  const { data, isLoading } = useClientProfile(tenant.id, allowed);
  const on = Boolean(data?.enabled);
  const { data: meta } = useClientFields(allowed && on);
  const [open, setOpen] = useState<Set<string>>(() => new Set(["identity", "program"]));
  const [editing, setEditing] = useState<string | null>(null);

  if (!allowed || (!isLoading && !on)) return null;
  if (!data || !data.enabled || !meta) {
    return (
      <Card className="mb-4 flex items-center gap-2 p-5 text-label text-muted">
        <Spinner className="h-4 w-4" /> Loading client information…
      </Card>
    );
  }
  const { profile, canEdit, canSeeSsn } = data;

  const toggle = (key: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  return (
    <Card className="page-list-item-enter mb-4 p-5" style={{ animationDelay: "50ms" }}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <p className="kicker flex items-center gap-1.5"><IdCard className="h-3.5 w-3.5" /> Client information</p>
        <p className="text-micro text-muted">
          {profile.age !== null && <span className="font-semibold text-ink">Age {profile.age}</span>}
          {profile.age !== null && profile.updatedAt && " · "}
          {profile.updatedAt ? `Updated ${formatDateTime(profile.updatedAt)}${profile.updatedBy ? ` by ${profile.updatedBy}` : ""}` : "Nothing recorded yet"}
        </p>
      </div>
      <div className="divide-y divide-hairline rounded-card border border-hairline">
        {meta.sections.map((section) => (
          <SectionBlock
            key={section.key}
            section={section}
            meta={meta}
            tenant={tenant}
            profile={profile}
            canEdit={canEdit}
            canSeeSsn={canSeeSsn}
            open={open.has(section.key) || editing === section.key}
            onToggle={() => toggle(section.key)}
            editing={editing === section.key}
            onEdit={(on) => setEditing(on ? section.key : null)}
          />
        ))}
      </div>
    </Card>
  );
}

// ── One section ──────────────────────────────────────────────────────────

type Values = Record<string, ClientValue | undefined>;

const applies = (f: ClientField, v: Values) => !f.showIf || (typeof v[f.showIf.key] === "string" && f.showIf.in.includes(v[f.showIf.key] as string));
const isEmpty = (v: ClientValue | undefined) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
const same = (a: ClientValue | undefined, b: ClientValue | undefined) => JSON.stringify(isEmpty(a) ? null : a) === JSON.stringify(isEmpty(b) ? null : b);

function SectionBlock(props: {
  section: ClientSection;
  meta: ClientFieldsMeta;
  tenant: TenantDetail;
  profile: ClientProfile;
  canEdit: boolean;
  canSeeSsn: boolean;
  open: boolean;
  onToggle: () => void;
  editing: boolean;
  onEdit: (on: boolean) => void;
}) {
  const { section, profile, editing } = props;
  const shown = section.fields.filter((f) => applies(f, profile.values));
  const answered = shown.filter((f) => (f.type === "ssn" ? Boolean(profile.ssn) : !isEmpty(profile.values[f.key]))).length;

  return (
    <section>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button type="button" onClick={props.onToggle} disabled={editing} className="flex min-h-[36px] flex-1 items-center gap-2 text-left" aria-expanded={props.open}>
          <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted transition-transform", !props.open && "-rotate-90")} />
          <span className="font-heading text-body font-bold text-ink">{section.title}</span>
          <span className="text-micro text-muted">
            {answered} of {shown.length}
          </span>
        </button>
        {props.canEdit && !editing && (
          <Button size="sm" variant="ghost" onClick={() => props.onEdit(true)} aria-label={`Edit ${section.title}`}>
            <Pencil className="h-3.5 w-3.5" /> Edit
          </Button>
        )}
      </div>
      {props.open && (
        <div className="px-3 pb-4">
          {section.description && <p className="mb-3 text-micro text-muted">{section.description}</p>}
          {editing ? <SectionEditor {...props} /> : <SectionView {...props} />}
        </div>
      )}
    </section>
  );
}

// ── Reading ──────────────────────────────────────────────────────────────

function SectionView({ section, tenant, profile, canSeeSsn }: { section: ClientSection; tenant: TenantDetail; profile: ClientProfile; canSeeSsn: boolean }) {
  const fields = section.fields.filter((f) => applies(f, profile.values));
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-3 text-label sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.key} className={cn("min-w-0", f.wide && "sm:col-span-2")}>
            <dt className="text-micro font-semibold text-muted">{f.label}</dt>
            <dd className="mt-0.5 break-words text-ink">
              <FieldValue field={f} tenant={tenant} profile={profile} canSeeSsn={canSeeSsn} />
            </dd>
          </div>
        ))}
      </dl>
  );
}

const Blank = () => <span className="text-muted">—</span>;

function FieldValue({ field, tenant, profile, canSeeSsn }: { field: ClientField; tenant: TenantDetail; profile: ClientProfile; canSeeSsn: boolean }) {
  const v = profile.values[field.key];
  switch (field.type) {
    case "ssn":
      return profile.ssn ? <SsnValue tenantId={tenant.id} masked={profile.ssn.masked} canSeeSsn={canSeeSsn} /> : <Blank />;
    case "staff":
      return profile.caseLead ? (
        <>
          {profile.caseLead.name}
          {profile.caseLead.title && <span className="text-muted"> · {profile.caseLead.title}</span>}
          {!profile.caseLead.active && <span className="text-muted"> (no longer active)</span>}
        </>
      ) : <Blank />;
    case "date":
      return typeof v === "string" ? <>{fmtYmd(v)}{field.key === "dateOfBirth" && profile.age !== null ? <span className="text-muted"> · age {profile.age}</span> : null}</> : <Blank />;
    case "multi":
      return Array.isArray(v) && v.length ? <>{(v as string[]).join(", ")}</> : <Blank />;
    case "contacts":
      return Array.isArray(v) && v.length ? (
        <ul className="space-y-1.5">
          {(v as ContactRow[]).map((c, i) => (
            <li key={i}>
              <span className="font-semibold">{c.name}</span>
              {c.relationship && <span className="text-muted"> · {c.relationship}</span>}
              {(c.phone || c.email) && <span className="block text-micro text-muted">{[c.phone, c.email].filter(Boolean).join(" · ")}</span>}
            </li>
          ))}
        </ul>
      ) : <Blank />;
    default:
      return isEmpty(v) ? <Blank /> : <>{String(v)}</>;
  }
}

function SsnValue({ tenantId, masked, canSeeSsn }: { tenantId: string; masked: string; canSeeSsn: boolean }) {
  const toast = useToast();
  const [full, setFull] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function reveal() {
    setBusy(true);
    try {
      const { ssn } = await clientApi.revealSsn(tenantId);
      setFull(ssn);
      // Back to the last four after half a minute.
      window.setTimeout(() => setFull(null), 30_000);
    } catch (e) {
      toast(errorMessage(e, "Could not show the number."), "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono">{full ?? masked}</span>
      {canSeeSsn && (
        <button
          type="button"
          onClick={() => (full ? setFull(null) : void reveal())}
          disabled={busy}
          className="inline-flex items-center gap-1 text-micro font-semibold text-accent hover:underline"
          title={full ? "Hide" : "Show the whole number (recorded in the audit log)"}
        >
          {full ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          {full ? "Hide" : "Show"}
        </button>
      )}
    </span>
  );
}

function fmtYmd(v: string): string {
  const [y, m, d] = v.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? v : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ── Editing ──────────────────────────────────────────────────────────────

function SectionEditor({ section, meta, tenant, profile, onEdit }: { section: ClientSection; meta: ClientFieldsMeta; tenant: TenantDetail; profile: ClientProfile; onEdit: (on: boolean) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Values>(() => ({ ...profile.values }));
  /** A new SSN typed in; "" leaves the one on file alone. */
  const [ssn, setSsn] = useState("");
  const [clearSsn, setClearSsn] = useState(false);
  const [saving, setSaving] = useState(false);

  const fields = section.fields.filter((f) => applies(f, draft));
  const set = (key: string, value: ClientValue | undefined) => setDraft((d) => ({ ...d, [key]: value }));

  // Only this section's fields, and only those that changed.
  const changes = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const f of section.fields) {
      if (f.type === "ssn") continue;
      let next = applies(f, draft) ? draft[f.key] : undefined;
      if (f.type === "contacts" && Array.isArray(next)) next = cleanContacts(next as ContactRow[]);
      if (!same(next, profile.values[f.key])) out[f.key] = isEmpty(next) ? null : next;
    }
    if (ssn.trim()) out.ssn = ssn.trim();
    else if (clearSsn) out.ssn = null;
    return out;
  }, [draft, ssn, clearSsn, section, profile]);
  const dirty = Object.keys(changes).length > 0;

  async function save() {
    setSaving(true);
    try {
      const res = await clientApi.update(tenant.id, { version: profile.version, changes });
      qc.setQueryData(["roster", "client", tenant.id], res);
      // The resident's History picks up the change.
      void qc.invalidateQueries({ queryKey: ["roster", "tenant", tenant.id] });
      toast("Saved.");
      onEdit(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast("Someone else saved this client information while you were editing. Their version is loaded; make your change again.", "error");
        void qc.invalidateQueries({ queryKey: ["roster", "client", tenant.id] });
        onEdit(false);
      } else toast(errorMessage(e, "Could not save."), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {fields.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint} className={cn((f.wide || f.type === "contacts" || f.type === "multi") && "sm:col-span-2")}>
            {f.type === "ssn" ? (
              <SsnInput current={profile.ssn?.masked ?? null} value={ssn} onChange={setSsn} cleared={clearSsn} onClear={setClearSsn} />
            ) : (
              <FieldInput field={f} value={draft[f.key]} onChange={(v) => set(f.key, v)} meta={meta} tenant={tenant} />
            )}
          </Field>
        ))}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={() => onEdit(false)} disabled={saving} className="min-h-[44px] md:h-9 md:min-h-0">Cancel</Button>
        <Button onClick={() => void save()} disabled={!dirty || saving} className="min-h-[44px] md:h-9 md:min-h-0">
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

const inputCls = "min-h-[44px] md:min-h-9";

/** Blank rows dropped and blank parts left out, the way the server stores them. */
function cleanContacts(rows: ContactRow[]): ContactRow[] {
  return rows
    .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]).filter(([, v]) => v !== "" && v !== undefined)) as ContactRow)
    .filter((r) => Object.keys(r).length > 0);
}

function FieldInput({ field, value, onChange, meta, tenant }: { field: ClientField; value: ClientValue | undefined; onChange: (v: ClientValue | undefined) => void; meta: ClientFieldsMeta; tenant: TenantDetail }) {
  const str = typeof value === "string" || typeof value === "number" ? String(value) : "";
  switch (field.type) {
    case "textarea":
      return <Textarea value={str} onChange={(e) => onChange(e.target.value)} />;
    case "date":
      return <Input type="date" value={str} onChange={(e) => onChange(e.target.value)} className={inputCls} />;
    case "year":
      return <Input type="number" inputMode="numeric" min={1900} max={new Date().getFullYear()} value={str} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)} className={inputCls} />;
    case "phone":
      return <Input type="tel" autoComplete="off" value={str} onChange={(e) => onChange(e.target.value)} className={inputCls} />;
    case "email":
      return <Input type="email" autoComplete="off" value={str} onChange={(e) => onChange(e.target.value)} className={inputCls} />;
    case "select":
      return (
        <Select value={str} onChange={(e) => onChange(e.target.value || undefined)} placeholder="—" className={inputCls}
          options={(field.options ?? []).map((o) => ({ value: o, label: o }))} />
      );
    case "multi": {
      const picked = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="flex flex-wrap gap-1.5">
          {(field.options ?? []).map((o) => (
            <Chip key={o} active={picked.includes(o)} onClick={() => onChange(picked.includes(o) ? picked.filter((p) => p !== o) : [...picked, o])} className="whitespace-normal text-left">
              {o}
            </Chip>
          ))}
        </div>
      );
    }
    case "program":
      return <ProgramSelect field={field} value={str} onChange={onChange} meta={meta} siteCode={tenant.site?.code} />;
    case "staff":
      return <StaffSelect tenantId={tenant.id} value={str} onChange={onChange} />;
    case "contacts":
      return <ContactsInput value={Array.isArray(value) ? (value as ContactRow[]) : []} onChange={(rows) => onChange(rows)} />;
    default:
      return <Input value={str} onChange={(e) => onChange(e.target.value)} className={inputCls} />;
  }
}

function SsnInput({ current, value, onChange, cleared, onClear }: { current: string | null; value: string; onChange: (v: string) => void; cleared: boolean; onClear: (v: boolean) => void }) {
  return (
    <div className="space-y-1.5">
      <Input
        value={value}
        onChange={(e) => { onChange(e.target.value); onClear(false); }}
        placeholder={current && !cleared ? `${current} — type a new number to replace it` : "123-45-6789"}
        inputMode="numeric"
        autoComplete="off"
        className={cn(inputCls, "font-mono")}
      />
      {current && !value && (
        <button type="button" onClick={() => onClear(!cleared)} className="text-micro font-semibold text-accent hover:underline">
          {cleared ? "Keep the number on file" : "Remove the number on file"}
        </button>
      )}
    </div>
  );
}

function ProgramSelect({ field, value, onChange, meta, siteCode }: { field: ClientField; value: string; onChange: (v: string | undefined) => void; meta: ClientFieldsMeta; siteCode?: string }) {
  const [everywhere, setEverywhere] = useState(Boolean(field.allSites));
  const own = meta.programs.filter((p) => p.site === siteCode);
  // Their own building's programs first; every building's when asked (or when the value is elsewhere).
  const showAll = everywhere || own.length === 0 || (value !== "" && !own.some((p) => p.value === value));
  const list = showAll ? meta.programs : own;
  const groups = [...new Set(list.map((p) => p.value.split(" - ")[0]))];
  return (
    <div className="space-y-1.5">
      <Select value={value} onChange={(e) => onChange(e.target.value || undefined)} placeholder="—" className={inputCls}>
        {showAll
          ? groups.map((g) => (
              <optgroup key={g} label={g}>
                {list.filter((p) => p.value.split(" - ")[0] === g).map((p) => <option key={p.value} value={p.value}>{p.value}</option>)}
              </optgroup>
            ))
          : list.map((p) => <option key={p.value} value={p.value}>{p.value}</option>)}
      </Select>
      {!field.allSites && own.length > 0 && (
        <button type="button" onClick={() => setEverywhere(!everywhere)} className="text-micro font-semibold text-accent hover:underline">
          {showAll && everywhere ? "Only this building's programs" : "Show every building's programs"}
        </button>
      )}
    </div>
  );
}

function StaffSelect({ tenantId, value, onChange }: { tenantId: string; value: string; onChange: (v: string | undefined) => void }) {
  const { data, isLoading } = useCaseLeadChoices(tenantId, true);
  const options = (data ?? []).map((p) => ({ value: p.id, label: p.title ? `${p.name} — ${p.title}` : p.name }));
  if (value && !options.some((o) => o.value === value)) options.unshift({ value, label: "Current case lead (not at this site now)" });
  return <Select value={value} onChange={(e) => onChange(e.target.value || undefined)} placeholder={isLoading ? "Loading staff…" : "—"} options={options} className={inputCls} />;
}

function ContactsInput({ value, onChange }: { value: ContactRow[]; onChange: (rows: ContactRow[]) => void }) {
  const update = (i: number, patch: Partial<ContactRow>) => onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {value.map((row, i) => (
        <div key={i} className="grid grid-cols-1 gap-2 rounded-input border border-hairline p-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]">
          <Input placeholder="Name" value={row.name} onChange={(e) => update(i, { name: e.target.value })} className={inputCls} aria-label="Contact name" />
          <Input placeholder="Relationship" value={row.relationship ?? ""} onChange={(e) => update(i, { relationship: e.target.value })} className={inputCls} aria-label="Relationship" />
          <Input placeholder="Phone" type="tel" value={row.phone ?? ""} onChange={(e) => update(i, { phone: e.target.value })} className={inputCls} aria-label="Phone" />
          <Input placeholder="Email" type="email" value={row.email ?? ""} onChange={(e) => update(i, { email: e.target.value })} className={inputCls} aria-label="Email" />
          <Button variant="ghost" size="icon" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="Remove this contact" className="justify-self-end">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      {value.length < 10 && (
        <Button variant="secondary" size="sm" onClick={() => onChange([...value, { name: "" }])}>
          <Plus className="h-3.5 w-3.5" /> Add a contact
        </Button>
      )}
    </div>
  );
}
