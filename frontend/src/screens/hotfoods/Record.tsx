import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDownUp, Check, ChevronDown, ChevronLeft, ChevronRight, Minus, Plus, Search, UtensilsCrossed, X } from "lucide-react";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { SignaturePad, type SignaturePadHandle } from "@/components/attendance/SignaturePad";
import { SyncStatus } from "@/components/hotfoods/SyncStatus";
import { useAuth } from "@/lib/auth";
import { enqueueHotFood, undoHotFood, useHotFoodsQueue, withQueued } from "@/lib/hotFoodsQueue";
import { useHotFoodItems, useHotFoodToday, useSites, useTenants } from "@/lib/queries";
import { cn, initials, tintFor } from "@/lib/utils";
import type { HotFoodItem, Site, Tenant } from "@/lib/types";
import { ManageItemsDialog } from "./ManageItems";
import { slotColor } from "@/components/hotfoods/Charts";
import { readStorage, writeStorage } from "@/lib/storage";
import { cooldownLeft, mealsWithQueued, minutes, ruleProblems, type Rules, type Served } from "@/lib/hotFoodRules";
import { isLocating, LocationHint, PickerStatus, pickerHasIcon, siteOptions, useNearbySite } from "@/components/forms/SiteLocator";

/**
 * Record a hot meal as three guided steps: Meal → Resident → Sign, then a
 * "Saved" screen with Next resident and Undo. The meal is picked once for the
 * shift (remembered for the rest of the day), so for most residents it's tap
 * their name → they sign → Save → Next.
 *
 * Built iPad-first. On a wide screen (iPad landscape, desktop) a side panel
 * holds the steps, the shift's progress and the entries just recorded, with
 * Undo on any that haven't uploaded yet. On iPad portrait the steps run across
 * the top; on a phone they shrink to a progress bar.
 *
 * The screen is held to the viewport (data-fit-screen): every step fits
 * without the page scrolling, the signature pad taking whatever height is
 * left. Only the resident list scrolls, inside its own area under the search.
 *
 * Save never waits on the network: the entry goes into the device's queue
 * (lib/hotFoodsQueue) and uploads behind the scenes, so a dropped connection
 * doesn't stop the line. Served-today counts include this device's queued
 * entries too.
 *
 * The site is picked from the device's location when the person is standing
 * at one of their sites (see SiteLocator), else it's the last site they used.
 */

// In private mode these just aren't remembered.
const SITE_KEY = "ln.hotfoods.site";
const MEAL_KEY = "ln.hotfoods.meal";
const SORT_KEY = "ln.hotfoods.sort";
const remembered = (key: string) => readStorage(key) ?? "";

/** The shift's meal, stored with the day it was picked so tomorrow starts at step 1. */
function rememberedMeal(): { id: string; today: boolean } {
  const raw = remembered(MEAL_KEY);
  const [id, day] = raw.split("|");
  return { id: id ?? "", today: day === new Date().toDateString() };
}

/** One-tap reasons for serving someone past the daily limit or inside the shelter cooldown. */
const OVER_LIMIT_REASONS = ["Picking up for a household member", "Missed an earlier meal", "Extra meals available", "Approved by site manager"];

type Cart = Record<string, number>;
type Step = "meal" | "resident" | "sign" | "done";
type Filter = "all" | "todo" | "served";
/** "regulars": most meals here over the last 30 days first, then by room. */
type Sort = "regulars" | "room";

/** An entry saved during this visit to the screen, for the "Just recorded" list and Undo. */
interface Recent {
  clientId: string;
  name: string;
  detail: string;
  mealCount: number;
  slot: number | null;
}

const mealLabel = (lines: HotFoodItem[], cart: Cart) => lines.map((i) => `${cart[i.id]} ${i.name}`).join(", ");

