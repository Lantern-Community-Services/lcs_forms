import { useRef, useState } from "react";
import { ChevronsDown } from "lucide-react";
import { cn } from "@/lib/utils";

/** How far a card must travel before letting go commits the swipe. */
export const THRESHOLD = 110;
/** Down is a shorter reach for a thumb than across. */
export const SKIP_THRESHOLD = 90;

export type ExitDir = "left" | "right" | "down";

/**
 * Where the parent is holding the top card.
 *  lean — pulled toward an action, its stamp showing, as if mid-swipe. A button
 *         press plays this first so it looks like a swipe; a decision that asks
 *         a follow-up question waits here while it is open.
 *  out  — flying off the screen.
 */
export interface Pose {
  id: string;
  dir: ExitDir;
  stage: "lean" | "out";
}
/** How long a button-triggered lean shows before the card flies. */
export const LEAN_MS = 190;
/** Fly-out duration; the card is dropped from the deck when it ends. */
export const OUT_MS = 300;
export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * The top card's pose, owned by the deck's parent, and `playOut` to send a
 * card off the screen. A swipe arrives already past the threshold, so it flies
 * straight out; a button or key press leans the card first — slide, tilt,
 * stamp — so it reads exactly like the swipe it stands in for. `after` runs
 * once the card is gone (drop it from the queue, send it to the back).
 *
 * The timers live here in the parent, not in the card: the refetch that
 * follows a decision can drop the person from the data before the animation
 * ends, unmounting the card — a timer inside it would be cancelled and leave
 * the deck locked.
 */
export function useDeckPose() {
  const [pose, setPose] = useState<Pose | null>(null);
  function playOut(id: string, dir: ExitDir, swiped: boolean, after?: () => void) {
    const out = () => {
      setPose({ id, dir, stage: "out" });
      setTimeout(() => {
        after?.();
        setPose(null);
      }, OUT_MS);
    };
    if (swiped || prefersReducedMotion()) return out();
    setPose({ id, dir, stage: "lean" });
    setTimeout(out, LEAN_MS);
  }
  return { pose, setPose, playOut };
}

/**
 * The deck the cards stack in. 392px tall wherever there is room; a caller
 * that has to fit a short screen can let it shrink, and `swipe-deck` (a size
 * container, see index.css) tightens the card to match.
 */
export const DECK_CLASS = "swipe-deck relative mx-auto h-[392px] w-full max-w-[420px] select-none";

/**
 * One card in a swipe deck: the drag physics, the stamps that fade in as it
 * travels, the stacked look of the cards beneath, and the lean / fly-out poses
 * the parent drives. What the card says is `children`.
 */
