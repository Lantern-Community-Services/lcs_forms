import { useSyncExternalStore } from "react";
import type { TourDef } from "./types";

export interface Run {
  def: TourDef;
  /** Tells one showing of a tour from the next. */
  n: number;
  scope?: (pathname: string) => boolean;
  /** The step showing. */
  index: number;
  /** Whose tour it is (null on a public form). */
  userId: string | null;
}

/*
 * The tour on screen lives here, outside React, so a tour carries on through
 * anything that remounts the app around it: a tour step that opens another
 * page can do that (the Next page hosting the app is re-created on some
 * navigations), and so can a hot reload while developing.
 */
let current: Run | null = null;
const listeners = new Set<() => void>();
export const getRun = () => current;
export const setRun = (next: Run | null) => {
  current = next;
  listeners.forEach((l) => l());
};
export const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const getSample = () => Boolean(current?.def.sample);

/**
 * Whether the tour showing wants sample data on screen (TourDef.sample). Read
 * by the query hooks (lib/queries.ts), so it works outside TourProvider too.
 */
export function useTourSample(): boolean {
  return useSyncExternalStore(subscribe, getSample, getSample);
}