export function HotFoodsRecordPage() {
  const { can, user } = useAuth();
  const toast = useToast();
  const { data: sites, isLoading: sitesLoading } = useSites();
  const { data: items, isLoading: itemsLoading } = useHotFoodItems();
  const [siteCode, setSiteCode] = useState(() => remembered(SITE_KEY));
  const [initialMeal] = useState(rememberedMeal);
  const [mealId, setMealId] = useState(initialMeal.id);
  const [step, setStep] = useState<Step>(initialMeal.today ? "resident" : "meal");
  const [serving, setServing] = useState<Tenant | null>(null);
  // Their meals today as of being picked. Frozen, because Save queues the entry
  // a beat before the screen moves on, and a live count would flash the
  // over-limit warning for the entry being saved.
  const [servingCount, setServingCount] = useState(0);
  const [servingMeals, setServingMeals] = useState<Served>({});
  const [recent, setRecent] = useState<Recent[]>([]);
  const [managing, setManaging] = useState(false);
  const queue = useHotFoodsQueue();
  const topRef = useRef<HTMLDivElement>(null);

  const site = sites?.find((s) => s.code === siteCode) ?? (sites?.length === 1 ? sites[0] : undefined);
  const { data: rosterData, isLoading: rosterLoading, isPlaceholderData } = useTenants(site?.code, "active", Boolean(site));
  const roster = isPlaceholderData ? [] : rosterData?.items ?? [];
  const { data: today } = useHotFoodToday(site?.code);
  const counts = useMemo(() => withQueued(today?.counts ?? {}, queue.items, site?.code), [today?.counts, queue.items, site?.code]);
  const meals = useMemo(() => mealsWithQueued(today?.meals ?? {}, queue.items, site?.code), [today?.meals, queue.items, site?.code]);
  const rules: Rules = useMemo(() => ({ limit: today?.limit ?? 1, cooldownMinutes: today?.cooldownMinutes ?? 0 }), [today?.limit, today?.cooldownMinutes]);
  const storedMeal = items?.find((i) => i.id === mealId);
  const meal = storedMeal ?? items?.[0];
  // A remembered meal that has since been removed sends the shift back to step 1.
  const current: Step = step !== "meal" && items && !storedMeal ? "meal" : step;
  const queued = useMemo(() => new Set(queue.items.map((i) => i.clientId)), [queue.items]);

  // Location beats memory, but never overrides a site the person chose by
  // hand, and never swaps the site out from under someone signing.
  const nearby = useNearbySite(sites);
  const chosenByHand = useRef(false);
  // The picker reads "Finding your location…" until location answers, unless
  // the person has already picked a site themselves.
  const finding = isLocating(nearby) && !chosenByHand.current;
  useEffect(() => {
    if (!nearby.here || chosenByHand.current || current === "sign") return;
    if (nearby.here.site.code !== site?.code) setSiteCode(nearby.here.site.code);
  }, [nearby.here?.site.code]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (site) writeStorage(SITE_KEY, site.code);
  }, [site?.code]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each step starts at the top of the page.
  useEffect(() => {
    topRef.current?.closest("main")?.scrollTo({ top: 0 });
  }, [current]);

  function changeSite(code: string) {
    chosenByHand.current = true;
    setSiteCode(code);
    setServing(null);
    if (current === "sign" || current === "done") setStep("resident");
  }

  function chooseMeal(id: string) {
    setMealId(id);
    writeStorage(MEAL_KEY, `${id}|${new Date().toDateString()}`);
  }

  function startServing() {
    if (meal) chooseMeal(meal.id);
    setStep("resident");
  }

  function pick(t: Tenant) {
    setServing(t);
    setServingCount(counts[t.id] ?? 0);
    setServingMeals(meals[t.id] ?? {});
    setStep("sign");
  }

  function nextResident() {
    setServing(null);
    setStep("resident");
  }

  function undo(r: Recent) {
    if (undoHotFood(r.clientId)) {
      setRecent((list) => list.filter((x) => x.clientId !== r.clientId));
      toast(`Removed ${r.name}'s entry.`, "info");
      if (current === "done" && recent[0]?.clientId === r.clientId) nextResident();
    } else {
      toast("That entry already uploaded. Void it from Entries if it was a mistake.", "error");
    }
  }

  async function save(t: Tenant, cart: Cart, signature: string, notes: string, overrideReason: string) {
    if (!site || !user) return;
    const lines = (items ?? []).filter((i) => cart[i.id]);
    const mealCount = lines.reduce((n, i) => n + cart[i.id], 0);
    const entry = await enqueueHotFood({
      userId: user.id,
      siteCode: site.code,
      tenantId: t.id,
      tenantName: t.displayName,
      unit: t.unit ?? null,
      mealCount,
      body: {
        site: site.code,
        tenantId: t.id,
        items: lines.map((i) => ({ itemId: i.id, quantity: cart[i.id] })),
        notes: notes.trim() || undefined,
        overrideReason: overrideReason.trim() || undefined,
        signature,
      },
    });
    const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    setRecent((list) =>
      [{ clientId: entry.clientId, name: t.displayName, mealCount, slot: lines[0]?.colorSlot ?? null, detail: `${time} · ${mealLabel(lines, cart)}${overrideReason ? " · extra" : ""}` }, ...list].slice(0, 3)
    );
    setStep("done");
  }

  if (!can("roster.edit")) {
    return <EmptyState title="Recording isn't part of your role" hint="Ask an administrator for a site role to record Hot Foods." icon={<UtensilsCrossed className="h-8 w-8" />} />;
  }
  if (sitesLoading || itemsLoading) return <LoadingState />;
  if (!sites?.length) return <EmptyState title="No sites assigned" hint="You need to be assigned to a site to record Hot Foods. Ask an administrator." icon={<UtensilsCrossed className="h-8 w-8" />} />;
  if (!items?.length || !meal) {
    return (
      <div className="flex flex-col items-center">
        <EmptyState title="No meal types set up" hint="An administrator adds the meals staff can pick from." icon={<UtensilsCrossed className="h-8 w-8" />} />
        {can("forms.manage") && <Button onClick={() => setManaging(true)}>Manage meal types</Button>}
        <ManageItemsDialog open={managing} onOpenChange={setManaging} />
      </div>
    );
  }

  const servedPeople = roster.filter((t) => (counts[t.id] ?? 0) > 0).length;
  const mealsToday = Object.values(counts).reduce((n, c) => n + c, 0);
  const last = recent[0];
  const back = current === "resident" ? () => setStep("meal") : current === "sign" ? nextResident : undefined;

  return (
    <div ref={topRef} data-fit-screen className="flex min-h-0 flex-col overflow-hidden">
      <PhoneHeader title="Hot Foods" />

      {/* Site and upload status share one toolbar row above the steps. On a
          phone it steps aside while the resident signs: the site can't change
          mid-signature anyway, and the pad needs the height. On a wide screen
          it moves into the side panel instead (below), where there's room to
          spare and height is what the steps are short of. */}
      <div className={cn("enter-up flex-none border-b border-hairline px-4 py-2 md:block md:px-7 md:py-3 lg:hidden", current === "sign" && "hidden")}>
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-start gap-3">
          <SiteControl sites={sites} site={site} nearby={nearby} finding={finding} onChange={changeSite} hintOnPhone={current === "meal"} className="min-w-0 flex-1 md:max-w-[360px]" />
          <div className="ml-auto mt-1 shrink-0 md:mt-1.5">
            <SyncStatus />
          </div>
        </div>
      </div>

      <div className="mx-auto flex min-h-0 w-full max-w-[1240px] flex-1 flex-col lg:flex-row">
        <aside className="enter-up flex-none border-b border-hairline bg-sidebar px-4 py-1.5 scroll-thin md:py-3 md:px-7 lg:w-[272px] lg:overflow-y-auto lg:border-b-0 lg:border-r lg:px-5 lg:py-4">
          <div className="mb-3 hidden space-y-2 border-b border-hairline pb-3 lg:block">
            <SiteControl sites={sites} site={site} nearby={nearby} finding={finding} onChange={changeSite} />
            <SyncStatus />
          </div>
          <StepRail step={current} meal={meal} tenant={serving} onBack={back} onGo={setStep} />
          <div className="hidden lg:block">
            <ShiftSummary served={servedPeople} total={roster.length} meals={mealsToday} />
            <RecentList recent={recent} queued={queued} onUndo={undo} />
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {current === "meal" && (
            <MealStep items={items} selected={meal.id} onSelect={chooseMeal} onStart={startServing} onManage={can("forms.manage") ? () => setManaging(true) : undefined} />
          )}
          {current === "resident" &&
            (!site ? (
              <EmptyState title="Choose a site" hint="Pick the site you're serving at to see its residents." />
            ) : (
              <ResidentStep
                roster={roster}
                loading={rosterLoading || isPlaceholderData}
                counts={counts}
                meals={meals}
                regulars={today?.regulars ?? {}}
                regularsDays={today?.regularsDays ?? 30}
                rules={rules}
                meal={meal}
                onPick={pick}
              />
            ))}
          {current === "sign" && serving && (
            <SignStep
              key={serving.id}
              tenant={serving}
              items={items}
              defaultMeal={meal}
              servedToday={servingCount}
              served={servingMeals}
              rules={rules}
              onSave={(cart, sig, notes, reason) => save(serving, cart, sig, notes, reason)}
            />
          )}
          {current === "done" && (
            <DoneStep
              last={last}
              canUndo={Boolean(last && queued.has(last.clientId))}
              served={servedPeople}
              total={roster.length}
              onUndo={() => last && undo(last)}
              onNext={nextResident}
            />
          )}
        </div>
      </div>

      <ManageItemsDialog open={managing} onOpenChange={setManaging} />
    </div>
  );
}

