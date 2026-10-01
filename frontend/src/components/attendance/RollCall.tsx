import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsDown, CircleDashed, Search, Undo2, X } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { DECK_CLASS, RoundAction, SwipeCard, SwipeNote, useDeckPose } from "@/components/ui/swipe-card";
import { ResidentCardHeader } from "@/components/roster/ResidentCardHeader";
import { cn, formatDate, tintFor } from "@/lib/utils";
import type { Tenant } from "@/lib/types";
import { SignaturePanel } from "./SignaturePrompt";

type Choice = { status: "here"; signature: string | null } | { status: "not-here" };
type Decision = { tenantId: string; before?: Choice; skippedBefore: string[]; jumpBefore: string | null };
export type PresentEntry = { tenantId: string; signature?: string };

function status(choice: Choice | undefined, skipped: boolean) {
  if (choice?.status === "here") return choice.signature ? "Here · signed" : "Here";
  if (choice?.status === "not-here") return "Not here";
  return skipped ? "Skipped" : "To decide";
}

/** Local decisions stay in memory until the parent saves one attendance entry. */
export function RollCall({ roster, saving, collectSignatures, onSave }: { roster: Tenant[]; saving: boolean; collectSignatures: boolean; onSave: (entries: PresentEntry[]) => Promise<void> }) {
  const [choices, setChoices] = useState<Map<string, Choice>>(new Map());
  const [skipped, setSkipped] = useState<string[]>([]);
  const [history, setHistory] = useState<Decision[]>([]);
  const [jumpId, setJumpId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [promptId, setPromptId] = useState<string | null>(null);
  const [promptCreated, setPromptCreated] = useState(false);
  // Same motion as Review: a button press leans first, a swipe flies straight out.
  const { pose, setPose, playOut } = useDeckPose();
  /** Bumped on every open so the pad starts blank, even for the same person twice. */
  const [promptSeq, setPromptSeq] = useState(0);
  const byId = useMemo(() => new Map(roster.map((tenant) => [tenant.id, tenant])), [roster]);
  const skipRank = useMemo(() => new Map(skipped.map((id, index) => [id, index])), [skipped]);
  const queue = useMemo(() => roster.filter((tenant) => !choices.has(tenant.id)).sort((a, b) => {
    const aRank = skipRank.has(a.id) ? 1 + skipRank.get(a.id)! : 0;
    const bRank = skipRank.has(b.id) ? 1 + skipRank.get(b.id)! : 0;
    return aRank - bRank;
  }), [roster, choices, skipRank]);
  const active = jumpId ? byId.get(jumpId) ?? null : queue[0] ?? null;
  // A card being posed stays on top until its animation ends, even though its
  // choice has already moved it out of the queue.
  const top = (pose ? byId.get(pose.id) : null) ?? active;
  const deck = top ? [top, ...queue.filter((tenant) => tenant.id !== top.id)].slice(0, 3) : [];
  const canSkip = queue.length > 1 || Boolean(jumpId);
  const presentCount = [...choices.values()].filter((choice) => choice.status === "here").length;
  const signedCount = [...choices.values()].filter((choice) => choice.status === "here" && choice.signature).length;
  const promptChoice = promptId ? choices.get(promptId) : undefined;
  const panelInfo = promptId ? {
    id: promptId, name: byId.get(promptId)?.displayName ?? "", alreadyPresent: !promptCreated,
    alreadySigned: promptChoice?.status === "here" && Boolean(promptChoice.signature),
  } : null;
  // Keeps the panel's contents on screen while it fades back out.
  const lastPanel = useRef(panelInfo);
  if (panelInfo) lastPanel.current = panelInfo;
  const shownPanel = panelInfo ?? lastPanel.current;
  const searchResults = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return [];
    return roster.filter((tenant) => [tenant.displayName, tenant.firstName, tenant.lastName, tenant.preferredName, tenant.unit]
      .some((value) => value?.toLowerCase().includes(needle))).slice(0, 40);
  }, [roster, search]);

  function remember(tenantId: string) {
    setHistory((items) => [...items, { tenantId, before: choices.get(tenantId), skippedBefore: skipped, jumpBefore: jumpId }]);
  }
  /**
   * Here leans right with its stamp showing and, when collecting signatures, is
   * held there while the deck fades into the signature pad. Without signatures
   * it simply flies out like the other two.
   */
  function here(id: string, swiped = false) {
    if (pose) return;
    if (!collectSignatures) {
      playOut(id, "right", swiped);
      if (choices.get(id)?.status !== "here") {
        remember(id);
        setChoices((items) => new Map(items).set(id, { status: "here", signature: null }));
        setSkipped((items) => items.filter((entry) => entry !== id));
      }
      setJumpId(null);
      return;
    }
    setPose({ id, dir: "right", stage: "lean" });
    setPromptSeq((n) => n + 1);
    const previous = choices.get(id);
    if (previous?.status !== "here") {
      remember(id);
      setChoices((items) => new Map(items).set(id, { status: "here", signature: null }));
      setSkipped((items) => items.filter((entry) => entry !== id));
      setPromptCreated(true);
    } else setPromptCreated(false);
    setPromptId(id);
  }
  function notHere(id: string, swiped = false) {
    if (pose) return;
    playOut(id, "left", swiped);
    if (choices.get(id)?.status !== "not-here") {
      remember(id);
      setChoices((items) => new Map(items).set(id, { status: "not-here" }));
      setSkipped((items) => items.filter((entry) => entry !== id));
    }
    setJumpId(null);
  }
  function skip(id: string, swiped = false) {
    if (pose || !canSkip) return;
    playOut(id, "down", swiped);
    remember(id);
    setChoices((items) => { const next = new Map(items); next.delete(id); return next; });
    setSkipped((items) => [...items.filter((entry) => entry !== id), id]);
    setJumpId(null);
  }
  function closePrompt() { setPromptId(null); setJumpId(null); }
  /** Prompt answered: the held card carries on out to the right, or settles back if they were taken off. */
  function settle(fly: boolean) {
    const id = promptId;
    closePrompt();
    if (fly && id) playOut(id, "right", true);
    else setPose(null);
  }
  function commit(signature: string | null) {
    if (!promptId) return;
    const previous = choices.get(promptId);
    if (!promptCreated && previous?.status === "here" && previous.signature !== signature) remember(promptId);
    setChoices((items) => new Map(items).set(promptId, { status: "here", signature }));
    settle(true);
  }
  function removeFromAttendance() {
    if (!promptId) return;
    if (promptCreated) {
      const previous = history[history.length - 1];
      setHistory((items) => items.slice(0, -1));
      setChoices((items) => {
        const next = new Map(items);
        if (previous?.before) next.set(promptId, previous.before);
        else next.delete(promptId);
        return next;
      });
      if (previous) setSkipped(previous.skippedBefore);
    } else {
      remember(promptId);
      setChoices((items) => { const next = new Map(items); next.delete(promptId); return next; });
    }
    settle(false);
  }
  function undo() {
    const last = history[history.length - 1];
    if (!last || promptId || pose) return;
    setHistory((items) => items.slice(0, -1));
    setChoices((items) => {
      const next = new Map(items);
      if (last.before) next.set(last.tenantId, last.before);
      else next.delete(last.tenantId);
      return next;
    });
    setSkipped(last.skippedBefore);
    setJumpId(last.jumpBefore);
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (promptId || searchOpen || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); undo(); }
      else if (active && event.key === "ArrowRight") here(active.id);
      else if (active && event.key === "ArrowLeft") notHere(active.id);
      else if (active && event.key === "ArrowDown") { event.preventDefault(); skip(active.id); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const save = () => onSave([...choices.entries()].flatMap(([tenantId, choice]) =>
    choice.status === "here" ? [{ tenantId, signature: choice.signature ?? undefined }] : []));

  // Laid out as a column that fills the popup: everything but the deck keeps
  // its size and the deck takes what's left (down to a floor), so the whole roll
  // call fits on screen without scrolling.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1 flex flex-none items-center justify-between gap-3 md:mb-3">
        <p className="text-[13px] text-muted"><strong className="tabular text-ink">{choices.size}</strong> of {roster.length} decided · {presentCount} here{collectSignatures && <> · {signedCount} signed</>}</p>
        <Button variant="secondary" size="sm" onClick={undo} disabled={!history.length || Boolean(promptId) || Boolean(pose)} className="min-h-[36px] shrink-0 md:min-h-[40px]"><Undo2 className="h-4 w-4" /> Undo</Button>
      </div>
      <div className="mb-3 h-1.5 flex-none overflow-hidden rounded-pill bg-subtle2 md:mb-5" role="progressbar" aria-valuenow={choices.size} aria-valuemin={0} aria-valuemax={roster.length} aria-label="Roll call progress">
        <div className="h-full rounded-pill bg-status-greenDot transition-[width]" style={{ width: `${roster.length ? choices.size / roster.length * 100 : 100}%` }} />
      </div>

      {/* The deck and the signature pad share one grid cell and crossfade, so the
          popup keeps its size when one gives way to the other. */}
      <div className="grid min-h-[432px] flex-1 grid-rows-[minmax(0,1fr)] md:min-h-[480px]">
      <div className={cn("flex min-h-0 flex-col transition-[opacity,transform] duration-200 ease-out [grid-area:1/1]", promptId && "pointer-events-none scale-[0.98] opacity-0")} inert={Boolean(promptId)}>
      <div className="relative z-30 flex-none">
        <Button variant="secondary" className="min-h-[44px] w-full justify-start text-muted" onClick={() => setSearchOpen((open) => !open)} aria-expanded={searchOpen}><Search className="h-4 w-4" /> Find someone by name or unit</Button>
        {searchOpen && <Card className="absolute inset-x-0 top-full mt-2 overflow-hidden shadow-panel">
          <div className="border-b border-hairline p-3"><Input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Type a name or unit" className="min-h-[44px]" autoFocus /></div>
          {search.trim() ? <ul className="max-h-[min(45vh,320px)] overflow-y-auto scroll-thin">
            {searchResults.map((tenant) => <li key={tenant.id} className="border-b border-hairline last:border-0">
              <button type="button" className="flex min-h-[54px] w-full items-center gap-3 px-4 py-2 text-left hover:bg-rowhover" onClick={() => { setJumpId(tenant.id); setSearchOpen(false); setSearch(""); }}>
                <Avatar name={tenant.displayName} color={tintFor(tenant.id)} size={30} />
                <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-semibold text-ink">{tenant.displayName}</span><span className="block text-[12px] text-muted">{tenant.unit ? `Unit ${tenant.unit}` : "No unit"}</span></span>
                <span className="shrink-0 text-[12px] font-semibold text-muted">{status(choices.get(tenant.id), skipped.includes(tenant.id))}</span>
              </button>
            </li>)}
            {!searchResults.length && <li className="px-4 py-6 text-center text-[13px] text-muted">No matching residents.</li>}
          </ul> : <p className="px-4 py-3 text-[12px] text-muted">Search across this site's active roster.</p>}
        </Card>}
      </div>

      {/* The mask: a card is clipped the moment it leaves the band between the
          search bar and the Save bar, instead of sliding over either. The band's
          edges fade (.deck-band), so the cut is soft, sideways too. */}
      <div className="deck-band -mx-4 -mb-3 flex min-h-0 flex-1 flex-col overflow-y-clip px-4 pb-3 pt-3 md:-mx-6 md:px-6 md:pt-4">
      {top ? <div className="mx-auto flex min-h-0 w-full max-w-[420px] flex-1 flex-col">
        {jumpId && <div className="mb-2 flex flex-none items-center justify-between text-[12px] text-muted"><span>Search result · roll call resumes afterward</span><button type="button" onClick={() => setJumpId(null)} className="min-h-[36px] px-2 font-semibold text-accent">Back to roll call</button></div>}
        {/* 392px when there's room; shrinks toward 280px on a short phone. */}
        <div className={cn(DECK_CLASS, "h-auto max-h-[392px] min-h-[280px] flex-[1_1_392px]")}>
          {[...deck].reverse().map((tenant) => {
            const depth = deck.indexOf(tenant);
            return (
              <SwipeCard key={tenant.id} depth={depth} pose={pose?.id === tenant.id ? pose : null} rightLabel="HERE" leftLabel="NOT HERE"
                onSwipeRight={() => here(tenant.id, true)} onSwipeLeft={() => notHere(tenant.id, true)} onSwipeDown={() => skip(tenant.id, true)}>
                <AttendanceCardBody tenant={tenant} collectSignatures={collectSignatures} choice={choices.get(tenant.id)} skipped={skipped.includes(tenant.id)} remaining={queue.length} />
              </SwipeCard>
            );
          })}
        </div>
        <div className="mt-3 flex flex-none items-center justify-center gap-6 md:mt-5">
          <RoundAction label="Not here" tone="red" disabled={Boolean(pose)} onClick={() => notHere(top.id)}>
            <X className="h-7 w-7" strokeWidth={2.6} />
          </RoundAction>
          {/* Smaller than its neighbours: skipping decides nothing. */}
          <RoundAction label="Skip" tone="blue" size="sm" disabled={Boolean(pose) || !canSkip} onClick={() => skip(top.id)}>
            <ChevronsDown className="h-6 w-6" strokeWidth={2.4} />
          </RoundAction>
          <RoundAction label="Here" tone="green" disabled={Boolean(pose)} onClick={() => here(top.id)}>
            <Check className="h-7 w-7" strokeWidth={2.6} />
          </RoundAction>
        </div>
        <p className="mt-3 hidden flex-none text-center text-micro text-muted md:block">Swipe left if they're not here · down to skip · right if they're here</p>
      </div> : <Card className="mx-auto max-w-[420px]"><EmptyState title={roster.length ? "Roll call complete" : "Nobody on this roster"} hint={roster.length ? "Search to correct a choice, or save this attendance." : "You can still save an empty attendance entry."} /></Card>}
      </div>
      </div>
      <div className={cn("transition-[opacity,transform] duration-200 ease-out [grid-area:1/1]", !promptId && "pointer-events-none scale-[0.98] opacity-0")} inert={!promptId}>
        {shownPanel && <SignaturePanel key={`${shownPanel.id}-${promptSeq}`} tenantName={shownPanel.name} alreadyPresent={shownPanel.alreadyPresent} alreadySigned={shownPanel.alreadySigned}
          onClose={() => settle(true)} onSign={commit} onSkip={() => commit(null)} onRemove={removeFromAttendance} />}
      </div>
      </div>

      {/* No bottom inset of its own: on a phone the sheet reserves the site-wide one beneath it. */}
      <div className={cn("sticky bottom-0 z-10 mt-2 flex flex-none items-center justify-between gap-3 border-t border-hairline bg-surface px-3 py-2 md:mt-4 md:px-4 md:py-3", promptId && "invisible")}>
        <span className="text-[13px] font-semibold text-ink">{presentCount} here</span>
        <Button onClick={() => void save()} disabled={saving || Boolean(promptId)} className="min-h-[44px] max-w-[240px] flex-1 md:min-h-[48px]">{saving ? "Saving…" : "Save attendance"}</Button>
      </div>
    </div>
  );
}

