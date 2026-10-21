import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, Check, Loader2, MousePointerClick, PencilLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { currentDeviceKind } from "@/lib/device";
import { frameElement, onFrameReport, tellFrame, type FrameRect } from "@/lib/tour/frameBridge";
import type { TourDef, TourEnd, TourPlacement, TourStep } from "@/lib/tour/types";

/**
 * One tour on screen: the step's spot cut out of a dimmed screen, a card
 * beside it, and everything else locked.
 *
 * The lock is a set of capture-phase listeners on the window: a click, tap,
 * key or form submit anywhere but the card (and, on a click or fill step, the
 * spot and any list or menu it opens) is stopped before the app sees it. The
 * dimming itself lets everything through, so scrolling still works and the
 * spot is the real element, not a picture of it. A code form's page is inside
 * a sandboxed frame this document can't reach: the frame's runtime keeps the
 * same lock inside it (frameBridge.ts, app-runtime/tour.ts).
 *
 * A dialog the person opened from the spot (a camera, a confirmation) pauses
 * the tour until it closes. Esc or Skip ends it whenever they like.
 */

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Room around the spot, the gap to the card, and the card's distance from the screen's edges. */
const PAD = 6;
const GAP = 12;
const MARGIN = 12;
const DEFAULT_WAIT = 6000;
/** A list, menu or picker that a field opens belongs to the field. */
const POPUP = '[role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]';
const BLOCKED_EVENTS = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "auxclick"];

const visible = (e: Element) => e.getClientRects().length > 0;

/** The first match that's on screen: phone and desktop layouts are both in the page, one hidden. */
function findVisible(selector: string): Element | null {
  try {
    return Array.from(document.querySelectorAll(selector)).find(visible) ?? null;
  } catch {
    return null;
  }
}

/** Whether a spot's form controls hold an answer (when the step doesn't say how to tell). */
function domFilled(root: Element): boolean {
  const controls = root.matches("input, select, textarea") ? [root] : Array.from(root.querySelectorAll("input, select, textarea"));
  return controls.some((c) => {
    if (c instanceof HTMLInputElement) {
      if (c.type === "checkbox" || c.type === "radio") return c.checked;
      if (["button", "submit", "reset", "hidden", "file"].includes(c.type)) return false;
      return c.value.trim() !== "";
    }
    return (c as HTMLSelectElement | HTMLTextAreaElement).value.trim() !== "";
  });
}

/** A dialog that isn't the tour's own and doesn't hold the spot: the tour waits for it. */
function blockingDialog(spot: Element | null): Element | null {
  const open = document.querySelectorAll('[role="dialog"][data-state="open"], [role="dialog"][aria-modal="true"], [role="alertdialog"]');
  for (const d of Array.from(open)) {
    if (d.closest("[data-tour-card]") || !visible(d)) continue;
    if (spot && d.contains(spot)) continue;
    return d;
  }
  return null;
}

const samePlace = (a: Rect | null, b: Rect | null) =>
  a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

const round = (r: Rect): Rect => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });

/** Where the card goes on a computer or a tablet: beside the spot if there's room, else over it at the far edge. */
function placeCard(rect: Rect | null, w: number, h: number, vw: number, vh: number, pref: TourPlacement): { left: number; top: number } {
  if (!rect) return { left: (vw - w) / 2, top: Math.max(MARGIN, (vh - h) / 2) };
  const hole = { l: rect.x - PAD, t: rect.y - PAD, r: rect.x + rect.width + PAD, b: rect.y + rect.height + PAD };
  const clampX = (x: number) => Math.min(Math.max(x, MARGIN), vw - w - MARGIN);
  const clampY = (y: number) => Math.min(Math.max(y, MARGIN), vh - h - MARGIN);
  const midX = rect.x + rect.width / 2 - w / 2;
  const midY = rect.y + rect.height / 2 - h / 2;
  const sides: TourPlacement[] = pref === "auto" ? ["bottom", "top", "right", "left"] : [pref, "bottom", "top", "right", "left"];
  for (const side of sides) {
    if (side === "bottom" && hole.b + GAP + h <= vh - MARGIN) return { left: clampX(midX), top: hole.b + GAP };
    if (side === "top" && hole.t - GAP - h >= MARGIN) return { left: clampX(midX), top: hole.t - GAP - h };
    if (side === "right" && hole.r + GAP + w <= vw - MARGIN) return { left: hole.r + GAP, top: clampY(midY) };
    if (side === "left" && hole.l - GAP - w >= MARGIN) return { left: hole.l - GAP - w, top: clampY(midY) };
  }
  // A big spot with no room beside it: the card sits over it, at whichever end of the screen it fills less.
  return { left: (vw - w) / 2, top: rect.y + rect.height / 2 < vh / 2 ? vh - h - MARGIN : MARGIN };
}

