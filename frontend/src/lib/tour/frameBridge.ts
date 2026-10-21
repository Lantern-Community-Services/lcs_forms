/**
 * The tour's line into a code form's sandboxed frame (apps/AppFrame.tsx). The
 * frame's document can't be reached from here (an opaque origin), so a step
 * whose spot is inside a page says what to look for, and the frame's runtime
 * (app-runtime/tour.ts) finds it, reports where it is as it moves, locks
 * everything else inside the frame, and reports taps and answers. While a tour
 * is showing something outside the frame, the frame is locked whole.
 *
 * One code form is on screen at a time, so there is one frame.
 */

export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Host → frame. */
export type FrameCommand =
  | { t: "tour:target"; selector: string; interactive: boolean; action: "next" | "click" | "fill" }
  | { t: "tour:lock" }
  | { t: "tour:clear" };

/** Frame → host. */
export type FrameReport =
  | { t: "tour:rect"; rect: FrameRect | null }
  | { t: "tour:click" }
  | { t: "tour:value"; filled: boolean }
  | { t: "tour:blocked" }
  | { t: "tour:escape" }
  | { t: "tour:next" };

interface Frame {
  element: () => HTMLIFrameElement | null;
  send: (msg: FrameCommand) => void;
}

let frame: Frame | null = null;
/** The command in force, sent again to a frame that (re)loads — a page change is a new document. */
let current: FrameCommand | null = null;
const listeners = new Set<(r: FrameReport) => void>();

export function attachFrame(f: Frame): () => void {
  frame = f;
  if (current) f.send(current);
  return () => {
    if (frame === f) frame = null;
  };
}

/** The frame's document has just loaded: tell it what's going on. */
export function frameLoaded(f: Frame) {
  if (frame === f && current) f.send(current);
}

export function frameElement(): HTMLIFrameElement | null {
  return frame?.element() ?? null;
}

export function tellFrame(cmd: FrameCommand) {
  current = cmd.t === "tour:clear" ? null : cmd;
  frame?.send(cmd);
}

export function fromFrame(report: FrameReport) {
  listeners.forEach((l) => l(report));
}

export function onFrameReport(fn: (r: FrameReport) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── tutorial.start() / active() from a page ─────────────────────────────

let starter: (() => boolean) | null = null;
let activeProbe: () => boolean = () => false;

/** The code form on screen: how to start its tutorial (AppHostPage). */
export function setFrameTutorialStarter(fn: () => boolean): () => void {
  starter = fn;
  return () => {
    if (starter === fn) starter = null;
  };
}

export const startTutorialFromFrame = () => starter?.() ?? false;

export function setTourActiveProbe(fn: () => boolean) {
  activeProbe = fn;
}

export const tourActive = () => activeProbe();
