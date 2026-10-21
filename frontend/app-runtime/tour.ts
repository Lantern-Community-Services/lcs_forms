import { post } from "./sdk";

/**
 * The form tutorial's half inside the sandboxed frame (the host's half is
 * src/lib/tour). The host can't see this document, so it says which
 * data-tour="…" element a step is about; this finds it, reports where it is
 * (frame coordinates; the host adds the frame's own position) whenever it
 * moves, reports taps and answers, and locks everything else in the page:
 * clicks, keys and form submits outside it are swallowed. "tour:lock" locks
 * the whole page while the tutorial shows something outside the frame.
 */

type Command =
  | { t: "tour:target"; selector: string; interactive: boolean; action: "next" | "click" | "fill" }
  | { t: "tour:lock" }
  | { t: "tour:clear" };

let cmd: Command | null = null;
let el: Element | null = null;
let lastRect = "";
let lastFilled: boolean | null = null;
let scrolled = false;
let raf = 0;
let timer = 0;
let frames = 0;

const visible = (e: Element) => e.getClientRects().length > 0;

function find(selector: string): Element | null {
  try {
    return Array.from(document.querySelectorAll(selector)).find(visible) ?? null;
  } catch {
    return null;
  }
}

/** Whether a field (or anything with form controls inside) has an answer. data-tour-filled="true" says so for a custom one. */
function filledIn(root: Element): boolean {
  const flag = root.getAttribute("data-tour-filled") ?? root.querySelector("[data-tour-filled]")?.getAttribute("data-tour-filled");
  if (flag !== null && flag !== undefined) return flag !== "false" && flag !== "";
  const controls = root.matches("input, select, textarea") ? [root] : Array.from(root.querySelectorAll("input, select, textarea, [contenteditable='true'], [contenteditable='']"));
  return controls.some((c) => {
    if (c instanceof HTMLInputElement) {
      if (c.type === "checkbox" || c.type === "radio") return c.checked;
      if (["button", "submit", "reset", "hidden", "file"].includes(c.type)) return false;
      return c.value.trim() !== "";
    }
    if (c instanceof HTMLSelectElement || c instanceof HTMLTextAreaElement) return c.value.trim() !== "";
    return (c.textContent ?? "").trim() !== "";
  });
}

function loop() {
  raf = 0;
  look();
  if (cmd?.t === "tour:target") raf = requestAnimationFrame(loop);
}

/** Where the element is now, and whether it's answered. Every frame, and on a timer for a frame that isn't drawing. */
function look() {
  if (cmd?.t !== "tour:target") return;
  // Looking the element up is the costly part: a few times a second. Its position: every frame.
  if (frames++ % 6 === 0 || !el || !el.isConnected) {
    const found = find(cmd.selector);
    if (found !== el) {
      el = found;
      scrolled = false;
      lastFilled = null;
    }
  }
  if (el && !scrolled) {
    scrolled = true;
    const r = el.getBoundingClientRect();
    if (r.top < 8 || r.bottom > window.innerHeight - 8) el.scrollIntoView({ block: "center" });
  }
  const r = el?.getBoundingClientRect();
  const rect = r ? { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } : null;
  const key = JSON.stringify(rect);
  if (key !== lastRect) {
    lastRect = key;
    post({ t: "tour:rect", rect });
  }
  if (cmd.action === "fill" && el) {
    const filled = filledIn(el);
    if (filled !== lastFilled) {
      lastFilled = filled;
      post({ t: "tour:value", filled });
    }
  }
}

export function onTourCommand(next: Command) {
  cmd = next.t === "tour:clear" ? null : next;
  el = null;
  lastRect = "";
  lastFilled = null;
  scrolled = false;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  window.clearInterval(timer);
  if (cmd?.t === "tour:target") {
    raf = requestAnimationFrame(loop);
    timer = window.setInterval(look, 250);
    // The step's own field gets the keyboard, on a computer (on a phone that would throw the keyboard up unasked).
    if (cmd.action === "fill" && !window.matchMedia?.("(pointer: coarse)").matches) {
      window.setTimeout(() => {
        const field = el?.matches("input, select, textarea") ? el : el?.querySelector("input:not([type=hidden]), select, textarea");
        (field as HTMLElement | null | undefined)?.focus({ preventScroll: true });
      }, 350);
    }
  }
}

// ── The lock ─────────────────────────────────────────────────────────────

/** A popup a field opens (a list, a menu, a picker) belongs to it. */
const POPUP = '[role="listbox"], [role="menu"], [role="dialog"], [data-radix-popper-content-wrapper]';

function allowed(target: EventTarget | null): boolean {
  if (!cmd) return true;
  if (cmd.t !== "tour:target" || !cmd.interactive || !el) return false;
  const node = target instanceof Node ? target : null;
  if (!node) return false;
  if (el.contains(node)) return true;
  return node instanceof Element ? Boolean(node.closest(POPUP)) : Boolean(node.parentElement?.closest(POPUP));
}

let lastBlocked = 0;
function block(e: Event) {
  if (allowed(e.target)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if ((e.type === "pointerdown" || e.type === "mousedown") && Date.now() - lastBlocked > 400) {
    lastBlocked = Date.now();
    post({ t: "tour:blocked" });
  }
}

for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "auxclick"]) {
  window.addEventListener(type, block, { capture: true });
}

// A tap on the step's element moves a click step on (after the page has had it).
window.addEventListener(
  "click",
  (e) => {
    if (cmd?.t === "tour:target" && cmd.action === "click" && el && e.target instanceof Node && el.contains(e.target)) {
      window.setTimeout(() => post({ t: "tour:click" }), 0);
    }
  },
  { capture: true }
);

window.addEventListener(
  "submit",
  (e) => {
    if (!cmd) return;
    const by = (e as SubmitEvent).submitter;
    if (cmd.t === "tour:target" && cmd.action === "click" && by && allowed(by)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  },
  { capture: true }
);

window.addEventListener(
  "keydown",
  (e) => {
    if (!cmd) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      post({ t: "tour:escape" });
      return;
    }
    if (!allowed(document.activeElement)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  },
  { capture: true }
);

window.addEventListener(
  "focusin",
  (e) => {
    if (!cmd || allowed(e.target)) return;
    (e.target as HTMLElement | null)?.blur?.();
  },
  { capture: true }
);