/** What a roll call card says — laid out exactly like a Review card. */
function AttendanceCardBody({ tenant, collectSignatures, choice, skipped, remaining }: { tenant: Tenant; collectSignatures: boolean; choice?: Choice; skipped: boolean; remaining: number }) {
  const note = choice?.status === "here"
    ? { tone: "bg-status-greenBg text-status-greenText", icon: <Check className="h-4 w-4" />, title: choice.signature ? "Here · signed" : "Here", detail: choice.signature ? "Signature collected" : collectSignatures ? "No signature yet" : "Marked present" }
    : choice?.status === "not-here"
      ? { tone: "bg-status-redBg text-status-redText", icon: <X className="h-4 w-4" />, title: "Not here", detail: "Swipe right if they've arrived" }
      : skipped
        ? { tone: "bg-status-blueBg text-status-blueText", icon: <ChevronsDown className="h-4 w-4" />, title: "Skipped earlier", detail: "Back for another look" }
        : { tone: "bg-subtle2 text-ink", icon: <CircleDashed className="h-4 w-4" />, title: "Not marked yet", detail: "Swipe right if they're here" };
  return <>
    <ResidentCardHeader tenant={tenant} />
    <SwipeNote tone={note.tone} icon={note.icon} title={note.title}>{note.detail}</SwipeNote>

    <span className="flex-1" />
    <p className="text-micro text-muted">{remaining} still to mark{tenant.moveInDate ? ` · moved in ${formatDate(tenant.moveInDate)}` : ""}</p>
  </>;
}
