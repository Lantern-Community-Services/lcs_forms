import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRightLeft, CalendarClock, CheckCircle2, DoorOpen, Home, LogIn, LogOut, Pencil, Plane, RotateCcw, Users } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { AwayDialog, HouseholdDialog, MoveInDialog, MoveOutDialog, ReturnedDialog, TransferDialog } from "@/components/residency/Dialogs";
import { fmtDay, residencyApi, shortRelation, todayLocal, useResidency, useResidencyRefresh, type Occupant, type ResidencyView, type TaskRow } from "@/lib/residency";
import { useSites } from "@/lib/queries";
import { cn, errorMessage } from "@/lib/utils";
import type { Tenant } from "@/lib/types";

/**
 * A resident's home and checklist (case management, supportive sites): their
 * unit, household, time away, every stay, and the paperwork due. The actions —
 * move in, move to another unit, away / back, move out — open the dialogs.
 */
export function ResidencyCards({ tenant }: { tenant: Tenant }) {
  const { data, isLoading } = useResidency(tenant.id, true);
  const { data: sites } = useSites();
  const site = sites?.find((s) => s.id === tenant.siteId);
  const [dialog, setDialog] = useState<null | "in" | "transfer" | "out" | "away" | "back">(null);
  const [member, setMember] = useState<Occupant | null>(null);

  if (isLoading || !data) {
    return <Card className="mb-4 flex items-center gap-2 p-5 text-[13px] text-muted"><Spinner className="h-4 w-4" /> Loading home…</Card>;
  }
  if (!data.on) return null;
  const v = data as Extract<ResidencyView, { on: true }>;
  const active = tenant.status === "active";
  const head = v.household.find((h) => h.head) ?? null;
  const current = v.stays.find((s) => !s.moveOutDate);

  return (
    <>
      <Card className="page-list-item-enter mb-4 p-5" style={{ animationDelay: "45ms" }}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="kicker flex items-center gap-1.5"><Home className="h-3.5 w-3.5" /> Home</p>
          {active && (
            <div className="flex flex-wrap gap-2">
              {v.can.move && !v.unit && (
                <Button size="sm" onClick={() => setDialog("in")}><LogIn className="h-3.5 w-3.5" /> Move in</Button>
              )}
              {v.can.move && v.unit && (
                <Button size="sm" variant="secondary" onClick={() => setDialog("transfer")}><ArrowRightLeft className="h-3.5 w-3.5" /> Move to another unit</Button>
              )}
              {v.can.move && v.unit && !v.away && (
                <Button size="sm" variant="secondary" onClick={() => setDialog("away")}><Plane className="h-3.5 w-3.5" /> Away</Button>
              )}
              {v.can.move && v.away && (
                <Button size="sm" variant="secondary" onClick={() => setDialog("back")}><RotateCcw className="h-3.5 w-3.5" /> They're back</Button>
              )}
              {v.can.moveOut && v.movedIn && (
                <Button size="sm" variant="outlineDanger" onClick={() => setDialog("out")}><LogOut className="h-3.5 w-3.5" /> Move out</Button>
              )}
            </div>
          )}
        </div>

        {!active ? (
          <p className="text-[13px] text-muted">Not on the roster now. Their stays are below.</p>
        ) : !v.unit ? (
          <p className="rounded-input bg-status-amberBg px-3 py-2 text-[13px] text-status-amberText">
            {v.movedIn ? "No unit recorded yet." : "On the roster, not moved in yet."} Move them in to give them a unit, start their stay and their checklist.
            {!v.movedIn && " Until then they aren't in form resident lists or the review queue."}
          </p>
        ) : (
          <dl className="grid grid-cols-2 gap-3 text-[13px] md:grid-cols-4">
            <Stat label="Unit" value={v.unit.label} hint={v.unit.unitType ?? undefined} />
            <Stat label="Moved in" value={fmtDay(current?.moveInDate)} hint={current ? `${current.days} days` : undefined} />
            <Stat label="Program" value={current?.program ?? v.unit.program ?? "—"} />
            <Stat label="Status" value={v.away ? `Away since ${fmtDay(v.away.lastSeen)}` : "Living here"} hint={v.away ? `${v.away.reason}${v.away.detail ? ` · ${v.away.detail}` : ""}` : undefined} />
          </dl>
        )}
        {v.away?.expectedReturn && <p className="mt-2 text-micro text-muted">Expected back {fmtDay(v.away.expectedReturn)}.</p>}

        {v.households && v.household.length > 0 && (
          <div className="mt-4 border-t border-hairline pt-3">
            <p className="mb-2 flex items-center gap-1.5 text-micro font-semibold text-muted"><Users className="h-3.5 w-3.5" /> Household</p>
            <ul className="space-y-1.5 text-[13px]">
              {v.household.map((h) => (
                <li key={h.id} className="flex items-center gap-2">
                  {h.id === tenant.id ? <span className="font-semibold text-ink">{h.displayName}</span> : <Link to={`/tenants/${h.id}`} className="font-semibold text-accent hover:underline">{h.displayName}</Link>}
                  <span className="text-muted">· {h.head ? "Head of household" : shortRelation(h.relation) ?? "Relation not recorded"}{h.away ? " · away" : ""}</span>
                  {v.can.move && !h.head && active && (
                    <button type="button" onClick={() => setMember(h)} className="ml-auto inline-flex items-center gap-1 text-micro font-semibold text-accent hover:underline" aria-label={`Change ${h.displayName}'s relation`}>
                      <Pencil className="h-3 w-3" /> Change
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {v.stays.length > 0 && (
          <div className="mt-4 border-t border-hairline pt-3">
            <p className="mb-2 flex items-center gap-1.5 text-micro font-semibold text-muted"><DoorOpen className="h-3.5 w-3.5" /> Stays</p>
            <ul className="space-y-2 text-[13px]">
              {v.stays.map((s) => (
                <li key={s.id}>
                  <p className="text-ink">
                    <span className="font-semibold">{s.unitLabel ? `Unit ${s.unitLabel}` : "No unit"}</span> · {s.siteName}
                    {s.program ? <span className="text-muted"> · {s.program}</span> : null}
                  </p>
                  <p className="text-micro text-muted">
                    {s.startKind === "transferred" ? "Transferred in" : "Moved in"} {fmtDay(s.moveInDate)}
                    {s.moveOutDate
                      ? ` → ${s.endKind === "transferred" ? "transferred out" : s.endKind === "removed" ? "removed" : "moved out"} ${fmtDay(s.moveOutDate)}${s.endReason ? ` — ${s.endReason}` : ""}`
                      : " → now"}
                    {` · ${s.days} days`}
                  </p>
                  {s.exitDestination && <p className="text-micro text-muted">Went to: {s.exitDestination}</p>}
                  {s.forwardingAddress && <p className="text-micro text-muted">Forwarding: {[s.forwardingAddress.line1, s.forwardingAddress.line2, s.forwardingAddress.city, s.forwardingAddress.state, s.forwardingAddress.zip].filter(Boolean).join(", ")}</p>}
                  {s.endNote && <p className="text-micro text-muted">{s.endNote}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {v.absences.some((a) => a.outcome) && (
          <details className="mt-3 text-[13px]">
            <summary className="cursor-pointer text-micro font-semibold text-muted">Earlier time away</summary>
            <ul className="mt-2 space-y-1">
              {v.absences.filter((a) => a.outcome).map((a) => (
                <li key={a.id} className="text-micro text-muted">
                  {fmtDay(a.lastSeen)} → {a.returnedOn ? fmtDay(a.returnedOn) : "moved out"} · {a.days} days · {a.reason}{a.detail ? ` (${a.detail})` : ""}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      <ChecklistCard tasks={v.tasks} canTick={v.can.tick} />

      {site && <MoveInDialog open={dialog === "in"} onOpenChange={(o) => !o && setDialog(null)} site={site} tenant={tenant} />}
      {dialog === "transfer" && <TransferDialog open onOpenChange={(o) => !o && setDialog(null)} tenant={tenant} household={v.household} />}
      {dialog === "out" && (
        <MoveOutDialog open onOpenChange={(o) => !o && setDialog(null)} tenant={tenant} household={v.household} awaySince={v.away?.lastSeen} onTransfer={() => setDialog("transfer")} />
      )}
      {dialog === "away" && <AwayDialog open onOpenChange={(o) => !o && setDialog(null)} tenant={tenant} />}
      {dialog === "back" && <ReturnedDialog open onOpenChange={(o) => !o && setDialog(null)} tenant={tenant} since={v.away?.lastSeen} />}
      <HouseholdDialog open={Boolean(member)} onOpenChange={(o) => !o && setMember(null)} member={member} head={head} />
    </>
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

// ── Checklist ────────────────────────────────────────────────────────────

export function ChecklistCard({ tasks, canTick }: { tasks: TaskRow[]; canTick: boolean }) {
  const open = tasks.filter((t) => t.status === "open");
  const done = tasks.filter((t) => t.status === "done" || t.status === "skipped").sort((a, b) => (b.doneOn ?? "").localeCompare(a.doneOn ?? ""));
  if (!tasks.length) return null;
  const late = open.filter((t) => (t.overdueDays ?? 0) > 0).length;
  return (
    <Card className="page-list-item-enter mb-4 p-5" style={{ animationDelay: "55ms" }}>
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <p className="kicker flex items-center gap-1.5"><CalendarClock className="h-3.5 w-3.5" /> Checklist</p>
        <p className="text-micro text-muted">{open.length} open{late ? ` · ${late} overdue` : ""}</p>
      </div>
      {open.length === 0 ? (
        <p className="text-[13px] text-muted">Nothing due.</p>
      ) : (
        <ul className="divide-y divide-hairline">
          {open.map((t) => <TaskLine key={t.id} task={t} canTick={canTick} />)}
        </ul>
      )}
      {done.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-micro font-semibold text-muted">Done ({done.length})</summary>
          <ul className="mt-2 space-y-1.5">
            {done.map((t) => (
              <li key={t.id} className="flex items-start gap-2 text-[13px]">
                <CheckCircle2 className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", t.status === "done" ? "text-status-greenDot" : "text-muted")} />
                <span className="min-w-0">
                  <span className="text-ink">{t.label}</span>
                  <span className="block text-micro text-muted">
                    {t.status === "skipped" ? "Not needed" : "Done"} {fmtDay(t.doneOn)}{t.doneByName ? ` by ${t.doneByName}` : ""} · was due {fmtDay(t.dueOn)}
                    {t.entryRef ? " · from a form" : ""}{t.note ? ` · ${t.note}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

/** One open task: due date, and Done / Not needed. */
/** `formLink`: a link to the form that does it (the caseload's to-do list). */
export function TaskLine({ task, canTick, showResident = false, formLink = false }: { task: TaskRow; canTick: boolean; showResident?: boolean; formLink?: boolean }) {
  const toast = useToast();
  const refresh = useResidencyRefresh();
  const [mode, setMode] = useState<null | "done" | "skipped">(null);
  const [date, setDate] = useState(todayLocal());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const overdue = (task.overdueDays ?? 0) > 0;
  const dueText =
    task.overdueDays === null ? "" : overdue ? `${task.overdueDays} ${task.overdueDays === 1 ? "day" : "days"} overdue` : task.overdueDays === 0 ? "due today" : `due in ${-task.overdueDays} ${task.overdueDays === -1 ? "day" : "days"}`;

  async function save() {
    if (mode === "skipped" && !note.trim()) return toast("Say why it isn't needed.", "error");
    setBusy(true);
    try {
      const r = await residencyApi.task(task.id, { status: mode!, doneOn: date, note: note.trim() || null });
      await refresh();
      toast(r.next ? `Done. Next one due ${fmtDay(r.next.dueOn)}.` : "Done.");
      setMode(null);
    } catch (e) {
      toast(errorMessage(e, "Could not save."), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">
          {showResident && task.resident && (
            <Link to={`/tenants/${task.resident.id}`} className="block truncate text-[13.5px] font-semibold text-accent hover:underline">
              {task.resident.displayName}{task.resident.unit ? <span className="font-normal text-muted"> · {task.resident.unit}</span> : null}
            </Link>
          )}
          <span className="block text-[13.5px] text-ink">
            {task.label}
            {formLink && task.forms[0] && (
              <Link to={`/f/${task.forms[0]}`} className="ml-2 text-[12.5px] font-semibold text-accent hover:underline dark:text-white">Open form</Link>
            )}
          </span>
          <span className={cn("block text-micro", overdue ? "font-semibold text-status-redText" : "text-muted")}>
            {fmtDay(task.dueOn)}{dueText ? ` · ${dueText}` : ""}{showResident && task.caseLead ? ` · case lead ${task.caseLead.name}` : ""}
          </span>
        </span>
        {canTick && !mode && (
          <span className="flex gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => { setMode("done"); setDate(todayLocal()); setNote(""); }}>Done</Button>
            <Button size="sm" variant="ghost" onClick={() => { setMode("skipped"); setDate(todayLocal()); setNote(""); }}>Not needed</Button>
          </span>
        )}
      </div>
      {mode && (
        <div className="mt-2 grid gap-2 rounded-input bg-subtle p-2 sm:grid-cols-[150px_1fr_auto]">
          <Input type="date" value={date} max={todayLocal()} onChange={(e) => setDate(e.target.value)} aria-label="Done on" className="min-h-[40px]" />
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={mode === "skipped" ? "Why isn't it needed? (required)" : "Note (optional)"} maxLength={2000} className="min-h-[40px]" />
          <span className="flex gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => setMode(null)} disabled={busy}>Cancel</Button>
            <Button size="sm" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
          </span>
        </div>
      )}
    </li>
  );
}
