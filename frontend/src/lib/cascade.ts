import { useLayoutEffect, type RefObject } from "react";

const SELECTOR = ".enter-up, .enter-pop";

/** Milliseconds of delay per pixel down the screen, and the most any element waits. */
const PER_PX = 0.7;
const MAX_DELAY = 650;
/** How long the contents of an animating block hold off after the block itself starts. */
const NESTED_LAG = 170;

/**
 * Makes everything marked `enter-up` / `enter-pop` inside `root` arrive from
 * the top of the screen down.
 *
 * An element's delay comes from where it sits, not from a number someone typed
 * in: whatever is higher on screen starts first, things side by side start
 * together, and a screen that gains a block later is ordered correctly without
 * touching it. Something inside an animating block (the group list inside the
 * "All forms" frame) waits for that block to start, then follows top-down, so
 * a container arrives first and its contents after it. Positions are measured
 * against the topmost element of the batch that just appeared, so one card
 * added by a search starts at once instead of waiting out a delay meant for a
 * whole page.
 *
 * Runs in a MutationObserver callback, which fires before the browser paints,
 * so the delay is in place before the first frame of the animation.
 */
export function useCascade(root: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const host = root.current;
    if (!host) return;

    const cascade = (nodes: Iterable<Element>) => {
      const placed: { el: HTMLElement; top: number }[] = [];
      for (const el of nodes) {
        if (!(el instanceof HTMLElement) || !el.isConnected || el.dataset.cascaded) continue;
        const rect = el.getBoundingClientRect();
        // Not displayed (the phone layout while on a desktop, say): leave it.
        if (rect.width === 0 && rect.height === 0) continue;
        el.dataset.cascaded = "1";
        // Below the fold counts as the fold, so a long page finishes arriving together.
        placed.push({ el, top: Math.min(Math.max(rect.top, 0), window.innerHeight) });
      }
      if (placed.length === 0) return;
      const first = Math.min(...placed.map((p) => p.top));
      const delays = new Map<HTMLElement, { delay: number; top: number }>();
      // Outermost first, so a block's own delay is known before its contents'.
      const depth = (el: Element) => { let n = 0; for (let p = el.parentElement; p; p = p.parentElement) n++; return n; };
      for (const { el, top } of placed.sort((a, b) => depth(a.el) - depth(b.el))) {
        const outer = el.parentElement?.closest<HTMLElement>(SELECTOR);
        const parent = outer && delays.get(outer);
        const delay = parent
          ? Math.min(parent.delay + NESTED_LAG + (top - parent.top) * PER_PX, MAX_DELAY + NESTED_LAG)
          : Math.min((top - first) * PER_PX, MAX_DELAY);
        delays.set(el, { delay, top });
        el.style.animationDelay = `${delay.toFixed(0)}ms`;
      }
    };

    cascade(host.querySelectorAll(SELECTOR));

    const observer = new MutationObserver((records) => {
      const added = new Set<Element>();
      for (const record of records) {
        record.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          if (node.matches(SELECTOR)) added.add(node);
          node.querySelectorAll(SELECTOR).forEach((el) => added.add(el));
        });
      }
      cascade(added);
    });
    observer.observe(host, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [root]);
}