export function SwipeCard({
  depth, pose, rightLabel, leftLabel, canRight = true, canLeft = true, onSwipeLeft, onSwipeRight, onSwipeDown, children,
}: {
  depth: number;
  pose: Pose | null;
  rightLabel: string;
  leftLabel: string;
  canRight?: boolean;
  canLeft?: boolean;
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
  onSwipeDown: () => void;
  children: React.ReactNode;
}) {
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  /** Decided by the first ~10px of movement, so a sideways swipe never drifts into a skip. */
  const axis = useRef<"x" | "y" | null>(null);
  const isTop = depth === 0;

  function down(e: React.PointerEvent) {
    if (!isTop || pose) return;
    if ((e.target as HTMLElement).closest("a,button")) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    axis.current = null;
    try {
      // Keeps the drag if the finger slides off the card. Best-effort: a
      // browser that refuses capture still gets a working swipe.
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    setDragging(true);
  }
  function move(e: React.PointerEvent) {
    if (!dragging || !start.current) return;
    const rawX = e.clientX - start.current.x;
    const rawY = e.clientY - start.current.y;
    if (!axis.current) {
      if (Math.hypot(rawX, rawY) < 10) return;
      axis.current = Math.abs(rawY) > Math.abs(rawX) ? "y" : "x";
    }
    if (axis.current === "x") {
      let next = rawX;
      // Resist in a direction the person isn't allowed to commit.
      if (next > 0 && !canRight) next = next / 4;
      if (next < 0 && !canLeft) next = next / 4;
      setDx(next);
    } else {
      // Down skips; up has no meaning, so it only gives a little.
      setDy(rawY > 0 ? rawY : rawY / 5);
    }
  }
  function up() {
    if (!dragging) return;
    setDragging(false);
    start.current = null;
    axis.current = null;
    if (dx > THRESHOLD && canRight) onSwipeRight();
    else if (dx < -THRESHOLD && canLeft) onSwipeLeft();
    else if (dy > SKIP_THRESHOLD) onSwipeDown();
    setDx(0);
    setDy(0);
  }

  // A pose from the parent wins over the finger. Lean positions sit just past
  // each threshold, so the stamp is fully showing — the same frame a real
  // swipe reaches the moment it would commit.
  const LEAN = { x: THRESHOLD + 30, y: SKIP_THRESHOLD + 20 };
  const posed = (dir: ExitDir) =>
    pose?.dir === dir ? (pose.stage === "out" ? (dir === "down" ? 520 : 640) : dir === "down" ? LEAN.y : LEAN.x) : 0;
  const offset = pose ? posed("right") - posed("left") : dx;
  const drop = pose ? posed("down") : dy;
  const rotate = offset / 18;
  const scale = isTop ? 1 : 1 - depth * 0.04;
  const lift = isTop ? 0 : depth * 12;
  const rightOpacity = Math.min(1, Math.max(0, offset / THRESHOLD));
  const leftOpacity = Math.min(1, Math.max(0, -offset / THRESHOLD));
  const skipOpacity = Math.min(1, Math.max(0, drop / SKIP_THRESHOLD));
  const leaving = pose?.stage === "out";
  // The lean is a quick, decisive pull; the fly-out accelerates away; with no
  // pose the card settles back like a spring.
  const transition = dragging
    ? "none"
    : pose?.stage === "lean"
      ? `transform ${LEAN_MS}ms cubic-bezier(.2,.9,.3,1)`
      : leaving
        ? `transform ${OUT_MS}ms cubic-bezier(.4,0,.9,.6), opacity ${OUT_MS}ms ease-in`
        : "transform 320ms cubic-bezier(.2,1.2,.4,1)";

  return (
    <div
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      className={cn(
        "absolute inset-0 rounded-[16px] border border-hairline bg-surface shadow-panel",
        isTop ? "cursor-grab active:cursor-grabbing" : "pointer-events-none",
      )}
      style={{
        transform: `translate3d(${offset}px, ${lift + drop}px, 0) rotate(${rotate}deg) scale(${scale})`,
        // The card owns every direction now that down means skip; the page
        // still scrolls from anywhere outside it.
        touchAction: isTop ? "none" : "auto",
        opacity: leaving ? 0 : 1,
        transition,
        zIndex: 10 - depth,
      }}
      aria-hidden={!isTop}
    >
      {/* Stamps that fade in as the card travels. */}
      <span
        className="pointer-events-none absolute left-5 top-5 rotate-[-12deg] rounded-input border-[3px] border-status-greenDot px-2.5 py-1 font-heading text-[20px] font-extrabold tracking-wide text-status-greenText"
        style={{ opacity: rightOpacity }}
      >
        {rightLabel}
      </span>
      <span
        className="pointer-events-none absolute right-5 top-5 rotate-[12deg] rounded-input border-[3px] border-status-redDot px-2.5 py-1 font-heading text-[20px] font-extrabold tracking-wide text-status-redText"
        style={{ opacity: leftOpacity }}
      >
        {leftLabel}
      </span>
      {/* Same stamp language as the side stamps — outline, no fill, a slight
          tilt — in blue, top-centre and above the avatar so the two never collide. */}
      <span
        className="pointer-events-none absolute left-1/2 top-2.5 z-[1] flex -translate-x-1/2 rotate-[-4deg] items-center gap-1 rounded-input border-[3px] border-status-blueDot py-0 pl-1.5 pr-2.5 font-heading text-[18px] font-extrabold tracking-wide text-status-blueText"
        style={{ opacity: skipOpacity }}
      >
        <ChevronsDown className="h-[18px] w-[18px]" strokeWidth={3} /> SKIP
      </span>

      <div
        className="swipe-card-body flex h-full flex-col items-center px-6 pb-5 pt-10 text-center"
        // Pulled down, the contents dim and settle 16px lower, so the stamp
        // gets clear space above the avatar instead of sitting on it.
        style={{ opacity: 1 - skipOpacity * 0.4, transform: `translateY(${skipOpacity * 16}px)` }}
      >
        {children}
      </div>
    </div>
  );
}

/** The coloured box under the name on a card: where the person stands. `tone` gives its background and text colour. */
export function SwipeNote({ tone, icon, title, children }: { tone: string; icon: React.ReactNode; title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={cn("swipe-note mt-5 w-full rounded-card px-4 py-3 text-left", tone)}>
      <p className="flex items-center gap-2 text-[14px] font-bold">{icon} {title}</p>
      <p className="mt-1 text-[12.5px] opacity-90">{children}</p>
    </div>
  );
}

export function RoundAction({
  label, tone, size = "md", disabled, onClick, children,
}: {
  label: string;
  tone: "red" | "green" | "blue";
  size?: "sm" | "md";
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="flex flex-col items-center gap-1.5 disabled:opacity-40"
    >
      <span
        className={cn(
          "flex items-center justify-center rounded-full border-2 bg-surface shadow-card transition-transform active:scale-95",
          size === "sm" ? "h-[52px] w-[52px]" : "h-16 w-16",
          tone === "red" && "border-status-redDot text-status-redText",
          tone === "green" && "border-status-greenDot text-status-greenText",
          tone === "blue" && "border-status-blueDot text-status-blueText"
        )}
      >
        {children}
      </span>
      <span className="text-[12px] font-bold text-muted">{label}</span>
    </button>
  );
}
