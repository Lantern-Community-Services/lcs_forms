import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, GripVertical, LayoutDashboard, PencilLine, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useAuth } from "@/lib/auth";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { cn } from "@/lib/utils";
import {
  SIZE_LABEL,
  SIZE_SPAN,
  clean,
  loadLayout,
  moveTo,
  presets,
  sameLayout,
  saveLayout,
  BLANK,
  type LayoutItem,
  type Preset,
  type WidgetId,
  type WidgetSize,
} from "./layout";
import { WIDGETS, WIDGET_BY_ID, type WidgetCtx, type WidgetDef } from "./widgets";

/**
 * The Forms home's dashboard on tablet and desktop, which each person arranges
 * for themselves. All forms is one of its widgets, near the top of every
 * preset; someone who removes it still sees search matches, above the rest
 * (searchOnly). It starts blank — All forms alone —
 * offering four layouts to start from; Edit
 * dashboard opens the editor with the widget panel beside it, where widgets
 * are added (or a layout picked), dragged to new places, resized (S / M / L /
 * Full) and removed. Nothing changes until Save; Cancel throws the draft away.
 *
 * Ported from the invoices site's dashboard (lcs_invoices screens/Dashboard).
 * Moving widgets works like rearranging apps on an iPhone: in the editor they
 * jiggle, the one picked up lifts and follows the pointer or finger, the rest
 * slide out of its way, and it settles into its new place when let go. On a
 * touchscreen a widget is picked up by pressing and holding (so a swipe still
 * scrolls the page), or straight away by its handle.
 *
 * The phone keeps its fixed home screen (screens/Forms): there's no room to
 * arrange anything, and the forms have to be reachable without scrolling.
 */
