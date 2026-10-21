import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { currentDeviceKind } from "@/lib/device";
import { tutorialAutoStartsFor, tutorialStepsFor, type FormTutorial, type TutorialStep, type Values } from "@/lib/formEngine";
import { useTour } from "./TourProvider";
import { seenVersion, useTutorialProgress } from "./progress";
import type { TourDef, TourStep } from "./types";

/**
 * A form's own tutorial (its "tutorial": forms/engine.ts FormTutorial), turned
 * into a tour for the person opening it — their role's steps, on their kind
 * of device — and started the first time they open the form.
 */

const css = (s: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&"));

/** {user:first} and {user:name} in a step's text. */
function fill(text: string | undefined, name: string | undefined) {
  if (!text) return text;
  return text.replace(/\{user:first\}/g, name?.split(" ")[0] ?? "").replace(/\{user:name\}/g, name ?? "");
}

const answered = (v: unknown): boolean => {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).some(answered);
  return true;
};

const formTitle = (t: FormTutorial, fallback: string) => t.title?.trim() || `How to use ${fallback}`;

/** A basic form (/f/<slug>): fields by id, the form's own spots by name. */
export function basicFormTour(opts: {
  formId: string;
  title: string;
  tutorial: FormTutorial;
  roleKey: string;
  userName?: string;
  /** The answers so far, for fill steps. */
  values: () => Values;
  record: boolean;
}): TourDef {
  const device = currentDeviceKind();
  const steps: TourStep[] = tutorialStepsFor(opts.tutorial, { roleKey: opts.roleKey, device }).map((s: TutorialStep, i) => ({
    id: s.id ?? `step-${i + 1}`,
    title: fill(s.title, opts.userName) ?? "",
    body: fill(s.body, opts.userName),
    target: s.field ? { in: "page", selector: `[data-field="${css(s.field)}"]` } : s.target ? { in: "page", selector: `[data-tour="form-${css(s.target)}"]` } : undefined,
    placement: s.placement,
    action: s.action,
    filled: s.field && s.action === "fill" ? () => answered(opts.values()[s.field!]) : undefined,
  }));
  // Fields are on screen as soon as their page is: one that isn't (another page, hidden by a rule) isn't coming.
  return { key: `form:${opts.formId}`, version: opts.tutorial.version ?? 1, title: formTitle(opts.tutorial, opts.title), steps, record: opts.record, waitMs: 1200 };
}

/** The app's own spots around a code form; anything else is a data-tour anchor inside the page. */
function codeTarget(target: string): TourStep["target"] {
  if (target === "tabs") return { in: "page", selector: '[data-tour="app-tabs"]' };
  if (target === "help") return { in: "page", selector: '[data-tour="app-help"]' };
  if (target.startsWith("tab:")) return { in: "page", selector: `[data-tour="app-tab-${css(target.slice(4))}"]` };
  return { in: "frame", selector: `[data-tour="${css(target)}"]` };
}

/** A code form (/apps/<slug>/<page>): each step on its page, which the tour opens. */
export function codeFormTour(opts: {
  formId: string;
  slug: string;
  title: string;
  draft: boolean;
  /** The pages this person can open (in tab order); a step on any other is dropped. */
  pages: { id: string; hidden: boolean }[];
  tutorial: FormTutorial;
  roleKey: string;
  userName?: string;
  record: boolean;
}): TourDef {
  const device = currentDeviceKind();
  const open = new Set(opts.pages.map((p) => p.id));
  let page = opts.pages.find((p) => !p.hidden)?.id ?? opts.pages[0]?.id ?? "";
  const steps: TourStep[] = [];
  tutorialStepsFor(opts.tutorial, { roleKey: opts.roleKey, device }).forEach((s, i) => {
    page = s.page ?? page;
    if (!open.has(page)) return;
    if (s.target?.startsWith("tab:") && !opts.pages.some((p) => p.id === s.target!.slice(4) && !p.hidden)) return;
    const path = `/apps/${opts.slug}/${page}`;
    steps.push({
      id: s.id ?? `step-${i + 1}`,
      title: fill(s.title, opts.userName) ?? "",
      body: fill(s.body, opts.userName),
      target: s.target ? codeTarget(s.target) : undefined,
      route: `${path}${opts.draft ? "?draft=1" : ""}`,
      onRoute: (p) => p === path,
      placement: s.placement,
      action: s.action,
    });
  });
  return { key: `form:${opts.formId}`, version: opts.tutorial.version ?? 1, title: formTitle(opts.tutorial, opts.title), steps, record: opts.record, waitMs: 5000 };
}

