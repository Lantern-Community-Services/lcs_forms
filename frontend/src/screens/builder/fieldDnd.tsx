import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { GripVertical, Plus } from "lucide-react";
import type { FieldType } from "@/lib/formEngine";
import { cn } from "@/lib/utils";

/**
 * Drag and drop for the builder's canvas, on pointer events rather than HTML5
 * drag: palette tiles drop in at a position and fields reorder, with the rows
 * sliding apart to open the spot, a card that follows the pointer and flies
 * into place on release (or back home on cancel), and FLIP animations for
 * every other change to the list (move up/down, duplicate, undo).
 *
 * The list is the element behind `listRef` (position: relative); each field is
 * a direct child carrying `data-field-row="<id>"`.
 */

export const EASE = "cubic-bezier(.2,.8,.2,1)";
const SLOT_H = 64;
const SLOT_INSET = 4; // rows carry py-1, so a slot sits 4px inside the row box it replaces
const THRESHOLD = 4;
const LAND_MS = 200;

export const prefersReducedMotion = () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

export type DragSource = { kind: "new"; type: FieldType; label: string } | { kind: "move"; id: string; label: string };

type Rect = { x: number; y: number; w: number; h: number };
interface Layout { tops: number[]; heights: number[]; end: number }
interface Drag { src: DragSource; x: number; y: number; over: boolean; index: number; layout: Layout; landing: Rect | null }

const rowsOf = (list: HTMLElement) => Array.from(list.querySelectorAll<HTMLElement>(":scope > [data-field-row]"));
const rowById = (list: HTMLElement, id: string) => rowsOf(list).find((r) => r.dataset.fieldRow === id) ?? null;
const toRect = (r: DOMRect): Rect => ({ x: r.left, y: r.top, w: r.width, h: r.height });

/** Untransformed positions: hit-testing against these keeps the slot from jittering while rows slide. */
function measure(list: HTMLElement): Layout {
  const rows = rowsOf(list);
  const tops = rows.map((r) => r.offsetTop);
  const heights = rows.map((r) => r.offsetHeight);
  const end = rows.length ? tops[rows.length - 1] + heights[rows.length - 1] : 0;
  return { tops, heights, end };
}