export function HomeDashboard({ heading, search, ctx }: { heading: React.ReactNode; search: React.ReactNode; ctx: WidgetCtx }) {
  const { user, can } = useAuth();
  const toast = useToast();
  const desktop = useMediaQuery("(min-width: 1280px)");
  const userId = user?.id ?? "anon";
  const rosterAccess = can("roster.view");

  const available = useMemo(() => WIDGETS.filter((w) => !w.allowed || w.allowed(can)), [can]);
  const allowedSizes = useMemo(() => {
    const ids = new Map(available.map((w) => [w.id, w.sizes]));
    return (id: WidgetId) => ids.get(id) ?? null;
  }, [available]);
  const presetList = useMemo(
    () => presets(desktop, rosterAccess).map((p) => ({ ...p, items: clean(p.items, allowedSizes) })),
    [desktop, rosterAccess, allowedSizes]
  );

  // Nothing saved on this device yet: a blank dashboard (All forms alone), with the layouts to start from.
  const [saved, setSaved] = useState<LayoutItem[]>(() => loadLayout(userId, allowedSizes) ?? BLANK);
  useEffect(() => setSaved(loadLayout(userId, allowedSizes) ?? BLANK), [userId, allowedSizes]);

  const [draft, setDraft] = useState<LayoutItem[] | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const editing = draft !== null;
  const items = draft ?? saved;

  const { gridRef, slotRef, cardRef, cardProps, dragging, animated } = useDragSort(items, editing, (next) => setDraft(next));

  const start = (from: LayoutItem[] = saved) => {
    setDraft(from);
    setPaletteOpen(true);
  };
  const cancel = () => {
    setDraft(null);
    setPaletteOpen(false);
  };
  const save = () => {
    if (!draft) return;
    saveLayout(userId, draft);
    setSaved(draft);
    setDraft(null);
    setPaletteOpen(false);
    toast("Dashboard saved on this device.", "success");
  };

  // Escape closes the panel, then leaves the editor.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (paletteOpen) setPaletteOpen(false);
      else cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, paletteOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (fn: (items: LayoutItem[]) => LayoutItem[]) => draft && animated(fn(draft));
  const add = (w: WidgetDef) => update((d) => (d.some((x) => x.id === w.id) ? d : [...d, { id: w.id, size: w.sizes[0] }]));
  const remove = (id: WidgetId) => update((d) => d.filter((x) => x.id !== id));
  const resize = (id: WidgetId, size: WidgetSize) => update((d) => d.map((x) => (x.id === id ? { ...x, size } : x)));
  const nudge = (id: WidgetId, by: -1 | 1) => update((d) => moveTo(d, id, d.findIndex((x) => x.id === id) + by));

  const placed = new Set(items.map((x) => x.id));
  const visible = items.filter((it) => {
    const def = WIDGET_BY_ID.get(it.id);
    return def && (editing || !def.isEmpty?.(ctx));
  });
  const unchanged = draft !== null && sameLayout(draft, saved);
  // Nothing but the forms (or nothing at all): time to pick a layout.
  const blank = visible.every((it) => it.id === "all_forms");
  // Searching without All forms on the dashboard: the matches still need somewhere to show.
  const searchOnly = ctx.searching && !editing && !placed.has("all_forms");

  return (
    <div>
      <div className="enter-up mb-5 flex flex-wrap items-center justify-between gap-4 xl:mb-6">
        <div className="min-w-0">{heading}</div>
        <div className="flex flex-wrap items-center gap-2">
          {editing ? (
            <>
              {!paletteOpen && (
                <Button variant="secondary" onClick={() => setPaletteOpen(true)}>
                  <Plus className="h-4 w-4" /> Widgets
                </Button>
              )}
              <Button variant="secondary" onClick={cancel}>Cancel</Button>
              <Button onClick={save} disabled={unchanged}>Save dashboard</Button>
            </>
          ) : (
            <>
              {search}
              <Button variant="secondary" onClick={() => start()} data-tour="home-edit" className="h-10">
                <PencilLine className="h-4 w-4" /> Edit dashboard
              </Button>
            </>
          )}
        </div>
      </div>

      {editing && !blank && (
        <p className="enter-up mb-3 rounded-input border border-dashed border-strongline bg-subtle px-4 py-2.5 text-[13px] text-muted" role="status">
          Drag a widget to move it (on an iPad, press and hold it first). Pick S, M, L or Full for its width. Saved on this device only.
        </p>
      )}

      {searchOnly && <div className="mb-7">{ctx.renderForms("full")}</div>}
      {blank && (
        <EmptyDashboard
          editing={editing}
          presetList={presetList}
          onPreset={(p) => (editing ? animated(p.items) : start(p.items))}
          onBuild={() => (editing ? setPaletteOpen(true) : start())}
        />
      )}
      {visible.length > 0 && (
        <div ref={gridRef} className="relative mb-7 grid grid-cols-6 items-stretch gap-3.5 xl:grid-cols-12 xl:gap-5">
          {visible.map((it, i) => {
            const def = WIDGET_BY_ID.get(it.id)!;
            const lifted = dragging === it.id;
            return (
              <div
                key={it.id}
                ref={slotRef(it.id)}
                data-widget={it.id}
                className={cn(
                  "dashboard-widget relative min-w-0 rounded-card",
                  SIZE_SPAN[it.size],
                  def.compact && "self-start",
                  // Where it will land: an outline left behind while it's carried.
                  lifted && "bg-navsel/30 outline-dashed outline-2 -outline-offset-2 outline-accent/45"
                )}
              >
                <div
                  ref={cardRef(it.id)}
                  {...cardProps(it.id)}
                  className={cn(
                    "h-full",
                    editing && "cursor-grab select-none [-webkit-touch-callout:none]",
                    lifted && "relative z-30 cursor-grabbing"
                  )}
                >
                  <div
                    className={cn("flex h-full flex-col gap-1.5 rounded-card transition-shadow duration-200", editing && !lifted && "dashboard-jiggle", lifted && "shadow-[0_22px_48px_rgba(35,42,58,0.28)]")}
                    style={editing ? ({ "--jiggle": JIGGLE[it.size], animationDelay: `${-((i * 97) % 260)}ms` } as React.CSSProperties) : undefined}
                  >
                    {editing && (
                      <EditBar
                        def={def}
                        size={it.size}
                        first={i === 0}
                        last={i === visible.length - 1}
                        onResize={(s) => resize(it.id, s)}
                        onNudge={(by) => nudge(it.id, by)}
                        onRemove={() => remove(it.id)}
                      />
                    )}
                    <div
                      // In the editor the widget is a picture of itself: nothing inside it takes a tap.
                      inert={editing || undefined}
                      className={cn("min-h-0 flex-1", editing && "pointer-events-none rounded-card ring-1 ring-strongline", lifted && "ring-2 ring-accent")}
                    >
                      {def.render(ctx, it.size)}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && paletteOpen && (
        <WidgetPalette
          available={available}
          placed={placed}
          ctx={ctx}
          presetList={presetList}
          current={items}
          unchanged={unchanged}
          onAdd={add}
          onApply={(p) => animated(p.items)}
          onClear={() => animated([])}
          onSave={save}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  );
}

/** How far each width rocks while jiggling: wide widgets less, so their edges don't swing. */
const JIGGLE: Record<WidgetSize, string> = { small: "0.45deg", medium: "0.3deg", large: "0.2deg", full: "0.12deg" };

// ── Moving widgets ───────────────────────────────────────────────────────

interface Drag {
  id: WidgetId;
  pointerId: number;
  touch: boolean;
  /** Started on the handle: a finger doesn't need to hold first. */
  handle: boolean;
  startX: number;
  startY: number;
  /** Where in the card it was grabbed. */
  grabX: number;
  grabY: number;
  x: number;
  y: number;
  active: boolean;
  liftedAt: number;
  hold: number | null;
  raf: number;
  /** The widget it last swapped with: not again until the pointer has left it. */
  lastTarget: WidgetId | null;
  lastSwapAt: number;
}

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * Pick up, carry and drop. Each widget has a slot (its place in the grid) and
 * a card inside it (what's carried). While carried, the card is moved every
 * frame to sit under the pointer, wherever its slot is; when the pointer is
 * over another widget, the carried one takes that widget's place and the
 * others glide to their new slots (FLIP). Let go and the card settles into
 * its slot with a small spring.
 */
function useDragSort(items: LayoutItem[], editing: boolean, onChange: (next: LayoutItem[]) => void) {
  const gridRef = useRef<HTMLDivElement>(null);
  const slots = useRef(new Map<WidgetId, HTMLElement>());
  const cards = useRef(new Map<WidgetId, HTMLElement>());
  const rects = useRef(new Map<WidgetId, DOMRect>());
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState<WidgetId | null>(null);
  const latest = useRef(items);
  latest.current = items;
  const change = useRef(onChange);
  change.current = onChange;

  const keep = (map: Map<WidgetId, HTMLElement>, id: WidgetId) => (el: HTMLElement | null) => {
    if (el) map.set(id, el);
    else map.delete(id);
  };

  /** FLIP, first half: where every slot is on screen now (mid-glide included). */
  const measure = () => {
    rects.current = new Map([...slots.current].map(([id, el]) => [id, el.getBoundingClientRect()]));
  };

  // FLIP, second half: after the change, each slot glides from where it was.
  const order = items.map((x) => `${x.id}:${x.size}`).join(",");
  useLayoutEffect(() => {
    const before = rects.current;
    rects.current = new Map();
    if (!before.size || reducedMotion()) return;
    for (const [id, el] of slots.current) {
      const was = before.get(id);
      // The carried one is drawn under the pointer, not in its slot.
      if (!was || id === drag.current?.id) continue;
      el.getAnimations().forEach((a) => a.cancel());
      const now = el.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], { duration: 380, easing: "cubic-bezier(0.25, 1, 0.5, 1)" });
    }
  }, [order]);

  /** Make a change, with the widgets gliding to their new places. */
  const animated = (next: LayoutItem[]) => {
    measure();
    change.current(next);
  };

  const frame = () => {
    const d = drag.current;
    if (!d?.active) return;
    const slot = slots.current.get(d.id);
    const card = cards.current.get(d.id);
    const grid = gridRef.current;
    if (!slot || !card || !grid) return;
    const now = performance.now();

    autoScroll(grid, d.y);

    // Follow the pointer, lifting a little over the first moments.
    const s = slot.getBoundingClientRect();
    const lift = reducedMotion() ? 1 : easeOut(Math.min(1, (now - d.liftedAt) / 160));
    card.style.transform = `translate3d(${d.x - d.grabX - s.left}px, ${d.y - d.grabY - s.top}px, 0) scale(${1 + 0.035 * lift})`;

    // Over another widget: take its place. Layout boxes (offsets) ignore the glides in progress.
    const g = grid.getBoundingClientRect();
    const px = d.x - g.left;
    const py = d.y - g.top;
    let over: WidgetId | null = null;
    for (const [id, el] of slots.current) {
      if (id === d.id) continue;
      if (px >= el.offsetLeft && px <= el.offsetLeft + el.offsetWidth && py >= el.offsetTop && py <= el.offsetTop + el.offsetHeight) {
        over = id;
        break;
      }
    }
    if (over !== d.lastTarget) {
      if (d.lastTarget && over === null) d.lastTarget = null;
      if (over && now - d.lastSwapAt > 90) {
        const list = latest.current;
        const from = list.findIndex((x) => x.id === d.id);
        const to = list.findIndex((x) => x.id === over);
        const without = list.filter((x) => x.id !== d.id);
        const k = without.findIndex((x) => x.id === over);
        const next = moveTo(list, d.id, from < to ? k + 1 : k);
        if (next !== list) {
          d.lastTarget = over;
          d.lastSwapAt = now;
          animated(next);
        }
      }
    }
    d.raf = requestAnimationFrame(frame);
  };

  const activate = () => {
    const d = drag.current;
    if (!d || d.active) return;
    d.active = true;
    d.liftedAt = performance.now();
    d.hold = null;
    setDragging(d.id);
    if (d.touch) navigator.vibrate?.(8);
    d.raf = requestAnimationFrame(frame);
  };

  // A carried widget keeps the page from scrolling under a finger (touchmove must be non-passive for that).
  useEffect(() => {
    const block = (e: TouchEvent) => {
      if (drag.current?.active) e.preventDefault();
    };
    window.addEventListener("touchmove", block, { passive: false });
    return () => window.removeEventListener("touchmove", block);
  }, []);

  // Window listeners that stay the same function across renders, so the one added is the one removed.
  const handlers = useRef({ move: (_e: PointerEvent) => {}, end: (_e: PointerEvent) => {} });
  const listen = useRef({ move: (e: PointerEvent) => handlers.current.move(e), end: (e: PointerEvent) => handlers.current.end(e) }).current;

  const finish = () => {
    const d = drag.current;
    drag.current = null;
    window.removeEventListener("pointermove", listen.move);
    window.removeEventListener("pointerup", listen.end);
    window.removeEventListener("pointercancel", listen.end);
    if (!d) return;
    if (d.hold) clearTimeout(d.hold);
    if (!d.active) return;
    cancelAnimationFrame(d.raf);
    const card = cards.current.get(d.id);
    if (card) {
      const from = card.style.transform;
      card.style.transform = "";
      // Settle into the slot, overshooting a touch.
      if (from && !reducedMotion()) card.animate([{ transform: from }, { transform: "none" }], { duration: 300, easing: "cubic-bezier(0.3, 1.25, 0.5, 1)" });
    }
    setDragging(null);
  };

  function onMove(e: PointerEvent) {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    d.x = e.clientX;
    d.y = e.clientY;
    if (d.active) return;
    const moved = Math.hypot(d.x - d.startX, d.y - d.startY);
    if (d.touch && !d.handle) {
      // Moving before the hold is up is a swipe: let the page scroll.
      if (moved > 10) finish();
    } else if (moved > 4) {
      activate();
    }
  }

  function onEnd(e: PointerEvent) {
    if (drag.current && e.pointerId === drag.current.pointerId) finish();
  }
  handlers.current = { move: onMove, end: onEnd };

  // Leaving the editor (Save, Cancel) mid-carry drops it.
  useEffect(() => {
    if (!editing) finish();
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const cardProps = (id: WidgetId) =>
    editing
      ? {
          onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
            if (drag.current || (e.pointerType === "mouse" && e.button !== 0)) return;
            const t = e.target as HTMLElement;
            const handle = Boolean(t.closest("[data-drag-handle]"));
            // The toolbar's own buttons (width, move, remove) are for tapping.
            if (!handle && t.closest("button")) return;
            const r = e.currentTarget.getBoundingClientRect();
            const touch = e.pointerType === "touch";
            drag.current = {
              id,
              pointerId: e.pointerId,
              touch,
              handle,
              startX: e.clientX,
              startY: e.clientY,
              grabX: e.clientX - r.left,
              grabY: e.clientY - r.top,
              x: e.clientX,
              y: e.clientY,
              active: false,
              liftedAt: 0,
              hold: null,
              raf: 0,
              lastTarget: null,
              lastSwapAt: 0,
            };
            if (!touch) e.preventDefault();
            window.addEventListener("pointermove", listen.move);
            window.addEventListener("pointerup", listen.end);
            window.addEventListener("pointercancel", listen.end);
            if (touch && handle) activate();
            else if (touch) drag.current.hold = window.setTimeout(activate, 260);
          },
        }
      : {};

  return { gridRef, slotRef: (id: WidgetId) => keep(slots.current, id), cardRef: (id: WidgetId) => keep(cards.current, id), cardProps, dragging, animated };
}

/** Near the top or bottom of the scrolling pane, scroll it (faster closer to the edge) so a widget can be carried past the screen. */
function autoScroll(from: HTMLElement, y: number) {
  let pane: HTMLElement | null = from.parentElement;
  while (pane && !(pane.scrollHeight > pane.clientHeight && /(auto|scroll)/.test(getComputedStyle(pane).overflowY))) pane = pane.parentElement;
  const target = pane ?? document.scrollingElement;
  if (!target) return;
  const box = pane ? pane.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  const edge = 80;
  if (y < box.top + edge) target.scrollTop -= Math.ceil(((box.top + edge - y) / edge) * 14);
  else if (y > box.bottom - edge) target.scrollTop += Math.ceil(((y - (box.bottom - edge)) / edge) * 14);
}

// ── Editor pieces ────────────────────────────────────────────────────────

function EditBar({ def, size, first, last, onResize, onNudge, onRemove }: {
  def: WidgetDef;
  size: WidgetSize;
  first: boolean;
  last: boolean;
  onResize: (s: WidgetSize) => void;
  onNudge: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const iconBtn = "flex h-8 w-8 items-center justify-center rounded-[6px] text-muted hover:bg-subtle hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent";
  return (
    <div className="flex flex-none items-center gap-1 rounded-input border border-hairline bg-surface p-1 shadow-card">
      <button
        type="button"
        data-drag-handle
        aria-label={`Drag ${def.title} to move it`}
        title="Drag to move"
        className="flex h-8 w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-[6px] text-muted hover:bg-subtle hover:text-ink active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="min-w-0 flex-1 truncate px-1 text-[12.5px] font-bold text-ink">{def.title}</span>
      {def.sizes.length > 1 && (
        <div className="flex shrink-0 rounded-[7px] bg-subtle p-[2px]" role="group" aria-label={`${def.title} width`}>
          {def.sizes
            .slice()
            .sort((a, b) => ORDER[a] - ORDER[b])
            .map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onResize(s)}
                aria-pressed={size === s}
                title={SIZE_LABEL[s].long}
                className={cn(
                  "h-7 min-w-[28px] rounded-[5px] px-1.5 text-[11.5px]",
                  size === s ? "bg-surface font-bold text-ink shadow-card" : "font-semibold text-muted hover:text-ink"
                )}
              >
                {SIZE_LABEL[s].short}
              </button>
            ))}
        </div>
      )}
      <button type="button" className={iconBtn} disabled={first} onClick={() => onNudge(-1)} aria-label={`Move ${def.title} earlier`} title="Move earlier">
        <ArrowLeft className="h-4 w-4" />
      </button>
      <button type="button" className={iconBtn} disabled={last} onClick={() => onNudge(1)} aria-label={`Move ${def.title} later`} title="Move later">
        <ArrowRight className="h-4 w-4" />
      </button>
      <button type="button" className={cn(iconBtn, "hover:bg-status-redBg hover:text-status-redText")} onClick={onRemove} aria-label={`Remove ${def.title}`} title="Remove">
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

const ORDER: Record<WidgetSize, number> = { small: 0, medium: 1, large: 2, full: 3 };

/** The four layouts as cards to pick from: on the blank dashboard (big) and in the widget panel. */
function PresetCards({ presetList, current, onPick, big = false }: { presetList: Preset[]; current?: LayoutItem[]; onPick: (p: Preset) => void; big?: boolean }) {
  return (
    <div className={cn("grid gap-2", big ? "grid-cols-2 xl:grid-cols-4 xl:gap-3" : "grid-cols-2")}>
      {presetList.map((p) => {
        const on = Boolean(current?.length) && sameLayout(p.items, current!);
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onPick(p)}
            aria-pressed={current ? on : undefined}
            className={cn(
              "flex flex-col gap-2 rounded-input border text-left transition-colors",
              big ? "bg-surface p-3.5 shadow-card" : "p-2.5",
              on ? "border-accent bg-navsel/50" : "border-hairline hover:border-strongline hover:bg-rowhover"
            )}
          >
            <PresetSketch items={p.items} big={big} />
            <span className={cn("font-bold text-ink", big ? "text-[14.5px]" : "text-[13px]")}>{p.title}</span>
            <span className={cn("leading-snug text-muted", big ? "text-[12.5px]" : "text-[11.5px]")}>{p.description}</span>
          </button>
        );
      })}
    </div>
  );
}

function EmptyDashboard({ editing, presetList, onPreset, onBuild }: { editing: boolean; presetList: Preset[]; onPreset: (p: Preset) => void; onBuild: () => void }) {
  return (
    <section data-tour="home-dashboard" className="enter-up mb-7 rounded-card border border-dashed border-strongline bg-subtle/60 px-5 py-6 xl:px-7 xl:py-7">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-navsel text-accent dark:text-white">
          <LayoutDashboard className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-heading font-extrabold text-ink">{editing ? "Your dashboard is empty" : "Make this page yours"}</h2>
          <p className="text-[13px] text-muted">Start from a layout, or build your own from the widget list. You can change it any time.</p>
        </div>
        <Button variant="secondary" onClick={onBuild}>
          <Plus className="h-4 w-4" /> Build my own
        </Button>
      </div>
      <PresetCards presetList={presetList} onPick={onPreset} big />
    </section>
  );
}

/**
 * The side panel of layouts and widgets to add, each widget with a live,
 * scaled-down preview. It opens with the editor and floats over the page
 * without a backdrop: the dashboard keeps its full width underneath, so what
 * you arrange is what you'll see after saving. On a phone or iPad it stops
 * at the top of the dock, so its Save button isn't hidden behind the bar.
 */
function WidgetPalette({ available, placed, ctx, presetList, current, unchanged, onAdd, onApply, onClear, onSave, onClose }: {
  available: WidgetDef[];
  placed: Set<WidgetId>;
  ctx: WidgetCtx;
  presetList: Preset[];
  current: LayoutItem[];
  unchanged: boolean;
  onAdd: (w: WidgetDef) => void;
  onApply: (p: Preset) => void;
  onClear: () => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const toAdd = available.filter((w) => !placed.has(w.id));
  const dock = useDockHeight();
  return (
    <aside
      aria-label="Widgets"
      style={{ bottom: dock }}
      className={cn(
        "dashboard-palette fixed right-0 top-0 z-40 flex w-[380px] max-w-[calc(100vw-1rem)] flex-col border-l border-hairline bg-surface shadow-modal",
        dock > 0 && "rounded-bl-card border-b"
      )}
    >
      <div className="flex items-center gap-2 border-b border-hairline px-4 py-3 pt-safe-top">
        <h2 className="flex-1 text-[17px] font-heading font-extrabold text-ink">Edit dashboard</h2>
        <button type="button" onClick={onClose} aria-label="Close the widget panel" title="Close the panel (your changes stay)" className="flex h-9 w-9 items-center justify-center rounded-input text-muted hover:bg-subtle hover:text-ink">
          <X className="h-[18px] w-[18px]" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 scroll-thin">
        <h3 className="mb-2 text-micro font-bold uppercase tracking-[0.08em] text-muted">Start from a layout</h3>
        <div data-tour="home-presets" className="mb-5">
          <PresetCards presetList={presetList} current={current} onPick={onApply} />
        </div>

        <h3 className="mb-2 text-micro font-bold uppercase tracking-[0.08em] text-muted">Add widgets</h3>
        {toAdd.length === 0 ? (
          <p className="rounded-input bg-subtle px-3 py-4 text-center text-[13px] text-muted">Every widget is on your dashboard.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {toAdd.map((w) => (
              <li key={w.id} className="overflow-hidden rounded-card border border-hairline">
                <div className="relative h-[118px] overflow-hidden bg-appbg" aria-hidden>
                  {/* The real widget at half size, so what's added is what was shown. */}
                  <div inert className="pointer-events-none absolute left-3 top-3 w-[calc(200%-48px)] origin-top-left scale-50">
                    {w.render(ctx, w.sizes[0])}
                  </div>
                </div>
                <div className="flex items-center gap-3 border-t border-hairline px-3 py-2.5">
                  <w.icon className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-bold text-ink">{w.title}</span>
                    <span className="block text-[12px] leading-snug text-muted">{w.description}</span>
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => onAdd(w)} aria-label={`Add ${w.title}`}>
                    <Plus className="h-3.5 w-3.5" /> Add
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {/* Above the dock, the dock has already cleared the home indicator. */}
      <div className={cn("flex items-center gap-2 border-t border-hairline px-4 py-3", dock === 0 && "pb-safe-bottom")}>
        <Button variant="ghost" size="sm" className="text-status-redText" onClick={onClear} disabled={current.length === 0}>
          Clear all
        </Button>
        <span className="flex-1" />
        {/* Here too, since on an iPad the panel covers the page's own Save. */}
        <Button onClick={onSave} disabled={unchanged} data-tour="home-save">
          Save dashboard
        </Button>
      </div>
    </aside>
  );
}

/** A layout as little bars, a 12-column row at a time, for picking by shape. */
function PresetSketch({ items, big }: { items: LayoutItem[]; big: boolean }) {
  const span: Record<WidgetSize, number> = { small: 4, medium: 6, large: 8, full: 12 };
  return (
    <span className={cn("grid grid-cols-12 content-start gap-[3px] overflow-hidden", big ? "h-[58px]" : "h-[46px]")} aria-hidden>
      {items.map((it) => (
        <span key={it.id} className={cn("rounded-[2px] bg-strongline", big ? "h-[11px]" : "h-[9px]")} style={{ gridColumn: `span ${span[it.size]} / span ${span[it.size]}` }} />
      ))}
    </span>
  );
}

/**
 * How tall the phone / iPad dock is (AppShell's bottom bar), or 0 where there's
 * none (a computer, or while the on-screen keyboard has hidden it). It's a
 * flex sibling of the page, so a panel fixed to the screen has to stop above it.
 */
function useDockHeight() {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    let dock: HTMLElement | null = null;
    const read = () => setHeight(dock?.offsetHeight ?? 0);
    const ro = new ResizeObserver(read);
    const watch = () => {
      const now = document.querySelector<HTMLElement>('nav[data-tour="dock"]');
      if (now === dock) return;
      ro.disconnect();
      dock = now;
      if (dock) ro.observe(dock);
      read();
    };
    watch();
    // The dock comes and goes with the keyboard: notice when it's put back.
    const mo = new MutationObserver(watch);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);
  return height;
}
