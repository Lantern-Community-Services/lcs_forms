import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ClipboardList, History, RotateCcw } from "lucide-react";
import { DesktopBackLink, Page } from "@/components/shell/AppShell";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Avatar } from "@/components/ui/avatar";
import { TenantStatusBadge } from "@/components/ui/badge";
import { LoadingState, EmptyState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { RemoveDialog } from "@/components/roster/RemoveDialog";
import { RemoveResidentIcon } from "@/components/roster/RemoveResidentIcon";
import { useRosterActions } from "@/components/roster/useRosterActions";
import { rosterApi, useRosterMutation, useTenant } from "@/lib/queries";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { errorMessage, formatDate, formatDateInput, formatDateTime, quietFor, relativeTime, tintFor } from "@/lib/utils";
import type { Tenant } from "@/lib/types";

type FormState = { unit: string; firstName: string; lastName: string; preferredName: string; moveInDate: string; notes: string; externalId: string };
const toForm = (t: Tenant): FormState => ({
  unit: t.unit ?? "",
  firstName: t.firstName,
  lastName: t.lastName,
  preferredName: t.preferredName ?? "",
  moveInDate: formatDateInput(t.moveInDate),
  notes: t.notes ?? "",
  externalId: t.externalId ?? "",
});

export function TenantDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const { data: t, isLoading } = useTenant(id);
  const { remove, keep, restore } = useRosterActions();
  const [form, setForm] = useState<FormState | null>(null);
  /** The version of the record the form was filled from — what a save is checked against. */
  const [loaded, setLoaded] = useState<Tenant | null>(null);
  const [conflict, setConflict] = useState<Tenant | null>(null);
  const [removing, setRemoving] = useState(false);
  const save = useRosterMutation((body: Record<string, unknown>) => rosterApi.update(id!, body));

  const dirty = Boolean(form && loaded && JSON.stringify(form) !== JSON.stringify(toForm(loaded)));

  // Follow the server while the person has nothing unsaved (a keep, a restore,
  // a colleague's edit). With unsaved edits, leave the form alone — the save
  // will surface the conflict instead of the typing vanishing.
  useEffect(() => {
    if (!t) return;
    if (!loaded || (!dirty && t.version !== loaded.version) || t.id !== loaded.id) {
      setLoaded(t);
      setForm(toForm(t));
    }
  }, [t]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading || !t || !form || !loaded) return <LoadingState />;
  const baseVersion = loaded.version;

  const editable = can("roster.edit") && t.status === "active";
  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f!, [k]: e.target.value }));

  async function onSave() {
    if (!form!.firstName.trim()) return toast("First name is required.", "error");
    try {
      const updated = await save.mutateAsync({
        version: baseVersion,
        unit: form!.unit.trim() || null,
        firstName: form!.firstName.trim(),
        lastName: form!.lastName.trim(),
        preferredName: form!.preferredName.trim() || null,
        moveInDate: form!.moveInDate || null,
        notes: form!.notes || null,
        externalId: form!.externalId.trim() || null,
      });
      setLoaded(updated);
      setForm(toForm(updated));
      setConflict(null);
      toast("Saved.");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setConflict((e.details as { current: Tenant }).current);
      } else toast(errorMessage(e, "Could not save."), "error");
    }
  }

  const where = [t.unit && `Unit ${t.unit}`, t.site?.name].filter(Boolean).join(" · ");

  return (
    <div className="flex min-h-full flex-col">
      <PhoneHeader title={t.displayName} subtitle={where} back={{ to: "/roster", label: "Roster" }} />
      <Page className="w-full max-w-[880px]">
        <DesktopBackLink to="/roster">{t.site?.name ?? "Roster"}</DesktopBackLink>

        <Card className="page-list-item-enter mb-4 p-5">
          <div className="flex flex-wrap items-center gap-4">
            <Avatar name={t.displayName} color={tintFor(t.id)} size={56} />
            <div className="min-w-0 flex-1">
              <h1 className="text-[21px] font-heading font-extrabold text-ink md:text-[24px]">{t.displayName}</h1>
              <p className="text-[13px] text-muted">
                {where}
                {t.preferredName && ` · legal name ${t.firstName} ${t.lastName}`}
              </p>
              <div className="mt-1.5">
                <TenantStatusBadge status={t.status} needsAttention={t.needsAttention} />
              </div>
            </div>
            <div className="flex w-full gap-2 md:w-auto">
              {t.status === "active" ? (
                <>
                  {can("roster.edit") && (
                    <Button variant="secondary" onClick={() => void keep(t)} className="min-h-[44px] flex-1 md:h-9 md:min-h-0">
                      <CheckCircle2 className="h-4 w-4" /> Still here
                    </Button>
                  )}
                  {can("roster.archive") && (
                    <Button variant="outlineDanger" onClick={() => setRemoving(true)} className="min-h-[44px] flex-1 md:h-9 md:min-h-0">
                      <RemoveResidentIcon className="h-4 w-4" /> Remove
                    </Button>
                  )}
                </>
              ) : (
                can("roster.restore") && (
                  <Button onClick={() => void restore(t)} className="min-h-[44px] flex-1 md:h-9 md:min-h-0">
                    <RotateCcw className="h-4 w-4" /> Restore to roster
                  </Button>
                )
              )}
            </div>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-hairline pt-4 text-[13px] md:grid-cols-4">
            <Stat label="Last on a form" value={t.lastActivityAt ? relativeTime(t.lastActivityAt) : "Never"} hint={t.lastActivitySource ?? undefined} />
            <Stat label="Last confirmed" value={t.lastKeptAt ? relativeTime(t.lastKeptAt) : "—"} />
            <Stat label="Quiet for" value={t.status === "active" ? quietFor(t.hoursQuiet) : "—"} />
            <Stat label="Roster ID" value={<span className="font-mono text-[11.5px]">{t.id}</span>} />
          </dl>
          {t.status === "archived" && (
            <p className="mt-4 rounded-input bg-subtle px-3 py-2 text-[13px] text-ink">
              Removed {formatDate(t.archivedAt)} — {t.archiveReason}
            </p>
          )}
        </Card>

        <Card className="page-list-item-enter mb-4 p-5" style={{ animationDelay: "35ms" }}>
          <p className="kicker mb-4">Details</p>
          {conflict && (
            <div className="mb-4 rounded-card border border-status-amberDot/40 bg-status-amberBg p-3 text-[13px] text-status-amberText">
              <p className="flex items-center gap-2 font-bold">
                <AlertTriangle className="h-4 w-4" /> Someone else saved changes while you were editing
              </p>
              <p className="mt-1">
                Their version: {conflict.displayName}
                {conflict.unit ? `, unit ${conflict.unit}` : ""}. Your edits haven't been saved.
              </p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => { setLoaded(conflict); setForm(toForm(conflict)); setConflict(null); }}>
                  Use their version
                </Button>
                <Button size="sm" onClick={() => {
                  // Rebase: check the next save against their version, keep my typing.
                  setLoaded(conflict);
                  setConflict(null);
                  toast("Save again to apply your edits on top of theirs.", "info");
                }}>
                  Keep mine
                </Button>
              </div>
            </div>
          )}
          <fieldset disabled={!editable} className="grid grid-cols-2 gap-3">
            <Field label="Unit / bed"><Input value={form.unit} onChange={set("unit")} className="min-h-[44px] md:min-h-9" /></Field>
            <Field label="Move-in date"><Input type="date" value={form.moveInDate} onChange={set("moveInDate")} className="min-h-[44px] md:min-h-9" /></Field>
            <Field label="First name" className="col-span-2 sm:col-span-1"><Input value={form.firstName} onChange={set("firstName")} className="min-h-[44px] md:min-h-9" /></Field>
            <Field label="Last name" className="col-span-2 sm:col-span-1"><Input value={form.lastName} onChange={set("lastName")} className="min-h-[44px] md:min-h-9" /></Field>
            <Field label="Goes by" className="col-span-2 sm:col-span-1"><Input value={form.preferredName} onChange={set("preferredName")} className="min-h-[44px] md:min-h-9" /></Field>
            <Field label="External ID" className="col-span-2 sm:col-span-1" hint="Yardi / property-management id, if any.">
              <Input value={form.externalId} onChange={set("externalId")} className="min-h-[44px] md:min-h-9" />
            </Field>
            <Field label="Staff notes" className="col-span-2" hint="Internal — never sent to WordPress or other integrations.">
              <Textarea value={form.notes} onChange={set("notes")} />
            </Field>
          </fieldset>
          {editable && (
            <div className="mt-4 flex justify-end gap-2">
              {dirty && (
                <Button variant="secondary" onClick={() => { setLoaded(t); setForm(toForm(t)); }}>Discard</Button>
              )}
              <Button onClick={onSave} disabled={!dirty || save.isPending} className="min-h-[44px] md:h-9 md:min-h-0">
                {save.isPending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          )}
        </Card>

        <div className="grid gap-4 md:grid-cols-2">
          <Card className="page-list-item-enter p-5" style={{ animationDelay: "70ms" }}>
            <p className="kicker mb-3 flex items-center gap-1.5"><ClipboardList className="h-3.5 w-3.5" /> Form activity</p>
            {t.activities.length === 0 ? (
              <EmptyState title="No form activity yet" hint="When a Gravity Form or integration names this person, it shows here and resets the review clock." />
            ) : (
              <ul className="space-y-3">
                {t.activities.map((a) => (
                  <li key={a.id} className="text-[13px]">
                    <p className="font-semibold text-ink">{a.label ?? a.source}</p>
                    <p className="text-micro text-muted">
                      {formatDateTime(a.occurredAt)}
                      {a.externalRef ? ` · ref ${a.externalRef}` : ""}
                      {a.recordedBy ? ` · ${a.recordedBy}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card className="page-list-item-enter p-5" style={{ animationDelay: "105ms" }}>
            <p className="kicker mb-3 flex items-center gap-1.5"><History className="h-3.5 w-3.5" /> History</p>
            {t.history.length === 0 ? (
              <p className="text-[13px] text-muted">Imported {formatDate(t.createdAt)}. No changes since.</p>
            ) : (
              <ul className="space-y-3">
                {t.history.map((h) => (
                  <li key={h.id} className="text-[13px]">
                    <p className="text-ink">{h.summary}</p>
                    <p className="text-micro text-muted">{h.actorName} · {formatDateTime(h.createdAt)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </Page>

      <RemoveDialog
        tenant={removing ? t : null}
        onCancel={() => setRemoving(false)}
        onConfirm={async (reason, note) => {
          setRemoving(false);
          await remove(t, reason, note);
        }}
      />
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-micro font-semibold text-muted">{label}</dt>
      <dd className="mt-0.5 truncate font-semibold text-ink">{value}</dd>
      {hint && <dd className="truncate text-micro text-muted">{hint}</dd>}
    </div>
  );
}