/** The site being served: a picker (with the location hint) for someone with several, else just its name. */
function SiteControl({ sites, site, nearby, finding, onChange, hintOnPhone = true, className }: {
  sites: Site[];
  site?: Site;
  nearby: ReturnType<typeof useNearbySite>;
  finding: boolean;
  onChange: (code: string) => void;
  /** Off past the meal step: on a phone the list below needs the two lines more than the reminder. */
  hintOnPhone?: boolean;
  className?: string;
}) {
  if (sites.length <= 1) return <p className={cn("min-h-[36px] content-center text-[15px] font-semibold text-ink", className)}>{site?.name}</p>;
  return (
    <div className={className}>
      <div className="relative">
        {/* While location looks, the box says so rather than showing the
            remembered site it may be about to replace; picking one by hand
            still works. */}
        <Select
          value={finding ? "" : (site?.code ?? "")}
          onChange={(e) => onChange(e.target.value)}
          options={siteOptions(sites, nearby.ranked)}
          placeholder={finding ? "Finding your location…" : "Choose a site"}
          aria-label="Site"
          className={cn("min-h-[44px] text-[16px] font-semibold md:min-h-[48px]", (finding || pickerHasIcon(nearby, site?.code)) && "pl-9")}
        />
        <PickerStatus nearby={nearby} finding={finding} selectedCode={site?.code} />
      </div>
      <div className={hintOnPhone ? undefined : "hidden md:block"}>
        <LocationHint nearby={nearby} selectedCode={site?.code} onPick={onChange} />
      </div>
    </div>
  );
}

