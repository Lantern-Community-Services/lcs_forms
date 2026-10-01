import { useEffect, useRef, useState } from "react";
import { RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";

/** How far (after resistance) a pull has to travel before letting go reloads. */
const THRESHOLD = 72;
const MAX_PULL = 110;
/** Finger travel per pixel of pull: the indicator lags the finger, as native ones do. */
const RESISTANCE = 0.5;

/**
 * Drag down from the top to reload.
 *
 * The app is used from the home screen, where there is no browser chrome and
 * so no reload button and no native pull-to-refresh. This is that gesture,
 * on the page's scroll region: it starts only when everything under the finger
 * is already scrolled to the top, and never on something that takes a
 * downward drag for itself (a signature pad, a text field, a code form's frame).
 */
export function PullToRefresh({ scrollRef }: { scrollRef: React.RefObject<HTMLElement | null> }) {
  const [pull, setPull] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let startX = 0;
    let startY = 0;
    let tracking = false;
    let pulling = false;
    let distance = 0;

    // Everything between the finger and the scroll region is at its top.
    const atTop = (target: EventTarget | null) => {
      for (let n = target as HTMLElement | null; n; n = n.parentElement) {
        if (n.scrollTop > 0) return false;
        if (n === el) return true;
      }
      return false;
    };

    const onStart = (e: TouchEvent) => {
      tracking = false;
      if (refreshingRef.current || e.touches.length !== 1) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, canvas, iframe, [contenteditable], [data-no-pull]")) return;
      if (!atTop(target)) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true;
      // Only a touch that could become a pull gets a blocking touchmove; every
      // other scroll stays passive and never waits on this script.
      el.addEventListener("touchmove", onMove, { passive: false });
      pulling = false;
      distance = 0;
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (!pulling) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        // Up, or more sideways than down: a scroll or a swipe, not a pull.
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
          tracking = false;
          return;
        }
        pulling = true;
        setDragging(true);
      }
      // Ours now: keep the page from rubber-banding along with the indicator.
      if (e.cancelable) e.preventDefault();
      distance = Math.min(MAX_PULL, Math.max(0, dy * RESISTANCE));
      setPull(distance);
    };

    const onEnd = () => {
      el.removeEventListener("touchmove", onMove);
      if (!tracking) return;
      tracking = false;
      if (!pulling) return;
      pulling = false;
      setDragging(false);
      if (distance >= THRESHOLD) {
        refreshingRef.current = true;
        setRefreshing(true);
        setPull(THRESHOLD);
        // A beat so the spinner is seen settling into place before the reload.
        window.setTimeout(() => window.location.reload(), 180);
      } else {
        setPull(0);
      }
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [scrollRef]);

  const progress = Math.min(1, pull / THRESHOLD);
  const ready = progress >= 1;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center" style={{ paddingTop: "var(--safe-top, 0px)" }}>
      <div
        className={cn(
          "flex h-10 w-10 items-center justify-center rounded-full border border-hairline bg-surface shadow-panel",
          !dragging && "transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none"
        )}
        style={{ transform: `translateY(${pull - 48}px)`, opacity: pull > 0 ? Math.max(0.35, progress) : 0 }}
      >
        <RotateCw
          className={cn("h-[18px] w-[18px]", ready || refreshing ? "text-accent dark:text-white" : "text-muted", refreshing && "animate-spin")}
          style={refreshing ? undefined : { transform: `rotate(${progress * 270}deg)` }}
        />
      </div>
    </div>
  );
}