/**
 * Forms whose tutorial has run since the app was opened (by itself, from the
 * button or ?tour=1): it doesn't start by itself again until the next visit.
 * Outside React, so a remount of the page doesn't forget it.
 */
const ranThisVisit = new Set<string>();

/**
 * Start a form's tutorial the first time someone opens it, and offer it again
 * ("Show me how"). ?tour=1 in the address runs it whatever they've seen, and
 * records nothing — for whoever is building it.
 *
 * `build(record)` makes the tour; `ready` says the form is on screen and
 * fillable (not loading, not closed, not on its confirmation).
 */
export function useFormTutorial(opts: {
  formId: string | null;
  tutorial: FormTutorial | null | undefined;
  build: (record: boolean) => TourDef | null;
  ready: boolean;
  /** Paths the tutorial belongs on; leaving them puts it away. */
  scope: (pathname: string) => boolean;
  /** A preview (builder or code editor): only ?tour=1 starts it. */
  preview?: boolean;
}) {
  const tour = useTour();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const progress = useTutorialProgress(userId);
  const [search, setSearch] = useSearchParams();
  const forced = search.get("tour") === "1";
  const buildRef = useRef(opts.build);
  buildRef.current = opts.build;
  const scopeRef = useRef(opts.scope);
  scopeRef.current = opts.scope;

  const stepCount = useMemo(() => (opts.tutorial ? (opts.build(false)?.steps.length ?? 0) : 0), [opts.tutorial, opts.ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const key = opts.formId ? `form:${opts.formId}` : null;
  const start = useCallback(
    (record = true) => {
      const def = buildRef.current(record);
      const ok = def ? tour.start(def, { scope: scopeRef.current }) : false;      if (ok) ranThisVisit.add(def!.key);
      return ok;
    },
    [tour]
  );

  useEffect(() => {
    if (!opts.ready || !opts.tutorial || !key || tour.active || ranThisVisit.has(key)) return;
    if (forced) {
      // Started before the address is tidied: tidying it re-runs this effect, and would cancel a start still waiting.
      start(false);
      const next = new URLSearchParams(search);
      next.delete("tour");
      setSearch(next, { replace: true });
      return;
    }
    if (opts.preview || window.self !== window.top) return;
    if (userId && !tutorialAutoStartsFor(opts.tutorial, user?.roleKey ?? "")) return;
    if (!userId && opts.tutorial.autoStart === false) return;
    // Signed in: wait until we know what they've seen (offline, the stored answer or this device's own record).
    if (userId && !progress.isSuccess && !progress.isError) return;
    if (seenVersion(progress.data, userId, key) >= (opts.tutorial.version ?? 1)) return;
    const t = window.setTimeout(() => start(true), 600);
    return () => window.clearTimeout(t);
  }, [opts.ready, opts.tutorial, key, forced, progress.isSuccess, progress.isError, progress.data, tour.active, userId]); // eslint-disable-line react-hooks/exhaustive-deps

  const preview = Boolean(opts.preview);
  const startByHand = useCallback(() => start(!preview), [start, preview]);
  return { available: stepCount > 0, start: startByHand, active: Boolean(key && tour.active?.key === key) };
}
