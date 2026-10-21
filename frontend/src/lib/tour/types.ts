/**
 * Guided tours: one step at a time, the step's spot highlighted and the rest
 * of the screen dimmed and locked (TourOverlay). Two kinds use the same engine:
 * the welcome tour of the site (siteTour.ts, built in code by role and device)
 * and a form's own tutorial (formTours.ts, from the form's "tutorial").
 */

export type TourAction = "next" | "click" | "fill";
export type TourPlacement = "auto" | "top" | "bottom" | "left" | "right";

/** Where a step's spot is: in the app's own page, or inside a code form's sandboxed frame. */
export type TourTarget = { in: "page"; selector: string } | { in: "frame"; selector: string };

export interface TourStep {
  id: string;
  title: string;
  /** Plain text: a blank line starts a paragraph, **bold** works. */
  body?: string;
  /** Nothing: a card in the middle of the screen. */
  target?: TourTarget;
  /** Go here first (an app path). The step waits until the page is showing. */
  route?: string;
  /** Whether the current path already counts as the step's route (default: it starts with `route`'s path). */
  onRoute?: (pathname: string) => boolean;
  placement?: TourPlacement;
  /** next: look, press Next. click: tap the spot to go on. fill: answer it, then Next. */
  action?: TourAction;
  /** fill: whether it's answered. Without it, the form controls inside the spot are looked at. */
  filled?: () => boolean;
  /** How long to look for the spot before skipping the step. Default: the tour's. */
  waitMs?: number;
}

export interface TourDef {
  /** Progress key: "site:desktop", "site:touch", "form:<id>". */
  key: string;
  version: number;
  /** On every card, above the step ("Welcome to Lantern Forms", "How to use Hot Foods"). */
  title: string;
  steps: TourStep[];
  /** Keep a record of finishing or skipping it (not for previews and ?tour=1). */
  record: boolean;
  /** How long a step looks for its spot before it's skipped. Default 6s. */
  waitMs?: number;
}

export type TourEnd = "completed" | "skipped";
