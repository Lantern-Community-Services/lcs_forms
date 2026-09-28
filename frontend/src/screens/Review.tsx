import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, CheckCircle2, ChevronRight, ChevronsDown, Clock3, Undo2, X } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { LEAN_MS, OUT_MS, DECK_CLASS, RoundAction, SwipeCard, SwipeNote, useDeckPose, type Pose } from "@/components/ui/swipe-card";
import { RemoveDialog } from "@/components/roster/RemoveDialog";
import { ResidentCardHeader } from "@/components/roster/ResidentCardHeader";
import { useRosterActions } from "@/components/roster/useRosterActions";
import { useQueryClient } from "@tanstack/react-query";
import { rosterApi, useReviewQueue } from "@/lib/queries";
import { useToast } from "@/components/ui/toast";
import { SitePicker, useSiteSelection } from "@/lib/site";
import { useAuth } from "@/lib/auth";
import { errorMessage, formatDate, quietFor, relativeTime, tintFor, toggled } from "@/lib/utils";
import type { Tenant } from "@/lib/types";

/** One decision made in this session, newest last — what Undo walks back through. */
interface Decision {
  id: number;
  kind: "keep" | "remove" | "skip";
  tenant: Tenant;
}
const VERB: Record<Decision["kind"], string> = { keep: "keep", remove: "removal", skip: "skip" };
let decisionSeq = 0;

/**
 * The 48-hour review queue.
 *
 * Everyone whose attention clock — the latest of "added", "appeared on a
 * form", "a person confirmed they're here" — is older than the threshold. One
 * card at a time: swipe right (or →) to keep, which restarts their clock; swipe
 * left (or ←) to remove, which always asks for a reason first; swipe down (or ↓)
 * to skip, which sends them to the back of the queue undecided. Buttons do the
 * same for anyone who can't or won't swipe.
 *
 * Cards leave optimistically: the swipe animates immediately and the request
 * follows. A failure puts the card back and says so.
 */
