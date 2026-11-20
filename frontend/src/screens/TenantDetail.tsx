import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ClipboardList, History, ListChecks, Pencil, RotateCcw, UserPen } from "lucide-react";
import { ChangeList } from "@/components/roster/ChangeList";
import { DoneFrom } from "@/components/roster/DoneFrom";
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
import { HighAcuityFlag, HighAcuityToggle } from "@/components/roster/HighAcuity";
import { ClientInfoCard } from "@/components/roster/ClientInfo";
import { DocumentsCard, TimelineCard } from "@/components/roster/ClientRecord";
import { ResidencyCards } from "@/components/residency/ResidencyCards";
import { useResidencyFor } from "@/lib/residency";
import { useRosterActions } from "@/components/roster/useRosterActions";
import { rosterApi, useRosterMutation, useSites, useTenant } from "@/lib/queries";
import { useAuth, useCaseManagement } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { cn, errorMessage, formatDate, formatDateInput, formatDateTime, quietFor, relativeTime, tintFor } from "@/lib/utils";
import type { Tenant } from "@/lib/types";

type FormState = { unit: string; firstName: string; lastName: string; preferredName: string; moveInDate: string; notes: string; externalId: string; highAcuity: boolean };
const toForm = (t: Tenant): FormState => ({
  unit: t.unit ?? "",
  firstName: t.firstName,
  lastName: t.lastName,
  preferredName: t.preferredName ?? "",
  moveInDate: formatDateInput(t.moveInDate),
  notes: t.notes ?? "",
  externalId: t.externalId ?? "",
  highAcuity: t.highAcuity,
});

