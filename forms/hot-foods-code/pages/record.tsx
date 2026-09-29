import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDownUp, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CloudOff, Loader2, MapPin, MapPinOff, Minus, Plus, RefreshCw, Search, Trash2, UploadCloud, UtensilsCrossed, X } from "lucide-react";
import { actions, app, entries, local, queue, roster, useApp, useData, type QueueStatus, type Resident, type Site } from "@lcs/sdk";
import { Button, EmptyState, Input, LoadingState, Select, Sheet, SignaturePad, Textarea, cn, initials, tintFor, type SignaturePadHandle } from "@lcs/ui";
import { slotColor } from "@lcs/charts";
import { cooldownLeft, minutes, OFFLINE_REVIEW, OVER_LIMIT_REASONS, ruleProblems, type Rules, type Served } from "../lib/rules";
import { siteOptions, useNearbySite } from "../lib/sites";
import type { Item, Today } from "../lib/types";

/**
 * Record a hot meal as three guided steps: Meal → Resident → Sign, then a
 * "Saved" screen with Next resident and Undo. The same screen as the built-in
 * Hot Foods, rebuilt as a code form: the meal is picked once per shift, most
 * frequent residents come first, a signature is required, and Save never
 * waits on the network (entries queue on the device and upload behind the
 * scenes). iPad-first: a side panel on wide screens, steps across the top in
 * portrait, a progress bar on a phone.
 */

const SITE_KEY = "site";
const MEAL_KEY = "meal";
const SORT_KEY = "sort";

type Cart = Record<string, number>;
type Step = "meal" | "resident" | "sign" | "done";
type Filter = "all" | "todo" | "served";
type Sort = "regulars" | "room";

interface Person {
  id: string;
  displayName: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  unit: string | null;
}

/** An entry saved on this visit to the screen: for "Just recorded", Undo, and counting it before it uploads. */
interface Saved {
  clientId: string;
  siteCode: string;
  tenantId: string;
  cart: Cart;
  savedAt: number;
  name: string;
  detail: string;
  mealCount: number;
  slot: number | null;
}

const toPerson = (r: Resident): Person => ({ id: r.id, displayName: r.name, firstName: r.firstName, lastName: r.lastName, preferredName: r.preferredName, unit: r.unit });
const mealLabel = (lines: Item[], cart: Cart) => lines.map((i) => `${cart[i.id]} ${i.name}`).join(", ");
const todayKey = () => new Date().toDateString();

export default function Record() {
  const { user, pages } = useApp();
  const isAdmin = user.roleKey === "admin";
  const [prefs, setPrefs] = useState<{ site: string; meal: string; mealToday: boolean; sort: Sort } | null>(null);
  const { data: sites, loading: sitesLoading } = useData(() => roster.sites(), []);
  const { data: items, loading: itemsLoading } = useData(() => actions.call<Item[]>("mealTypes"), []);

  useEffect(() => {
    void Promise.all([local.get(SITE_KEY), local.get(MEAL_KEY), local.get(SORT_KEY)]).then(([site, meal, sort]) => {
      const [id, day] = (meal ?? "").split("|");
      setPrefs({ site: site ?? "", meal: id ?? "", mealToday: day === todayKey(), sort: sort === "room" ? "room" : "regulars" });
    });
  }, []);

  if (!prefs || sitesLoading || itemsLoading) return <LoadingState />;
  if (!sites?.length) return <EmptyState title="No sites assigned" hint="You need to be assigned to a site to record Hot Foods. Ask an administrator." icon={<UtensilsCrossed className="h-8 w-8" />} />;
  const active = (items ?? []).filter((i) => i.active);
  if (!active.length) {
    return (
      <div className="flex flex-col items-center">
        <EmptyState title="No meal types set up" hint="An administrator adds the meals staff can pick from." icon={<UtensilsCrossed className="h-8 w-8" />} />
        {isAdmin && pages.some((p) => p.id === "settings") && <Button onClick={() => app.navigate("settings")}>Manage meal types</Button>}
      </div>
    );
  }
  return <RecordScreen sites={sites} items={active} prefs={prefs} canManage={isAdmin} />;
}

