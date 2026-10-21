import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { TourOverlay } from "@/components/tour/TourOverlay";
import { recordTour } from "./progress";
import { setTourActiveProbe, tellFrame } from "./frameBridge";
import type { TourDef, TourEnd } from "./types";

interface TourApi {
  /** The tour showing, if any. */
  active: TourDef | null;
  /**
   * Show a tour. False when one is already showing (one at a time) or it has no
   * steps. `scope`: the paths it belongs on — leaving them puts it away
   * unrecorded, so a form's tutorial starts again next time.
   */
  start: (def: TourDef, opts?: { scope?: (pathname: string) => boolean }) => boolean;
  /** Put the tour away without recording anything (only `key`'s, when given). */
  cancel: (key?: string) => void;
}

const TourContext = createContext<TourApi | null>(null);

interface Run {
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
const getRun = () => current;
const setRun = (next: Run | null) => {
  current = next;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/**
 * Runs the one tour on screen. The welcome tour (SiteTourStarter) and forms'
 * tutorials (useFormTutorial) start theirs here; finishing or skipping one is
 * recorded for the person (lib/tour/progress.ts) unless the tour says not to.
 */
export function TourProvider({ children }: { children: ReactNode }) {
  const run = useSyncExternalStore(subscribe, getRun, getRun);
  const qc = useQueryClient();
  const { user, loading } = useAuth();
  const userId = user?.id ?? null;
  const { pathname } = useLocation();

  useEffect(() => setTourActiveProbe(() => getRun() !== null), []);

  const start = useCallback(
    (def: TourDef, opts?: { scope?: (pathname: string) => boolean }) => {
      if (getRun() || !def.steps.length) return false;
      setRun({ def, n: Date.now(), scope: opts?.scope, index: 0, userId });
      return true;
    },
    [userId]
  );

  const close = useCallback(() => {    setRun(null);
    tellFrame({ t: "tour:clear" });
  }, []);

  const finish = useCallback(
    (status: TourEnd, step: number) => {
      const r = getRun();
      if (!r) return;
      close();
      if (r.def.record) {
        void recordTour(qc, r.userId, { key: r.def.key, version: r.def.version, status, step: status === "skipped" ? step : null, steps: r.def.steps.length });
      }
    },
    [qc, close]
  );

  const cancel = useCallback(
    (key?: string) => {
      const r = getRun();
      if (r && (!key || r.def.key === key)) close();
    },
    [close]
  );

  const goTo = useCallback((index: number) => {
    const r = getRun();
    if (r) setRun({ ...r, index });
  }, []);

  useEffect(() => {
    if (run?.scope && !run.scope(pathname)) cancel();
  }, [pathname, run, cancel]);

  // Signing out, or someone else signing in on this device, ends the tour that was theirs.
  useEffect(() => {
    if (!loading && run && run.userId !== userId) cancel();
  }, [loading, run, userId, cancel]);

  const value = useMemo<TourApi>(() => ({ active: run?.def ?? null, start, cancel }), [run, start, cancel]);
  return (
    <TourContext.Provider value={value}>
      {children}
      {run && <TourOverlay key={run.n} tour={run.def} index={run.index} onIndex={goTo} onEnd={finish} />}
    </TourContext.Provider>
  );
}

export function useTour(): TourApi {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error("useTour must be used within TourProvider");
  return ctx;
}