/** Plain text: a blank line starts a paragraph, **bold** works. */
function Body({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n\s*\n/).map((para, i) => (
        <p key={i} className="whitespace-pre-line">
          {para.split(/(\*\*[^*]+\*\*)/).map((part, j) =>
            part.length > 4 && part.startsWith("**") && part.endsWith("**") ? (
              <b key={j} className="font-semibold text-ink">{part.slice(2, -2)}</b>
            ) : (
              <Fragment key={j}>{part}</Fragment>
            )
          )}
        </p>
      ))}
    </>
  );
}

function useViewport() {
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const update = () => setVp((v) => (v.w === window.innerWidth && v.h === window.innerHeight ? v : { w: window.innerWidth, h: window.innerHeight }));
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, []);
  return vp;
}

export function TourOverlay({ tour, index, onIndex, onEnd }: {
  tour: TourDef;
  /** The step showing. It's kept by TourProvider, so the tour carries on if the app around it remounts. */
  index: number;
  onIndex: (index: number) => void;
  onEnd: (status: TourEnd, step: number) => void;
}) {
  /** Which way the last move went: a step whose spot never shows is passed over in the same direction. */
  const dir = useRef<1 | -1>(1);
  const step: TourStep = tour.steps[Math.min(index, tour.steps.length - 1)];
  const last = index >= tour.steps.length - 1;
  const action = step.action ?? "next";
  const interactive = action !== "next";
  const navigate = useNavigate();
  const vp = useViewport();
  const touch = currentDeviceKind() !== "desktop";
  const phone = vp.w < 640;

  const [rect, setRect] = useState<Rect | null>(null);
  const [shown, setShown] = useState(false);
  const [slow, setSlow] = useState(false);
  const [paused, setPaused] = useState(false);
  const [filled, setFilled] = useState(false);
  const [nudge, setNudge] = useState(0);
  const spot = useRef<Element | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const go = useCallback(
    (to: number) => {
      if (to >= tour.steps.length) return onEnd("completed", tour.steps.length - 1);
      const target = Math.max(0, to);
      dir.current = target < index ? -1 : 1;
      onIndex(target);
    },
    [index, tour.steps.length, onEnd, onIndex]
  );
  const live = useRef({ next: () => go(index + 1), back: () => go(index - 1), skip: () => onEnd("skipped", index), step, interactive, canNext: false });
  live.current = {
    next: () => go(index + 1),
    back: () => index > 0 && go(index - 1),
    skip: () => onEnd("skipped", index),
    step,
    interactive,
    // What Next (or →) may do now: a click step moves on only by its tap, a fill step once answered.
    canNext: action === "next" || (action === "fill" && filled),
  };

  const onRoute = useCallback(
    (path: string) => {
      if (!step.route) return true;
      if (step.onRoute) return step.onRoute(path);
      return path === new URL(step.route, window.location.origin).pathname;
    },
    [step]
  );

  // The step's page, when it has one and it isn't showing.
  useEffect(() => {
    if (step.route && !onRoute(window.location.pathname)) navigate(step.route);
  }, [index]); // eslint-disable-line react-hooks/exhaustive-deps

  // Find the spot and follow it as the page scrolls, resizes or re-renders.
  // One that never shows (a field hidden by a rule, a tab this person can't
  // see) is passed over.
  useEffect(() => {
    // The old spot stays lit until the new one is found, so the light glides from one to the next.
    setShown(false);
    setSlow(false);
    setFilled(false);
    spot.current = null;
    const wait = step.waitMs ?? tour.waitMs ?? DEFAULT_WAIT;
    let lastSeen = Date.now();
    const slowTimer = window.setTimeout(() => setSlow(true), 700);
    const passOver = () => go(index + dir.current < 0 ? index + 1 : index + dir.current);
    const show = (r: Rect | null) => {
      lastSeen = Date.now();
      setRect((prev) => (samePlace(prev, r) ? prev : r));
      setShown(true);
    };
    let off = () => {};
    /** One look at the spot. False once the step is settled for good (a centred card shown, a spot given up on). */
    let tick: () => boolean;

    if (!step.target) {
      tellFrame({ t: "tour:lock" });
      tick = () => {
        if (!onRoute(window.location.pathname) && Date.now() - lastSeen <= wait) return true;
        show(null);
        return false;
      };
    } else if (step.target.in === "frame") {
      let inFrame: FrameRect | null = null;
      tellFrame({ t: "tour:target", selector: step.target.selector, interactive, action });
      off = onFrameReport((r) => {
        if (r.t === "tour:rect") inFrame = r.rect;
        else if ((r.t === "tour:click" || r.t === "tour:next") && action === "click") live.current.next();
        else if (r.t === "tour:value") setFilled(r.filled);
        else if (r.t === "tour:blocked") setNudge((n) => n + 1);
        else if (r.t === "tour:escape") live.current.skip();
      });
      tick = () => {
        const frame = frameElement();
        if (inFrame && frame && onRoute(window.location.pathname)) {
          const f = frame.getBoundingClientRect();
          // Only the part inside the frame's own box is on screen.
          const x = Math.max(f.left + inFrame.x, f.left);
          const y = Math.max(f.top + inFrame.y, f.top);
          const r = Math.min(f.left + inFrame.x + inFrame.width, f.right);
          const b = Math.min(f.top + inFrame.y + inFrame.height, f.bottom);
          show(r > x && b > y ? round({ x, y, width: r - x, height: b - y }) : null);
        } else if (Date.now() - lastSeen > wait) {
          passOver();
          return false;
        }
        return true;
      };
    } else {
      const selector = step.target.selector;
      tellFrame({ t: "tour:lock" });
      let n = 0;
      let scrolled = false;
      tick = () => {
        if (n++ % 6 === 0 || !spot.current?.isConnected) spot.current = onRoute(window.location.pathname) ? findVisible(selector) : null;
        const el = spot.current;
        if (el) {
          if (!scrolled) {
            scrolled = true;
            const r = el.getBoundingClientRect();
            if (r.top < 8 || r.bottom > window.innerHeight - 8) el.scrollIntoView({ block: "center", behavior: "smooth" });
          }
          show(round(el.getBoundingClientRect()));
        } else if (Date.now() - lastSeen > wait) {
          passOver();
          return false;
        }
        return true;
      };
    }

    // Every frame while the page is being drawn, and on a timer as well, for a tab that isn't drawing frames.
    let done = false;
    let raf = 0;
    const loop = () => {
      if (done) return;
      if (!tick()) done = true;
      else raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const timer = window.setInterval(() => {
      if (!done && !tick()) done = true;
    }, 250);
    return () => {
      done = true;
      cancelAnimationFrame(raf);
      window.clearInterval(timer);
      window.clearTimeout(slowTimer);
      off();
    };
  }, [index]); // eslint-disable-line react-hooks/exhaustive-deps

  // A click step moves on once the spot has had its click (a link has navigated, a tab has opened).
  useEffect(() => {
    if (action !== "click" || step.target?.in !== "page") return;
    const onClick = (e: MouseEvent) => {
      const el = spot.current;
      if (el && e.target instanceof Node && el.contains(e.target)) window.setTimeout(() => live.current.next(), 0);
    };
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, [index]); // eslint-disable-line react-hooks/exhaustive-deps

  // A fill step: is it answered yet?
  useEffect(() => {
    if (action !== "fill" || step.target?.in !== "page") return;
    const check = () => setFilled(step.filled ? step.filled() : spot.current ? domFilled(spot.current) : false);
    const t = window.setInterval(check, 250);
    return () => window.clearInterval(t);
  }, [index]); // eslint-disable-line react-hooks/exhaustive-deps

  // A dialog opened from the spot pauses the tour until it closes.
  useEffect(() => {
    const t = window.setInterval(() => setPaused(Boolean(blockingDialog(spot.current))), 200);
    return () => window.clearInterval(t);
  }, []);

  // The lock.
  useEffect(() => {
    if (paused) return;
    const allowed = (target: EventTarget | null) => {
      const node = target instanceof Node ? target : null;
      if (!node) return false;
      if (cardRef.current?.contains(node)) return true;
      const s = live.current;
      if (!s.interactive || s.step.target?.in !== "page") return false;
      if (spot.current?.contains(node)) return true;
      const el = node instanceof Element ? node : node.parentElement;
      return Boolean(el?.closest(POPUP));
    };
    const focusCard = () => (cardRef.current?.querySelector<HTMLElement>("[data-tour-primary]") ?? cardRef.current)?.focus({ preventScroll: true });
    const block = (e: Event) => {
      if (allowed(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === "pointerdown") setNudge((n) => n + 1);
    };
    // Nothing is sent while a tour is showing: a basic form's tutorial can't click Submit (lintTutorial
    // refuses it), and Enter in a field it's filling in would otherwise send the form half done.
    const onSubmit = (e: Event) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        live.current.skip();
        return;
      }
      // In the card: Tab, Enter and Space work its buttons; ← → move the tour. Nothing reaches the
      // page's own shortcuts (the calendar's arrows would move it a week while the tour moved a step).
      if (cardRef.current?.contains(document.activeElement)) {
        if (e.key === "Tab" || e.key === "Enter" || e.key === " ") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === "ArrowRight" && live.current.canNext) live.current.next();
        else if (e.key === "ArrowLeft") live.current.back();
        return;
      }
      if (allowed(document.activeElement)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Tab") focusCard();
    };
    const onFocus = (e: FocusEvent) => {
      // Focus going into a code form's frame: the frame keeps its own lock.
      if (allowed(e.target) || e.target instanceof HTMLIFrameElement) return;
      focusCard();
    };
    for (const type of BLOCKED_EVENTS) window.addEventListener(type, block, true);
    window.addEventListener("submit", onSubmit, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("focusin", onFocus, true);
    return () => {
      for (const type of BLOCKED_EVENTS) window.removeEventListener(type, block, true);
      window.removeEventListener("submit", onSubmit, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("focusin", onFocus, true);
    };
  }, [paused]);

  // Where the keyboard goes when a step shows: its field (on a computer), its button, or the card's Next.
  useEffect(() => {
    if (!shown || paused) return;
    const t = window.setTimeout(() => {
      const el = spot.current as HTMLElement | null;
      const inPage = step.target?.in === "page";
      if (inPage && action === "fill" && el && !touch) {
        const field = el.matches("input, select, textarea") ? el : el.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea");
        if (field) return field.focus({ preventScroll: true });
      }
      if (inPage && action === "click" && el?.matches("a[href], button, [tabindex]")) return el.focus({ preventScroll: true });
      (cardRef.current?.querySelector<HTMLElement>("[data-tour-primary]") ?? cardRef.current)?.focus({ preventScroll: true });
    }, 80);
    return () => window.clearTimeout(t);
  }, [shown, paused, index]); // eslint-disable-line react-hooks/exhaustive-deps

  // The card's place: measured after it renders at its width.
  const cardW = phone ? vp.w - 2 * MARGIN : Math.min(360, vp.w - 2 * MARGIN);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const h = cardRef.current?.offsetHeight ?? 0;
    setPos(placeCard(rect, cardW, h, vp.w, vp.h, step.placement ?? "auto"));
  }, [rect, cardW, vp, index, shown, filled, step.placement]);

  // Moving between steps the light glides; after that it sticks to its spot as the page scrolls.
  const [glide, setGlide] = useState(false);
  useEffect(() => {
    setGlide(true);
    const t = window.setTimeout(() => setGlide(false), 700);
    return () => window.clearTimeout(t);
  }, [index]);

  // Nudged: a tap outside the spot shakes the card.
  const [shaking, setShaking] = useState(false);
  useEffect(() => {
    if (!nudge) return;
    setShaking(true);
    const t = window.setTimeout(() => setShaking(false), 420);
    return () => window.clearTimeout(t);
  }, [nudge]);

  if (paused) return null;

  // The hole, kept on screen.
  const hole = rect && {
    left: Math.max(rect.x - PAD, 2),
    top: Math.max(rect.y - PAD, 2),
    right: Math.min(rect.x + rect.width + PAD, vp.w - 2),
    bottom: Math.min(rect.y + rect.height + PAD, vp.h - 2),
  };
  const holeOk = hole && hole.right - hole.left > 4 && hole.bottom - hole.top > 4;
  // Phones: the card sits at the top or bottom edge, away from the spot.
  const phoneEdge = !rect ? "middle" : rect.y + rect.height / 2 > vp.h / 2 ? "top" : "bottom";
  const kind = tour.key.startsWith("site:") ? "tour" : "tutorial";
  const counter = `${index + 1} of ${tour.steps.length}`;

  return (
    <>
      <div aria-hidden className="pointer-events-none fixed inset-0 z-[200]">
        {holeOk ? (
          <div
            className={cn(
              "absolute rounded-[12px]",
              glide && "transition-[left,top,width,height] duration-300 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none",
              interactive && shown && "tour-spot-live"
            )}
            style={{
              left: hole!.left,
              top: hole!.top,
              width: hole!.right - hole!.left,
              height: hole!.bottom - hole!.top,
              boxShadow: "0 0 0 2px rgb(var(--c-accent) / 0.9), 0 0 0 9999px var(--tour-dim)",
            }}
          />
        ) : (
          <div className="absolute inset-0 bg-[var(--tour-dim)]" />
        )}
      </div>

      {!shown && slow && (
        <div className="fixed left-1/2 top-1/2 z-[210] -translate-x-1/2 -translate-y-1/2 rounded-pill bg-surface px-3 py-2 shadow-panel" role="status">
          <Loader2 className="h-4 w-4 animate-spin text-muted" aria-label="Loading the next step" />
        </div>
      )}

      {shown && (
        <div
          ref={cardRef}
          data-tour-card
          role="dialog"
          aria-modal="true"
          aria-labelledby="tour-step-title"
          aria-describedby={step.body ? "tour-step-body" : undefined}
          tabIndex={-1}
          className={cn(
            "tour-card fixed z-[210] rounded-[18px] border border-hairline bg-surface p-4 shadow-panel outline-none md:p-5",
            phone && "inset-x-3",
            shaking && "tour-card-nudge"
          )}
          style={
            phone
              ? phoneEdge === "top"
                ? { top: "calc(env(safe-area-inset-top, 0px) + 12px)" }
                : phoneEdge === "bottom"
                  ? { bottom: "calc(env(safe-area-inset-bottom, 0px) + 12px)" }
                  : { top: "50%", transform: "translateY(-50%)" }
              : { left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: cardW }
          }
        >
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <p className="kicker min-w-0 truncate">{tour.title}</p>
            <span className="shrink-0 text-micro font-semibold tabular-nums text-muted">{counter}</span>
          </div>
          <h2 id="tour-step-title" className="font-heading text-[17px] font-extrabold leading-snug text-ink">{step.title}</h2>
          {step.body && (
            <div id="tour-step-body" className="mt-1.5 space-y-2 text-[14px] leading-relaxed text-muted">
              <Body text={step.body} />
            </div>
          )}
          {action === "click" && (
            <p className="mt-3 flex items-center gap-2 rounded-input bg-navsel px-3 py-2 text-[13px] font-semibold text-accent dark:text-white">
              <MousePointerClick className="h-4 w-4 shrink-0" /> {touch ? "Tap" : "Click"} the highlighted spot to go on.
            </p>
          )}
          {action === "fill" && (
            <p className={cn("mt-3 flex items-center gap-2 rounded-input px-3 py-2 text-[13px] font-semibold", filled ? "bg-status-greenBg text-status-greenText" : "bg-navsel text-accent dark:text-white")}>
              {filled ? <Check className="h-4 w-4 shrink-0" /> : <PencilLine className="h-4 w-4 shrink-0" />}
              {filled ? (last ? "That's it. Press Done." : "Got it. Press Next.") : "Fill this in to go on."}
            </p>
          )}
          <div className="mt-4 flex items-center gap-2">
            {!last && (
              <button type="button" onClick={() => live.current.skip()} className="-ml-1 rounded-input px-1 py-1 text-[13px] font-semibold text-muted hover:text-ink" aria-label={`Skip the ${kind}`}>
                Skip
              </button>
            )}
            <div className="flex-1" />
            {index > 0 && (
              <Button variant="secondary" size="sm" onClick={() => go(index - 1)} aria-label="Back">
                <ArrowLeft className="h-4 w-4" /> <span className="hidden sm:inline">Back</span>
              </Button>
            )}
            {action !== "click" && (
              <Button size="sm" data-tour-primary onClick={() => live.current.next()} disabled={action === "fill" && !filled}>
                {last ? "Done" : "Next"} {!last && <ArrowRight className="h-4 w-4" />}
              </Button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