function RecordScreen({ sites, items, prefs, canManage }: { sites: Site[]; items: Item[]; prefs: { site: string; meal: string; mealToday: boolean; sort: Sort }; canManage: boolean }) {
  const [siteCode, setSiteCode] = useState(prefs.site);
  const [mealId, setMealId] = useState(prefs.meal);
  const [step, setStep] = useState<Step>(prefs.mealToday && items.some((i) => i.id === prefs.meal) ? "resident" : "meal");
  const [serving, setServing] = useState<Person | null>(null);
  const [servingCount, setServingCount] = useState(0);
  const [servingMeals, setServingMeals] = useState<Served>({});
  const [saved, setSaved] = useState<Saved[]>([]);
  const [q, setQ] = useState<QueueStatus | null>(null);

  const site = sites.find((s) => s.code === siteCode) ?? (sites.length === 1 ? sites[0] : undefined);
  const { data: rosterData, loading: rosterLoading } = useData(() => (site ? roster.residents(site.code) : Promise.resolve([])), [site?.code]);
  const people = useMemo(() => (rosterData ?? []).map(toPerson), [rosterData]);
  const today = useData(() => (site ? actions.call<Today>("today", { site: site.code }) : Promise.resolve(null)), [site?.code]);

  useEffect(() => queue.subscribe(setQ), []);
  const pending = useMemo(() => new Set(q?.pendingIds ?? []), [q]);
  // When entries finish uploading, the server's counts include them: refresh.
  const pendingCount = q?.pending ?? 0;
  const lastPending = useRef(pendingCount);
  useEffect(() => {
    if (pendingCount < lastPending.current) today.refresh();
    lastPending.current = pendingCount;
  }, [pendingCount]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = setInterval(() => today.refresh(), 60_000);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Today's counts from the server plus this device's entries still waiting to upload.
  const { counts, meals } = useMemo(() => {
    const counts: Record<string, number> = { ...(today.data?.counts ?? {}) };
    const meals: Record<string, Served> = {};
    for (const [t, byItem] of Object.entries(today.data?.meals ?? {})) meals[t] = { ...byItem };
    for (const s of saved) {
      if (!pending.has(s.clientId) || s.siteCode !== site?.code) continue;
      counts[s.tenantId] = (counts[s.tenantId] ?? 0) + 1;
      const byItem = (meals[s.tenantId] ??= {});
      for (const [itemId, qty] of Object.entries(s.cart)) byItem[itemId] = [...(byItem[itemId] ?? []), ...Array<number>(qty).fill(s.savedAt)];
    }
    return { counts, meals };
  }, [today.data, saved, pending, site?.code]);

  const rules: Rules = { limit: today.data?.limit ?? 1, cooldownMinutes: today.data?.cooldownMinutes ?? 0 };
  const meal = items.find((i) => i.id === mealId) ?? items[0];

  const nearby = useNearbySite(sites);
  const chosenByHand = useRef(false);
  const finding = nearby.enabled && nearby.status === "locating" && !chosenByHand.current;
  useEffect(() => {
    if (!nearby.here || chosenByHand.current || step === "sign") return;
    if (nearby.here.site.code !== site?.code) setSiteCode(nearby.here.site.code);
  }, [nearby.here?.site.code]); // eslint-disable-line react-hooks/exhaustive-deps
  // Nothing remembered on this device and not standing at a site: start on the
  // nearest one within 5 km rather than an empty picker.
  useEffect(() => {
    if (site || chosenByHand.current || !nearby.ranked?.length) return;
    const nearest = nearby.ranked[0];
    if (nearest.meters <= 5000) setSiteCode(nearest.site.code);
  }, [nearby.ranked]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (site) void local.set(SITE_KEY, site.code);
  }, [site?.code]);

  function changeSite(code: string) {
    chosenByHand.current = true;
    setSiteCode(code);
    setServing(null);
    if (step === "sign" || step === "done") setStep("resident");
  }

  function chooseMeal(id: string) {
    setMealId(id);
    void local.set(MEAL_KEY, `${id}|${todayKey()}`);
  }

  function pick(t: Person) {
    setServing(t);
    setServingCount(counts[t.id] ?? 0);
    setServingMeals(meals[t.id] ?? {});
    setStep("sign");
  }

  function nextResident() {
    setServing(null);
    setStep("resident");
  }

  async function undo(s: Saved) {
    try {
      if (pending.has(s.clientId)) await queue.discard(s.clientId);
      else {
        // Already uploaded: void it (people can void their own entry for a few minutes).
        const mine = await entries.list({ mine: true, limit: 30, fields: [] });
        const hit = mine.items.find((e) => e.clientId === s.clientId);
        if (!hit) throw new Error("Couldn't find that entry to undo.");
        await entries.void(hit.id, "Undone by staff right after saving");
        today.refresh();
      }
      setSaved((list) => list.filter((x) => x.clientId !== s.clientId));
      app.toast(`Removed ${s.name}'s entry.`);
      if (step === "done" && saved[0]?.clientId === s.clientId) nextResident();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : "Couldn't undo that. Void it from Entries.", "error");
    }
  }

  async function save(t: Person, cart: Cart, signature: string, notes: string, overrideReason: string) {
    if (!site) return;
    const lines = items.filter((i) => cart[i.id]);
    const mealCount = lines.reduce((n, i) => n + cart[i.id], 0);
    const clientId = crypto.randomUUID();
    const res = await entries.create(
      { data: { cart, signature, notes: notes.trim() || undefined }, site: site.code, tenantId: t.id, clientId, override: overrideReason.trim() || undefined },
      { offline: true, offlineOverride: OFFLINE_REVIEW }
    );
    if (res.status === "invalid") {
      app.toast(res.message, "error");
      return;
    }
    const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    setSaved((list) =>
      [{ clientId, siteCode: site.code, tenantId: t.id, cart, savedAt: Date.now(), name: t.displayName, mealCount, slot: lines[0]?.colorSlot ?? null, detail: `${time} · ${mealLabel(lines, cart)}${overrideReason ? " · extra" : ""}` }, ...list].slice(0, 20)
    );
    setStep("done");
  }

  const current: Step = step;
  const servedPeople = people.filter((t) => (counts[t.id] ?? 0) > 0).length;
  const mealsToday = Object.values(meals).reduce((n, byItem) => n + Object.values(byItem).reduce((m, times) => m + times.length, 0), 0);
  const last = saved[0];
  const back = current === "resident" ? () => setStep("meal") : current === "sign" ? nextResident : undefined;

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden">
      <div className={cn("flex-none border-b border-hairline px-4 py-2 md:block md:px-7 md:py-3 lg:hidden", current === "sign" && "hidden")}>
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-start gap-3">
          <SiteControl sites={sites} site={site} nearby={nearby} finding={finding} onChange={changeSite} className="min-w-0 flex-1 md:max-w-[360px]" />
          <div className="ml-auto mt-1 shrink-0 md:mt-1.5"><SyncStatus q={q} saved={saved} /></div>
        </div>
      </div>

      <div className="mx-auto flex min-h-0 w-full max-w-[1240px] flex-1 flex-col lg:flex-row">
        <aside className="flex-none border-b border-hairline bg-sidebar px-4 py-1.5 scroll-thin md:px-7 md:py-3 lg:w-[272px] lg:overflow-y-auto lg:border-b-0 lg:border-r lg:px-5 lg:py-4">
          <div className="mb-3 hidden space-y-2 border-b border-hairline pb-3 lg:block">
            <SiteControl sites={sites} site={site} nearby={nearby} finding={finding} onChange={changeSite} />
            <SyncStatus q={q} saved={saved} />
          </div>
          <StepRail step={current} meal={meal} tenant={serving} onBack={back} onGo={setStep} />
          <div className="hidden lg:block">
            <ShiftSummary served={servedPeople} total={people.length} meals={mealsToday} />
            <RecentList recent={saved.slice(0, 3)} pending={pending} onUndo={undo} />
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {current === "meal" && <MealStep items={items} selected={meal.id} onSelect={chooseMeal} onStart={() => { chooseMeal(meal.id); setStep("resident"); }} onManage={canManage ? () => app.navigate("settings") : undefined} />}
          {current === "resident" &&
            (!site ? (
              <EmptyState title="Choose a site" hint="Pick the site you're serving at to see its residents." />
            ) : (
              <ResidentStep
                people={people}
                loading={rosterLoading || (today.loading && !today.data)}
                counts={counts}
                meals={meals}
                regulars={today.data?.regulars ?? {}}
                regularsDays={today.data?.regularsDays ?? 30}
                rules={rules}
                meal={meal}
                initialSort={prefs.sort}
                onPick={pick}
              />
            ))}
          {current === "sign" && serving && (
            <SignStep key={serving.id} tenant={serving} items={items} defaultMeal={meal} servedToday={servingCount} served={servingMeals} rules={rules} onSave={(cart, sig, notes, reason) => save(serving, cart, sig, notes, reason)} />
          )}
          {current === "done" && <DoneStep last={last} served={servedPeople} total={people.length} onUndo={() => last && undo(last)} onNext={nextResident} />}
        </div>
      </div>
    </div>
  );
}