export function useFieldDnd({ listRef, scrollRef, ids, onDrop }: {
  listRef: RefObject<HTMLElement | null>;
  scrollRef: RefObject<HTMLElement | null>;
  ids: string[];
  /** `index` is the insertion point in the current list (before the move). */
  onDrop: (src: DragSource, index: number) => void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [settling, setSettling] = useState(false);
  const dragRef = useRef<Drag | null>(null);
  const pending = useRef<{ src: DragSource; sx: number; sy: number; origin: Rect; el: HTMLElement; pointerId: number } | null>(null);
  const landing = useRef(false);
  const justDropped = useRef(false);
  const onDropRef = useRef(onDrop);
  useEffect(() => { onDropRef.current = onDrop; });

  const update = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  /** Fly the card into its slot (or back where it came from), then apply the drop. */
  const land = useCallback((cancel: boolean) => {
    const d = dragRef.current, p = pending.current, list = listRef.current;
    if (!d || !p) return;
    landing.current = true;
    const over = d.over && !cancel;
    let target = p.origin;
    if (over && list) {
      const el = d.src.kind === "new"
        ? list.querySelector<HTMLElement>("[data-drop-slot]") ?? list.querySelector<HTMLElement>("[data-drop-empty]")
        : rowById(list, d.src.id);
      if (el) target = toRect(el.getBoundingClientRect());
    }
    update({ ...d, over, landing: target });
    window.setTimeout(() => {
      landing.current = false;
      pending.current = null;
      document.documentElement.classList.remove("lcs-dragging");
      if (over) {
        // Rows already sit where the new order puts them: drop their transforms without a transition.
        setSettling(true);
        onDropRef.current(d.src, d.index);
        requestAnimationFrame(() => requestAnimationFrame(() => setSettling(false)));
      }
      update(null);
    }, prefersReducedMotion() ? 0 : LAND_MS);
  }, [listRef]);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = pending.current, list = listRef.current, scroller = scrollRef.current;
      if (!p || landing.current || e.pointerId !== p.pointerId || !list || !scroller) return;
      const d = dragRef.current;
      if (!d && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < THRESHOLD) return;
      if (!d) {
        // Keep the pointer even over the preview's iframes.
        try { p.el.setPointerCapture(e.pointerId); } catch { /* the element went away */ }
        document.documentElement.classList.add("lcs-dragging");
      }
      const layout = d?.layout ?? measure(list);
      const sr = scroller.getBoundingClientRect();
      const over = e.clientX >= sr.left && e.clientX <= sr.right && e.clientY >= sr.top && e.clientY <= sr.bottom;
      const py = e.clientY - list.getBoundingClientRect().top;
      let index = layout.tops.length;
      for (let i = 0; i < layout.tops.length; i++) {
        if (py < layout.tops[i] + layout.heights[i] / 2) { index = i; break; }
      }
      if (over) {
        if (e.clientY < sr.top + 48) scroller.scrollTop -= 14;
        else if (e.clientY > sr.bottom - 48) scroller.scrollTop += 14;
      }
      update({ src: p.src, x: e.clientX, y: e.clientY, over, index, layout, landing: null });
    };
    const up = (e: PointerEvent) => {
      const p = pending.current;
      if (!p || e.pointerId !== p.pointerId || landing.current) return;
      if (!dragRef.current) { pending.current = null; return; }
      // The click that follows this pointerup mustn't also add or select.
      justDropped.current = true;
      window.setTimeout(() => { justDropped.current = false; }, 0);
      land(e.type === "pointercancel");
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dragRef.current && !landing.current) {
        e.preventDefault();
        land(true);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key);
      document.documentElement.classList.remove("lcs-dragging");
    };
  }, [land, listRef, scrollRef]);

  /** onPointerDown for a drag source. Touch drags only from a `[data-drag-handle]`, so the canvas still scrolls. */
  const start = (src: DragSource) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || landing.current || dragRef.current) return;
    const t = e.target as HTMLElement;
    const handle = t.closest("[data-drag-handle]");
    if (e.pointerType === "touch" && !handle) return;
    const control = t.closest("button, a, input, textarea, select, [contenteditable]");
    if (control && control !== e.currentTarget && !handle) return;
    pending.current = { src, sx: e.clientX, sy: e.clientY, origin: toRect(e.currentTarget.getBoundingClientRect()), el: e.currentTarget, pointerId: e.pointerId };
  };

  // Where each row slides while something is held over the form.
  const { shift, slot, pad } = useMemo(() => {
    const shift = new Map<string, number>();
    let slot: { top: number; h: number } | null = null;
    let pad = 0;
    if (drag?.over && drag.layout.tops.length === ids.length) {
      const { tops, heights, end } = drag.layout, n = ids.length, i0 = drag.index;
      if (drag.src.kind === "new") {
        for (let i = i0; i < n; i++) shift.set(ids[i], SLOT_H + 2 * SLOT_INSET);
        if (n) {
          slot = { top: (i0 < n ? tops[i0] : end) + SLOT_INSET, h: SLOT_H };
          pad = SLOT_H + 2 * SLOT_INSET;
        }
      } else {
        const from = ids.indexOf(drag.src.id);
        if (from >= 0) {
          const to = i0 > from ? i0 - 1 : i0;
          let travel = 0;
          if (to > from) for (let k = from + 1; k <= to; k++) { shift.set(ids[k], -heights[from]); travel += heights[k]; }
          else for (let k = to; k < from; k++) { shift.set(ids[k], heights[from]); travel -= heights[k]; }
          shift.set(drag.src.id, travel);
        }
      }
    }
    return { shift, slot, pad };
  }, [drag, ids]);

  const heldId = drag?.src.kind === "move" ? drag.src.id : null;
  const smooth = !settling && !prefersReducedMotion();

  const rowStyle = (id: string): CSSProperties => {
    const s = shift.get(id);
    return {
      position: "relative",
      zIndex: id === heldId ? 0 : 1,
      transform: s ? `translateY(${s}px)` : undefined,
      transition: smooth ? `transform 220ms ${EASE}` : "none",
    };
  };

  const listStyle: CSSProperties = { paddingBottom: pad || undefined, transition: smooth ? `padding 220ms ${EASE}` : undefined };
  const slotStyle: CSSProperties | null = slot ? { top: slot.top, height: slot.h, transition: smooth ? `top 220ms ${EASE}` : undefined } : null;

  const ghost = drag && typeof document !== "undefined" ? createPortal(<Ghost drag={drag} />, document.body) : null;

  return {
    start,
    rowStyle,
    listStyle,
    slotStyle,
    heldId,
    ghost,
    /** Something is held over the canvas. */
    over: Boolean(drag?.over && !drag.landing),
    /** A palette tile is held over the canvas. */
    overNew: drag?.over && !drag.landing && drag.src.kind === "new" ? drag.src.label : null,
    dragging: Boolean(drag),
    /** True for the click that ends a drag, so it doesn't also add a field or change the selection. */
    consumeClick: () => justDropped.current,
  };
}