const STEPS: { key: Exclude<Step, "done">; label: string }[] = [
  { key: "meal", label: "Meal" },
  { key: "resident", label: "Resident" },
  { key: "sign", label: "Sign" },
];
const STEP_TITLES: Record<Step, string> = { meal: "Pick the meal", resident: "Who is it for?", sign: "Confirm and sign", done: "All set" };

/**
 * Where the shift is in Meal → Resident → Sign. A bar on the phone, a row of
 * step buttons on iPad portrait, a column in the side panel on wide screens.
 * Finished steps show what was chosen and can be tapped to go back.
 */
function StepRail({ step, meal, tenant, onBack, onGo }: { step: Step; meal: HotFoodItem; tenant: Tenant | null; onBack?: () => void; onGo: (s: Step) => void }) {
  const at = step === "done" ? 3 : STEPS.findIndex((s) => s.key === step);
  const value = (i: number) =>
    i === 0 ? meal.name : i === 1 ? (at >= 2 && tenant ? tenant.displayName : at === 1 ? "Choose someone" : "Next") : at === 3 ? "Signed" : at === 2 ? "Waiting" : "Last";

  return (
    <>
      {/* Phone */}
      {/* Phone: one row — back, the step with the shift's meal under it, and
          the progress as three short bars (labels for screen readers only). */}
      <div className="flex min-h-[44px] items-center gap-1 md:hidden">
        {onBack && (
          <button type="button" onClick={onBack} aria-label="Back a step" className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink">
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[18px] font-heading font-extrabold leading-tight text-ink">{STEP_TITLES[step]}</h2>
          {at >= 1 && <p className="truncate text-[12.5px] leading-tight text-muted">Serving <strong className="font-semibold text-ink">{meal.name}</strong></p>}
        </div>
        <ol className="flex shrink-0 gap-1" aria-label={`Step ${Math.min(at + 1, 3)} of 3`}>
          {STEPS.map((s, i) => (
            <li key={s.key} className={cn("h-[5px] w-6 rounded-pill", i < at ? "bg-status-greenDot" : i === at ? "bg-navy dark:bg-white" : "bg-hairline")}>
              <span className="sr-only">{s.label}{i < at ? ", done" : i === at ? ", current" : ""}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* iPad and wider */}
      <ol className="hidden gap-2 md:flex lg:flex-col lg:gap-1" aria-label="Steps">
        {STEPS.map((s, i) => {
          const done = i < at;
          const cur = i === at;
          return (
            <li key={s.key} className="min-w-0 flex-1 lg:flex-none">
              <button
                type="button"
                disabled={!done}
                onClick={() => onGo(s.key === "sign" ? "resident" : s.key)}
                aria-current={cur ? "step" : undefined}
                className={cn(
                  "flex min-h-[64px] w-full items-center gap-3 rounded-card lg:min-h-[50px] lg:py-1.5 border-[1.5px] px-3 py-2 text-left",
                  cur ? "border-navy bg-surface dark:border-white" : done ? "border-hairline hover:bg-rowhover" : "border-transparent"
                )}
              >
                <span
                  className={cn(
                    "flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border-2 text-[15px] font-extrabold",
                    done ? "border-status-greenDot bg-status-greenDot text-white" : cur ? "border-navy bg-navy text-white dark:border-white dark:bg-white dark:text-[#111]" : "border-strongline bg-surface text-muted"
                  )}
                >
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
        <span className="text-[30px] font-heading font-extrabold tabular text-ink">{served}</span>
        <span className="text-[14px] text-muted tabular">
          of {total} residents served · {meals} meal{meals === 1 ? "" : "s"}
        </span>
      </p>
      <div className="mt-2 h-2 overflow-hidden rounded-pill bg-hairline" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Residents served">
        <div className="h-full rounded-pill bg-status-greenDot" style={{ width: `${pct}%` }} />
      </div>
    </section>
  );
}

function RecentList({ recent, queued, onUndo }: { recent: Recent[]; queued: Set<string>; onUndo: (r: Recent) => void }) {
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
                <span className="block truncate text-[12.5px] text-muted">{r.detail}</span>
              </span>
              {queued.has(r.clientId) ? (
                <Button variant="secondary" size="sm" className="min-h-[40px]" onClick={() => onUndo(r)}>
                  Undo
                </Button>
              ) : (
                <span className="text-[12px] font-semibold text-status-greenText">Uploaded</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Step 1: the shift's meal, chosen once and preselected for everyone. */
function MealStep({ items, selected, onSelect, onStart, onManage }: { items: HotFoodItem[]; selected: string; onSelect: (id: string) => void; onStart: () => void; onManage?: () => void }) {
  const chosen = items.find((i) => i.id === selected) ?? items[0];
  return (
    <>
      <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 scroll-thin md:px-7 md:py-6" aria-label="Meal being served">
        <div className="enter-up mb-3 flex flex-wrap items-end justify-between gap-x-2 md:mb-4">
          <div>
            <h2 className="hidden text-[24px] font-heading font-extrabold text-ink md:block">What are you serving this shift?</h2>
            <p className="text-[13.5px] text-muted md:mt-1 md:text-[14.5px]">Pick once. Everyone you record gets this meal unless you change it for them.</p>
          </div>
          {onManage && (
            <button type="button" onClick={onManage} className="min-h-[40px] text-[13px] font-semibold text-accent dark:text-white">
              Manage meal types
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 md:gap-3.5 lg:grid-cols-3" role="radiogroup">
          {items.map((item) => {
            const on = item.id === chosen.id;
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onSelect(item.id)}
                className={cn(
                  "enter-up relative flex min-h-[64px] items-center gap-2.5 rounded-card border-2 p-2 pr-8 text-left active:scale-[0.99] md:min-h-[136px] md:flex-col md:items-start md:gap-3.5 md:p-4 md:pr-12",
                  on ? "border-navy bg-navsel/50 dark:border-white" : "border-hairline bg-surface hover:border-strongline"
                )}
              >
                <MealThumb item={item} className="h-10 w-10 md:h-16 md:w-16" />
                <span className="text-[15px] font-bold leading-tight text-ink md:text-[17px]">{item.name}</span>
                <span
                  className={cn(
                    "absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full border-2 md:right-3 md:top-4 md:h-7 md:w-7",
                    on ? "border-navy bg-navy text-white dark:border-white dark:bg-white dark:text-[#111]" : "border-strongline"
                  )}
                >
                  {on && <Check className="h-3 w-3 md:h-4 md:w-4" strokeWidth={3.4} />}
                </span>
              </button>
            );
          })}
        </div>
      </section>
      <div className="enter-up flex flex-none justify-end border-t border-hairline bg-surface px-4 py-3 md:px-7 md:py-4">
        <Button className="min-h-[58px] w-full text-[17px] font-extrabold md:w-auto md:min-w-[300px]" onClick={onStart}>
          Start serving {chosen.name}
        </Button>
      </div>
    </>
  );
}

function MealThumb({ item, className }: { item: HotFoodItem; className?: string }) {
  return (
    <span className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-white text-muted ring-1 ring-hairline", className)}>
      {item.imageUrl ? <img src={item.imageUrl} alt="" loading="lazy" className="h-full w-full object-contain p-0.5" /> : <UtensilsCrossed className="h-5 w-5" />}
    </span>
  );
}

/** Step 2: find the resident. Not-served first, most frequent at the top. */
function ResidentStep({ roster, loading, counts, meals, regulars, regularsDays, rules, meal, onPick }: {
  roster: Tenant[];
  loading: boolean;
  counts: Record<string, number>;
  meals: Record<string, Served>;
  regulars: Record<string, number>;
  regularsDays: number;
  rules: Rules;
  meal: HotFoodItem;
  onPick: (t: Tenant) => void;
}) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("todo");
  // Re-render every 30s so a shelter cooldown counts down on its own.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!rules.cooldownMinutes) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [rules.cooldownMinutes]);
  const [sort, setSort] = useState<Sort>(() => (remembered(SORT_KEY) === "room" ? "room" : "regulars"));
  const sortLabel = `Sorted by ${sort === "regulars" ? "most frequent" : "room"}. Tap to sort by ${sort === "regulars" ? "room" : "most frequent"}.`;
  const toggleSort = () => {
    const next = sort === "regulars" ? "room" : "regulars";
    setSort(next);
    writeStorage(SORT_KEY, next);
  };
  const sorted = useMemo(() => {
    const byRoom = (a: Tenant, b: Tenant) => (a.unit ?? "").localeCompare(b.unit ?? "", undefined, { numeric: true }) || a.displayName.localeCompare(b.displayName);
    return [...roster].sort(sort === "regulars" ? (a, b) => (regulars[b.id] ?? 0) - (regulars[a.id] ?? 0) || byRoom(a, b) : byRoom);
  }, [roster, sort, regulars]);
  const servedPeople = sorted.filter((t) => (counts[t.id] ?? 0) > 0).length;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sorted.filter((t) => {
      const n = counts[t.id] ?? 0;
      // A search looks across everyone, so a served resident can still be found.
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
      <div className="enter-up mb-2 flex flex-none flex-col gap-2 md:mb-3 xl:flex-row xl:items-center xl:gap-3">
        <div className="flex gap-2 xl:flex-1">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or room"
            type="search"
            enterKeyHint="search"
            className="min-h-[46px] pl-11 pr-12 text-[16px] md:min-h-[52px]"
            autoComplete="off"
          />
          {q && (
            <button type="button" onClick={() => setQ("")} aria-label="Clear search" className="absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-muted">
              <X className="h-5 w-5" />
            </button>
          )}
        </div>
        {/* Phone: the sort is an icon beside the search, not a row of its own. */}
        <button type="button" onClick={toggleSort} aria-label={sortLabel} title={sortLabel} className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-input border border-hairline text-accent dark:text-white md:hidden">
          <ArrowDownUp className="h-5 w-5" />
        </button>
        </div>
        <div className="flex gap-1 rounded-pill bg-subtle p-1" role="tablist" aria-label="Show">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={filter === t.key}
              onClick={() => setFilter(t.key)}
              className={cn("min-h-[38px] flex-1 whitespace-nowrap rounded-pill md:min-h-[42px] px-3 text-[13.5px] font-semibold tabular", filter === t.key ? "bg-surface text-ink shadow-sm" : "text-muted")}
            >
              {t.label} <span className="font-normal">{t.n}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="enter-up mb-2 hidden flex-none items-center justify-between gap-3 md:flex">
        <p className="min-w-0 truncate text-[13px] text-muted">
          Serving <strong className="font-semibold text-ink">{meal.name}</strong>
        </p>
        <button
          type="button"
          onClick={toggleSort}
          className="flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-pill px-2 text-[13px] font-semibold text-accent dark:text-white"
          aria-label={sortLabel}
        >
          <ArrowDownUp className="h-4 w-4" /> {sort === "regulars" ? "Most frequent first" : "By room"}
        </button>
      </div>

      {/* The one scrolling area on the screen: search and filters stay put above it. */}
      <div className="-mx-4 min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4 scroll-thin md:-mx-7 md:px-7 md:pb-6">
      {loading ? (
        <LoadingState label="Loading residents…" />
      ) : shown.length === 0 ? (
        <EmptyState
          title={q ? "No one matches" : filter === "todo" ? "Everyone has been served" : filter === "served" ? "No one served yet" : "No residents on this roster"}
          hint={q ? "Try part of the name or the room number." : undefined}
        />
      ) : (
        <ul className="enter-up divide-y divide-hairline border-y border-hairline md:mx-0 md:grid md:grid-cols-2 md:gap-3 md:divide-y-0 md:border-0 xl:grid-cols-3">
          {shown.slice(0, 300).map((t) => {
            const n = counts[t.id] ?? 0;
            // The badge speaks for the shift's meal: its count against the
            // per-type limit, or the time left on a shelter cooldown.
            const times = meals[t.id]?.[meal.id] ?? [];
            const over = times.length >= rules.limit;
            const wait = over ? 0 : cooldownLeft(rules, times, now);
            const freq = regulars[t.id] ?? 0;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => onPick(t)}
                  className={cn(
                    "flex min-h-[70px] w-full items-center gap-3 px-4 py-2 text-left hover:bg-rowhover active:bg-navsel/60 md:min-h-[84px] md:rounded-card md:border-[1.5px] md:px-3.5",
                    n > 0 ? "md:border-status-greenDot/30 md:bg-status-greenBg/40" : "md:border-hairline"
                  )}
                >
                  <span
                    className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[14px] font-bold text-white md:h-12 md:w-12", n > 0 && "bg-muted")}
                    style={n > 0 ? undefined : { background: tintFor(t.id) }}
                  >
                    {initials(t.displayName)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate text-[16px] font-semibold md:text-[16.5px]", n > 0 ? "text-muted" : "text-ink")}>{t.displayName}</span>
                    <span className="block truncate text-[13px] text-muted">
                      {t.unit ? `Room ${t.unit}` : "No room on file"}
                      {sort === "regulars" && <span className="tabular"> · {freq > 0 ? `${freq} in ${regularsDays} days` : "New here"}</span>}
                    </span>
                  </span>
                  {n > 0 && (
                    <span
                      className={cn("shrink-0 rounded-pill px-2.5 py-1 text-[12px] font-bold tabular", over || wait ? "bg-status-amberBg text-status-amberText" : "bg-status-greenBg text-status-greenText")}
                      title={wait ? `Cooldown: ${minutes(wait)} left before another ${meal.name}` : undefined}
                    >
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

/**
 * Step 3: the resident, the meal (already filled in), their signature, Save.
 * Another meal type, a second portion or a note is one extra tap. On a wide
 * screen the details sit left and a large signature pad right, ready to turn
 * toward the resident.
 */
function SignStep({ tenant, items, defaultMeal, servedToday, served, rules, onSave }: {
  tenant: Tenant;
  items: HotFoodItem[];
  defaultMeal: HotFoodItem;
  servedToday: number;
  /** Their meals today by type, as of being picked. */
  served: Served;
  rules: Rules;
  onSave: (cart: Cart, signature: string, notes: string, overrideReason: string) => Promise<void>;
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
    // Scrolls only when something opened on top of the usual form — the over-limit
    // reasons, the full meal list, a note — leaves the pad no room at its minimum.
    <section className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-4 scroll-thin md:px-7 md:pt-6 xl:grid xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)] xl:gap-7 xl:pb-6" aria-label={`Serve ${tenant.displayName}`}>
      <div className="enter-up space-y-3.5">
        <div className="flex items-center gap-3.5">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-[16px] font-bold text-white md:h-[60px] md:w-[60px] md:text-[19px]" style={{ background: tintFor(tenant.id) }}>
            {initials(tenant.displayName)}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[20px] font-heading font-extrabold text-ink md:text-[24px]">{tenant.displayName}</span>
            <span className="block text-[13.5px] text-muted">
              {tenant.unit ? `Room ${tenant.unit}` : "No room on file"} · {servedToday > 0 ? `served ${servedToday}× today` : "not served yet today"}
            </span>
          </span>
        </div>

        {overLimit && (
          <div className="rounded-card border border-status-amberDot/40 bg-status-amberBg px-3.5 py-3 text-status-amberText">
            <p className="flex items-start gap-2 text-[14px] font-semibold">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {problems.length === 1 ? `${problems[0].text}.` : `${first} is past the rules here:`} Pick a reason:
            </p>
            {problems.length > 1 && (
              <ul className="mt-1.5 list-disc space-y-0.5 pl-10 text-[13.5px]">
                {problems.map((p) => <li key={p.itemId}>{p.text}</li>)}
              </ul>
            )}
            <div className="mt-2.5 flex flex-wrap gap-2">
              {OVER_LIMIT_REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setReason(r)}
                  aria-pressed={reason === r}
                  className={cn("min-h-[44px] rounded-pill border px-3.5 text-[13.5px] font-semibold", reason === r ? "border-status-amberText bg-status-amberText text-white" : "border-status-amberDot/50 bg-surface text-ink")}
                >
                  {r}
                </button>
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
                    <button type="button" onClick={() => setQty(item.id, 1)} className="flex h-11 min-w-[72px] items-center justify-center gap-1 rounded-pill border border-hairline px-3 text-[14px] font-semibold text-ink active:scale-95">
                      <Plus className="h-4 w-4" /> Add
                    </button>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <button type="button" onClick={() => setQty(item.id, qty - 1)} aria-label={`One fewer ${item.name}`} className="flex h-11 w-11 items-center justify-center rounded-full bg-subtle text-ink active:scale-95 md:h-12 md:w-12">
                        <Minus className="h-5 w-5" />
                      </button>
                      <span className="w-6 text-center text-[19px] font-bold tabular text-ink" aria-live="polite">{qty}</span>
                      <button type="button" onClick={() => setQty(item.id, qty + 1)} aria-label={`One more ${item.name}`} className="flex h-11 w-11 items-center justify-center rounded-full bg-navy text-white active:scale-95 dark:bg-white dark:text-[#111] md:h-12 md:w-12">
                        <Plus className="h-5 w-5" />
                      </button>
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
            {/* Closing clears the text too: a note backed out of isn't saved. */}
            <button
              type="button"
              onClick={() => {
                if (noteOpen) setNotes("");
                setNoteOpen(!noteOpen);
              }}
              className="flex min-h-[44px] items-center gap-1 text-[14px] font-semibold text-accent dark:text-white"
            >
              {noteOpen ? <><X className="h-4 w-4" /> Remove note</> : <><Plus className="h-4 w-4" /> Note</>}
            </button>
          </div>
          {noteOpen && <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="Note (optional)" className="mt-1 min-h-[64px] text-[15px]" autoFocus />}
        </div>
      </div>

      <div className="enter-up mt-4 flex flex-1 flex-col xl:mt-0">
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <p className="text-[15px] font-semibold text-ink md:text-[17px]">
            <span className="md:hidden">{first}, sign here</span>
            <span className="hidden md:inline">Turn the screen to {first} to sign</span>
          </p>
          <button type="button" onClick={() => padRef.current?.clear()} disabled={empty} className="min-h-[44px] px-1 text-[14px] font-semibold text-accent disabled:opacity-40 dark:text-white">
            Clear
          </button>
        </div>
        {/* The wrapper takes the leftover height; the canvas fills it absolutely,
            so its backing-store size never feeds back into the layout. */}
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

/** After Save: confirmation, Undo while the entry is still on the device, Next resident. */
function DoneStep({ last, canUndo, served, total, onUndo, onNext }: { last?: Recent; canUndo: boolean; served: number; total: number; onUndo: () => void; onNext: () => void }) {
  const nextRef = useRef<HTMLButtonElement>(null);
  useEffect(() => nextRef.current?.focus(), []);
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-10 text-center" aria-live="polite">
      <span className="enter-pop flex h-24 w-24 items-center justify-center rounded-full bg-status-greenBg md:h-28 md:w-28">
        <Check className="h-12 w-12 text-status-greenText md:h-14 md:w-14" strokeWidth={3} />
      </span>
      <h2 className="enter-up text-[28px] font-heading font-extrabold text-ink md:text-[32px]">Saved</h2>
      {last && (
        <p className="enter-up max-w-[420px] text-[16px] leading-relaxed text-muted md:text-[17px]">
          {last.mealCount} meal{last.mealCount === 1 ? "" : "s"} for {last.name}.
          <br />
          <span className="tabular">
            {served} of {total} residents served here today.
          </span>
        </p>
      )}
      <div className="enter-up mt-2 flex w-full max-w-[560px] flex-col-reverse gap-3 md:flex-row md:justify-center">
        {canUndo && (
          <Button variant="secondary" className="min-h-[58px] text-[16px] md:px-6" onClick={onUndo}>
            Undo this entry
          </Button>
        )}
        <Button ref={nextRef} className="min-h-[58px] text-[17px] font-extrabold md:min-w-[260px]" onClick={onNext}>
          Next resident
        </Button>
      </div>
    </section>
  );
}