export function ReviewPage() {
  const { can } = useAuth();
  const { codes, setCodes, selected, param } = useSiteSelection();
  const { data, isLoading } = useReviewQueue(param);
  const multiSite = selected.length > 1;
  const { keep, remove } = useRosterActions();
  const qc = useQueryClient();
  const toast = useToast();

  const [handled, setHandled] = useState<Set<string>>(new Set());
  const [skipped, setSkipped] = useState<string[]>([]);
  const { pose, setPose, playOut } = useDeckPose();
  const [confirming, setConfirming] = useState<Tenant | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [history, setHistory] = useState<Decision[]>([]);
  const [undoing, setUndoing] = useState(false);
  /** Someone just brought back by Undo — shown on top, ahead of everyone. */
  const [pinned, setPinned] = useState<string | null>(null);

  // New selection, new queue.
  useEffect(() => {
    setHandled(new Set());
    setSkipped([]);
    setDone(0);
    setHistory([]);
    setPinned(null);
  }, [param]);

  const queue = useMemo(() => {
    const items = (data?.items ?? []).filter((t) => !handled.has(t.id));
    // Undone first, then the queue, then skipped cards in the order they were skipped.
    const rank = (t: Tenant) => (t.id === pinned ? -1 : skipped.includes(t.id) ? 1 + skipped.indexOf(t.id) : 0);
    return [...items].sort((a, b) => rank(a) - rank(b));
  }, [data, handled, skipped, pinned]);

  const top = queue[0];
  const canAct = can("roster.edit");
  const canRemove = can("roster.archive");
  const hours = data?.attentionHours ?? 48;

  const markHandled = (id: string, yes: boolean) => setHandled((h) => toggled(h, id, yes));

  const doKeep = useCallback(
    async (t: Tenant, swiped = false) => {
      if (!canAct || pose) return;
      // Only the top card is on screen to animate; list rows just drop out.
      if (t.id === queue[0]?.id) playOut(t.id, "right", swiped, () => markHandled(t.id, true));
      else markHandled(t.id, true);
      const decision: Decision = { id: ++decisionSeq, kind: "keep", tenant: t };
      const ok = await keep(t, { onUndo: () => void undoRef.current(decision) });
      if (ok) {
        setDone((n) => n + 1);
        setHistory((h) => [...h, decision]);
      }
      // After the exit animation has marked it handled — put the card back.
      else setTimeout(() => markHandled(t.id, false), LEAN_MS + OUT_MS + 100);
    },
    [canAct, pose, keep, queue]
  );

  /**
   * Removal always asks first. The card leans left with REMOVE showing and is
   * held there while the question is open — confirming carries it off to the
   * left, cancelling lets it settle back — so the confirmation reads as the
   * middle of the swipe rather than an interruption of it.
   */
  const askRemove = useCallback(
    (t: Tenant) => {
      if (!canRemove || pose) return;
      if (t.id === queue[0]?.id) setPose({ id: t.id, dir: "left", stage: "lean" });
      setConfirming(t);
    },
    [canRemove, pose, queue]
  );

  function cancelRemove() {
    setConfirming(null);
    setPose(null); // back to the middle
  }

  async function confirmRemove(reason: string, note: string) {
    const t = confirming;
    if (!t) return;
    setBusy(true);
    setConfirming(null);
    // Already leaning — carry straight on out.
    if (t.id === queue[0]?.id) playOut(t.id, "left", true, () => markHandled(t.id, true));
    else markHandled(t.id, true);
    const decision: Decision = { id: ++decisionSeq, kind: "remove", tenant: t };
    const ok = await remove(t, reason, note, { onUndo: () => void undoRef.current(decision) });
    setBusy(false);
    if (ok) {
      setDone((n) => n + 1);
      setHistory((h) => [...h, decision]);
    }
    else setTimeout(() => markHandled(t.id, false), LEAN_MS + OUT_MS + 100);
  }

  /**
   * Skip: no decision, just "not now". The card drops away and the person goes
   * to the back of this session's queue — they're still due for review, and
   * come round again after everyone else.
   */
  const skip = useCallback(
    (t: Tenant, swiped = false) => {
      if (pose) return;
      setHistory((h) => [...h, { id: ++decisionSeq, kind: "skip", tenant: t }]);
      if (pinned === t.id) setPinned(null);
      const toBack = () => setSkipped((s) => [...s.filter((id) => id !== t.id), t.id]);
      if (t.id !== queue[0]?.id || queue.length === 1) return toBack();
      playOut(t.id, "down", swiped, toBack);
    },
    [pose, queue, pinned]
  );

  /**
   * Walk back one decision — the latest, or a specific one (a toast's Undo).
   * The person comes back on top of the stack, exactly as they were: a keep is
   * reversed on the server (their old "confirmed" time is restored), a removal
   * is restored without counting as a confirmation, and a skip just un-skips.
   */
  async function undo(target?: Decision) {
    const d = target ?? history[history.length - 1];
    if (!d || undoing || pose) return;
    setHistory((h) => h.filter((x) => x.id !== d.id));
    setUndoing(true);
    try {
      if (d.kind === "keep") await rosterApi.undoKeep(d.tenant.id);
      if (d.kind === "remove") await rosterApi.restore(d.tenant.id);
      if (d.kind !== "skip") setDone((n) => Math.max(0, n - 1));
      setSkipped((s) => s.filter((id) => id !== d.tenant.id));
      markHandled(d.tenant.id, false);
      setPinned(d.tenant.id);
      await qc.invalidateQueries({ queryKey: ["roster"] });
      toast(`Undid ${VERB[d.kind]} — ${d.tenant.displayName} is back.`, "info");
    } catch (e) {
      toast(errorMessage(e, "Couldn't undo that."), "error");
    } finally {
      setUndoing(false);
    }
  }
  // Toast buttons are created before the decision settles; a ref keeps them
  // calling the current undo, with the current history.
  const undoRef = useRef(undo);
  undoRef.current = undo;
  const last = history[history.length - 1];

  // Keyboard: ← remove, → keep, ↓ or S skip — only while no dialog is open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (confirming || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void undoRef.current();
        return;
      }
      if (!top) return;
      if (e.key === "ArrowRight") void doKeep(top);
      else if (e.key === "ArrowLeft") askRemove(top);
      else if (e.key === "ArrowDown" || e.key.toLowerCase() === "s") {
        e.preventDefault(); // ↓ would otherwise scroll the page
        skip(top);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [top, confirming, doKeep, askRemove, skip]);

  const subtitle = `Not on any form or confirmed in ${hours}+ hours`;

  // overflow-clip: a card flying off the deck must not grow the page's scroll area.
  return (
    <div className="flex min-h-full flex-col overflow-clip">
      <PhoneHeader title="Review" subtitle={subtitle}>
        <SitePicker codes={codes} onChange={setCodes} className="mt-3" />
      </PhoneHeader>

      <Page className="w-full max-w-[980px] flex-1">
        <div className="hidden md:block">
          <PageHeader
            title="Review"
            subtitle={`${subtitle}. Swipe or use ← ↓ → to decide.`}
            actions={<SitePicker codes={codes} onChange={setCodes} className="w-[260px]" />}
          />
        </div>

        {isLoading ? (
          <LoadingState label="Loading the queue…" />
        ) : !top ? (
          <Card className="page-list-item-enter">
            {last && (
              <div className="flex justify-end px-3 pt-3">
                <UndoButton last={last} busy={undoing} onUndo={() => void undo()} />
              </div>
            )}
            <EmptyState
              icon={<CheckCircle2 className="h-10 w-10 text-status-greenDot" />}
              title={done ? `All caught up — ${done} reviewed` : "All caught up"}
              hint={
                selected.length === 0
                  ? "You aren't assigned to any sites yet. Ask an administrator to add you to one."
                  : `Everyone ${multiSite ? `across ${selected.length} sites ` : "here "}has been on a form or confirmed in the last ${hours} hours.`
              }
            />
          </Card>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_1fr] lg:items-start">
            <div>
              <div className="flex min-h-[40px] items-center justify-between gap-3 text-[13px] text-muted">
                <p className="min-w-0">
                  <strong className="tabular text-ink">{queue.length}</strong> to review
                  {done > 0 && <> · {done} done</>}
                  {skipped.length > 0 && <> · {skipped.length} skipped</>}
                </p>
                <UndoButton last={last} busy={undoing || Boolean(pose)} onUndo={() => void undo()} />
              </div>

              {/* The mask: a card is clipped once it leaves this band (vertically —
                  the page root clips it sideways) rather than sliding over the
                  counts above or the tab bar below. */}
              <div className="overflow-y-clip pt-3">
              <div className={DECK_CLASS}>
                {queue.slice(0, 3).reverse().map((t) => {
                  const depth = queue.indexOf(t);
                  return (
                    <ReviewCard
                      key={t.id}
                      tenant={t}
                      depth={depth}
                      hours={hours}
                      showSite={multiSite}
                      pose={pose?.id === t.id ? pose : null}
                      canKeep={canAct}
                      canRemove={canRemove}
                      onSwipeRight={() => void doKeep(t, true)}
                      onSwipeLeft={() => askRemove(t)}
                      onSwipeDown={() => skip(t, true)}
                    />
                  );
                })}
              </div>

              {(canAct || canRemove) && (
                <div className="mt-5 flex items-center justify-center gap-6">
                  <RoundAction label="Remove" tone="red" disabled={!canRemove || Boolean(pose)} onClick={() => askRemove(top)}>
                    <X className="h-7 w-7" strokeWidth={2.6} />
                  </RoundAction>
                  {/* Smaller than its neighbours: skipping decides nothing. */}
                  <RoundAction label="Skip" tone="blue" size="sm" disabled={Boolean(pose) || queue.length < 2} onClick={() => skip(top)}>
                    <ChevronsDown className="h-6 w-6" strokeWidth={2.4} />
                  </RoundAction>
                  <RoundAction label="Keep" tone="green" disabled={!canAct || Boolean(pose)} onClick={() => void doKeep(top)}>
                    <Check className="h-7 w-7" strokeWidth={2.6} />
                  </RoundAction>
                </div>
              )}
              <p className="mt-3 text-center text-micro text-muted">
                Swipe left to remove · down to skip · right if they're still here
              </p>
              </div>
            </div>

            {/* Wide screens: the rest of the queue, actionable in place. From 1024px up —
                below that (iPad portrait) there is no room beside the card. */}
            <Card className="hidden lg:block">
              <p className="kicker border-b border-hairline px-4 py-3">Up next</p>
              <ul className="max-h-[520px] overflow-y-auto scroll-thin">
                {queue.slice(1, 40).map((t) => (
                  <li key={t.id} className="flex items-center gap-3 border-b border-hairline px-4 py-2.5 last:border-0">
                    <Avatar name={t.displayName} color={tintFor(t.id)} size={30} />
                    <Link to={`/tenants/${t.id}`} className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-semibold text-ink">{t.displayName}</p>
                      <p className="truncate text-micro text-muted">
                        {[t.unit && `Unit ${t.unit}`, multiSite && t.site?.name, `quiet ${quietFor(t.hoursQuiet)}`].filter(Boolean).join(" · ")}
                      </p>
                    </Link>
                    {canRemove && (
                      <Button size="sm" variant="secondary" onClick={() => askRemove(t)} title="Remove">
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {canAct && (
                      <Button size="sm" variant="secondary" onClick={() => void doKeep(t)} title="Keep">
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </li>
                ))}
                {queue.length === 1 && <li className="px-4 py-6 text-center text-[13px] text-muted">This is the last one.</li>}
              </ul>
            </Card>
          </div>
        )}
      </Page>

      <RemoveDialog tenant={confirming} busy={busy} onCancel={cancelRemove} onConfirm={confirmRemove} />
    </div>
  );
}

/** "Undo keep · Oneil W." — says exactly what it will put back. Hidden when there's nothing to undo. */
function UndoButton({ last, busy, onUndo }: { last?: Decision; busy: boolean; onUndo: () => void }) {
  if (!last) return null;
  const first = last.tenant.preferredName || last.tenant.firstName;
  const initial = last.tenant.lastName ? ` ${last.tenant.lastName[0]}.` : "";
  return (
    <button
      type="button"
      onClick={onUndo}
      disabled={busy}
      title={`Undo ${VERB[last.kind]} of ${last.tenant.displayName} (Ctrl/⌘+Z)`}
      className="inline-flex min-h-[40px] max-w-[60%] shrink-0 items-center gap-1.5 rounded-pill border border-hairline bg-surface px-3 text-[12.5px] font-semibold text-ink shadow-card transition-colors hover:border-strongline disabled:opacity-50"
    >
      <Undo2 className="h-3.5 w-3.5 shrink-0 text-accent dark:text-white" />
      <span className="truncate">
        Undo {VERB[last.kind]} <span className="text-muted">· {first}{initial}</span>
      </span>
    </button>
  );
}

function ReviewCard({
  tenant: t, depth, hours, showSite, pose, canKeep, canRemove, onSwipeLeft, onSwipeRight, onSwipeDown,
}: {
  tenant: Tenant;
  depth: number;
  hours: number;
  showSite: boolean;
  pose: Pose | null;
  canKeep: boolean;
  canRemove: boolean;
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
  onSwipeDown: () => void;
}) {
  const lastSeen = t.lastActivityAt
    ? { label: `Last on a form ${relativeTime(t.lastActivityAt)}`, detail: t.lastActivitySource }
    : t.lastKeptAt
      ? { label: `Last confirmed ${relativeTime(t.lastKeptAt)}`, detail: null }
      : { label: "No form activity on record", detail: `on roster since ${formatDate(t.createdAt)}` };

  return (
    <SwipeCard
      depth={depth}
      pose={pose}
      rightLabel="KEEP"
      leftLabel="REMOVE"
      canRight={canKeep}
      canLeft={canRemove}
      onSwipeLeft={onSwipeLeft}
      onSwipeRight={onSwipeRight}
      onSwipeDown={onSwipeDown}
    >
      <ResidentCardHeader tenant={t} showSite={showSite} />
      <SwipeNote tone="bg-status-amberBg text-status-amberText" icon={<Clock3 className="h-4 w-4" />} title={`Quiet for ${quietFor(t.hoursQuiet)}`}>
        {lastSeen.label}
        {lastSeen.detail ? ` · ${lastSeen.detail}` : ""}
      </SwipeNote>

      <span className="flex-1" />
      <Link
        to={`/tenants/${t.id}`}
        className="inline-flex min-h-[40px] items-center gap-1 text-[13px] font-semibold text-accent dark:text-white"
      >
        Open profile <ChevronRight className="h-4 w-4" />
      </Link>
      <p className="text-micro text-muted">Threshold {hours}h{t.moveInDate ? ` · moved in ${formatDate(t.moveInDate)}` : ""}</p>
    </SwipeCard>
  );
}