/** Upload state as a pill (as in the built-in Hot Foods); tap it for what's waiting on this device. */
function SyncStatus({ q, saved }: { q: QueueStatus | null; saved: Saved[] }) {
  const [open, setOpen] = useState(false);
  if (!q) return null;
  const waiting = q.pending;
  const failed = q.failed.length;
  const pill = failed
    ? { tone: "bg-status-redBg text-status-redText", icon: <AlertTriangle className="h-4 w-4" />, label: `${failed} need${failed === 1 ? "s" : ""} attention` }
    : waiting
      ? { tone: "bg-status-amberBg text-status-amberText", icon: q.syncing && q.online ? <Loader2 className="h-4 w-4 animate-spin" /> : q.online ? <UploadCloud className="h-4 w-4" /> : <CloudOff className="h-4 w-4" />, label: q.online ? `${waiting} uploading` : `Offline · ${waiting} saved here` }
      : q.online
        ? { tone: "bg-status-greenBg text-status-greenText", icon: <CheckCircle2 className="h-4 w-4" />, label: "All uploaded" }
        : { tone: "bg-subtle text-muted", icon: <CloudOff className="h-4 w-4" />, label: "Offline" };
  const who = (clientId: string) => saved.find((x) => x.clientId === clientId);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={cn("tabular flex min-h-[36px] items-center gap-1.5 rounded-pill px-3 text-[12.5px] font-bold", pill.tone)} aria-label={`Upload status: ${pill.label}`}>
        {pill.icon}
        <span className="whitespace-nowrap">{pill.label}</span>
      </button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title="Saved on this device"
        footer={(failed > 0 || waiting > 0) && <Button className="min-h-[52px] flex-1 text-[15px]" onClick={() => void queue.retry()} disabled={q.syncing}><RefreshCw className={cn("h-4 w-4", q.syncing && "animate-spin")} /> {failed ? "Retry all" : "Upload now"}</Button>}
      >
        <p className="text-[13.5px] text-muted">Every entry is saved on this device the moment it's signed, then uploaded. If the internet drops, keep serving — entries upload on their own when it's back.</p>
        {failed > 0 && (
          <section className="mt-4">
            <h3 className="text-[13px] font-bold uppercase tracking-wide text-muted">The server refused these</h3>
            <ul className="mt-2 divide-y divide-hairline rounded-card border border-hairline">
              {q.failed.map((f) => (
                <li key={f.clientId} className="flex items-center gap-3 px-3 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px] font-semibold text-ink">{who(f.clientId)?.name ?? "Entry"}</span>
                    <span className="mt-0.5 block text-[12.5px] font-semibold text-status-redText">{f.error}</span>
                  </span>
                  <button type="button" onClick={() => { if (confirm("Discard this signed entry? It will not be recorded anywhere.")) void queue.discard(f.clientId); }} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-status-redText hover:bg-status-redBg" aria-label="Discard entry"><Trash2 className="h-[18px] w-[18px]" /></button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {waiting > 0 && (
          <section className="mt-4">
            <h3 className="text-[13px] font-bold uppercase tracking-wide text-muted">{q.online ? "Uploading" : "Waiting for internet"}</h3>
            <ul className="mt-2 divide-y divide-hairline rounded-card border border-hairline">
              {q.pendingIds.map((id) => {
                const s = who(id);
                return <li key={id} className="px-3 py-2.5"><span className="block truncate text-[14.5px] font-semibold text-ink">{s?.name ?? "Entry from an earlier visit"}</span>{s && <span className="block text-[12.5px] text-muted">{s.mealCount} meal{s.mealCount === 1 ? "" : "s"} · {s.detail.split(" · ")[0]}</span>}</li>;
              })}
            </ul>
          </section>
        )}
        {!failed && !waiting && <p className="mt-6 flex items-center justify-center gap-2 text-[14px] font-semibold text-status-greenText"><CheckCircle2 className="h-5 w-5" /> Everything is uploaded.</p>}
      </Sheet>
    </>
  );
}

function SiteControl({ sites, site, nearby, finding, onChange, className }: { sites: Site[]; site?: Site; nearby: ReturnType<typeof useNearbySite>; finding: boolean; onChange: (code: string) => void; className?: string }) {
  if (sites.length <= 1) return <p className={cn("min-h-[36px] content-center text-[15px] font-semibold text-ink", className)}>{site?.name}</p>;
  const pinned = nearby.here && nearby.here.site.code === site?.code;
  return (
    <div className={className}>
      <div className="relative">
        <Select value={finding ? "" : site?.code ?? ""} onChange={(e) => onChange(e.target.value)} options={siteOptions(sites, nearby.ranked)} placeholder={finding ? "Finding your location…" : "Choose a site"} aria-label="Site" className={cn("min-h-[44px] text-[16px] font-semibold md:min-h-[48px]", (finding || pinned) && "pl-9")} />
        {finding && <span className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 text-muted"><Loader2 className="h-[18px] w-[18px] animate-spin" /></span>}
        {!finding && pinned && <span className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 text-status-greenText" title="Picked from your location"><MapPin className="h-[18px] w-[18px]" /></span>}
      </div>
      {nearby.enabled && nearby.status === "unavailable" && (
        <p className="mt-1.5 flex min-h-[32px] items-center gap-1.5 text-[12.5px] text-muted">
          <MapPinOff className="h-3.5 w-3.5 shrink-0" />
          <span>Location is off for this site, so pick yours above. <button type="button" onClick={nearby.locate} className="font-semibold text-accent underline-offset-2 hover:underline dark:text-white">Try again</button></span>
        </p>
      )}
      {nearby.status === "ok" && nearby.here && nearby.here.site.code !== site?.code && (
        <p className="mt-1.5 flex min-h-[32px] items-center gap-1.5 text-[12.5px] text-muted">
          <MapPin className="h-3.5 w-3.5 shrink-0" /> You seem to be at {nearby.here.site.name}.{" "}
          <button type="button" onClick={() => onChange(nearby.here!.site.code)} className="font-semibold text-accent underline-offset-2 hover:underline dark:text-white">Switch to it</button>
        </p>
      )}
    </div>
  );
}

const STEPS: { key: Exclude<Step, "done">; label: string }[] = [
  { key: "meal", label: "Meal" },
  { key: "resident", label: "Resident" },
  { key: "sign", label: "Sign" },
];
const STEP_TITLES: Record<Step, string> = { meal: "Pick the meal", resident: "Who is it for?", sign: "Confirm and sign", done: "All set" };

function StepRail({ step, meal, tenant, onBack, onGo }: { step: Step; meal: Item; tenant: Person | null; onBack?: () => void; onGo: (s: Step) => void }) {
  const at = step === "done" ? 3 : STEPS.findIndex((s) => s.key === step);
  const value = (i: number) => (i === 0 ? meal.name : i === 1 ? (at >= 2 && tenant ? tenant.displayName : at === 1 ? "Choose someone" : "Next") : at === 3 ? "Signed" : at === 2 ? "Waiting" : "Last");
  return (
    <>
      <div className="flex min-h-[44px] items-center gap-1 md:hidden">
        {onBack && (
          <button type="button" onClick={onBack} aria-label="Back a step" className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink"><ChevronLeft className="h-6 w-6" /></button>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-heading text-[18px] font-extrabold leading-tight text-ink">{STEP_TITLES[step]}</h2>
          {at >= 1 && <p className="truncate text-[12.5px] leading-tight text-muted">Serving <strong className="font-semibold text-ink">{meal.name}</strong></p>}
        </div>
        <ol className="flex shrink-0 gap-1" aria-label={`Step ${Math.min(at + 1, 3)} of 3`}>
          {STEPS.map((s, i) => <li key={s.key} className={cn("h-[5px] w-6 rounded-pill", i < at ? "bg-status-greenDot" : i === at ? "bg-navy dark:bg-white" : "bg-hairline")}><span className="sr-only">{s.label}</span></li>)}
        </ol>
      </div>
      <ol className="hidden gap-2 md:flex lg:flex-col lg:gap-1" aria-label="Steps">
        {STEPS.map((s, i) => {
          const done = i < at;
          const cur = i === at;
          return (
            <li key={s.key} className="min-w-0 flex-1 lg:flex-none">
              <button type="button" disabled={!done} onClick={() => onGo(s.key === "sign" ? "resident" : s.key)} aria-current={cur ? "step" : undefined}
                className={cn("flex min-h-[64px] w-full items-center gap-3 rounded-card border-[1.5px] px-3 py-2 text-left lg:min-h-[50px] lg:py-1.5", cur ? "border-navy bg-surface dark:border-white" : done ? "border-hairline hover:bg-rowhover" : "border-transparent")}>
                <span className={cn("flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border-2 text-[15px] font-extrabold", done ? "border-status-greenDot bg-status-greenDot text-white" : cur ? "border-navy bg-navy text-white dark:border-white dark:bg-white dark:text-[#111]" : "border-strongline bg-surface text-muted")}>
                  {done ? <Check className="h-4 w-4" strokeWidth={3.4} /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block text-[12px] font-bold uppercase tracking-wide text-muted">{s.label}</span>
                  <span className={cn("block truncate text-[15px] font-bold", done || cur ? "text-ink" : "text-muted")}>{value(i)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function ShiftSummary({ served, total, meals }: { served: number; total: number; meals: number }) {
  const pct = total ? Math.round((served / total) * 100) : 0;
  return (
    <section className="mt-4 border-t border-hairline pt-3" aria-label="This shift">
      <h3 className="text-[12px] font-bold uppercase tracking-wide text-muted">Today here</h3>
      <p className="mt-1.5 flex items-baseline gap-2">
        <span className="tabular font-heading text-[30px] font-extrabold text-ink">{served}</span>
        <span className="tabular text-[14px] text-muted">of {total} residents served · {meals} meal{meals === 1 ? "" : "s"}</span>
      </p>
      <div className="mt-2 h-2 overflow-hidden rounded-pill bg-hairline" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-pill bg-status-greenDot" style={{ width: `${pct}%` }} />
      </div>
    </section>
  );
}

function RecentList({ recent, pending, onUndo }: { recent: Saved[]; pending: Set<string>; onUndo: (r: Saved) => void }) {
  return (
    <section className="mt-4" aria-label="Just recorded">
      <h3 className="text-[12px] font-bold uppercase tracking-wide text-muted">Just recorded</h3>
      {recent.length === 0 ? (
        <p className="mt-2 text-[13.5px] text-muted">Entries you save this shift show here.</p>
      ) : (
        <ul className="mt-1.5">
          {recent.map((r) => (
            <li key={r.clientId} className="flex min-h-[44px] items-center gap-2.5">
              <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: slotColor(r.slot) }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-bold text-ink">{r.name}</span>
                <span className="block truncate text-[12.5px] text-muted">{r.detail}{pending.has(r.clientId) ? "" : " · uploaded"}</span>
              </span>
              <Button variant="secondary" size="sm" className="min-h-[40px]" onClick={() => onUndo(r)}>Undo</Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MealStep({ items, selected, onSelect, onStart, onManage }: { items: Item[]; selected: string; onSelect: (id: string) => void; onStart: () => void; onManage?: () => void }) {
  const chosen = items.find((i) => i.id === selected) ?? items[0];
  return (
    <>
      <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 scroll-thin md:px-7 md:py-6" aria-label="Meal being served">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-x-2 md:mb-4">
          <div>
            <h2 className="hidden font-heading text-[24px] font-extrabold text-ink md:block">What are you serving this shift?</h2>
            <p className="text-[13.5px] text-muted md:mt-1 md:text-[14.5px]">Pick once. Everyone you record gets this meal unless you change it for them.</p>
          </div>
          {onManage && <button type="button" onClick={onManage} className="min-h-[40px] text-[13px] font-semibold text-accent dark:text-white">Manage meal types</button>}
        </div>
        <div className="grid grid-cols-2 gap-2 md:gap-3.5 lg:grid-cols-3" role="radiogroup">
          {items.map((item) => {
            const on = item.id === chosen.id;
            return (
              <button key={item.id} type="button" role="radio" aria-checked={on} onClick={() => onSelect(item.id)}
                className={cn("relative flex min-h-[64px] items-center gap-2.5 rounded-card border-2 p-2 pr-8 text-left active:scale-[0.99] md:min-h-[136px] md:flex-col md:items-start md:gap-3.5 md:p-4 md:pr-12", on ? "border-navy bg-navsel/50 dark:border-white" : "border-hairline bg-surface hover:border-strongline")}>
                <MealThumb item={item} className="h-10 w-10 md:h-16 md:w-16" />
                <span className="text-[15px] font-bold leading-tight text-ink md:text-[17px]">{item.name}</span>
                <span className={cn("absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full border-2 md:right-3 md:top-4 md:h-7 md:w-7", on ? "border-navy bg-navy text-white dark:border-white dark:bg-white dark:text-[#111]" : "border-strongline")}>
                  {on && <Check className="h-3 w-3 md:h-4 md:w-4" strokeWidth={3.4} />}
                </span>
              </button>
            );
          })}
        </div>
      </section>
      <div className="flex flex-none justify-end border-t border-hairline bg-surface px-4 py-3 md:px-7 md:py-4">
        <Button className="min-h-[58px] w-full text-[17px] font-extrabold md:w-auto md:min-w-[300px]" onClick={onStart}>Start serving {chosen.name}</Button>
      </div>
    </>
  );
}

function MealThumb({ item, className }: { item: Item; className?: string }) {
  return (
    <span className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-white text-muted ring-1 ring-hairline", className)}>
      {item.imageUrl ? <img src={item.imageUrl} alt="" loading="lazy" className="h-full w-full object-contain p-0.5" /> : <UtensilsCrossed className="h-5 w-5" />}
    </span>
  );
}

function ResidentStep({ people, loading, counts, meals, regulars, regularsDays, rules, meal, initialSort, onPick }: {
  people: Person[]; loading: boolean; counts: Record<string, number>; meals: Record<string, Served>; regulars: Record<string, number>; regularsDays: number; rules: Rules; meal: Item; initialSort: Sort; onPick: (t: Person) => void;
}) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("todo");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!rules.cooldownMinutes) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [rules.cooldownMinutes]);
  const [sort, setSort] = useState<Sort>(initialSort);
  const sortLabel = `Sorted by ${sort === "regulars" ? "most frequent" : "room"}. Tap to sort by ${sort === "regulars" ? "room" : "most frequent"}.`;
  const toggleSort = () => {
    const next = sort === "regulars" ? "room" : "regulars";
    setSort(next);
    void local.set(SORT_KEY, next);
  };
  const sorted = useMemo(() => {
    const byRoom = (a: Person, b: Person) => (a.unit ?? "").localeCompare(b.unit ?? "", undefined, { numeric: true }) || a.displayName.localeCompare(b.displayName);
    return [...people].sort(sort === "regulars" ? (a, b) => (regulars[b.id] ?? 0) - (regulars[a.id] ?? 0) || byRoom(a, b) : byRoom);
  }, [people, sort, regulars]);
  const servedPeople = sorted.filter((t) => (counts[t.id] ?? 0) > 0).length;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sorted.filter((t) => {
      const n = counts[t.id] ?? 0;
      if (!needle && filter === "todo" && n > 0) return false;
      if (!needle && filter === "served" && n === 0) return false;
      if (!needle) return true;
      return t.displayName.toLowerCase().includes(needle) || `${t.firstName} ${t.lastName}`.toLowerCase().includes(needle) || (t.unit ?? "").toLowerCase().startsWith(needle);
    });
  }, [sorted, q, filter, counts]);
  const tabs: { key: Filter; label: string; n: number }[] = [
    { key: "todo", label: "Not served", n: sorted.length - servedPeople },
    { key: "served", label: "Served", n: servedPeople },
    { key: "all", label: "Everyone", n: sorted.length },
  ];

  return (
    <section className="flex min-h-0 flex-1 flex-col px-4 pt-2 md:px-7 md:pt-6" aria-label="Residents">
      <div className="mb-2 flex flex-none flex-col gap-2 md:mb-3 xl:flex-row xl:items-center xl:gap-3">
        <div className="flex gap-2 xl:flex-1">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or room" type="search" className="min-h-[46px] pl-11 pr-12 text-[16px] md:min-h-[52px]" autoComplete="off" />
            {q && <button type="button" onClick={() => setQ("")} aria-label="Clear search" className="absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-muted"><X className="h-5 w-5" /></button>}
          </div>
          <button type="button" onClick={toggleSort} aria-label={sortLabel} title={sortLabel} className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-input border border-hairline text-accent dark:text-white md:hidden"><ArrowDownUp className="h-5 w-5" /></button>
        </div>
        <div className="flex gap-1 rounded-pill bg-subtle p-1" role="tablist" aria-label="Show">
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={filter === t.key} onClick={() => setFilter(t.key)} className={cn("tabular min-h-[38px] flex-1 whitespace-nowrap rounded-pill px-3 text-[13.5px] font-semibold md:min-h-[42px]", filter === t.key ? "bg-surface text-ink shadow-sm" : "text-muted")}>
              {t.label} <span className="font-normal">{t.n}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="mb-2 hidden flex-none items-center justify-between gap-3 md:flex">
        <p className="min-w-0 truncate text-[13px] text-muted">Serving <strong className="font-semibold text-ink">{meal.name}</strong></p>
        <button type="button" onClick={toggleSort} className="flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-pill px-2 text-[13px] font-semibold text-accent dark:text-white" aria-label={sortLabel}>
          <ArrowDownUp className="h-4 w-4" /> {sort === "regulars" ? "Most frequent first" : "By room"}
        </button>
      </div>
      <div className="-mx-4 min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4 scroll-thin md:-mx-7 md:px-7 md:pb-6">
        {loading ? (
          <LoadingState label="Loading residents…" />
        ) : shown.length === 0 ? (
          <EmptyState title={q ? "No one matches" : filter === "todo" ? "Everyone has been served" : filter === "served" ? "No one served yet" : "No residents on this roster"} hint={q ? "Try part of the name or the room number." : undefined} />
        ) : (
          <ul className="divide-y divide-hairline border-y border-hairline md:mx-0 md:grid md:grid-cols-2 md:gap-3 md:divide-y-0 md:border-0 xl:grid-cols-3">
            {shown.slice(0, 300).map((t) => {
              const n = counts[t.id] ?? 0;
              const times = meals[t.id]?.[meal.id] ?? [];
              const over = times.length >= rules.limit;
              const wait = over ? 0 : cooldownLeft(rules, times, now);
              const freq = regulars[t.id] ?? 0;
              return (
                <li key={t.id}>
                  <button type="button" onClick={() => onPick(t)} className={cn("flex min-h-[70px] w-full items-center gap-3 px-4 py-2 text-left hover:bg-rowhover active:bg-navsel/60 md:min-h-[84px] md:rounded-card md:border-[1.5px] md:px-3.5", n > 0 ? "md:border-status-greenDot/30 md:bg-status-greenBg/40" : "md:border-hairline")}>
                    <span className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[14px] font-bold text-white md:h-12 md:w-12", n > 0 && "bg-muted")} style={n > 0 ? undefined : { background: tintFor(t.id) }}>{initials(t.displayName)}</span>
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-[16px] font-semibold md:text-[16.5px]", n > 0 ? "text-muted" : "text-ink")}>{t.displayName}</span>
                      <span className="block truncate text-[13px] text-muted">
                        {t.unit ? `Room ${t.unit}` : "No room on file"}
                        {sort === "regulars" && <span className="tabular"> · {freq > 0 ? `${freq} in ${regularsDays} days` : "New here"}</span>}
                      </span>
                    </span>
                    {n > 0 && (
                      <span className={cn("tabular shrink-0 rounded-pill px-2.5 py-1 text-[12px] font-bold", over || wait ? "bg-status-amberBg text-status-amberText" : "bg-status-greenBg text-status-greenText")} title={wait ? `Cooldown: ${minutes(wait)} left before another ${meal.name}` : undefined}>
                        {over ? `${times.length} of ${rules.limit}` : wait ? `Wait ${minutes(wait)}` : times.length ? `${times.length} of ${rules.limit}` : "Served"}
                      </span>
                    )}
                    <ChevronRight className="h-5 w-5 shrink-0 text-muted md:hidden" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {shown.length > 300 && <p className="mt-2 text-center text-[12.5px] text-muted">Showing 300 of {shown.length}. Search to narrow it down.</p>}
      </div>
    </section>
  );
}

function SignStep({ tenant, items, defaultMeal, servedToday, served, rules, onSave }: {
  tenant: Person; items: Item[]; defaultMeal: Item; servedToday: number; served: Served; rules: Rules; onSave: (cart: Cart, signature: string, notes: string, overrideReason: string) => Promise<void>;
}) {
  const padRef = useRef<SignaturePadHandle>(null);
  const [cart, setCart] = useState<Cart>({ [defaultMeal.id]: 1 });
  const [editing, setEditing] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  const [empty, setEmpty] = useState(true);
  const [saving, setSaving] = useState(false);
  const problems = ruleProblems(rules, served, cart, items);
  const overLimit = problems.length > 0;
  const first = tenant.preferredName || tenant.firstName || tenant.displayName;
  const lines = items.filter((i) => cart[i.id]);
  const mealCount = lines.reduce((n, i) => n + cart[i.id], 0);
  const needsReason = overLimit && reason.trim().length < 3;
  const blocked = empty || mealCount === 0 || needsReason || saving;

  const setQty = (id: string, qty: number) =>
    setCart((c) => {
      const next = { ...c };
      if (qty <= 0) delete next[id];
      else next[id] = Math.min(20, qty);
      return next;
    });

  async function submit() {
    const png = padRef.current?.toDataURL();
    if (!png || blocked) return;
    setSaving(true);
    try {
      await onSave(cart, png, notes, overLimit ? reason : "");
    } finally {
      setSaving(false);
    }
  }

  const shownItems = editing ? items : lines;
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-4 scroll-thin md:px-7 md:pt-6 xl:grid xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)] xl:gap-7 xl:pb-6" aria-label={`Serve ${tenant.displayName}`}>
      <div className="space-y-3.5">
        <div className="flex items-center gap-3.5">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-[16px] font-bold text-white md:h-[60px] md:w-[60px] md:text-[19px]" style={{ background: tintFor(tenant.id) }}>{initials(tenant.displayName)}</span>
          <span className="min-w-0">
            <span className="block truncate font-heading text-[20px] font-extrabold text-ink md:text-[24px]">{tenant.displayName}</span>
            <span className="block text-[13.5px] text-muted">{tenant.unit ? `Room ${tenant.unit}` : "No room on file"} · {servedToday > 0 ? `served ${servedToday}× today` : "not served yet today"}</span>
          </span>
        </div>

        {overLimit && (
          <div className="rounded-card border border-status-amberDot/40 bg-status-amberBg px-3.5 py-3 text-status-amberText">
            <p className="flex items-start gap-2 text-[14px] font-semibold">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {problems.length === 1 ? `${problems[0].text}.` : `${first} is past the rules here:`} Pick a reason:
            </p>
            {problems.length > 1 && <ul className="mt-1.5 list-disc space-y-0.5 pl-10 text-[13.5px]">{problems.map((p) => <li key={p.itemId}>{p.text}</li>)}</ul>}
            <div className="mt-2.5 flex flex-wrap gap-2">
              {OVER_LIMIT_REASONS.map((r) => (
                <button key={r} type="button" onClick={() => setReason(r)} aria-pressed={reason === r} className={cn("min-h-[44px] rounded-pill border px-3.5 text-[13.5px] font-semibold", reason === r ? "border-status-amberText bg-status-amberText text-white" : "border-status-amberDot/50 bg-surface text-ink")}>{r}</button>
              ))}
            </div>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="…or type a reason" className="mt-2 min-h-[44px] bg-surface text-ink" />
          </div>
        )}

        <div>
          <ul className="divide-y divide-hairline rounded-card border border-hairline">
            {shownItems.map((item) => {
              const qty = cart[item.id] ?? 0;
              return (
                <li key={item.id} className="flex min-h-[64px] items-center gap-3 px-2.5 py-1.5">
                  <MealThumb item={item} className="h-12 w-12" />
                  <span className={cn("min-w-0 flex-1 text-[15.5px] font-semibold leading-tight", qty ? "text-ink" : "text-muted")}>{item.name}</span>
                  {qty === 0 ? (
                    <button type="button" onClick={() => setQty(item.id, 1)} className="flex h-11 min-w-[72px] items-center justify-center gap-1 rounded-pill border border-hairline px-3 text-[14px] font-semibold text-ink active:scale-95"><Plus className="h-4 w-4" /> Add</button>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <button type="button" onClick={() => setQty(item.id, qty - 1)} aria-label={`One fewer ${item.name}`} className="flex h-11 w-11 items-center justify-center rounded-full bg-subtle text-ink active:scale-95 md:h-12 md:w-12"><Minus className="h-5 w-5" /></button>
                      <span className="tabular w-6 text-center text-[19px] font-bold text-ink" aria-live="polite">{qty}</span>
                      <button type="button" onClick={() => setQty(item.id, qty + 1)} aria-label={`One more ${item.name}`} className="flex h-11 w-11 items-center justify-center rounded-full bg-navy text-white active:scale-95 dark:bg-white dark:text-[#111] md:h-12 md:w-12"><Plus className="h-5 w-5" /></button>
                    </span>
                  )}
                </li>
              );
            })}
            {shownItems.length === 0 && <li className="px-3 py-4 text-center text-[14px] text-muted">No meal chosen. Add one below.</li>}
          </ul>
          <div className="mt-1 flex flex-wrap gap-x-4">
            {items.length > 1 && (
              <button type="button" onClick={() => setEditing((v) => !v)} className="flex min-h-[44px] items-center gap-1 text-[14px] font-semibold text-accent dark:text-white">
                {editing ? "Done" : `Different or extra meal for ${first}`} <ChevronDown className={cn("h-4 w-4 transition-transform", editing && "rotate-180")} />
              </button>
            )}
            <button type="button" onClick={() => { if (noteOpen) setNotes(""); setNoteOpen(!noteOpen); }} className="flex min-h-[44px] items-center gap-1 text-[14px] font-semibold text-accent dark:text-white">
              {noteOpen ? <><X className="h-4 w-4" /> Remove note</> : <><Plus className="h-4 w-4" /> Note</>}
            </button>
          </div>
          {noteOpen && <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="Note (optional)" className="mt-1 min-h-[64px] text-[15px]" autoFocus />}
        </div>
      </div>

      <div className="mt-4 flex flex-1 flex-col xl:mt-0">
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <p className="text-[15px] font-semibold text-ink md:text-[17px]">
            <span className="md:hidden">{first}, sign here</span>
            <span className="hidden md:inline">Turn the screen to {first} to sign</span>
          </p>
          <button type="button" onClick={() => padRef.current?.clear()} disabled={empty} className="min-h-[44px] px-1 text-[14px] font-semibold text-accent disabled:opacity-40 dark:text-white">Clear</button>
        </div>
        <div className="relative min-h-[150px] flex-1 md:min-h-[220px]">
          <SignaturePad ref={padRef} onChangeEmpty={setEmpty} className="absolute inset-0 h-full w-full" />
        </div>
        <div className="flex-none pb-3 pt-3 xl:pb-0">
          <Button className="min-h-[60px] w-full text-[17px] font-extrabold" disabled={blocked} onClick={submit}>
            {mealCount === 0 ? "Choose a meal" : needsReason ? "Pick a reason first" : empty ? "Waiting for signature" : `Save · ${mealCount} meal${mealCount === 1 ? "" : "s"}`}
          </Button>
        </div>
      </div>
    </section>
  );
}

function DoneStep({ last, served, total, onUndo, onNext }: { last?: Saved; served: number; total: number; onUndo: () => void; onNext: () => void }) {
  const nextRef = useRef<HTMLButtonElement>(null);
  useEffect(() => nextRef.current?.focus(), []);
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-10 text-center" aria-live="polite">
      <span className="flex h-24 w-24 items-center justify-center rounded-full bg-status-greenBg md:h-28 md:w-28"><Check className="h-12 w-12 text-status-greenText md:h-14 md:w-14" strokeWidth={3} /></span>
      <h2 className="font-heading text-[28px] font-extrabold text-ink md:text-[32px]">Saved</h2>
      {last && (
        <p className="max-w-[420px] text-[16px] leading-relaxed text-muted md:text-[17px]">
          {last.mealCount} meal{last.mealCount === 1 ? "" : "s"} for {last.name}.
          <br />
          <span className="tabular">{served} of {total} residents served here today.</span>
        </p>
      )}
      <div className="mt-2 flex w-full max-w-[560px] flex-col-reverse gap-3 md:flex-row md:justify-center">
        {last && <Button variant="secondary" className="min-h-[58px] text-[16px] md:px-6" onClick={onUndo}>Undo this entry</Button>}
        <Button ref={nextRef} className="min-h-[58px] text-[17px] font-extrabold md:min-w-[260px]" onClick={onNext}>Next resident</Button>
      </div>
    </section>
  );
}