export function TenantDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const caseManagement = useCaseManagement();
  const { data: allSites } = useSites();
  const residencyFor = useResidencyFor();
  const toast = useToast();
  const { data: t, isLoading } = useTenant(id);
  const { remove, keep, restore, sendToReview } = useRosterActions();
  const [form, setForm] = useState<FormState | null>(null);
  /** The version of the record the form was filled from — what a save is checked against. */
  const [loaded, setLoaded] = useState<Tenant | null>(null);
  const [conflict, setConflict] = useState<Tenant | null>(null);
  const [removing, setRemoving] = useState(false);
  /** Details show as a read view; Edit opens the fields (and they stay open while there are unsaved edits or a conflict). */
  const [editingOn, setEditing] = useState(false);
  const save = useRosterMutation((body: Record<string, unknown>) => rosterApi.update(id!, body));

  const dirty = Boolean(form && loaded && JSON.stringify(form) !== JSON.stringify(toForm(loaded)));
  const editing = editingOn || dirty || Boolean(conflict);

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
  // Case management at a supportive site: the unit and move-in come from Move in / transfers (Home, below).
  const units = residencyFor(allSites?.find((s) => s.id === t.siteId));
  // Away, or not moved in yet: out of review, so no Still here / Send to review.
  const onHold = t.movedIn === false || Boolean(t.awaySince);
  const set = (k: Exclude<keyof FormState, "highAcuity">) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
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
        highAcuity: form!.highAcuity,
      });
      setLoaded(updated);
      setForm(toForm(updated));
      setConflict(null);
      setEditing(false);
      toast("Saved.");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setConflict((e.details as { current: Tenant }).current);
      } else toast(errorMessage(e, "Could not save."), "error");
    }
  }

  const where = [t.unit && `Unit ${t.unit}`, t.site?.name].filter(Boolean).join(" · ");

  // The three roster actions: a row of buttons on a computer, three big tiles on a phone or tablet.
  const actionClass = "md:flex-none touch:h-auto touch:min-h-[64px] touch:flex-col touch:gap-1 touch:px-1 touch:py-2 touch:whitespace-normal touch:text-center";

  return (
    <div className="flex min-h-full flex-col">
      {/* The card below carries the name, so the phone header is just the way back. */}
      <PhoneHeader back={{ to: "/roster", label: t.site?.name ?? "Roster" }} />
      <Page className="w-full max-w-[880px]">
        <DesktopBackLink to="/roster">{t.site?.name ?? "Roster"}</DesktopBackLink>

        <Card className="page-list-item-enter mb-4 p-5">
          <div className="flex flex-wrap items-center gap-4">
            <Avatar name={t.displayName} color={tintFor(t.id)} size={56} />
            <div className="min-w-0 flex-1">
              <h1 className="text-title-sm font-heading font-extrabold text-ink md:text-title">{t.displayName}</h1>
              <p className="text-label text-muted">
                {where}
                {t.preferredName && ` · legal name ${t.firstName} ${t.lastName}`}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <TenantStatusBadge status={t.status} needsAttention={t.needsAttention && can("roster.archive")} />
                {t.highAcuity && <HighAcuityFlag />}
                {t.status === "active" && t.movedIn === false && (
                  <span className="rounded-pill bg-status-amberBg px-2 py-0.5 text-micro font-bold text-status-amberText">Not moved in</span>
                )}
                {t.status === "active" && t.awaySince && (
                  <span className="rounded-pill bg-subtle2 px-2 py-0.5 text-micro font-bold text-ink" title={t.awayReason ?? undefined}>Away</span>
                )}
              </div>
            </div>
            {/* Equal columns that wrap to whatever is offered, so nothing runs off a phone screen. */}
            <div className="grid w-full auto-cols-fr grid-flow-col gap-2 md:flex md:w-auto">
              {t.status === "active" ? (
                <>
                  {can("roster.edit") && !onHold && (
                    <Button variant="secondary" onClick={() => void keep(t)} className={actionClass}>
                      <CheckCircle2 className="h-4 w-4 touch:h-5 touch:w-5" /> Still here
                    </Button>
                  )}
                  {can("roster.edit") && !t.needsAttention && !onHold && (
                    <Button variant="secondary" onClick={() => void sendToReview(t)} className={actionClass} aria-label="Send to review">
                      <ListChecks className="h-4 w-4 touch:h-5 touch:w-5" />
                      Send to review
                    </Button>
                  )}
                  {can("roster.archive") && (
                    <Button variant="outlineDanger" onClick={() => setRemoving(true)} className={actionClass}>
                      <RemoveResidentIcon className="h-4 w-4 touch:h-5 touch:w-5" /> Remove
                    </Button>
                  )}
                </>
              ) : (
                can("roster.restore") && (
                  <Button onClick={() => void restore(t)} className="min-h-[44px] md:h-9 md:min-h-0">
                    <RotateCcw className="h-4 w-4" /> Restore to roster
                  </Button>
                )
              )}
            </div>
          </div>

          <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-hairline pt-4 text-label">
            <Stat label="Last on a form" value={t.lastActivityAt ? relativeTime(t.lastActivityAt) : "Never"} hint={t.lastActivitySource ?? undefined} />
            <Stat label="Last confirmed" value={t.lastKeptAt ? relativeTime(t.lastKeptAt) : "Not yet"} />
            <Stat label="Quiet for" value={t.status === "active" ? quietFor(t.hoursQuiet) : "—"} />
          </dl>
          {t.sentToReview && can("roster.archive") && (
            <p className="mt-4 rounded-input bg-status-amberBg px-3 py-2 text-label text-status-amberText">
              Sent back to review. They stay in Review until someone confirms they're still here or removes them.
            </p>
          )}
          {t.status === "archived" && (
            <p className="mt-4 rounded-input bg-subtle px-3 py-2 text-label text-ink">
              Removed {formatDate(t.archivedAt)} — {t.archiveReason}
            </p>
          )}
        </Card>

        <Card className="page-list-item-enter mb-4 p-5" style={{ animationDelay: "35ms" }}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="font-heading text-lead font-extrabold text-ink">Details</h2>
            {editable && !editing && (
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
            )}
          </div>
          {!editing && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-body">
              <Detail label="Unit / bed" value={t.unit} />
              <Detail label="Move-in date" value={t.moveInDate ? formatDate(t.moveInDate) : null} />
              <Detail label="First name" value={t.firstName} />
              <Detail label="Last name" value={t.lastName} />
              <Detail label="Goes by" value={t.preferredName} />
              <Detail label="Yardi ID" value={t.externalId} />
              <Detail label="High Acuity" value={t.highAcuity ? "Yes" : "No"} />
              <Detail label="Staff notes" value={t.notes} className="col-span-2 whitespace-pre-wrap" />
            </dl>
          )}
          {editing && conflict && (
            <div className="mb-4 rounded-card border border-status-amberDot/40 bg-status-amberBg p-3 text-label text-status-amberText">
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
          {editing && (
            <fieldset disabled={!editable} className="grid grid-cols-2 gap-3">
              <Field label="Unit / bed" hint={units ? "Set by Move in or Move to another unit, under Home." : undefined}>
                <Input value={form.unit} onChange={set("unit")} disabled={units} className="min-h-[44px] md:min-h-9" />
              </Field>
              <Field label="Move-in date" hint={units ? "Set by Move in." : undefined}>
                <Input type="date" value={form.moveInDate} onChange={set("moveInDate")} disabled={units} className="min-h-[44px] md:min-h-9" />
              </Field>
              <Field label="First name" className="col-span-2 sm:col-span-1"><Input value={form.firstName} onChange={set("firstName")} className="min-h-[44px] md:min-h-9" /></Field>
              <Field label="Last name" className="col-span-2 sm:col-span-1"><Input value={form.lastName} onChange={set("lastName")} className="min-h-[44px] md:min-h-9" /></Field>
              <Field label="Goes by" className="col-span-2 sm:col-span-1"><Input value={form.preferredName} onChange={set("preferredName")} className="min-h-[44px] md:min-h-9" /></Field>
              <Field label="Yardi ID" className="col-span-2 sm:col-span-1" hint="The property-management ID, if there is one.">
                <Input value={form.externalId} onChange={set("externalId")} className="min-h-[44px] md:min-h-9" />
              </Field>
              <HighAcuityToggle className="col-span-2" checked={form.highAcuity} onChange={(v) => setForm((f) => ({ ...f!, highAcuity: v }))} disabled={!editable} />
              <Field label="Staff notes" className="col-span-2" hint="Staff only: never sent outside Lantern Forms.">
                <Textarea value={form.notes} onChange={set("notes")} />
              </Field>
            </fieldset>
          )}
          {editable && editing && (
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setLoaded(t);
                  setForm(toForm(t));
                  setConflict(null);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
              <Button onClick={onSave} disabled={!dirty || save.isPending} className="min-h-[44px] md:h-9 md:min-h-0">
                {save.isPending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          )}
        </Card>

        {/* Part of the case management rework: only when it's on for this site (Admin → Settings). */}
        {units && <ResidencyCards tenant={t} />}
        {caseManagement && <ClientInfoCard tenant={t} />}
        {caseManagement && can("clients.view") && (
          <>
            <DocumentsCard tenant={t} />
            <TimelineCard tenant={t} />
          </>
        )}

        <div className="grid items-start gap-4 md:grid-cols-2">
          <Card className="page-list-item-enter p-5" style={{ animationDelay: "70ms" }}>
            <p className="kicker mb-3 flex items-center gap-1.5"><ClipboardList className="h-3.5 w-3.5" /> Form activity</p>
            {t.activities.length === 0 ? (
              <EmptyState title="No form activity yet" hint="When a form names this person, it shows here and resets the review clock." />
            ) : (
              <ul className="space-y-3">
                {t.activities.map((a) => (
                  <li key={a.id} className="text-label">
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
          {(t.nameHistory?.length ?? 0) > 0 && (
            <Card className="page-list-item-enter p-5" style={{ animationDelay: "90ms" }}>
              <p className="kicker mb-3 flex items-center gap-1.5"><UserPen className="h-3.5 w-3.5" /> Previous names</p>
              <ul className="space-y-3">
                {t.nameHistory!.map((n, i) => (
                  <li key={`${n.at}-${i}`} className="text-label">
                    <p className="text-ink"><span className="font-semibold">{n.from}</span> <span className="text-muted">→</span> {n.to}</p>
                    <p className="text-micro text-muted">Changed by {n.by} · {formatDateTime(n.at)}</p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card className="page-list-item-enter p-5" style={{ animationDelay: "105ms" }}>
            <p className="kicker mb-3 flex items-center gap-1.5"><History className="h-3.5 w-3.5" /> History</p>
            {t.history.length === 0 ? (
              <p className="text-label text-muted">Imported {formatDate(t.createdAt)}. No changes since.</p>
            ) : (
              <ul className="space-y-3">
                {t.history.map((h) => (
                  <li key={h.id} className="text-label">
                    <p className="text-ink">{h.summary}</p>
                    <ChangeList event={h} />
                    <p className="text-micro text-muted">{h.actorName} · {formatDateTime(h.createdAt)}</p>
                    <DoneFrom e={h} />
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

/** One line of the read view: the label above, the value (or a quiet "Not set"). */
function Detail({ label, value, className }: { label: string; value: string | null | undefined; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-caption font-semibold text-muted">{label}</dt>
      <dd className={cn("mt-0.5 break-words", value ? "font-semibold text-ink" : "text-muted")}>{value || "Not set"}</dd>
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