function Ghost({ drag }: { drag: Drag }) {
  const l = drag.landing;
  const land = (p: string) => `${p} ${LAND_MS}ms ${EASE}`;
  const style: CSSProperties = l
    ? {
        left: l.x, top: l.y, width: l.w, height: l.h, transform: "none", opacity: 0, boxShadow: "none",
        transition: [land("left"), land("top"), land("width"), land("height"), land("transform"), land("box-shadow"), `opacity ${LAND_MS}ms cubic-bezier(.7,0,.9,.4)`].join(", "),
      }
    : {
        left: drag.x + 14, top: drag.y + 10, width: 230, height: 42,
        transform: drag.over ? "rotate(-1deg) scale(1.03)" : "rotate(-3deg)",
        transition: `transform 180ms ${EASE}, box-shadow 180ms ${EASE}, border-color 150ms`,
      };
  const hint = l || drag.over ? "" : drag.src.kind === "new" ? "drop on the form" : "release to cancel";
  return (
    <div
      aria-hidden
      style={style}
      className={cn(
        "lcs-ghost pointer-events-none fixed z-[100] flex items-center gap-2 overflow-hidden whitespace-nowrap rounded-card border-[1.5px] bg-surface px-2.5 text-[13px] font-semibold text-ink shadow-modal",
        drag.over ? "border-navy dark:border-accent" : "border-hairline"
      )}
    >
      <span className={cn("grid h-6 w-6 flex-none place-items-center rounded-input text-white transition-colors", drag.over ? "bg-navy" : "bg-muted")}>
        {drag.src.kind === "new" ? <Plus className="h-3.5 w-3.5" /> : <GripVertical className="h-3.5 w-3.5" />}
      </span>
      <span className="truncate">{drag.src.label}</span>
      {hint && <span className="text-meta font-medium text-muted">{hint}</span>}
    </div>
  );
}

/**
 * FLIP for the field list: whenever the order changes, each row slides from
 * where it was to where it is now, and rows that weren't there fade in.
 */
export function useListMotion(listRef: RefObject<HTMLElement | null>, ids: string[]) {
  const prev = useRef(new Map<string, number>());
  const prevKey = useRef<string | null>(null);
  const skip = useRef(false);
  const landed = useRef<string | null>(null);
  const key = ids.join("\n");

  const record = () => {
    const list = listRef.current;
    if (!list) return;
    prev.current = new Map(rowsOf(list).map((r) => [r.dataset.fieldRow ?? "", r.offsetTop]));
  };

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const rows = rowsOf(list);
    if (prevKey.current !== null && prevKey.current !== key && !prefersReducedMotion()) {
      for (const r of rows) {
        const id = r.dataset.fieldRow ?? "";
        const before = prev.current.get(id);
        if (before === undefined || id === landed.current) enter(r);
        else if (!skip.current) {
          const dy = before - r.offsetTop;
          if (dy) r.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], { duration: 260, easing: EASE });
        }
      }
    }
    skip.current = false;
    landed.current = null;
    prevKey.current = key;
    record();
  });

  return {
    /** The next change was a drop: rows are already in place, only the dropped one gets its landing. */
    dropped: (id: string) => {
      skip.current = true;
      landed.current = id;
    },
    /** Shrink a row away before it's removed. */
    collapse: async (id: string) => {
      const list = listRef.current;
      const row = list && rowById(list, id);
      if (!row || prefersReducedMotion()) return;
      row.style.overflow = "hidden";
      const anim = row.animate(
        [{ height: `${row.offsetHeight}px`, opacity: 1 }, { height: "0px", opacity: 0, paddingTop: "0px", paddingBottom: "0px" }],
        { duration: 220, easing: EASE, fill: "forwards" }
      );
      // A hidden or throttled tab may never finish the animation; don't hold the delete hostage to it.
      await Promise.race([anim.finished.catch(() => undefined), new Promise((r) => window.setTimeout(r, 320))]);
      record(); // the rows below have already moved up
    },
  };
}

function enter(row: HTMLElement) {
  row.animate([{ opacity: 0, transform: "translateY(-6px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: EASE });
  const card = row.firstElementChild as HTMLElement | null;
  const tint = getComputedStyle(document.documentElement).getPropertyValue("--st-blue-bg").trim();
  if (card && tint) card.animate([{ backgroundColor: `rgb(${tint})` }, { backgroundColor: getComputedStyle(card).backgroundColor }], { duration: 900, easing: "ease-out" });
}
