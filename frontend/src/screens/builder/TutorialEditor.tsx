import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowDown, ArrowUp, Copy, GraduationCap, Loader2, Monitor, Play, Plus, Smartphone, Tablet, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { CheckboxList } from "@/components/ui/checkbox";
import { api } from "@/lib/api";
import { useRoles } from "@/lib/queries";
import {
  APP_TUTORIAL_TARGETS, FORM_TUTORIAL_TARGETS, TUTORIAL_MAX_STEPS, lintTutorial,
  type FormTutorial, type TutorialAction, type TutorialDevice, type TutorialPlacement, type TutorialStep,
} from "@/lib/formEngine";
import { cn } from "@/lib/utils";
import { Row, Section, Toggle } from "./SettingsPanel";

/**
 * A form's tutorial (forms/engine.ts FormTutorial), point and click: the steps in
 * order, each with what it says, what it highlights and what the person has to
 * do. The same editor for a basic form (the builder's Tutorial tab, doc.tutorial)
 * and a code form (the code editor's Tutorial panel, form.json "tutorial"); only
 * what a step can point at differs.
 */

export type TutorialTargets =
  | {
      kind: "basic";
      /** Fields a step can highlight (not hidden fields or page breaks), with the page each is on (1-based). */
      fields: { id: string; label: string; page: number }[];
      /** Every field id, for the checks. */
      fieldIds: Set<string>;
      pages: number;
      requireSite: boolean;
    }
  | {
      kind: "code";
      /** form.json's pages, with the data-tour anchors written in each (and the files it shares). */
      pages: { id: string; label: string; file?: string; hidden?: boolean; anchors: string[] }[];
      /** False until the anchors have been read, so a step isn't flagged before we know. */
      anchorsLoaded: boolean;
    };

type Problem = { path: string; message: string };

interface TutorialStats {
  people: number;
  completed: number;
  skipped: number;
  byVersion: { version: number; completed: number; skipped: number }[];
  skippedAtStep: Record<string, number>;
}

const STEP_ID_RE = /^[A-Za-z][\w-]{0,63}$/;

/** What the strict schema (tutorials/schema.ts) refuses and lintTutorial doesn't look at: blank titles, lengths, step names. */
export function tutorialShapeProblems(t: FormTutorial, base = "tutorial"): Problem[] {
  const out: Problem[] = [];
  if ((t.title ?? "").trim().length > 80) out.push({ path: `${base}.title`, message: "Keep the tutorial's name to 80 characters." });
  t.steps.forEach((s, i) => {
    const p = `${base}.steps[${i}]`;
    if (!s.title.trim()) out.push({ path: `${p}.title`, message: "Give the step a title." });
    else if (s.title.trim().length > 80) out.push({ path: `${p}.title`, message: "Keep a step's title to 80 characters." });
    if ((s.body ?? "").length > 600) out.push({ path: `${p}.body`, message: "Keep a step's text to 600 characters." });
    if (s.id !== undefined && !STEP_ID_RE.test(s.id)) out.push({ path: `${p}.id`, message: "A step name starts with a letter and uses letters, digits, - and _." });
  });
  return out;
}

/** A basic form's named spots, as people know them. */
const SPOT_NAMES: Record<string, string> = {
  title: "The form's title",
  site: "The site picker",
  progress: "The progress bar",
  next: "The Next button",
  back: "The Back button",
  submit: "The Submit button",
  entries: "The Entries link",
  help: "The “Show me how” button",
};

const ACTIONS: { key: TutorialAction; label: string; hint: string }[] = [
  { key: "next", label: "Look, then Next", hint: "They read the card and press Next." },
  { key: "click", label: "Tap it", hint: "They have to tap the highlighted spot, which moves the tutorial on." },
  { key: "fill", label: "Fill it in", hint: "Next unlocks once they've answered the highlighted field." },
];

const PLACEMENTS: { key: TutorialPlacement; label: string }[] = [
  { key: "auto", label: "Auto" },
  { key: "top", label: "Above" },
  { key: "bottom", label: "Below" },
  { key: "left", label: "Left" },
  { key: "right", label: "Right" },
];

const DEVICES: { key: TutorialDevice; label: string; Icon: typeof Smartphone }[] = [
  { key: "phone", label: "Phones", Icon: Smartphone },
  { key: "tablet", label: "iPads", Icon: Tablet },
  { key: "desktop", label: "Computers", Icon: Monitor },
];

const OTHER = "__other";
const hostTarget = (t: string) => t === "tabs" || t === "help" || t.startsWith("tab:");

/** Why an action can't be used on this step (null: it can). Mirrors lintTutorial, a little stricter. */
function actionBlocked(s: TutorialStep, kind: "basic" | "code", action: TutorialAction): string | null {
  if (action === "next") return null;
  if (!s.field && !s.target) return "Point the step at something first.";
  if (kind === "basic") {
    if (action === "click" && s.target === "submit") return "A tap on Submit would send a real entry in the middle of the tutorial.";
    if (action === "fill" && !s.field) return "Only a field can be filled in.";
    return null;
  }
  if (action === "fill" && s.target && hostTarget(s.target)) return "Tabs and buttons can't be filled in.";
  return null;
}

/** Drop empty and default keys, so the JSON stays tidy and the strict schema is happy. */
function tidyStep(s: TutorialStep, kind: "basic" | "code"): TutorialStep {
  const out = { ...s } as Record<string, unknown>;
  for (const [k, v] of Object.entries(out)) {
    if (v === undefined || (v === "" && k !== "title") || (Array.isArray(v) && !v.length)) delete out[k];
  }
  if (out.action === "next") delete out.action;
  if (out.placement === "auto") delete out.placement;
  if (Array.isArray(out.devices) && out.devices.length === DEVICES.length) delete out.devices;
  const step = out as unknown as TutorialStep;
  if (step.action && actionBlocked(step, kind, step.action)) delete step.action;
  if (!step.field && !step.target) delete step.placement;
  return step;
}

function tidyTutorial(t: FormTutorial): FormTutorial {
  const out = { ...t } as Record<string, unknown>;
  if (!t.title?.trim()) delete out.title;
  if (t.autoStart !== false) delete out.autoStart;
  if (!t.roles?.length) delete out.roles;
  if (!t.version || t.version <= 1) delete out.version;
  return out as unknown as FormTutorial;
}

/** JSON with sorted keys: the server may hand the document back in another key order. */
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

const stepIndex = (path: string) => {
  const m = /\.steps\[(\d+)\]/.exec(path);
  return m ? Number(m[1]) : null;
};

export function TutorialEditor({
  value, onChange, targets, live, formId, formTitle, focus, onTry, trying = false, dirty = false, compact = false,
}: {
  value: FormTutorial | undefined;
  onChange: (t: FormTutorial | undefined) => void;
  targets: TutorialTargets;
  /** The published tutorial (null when nothing's live): "Show it again" goes past its version. */
  live: FormTutorial | null;
  formId: string;
  formTitle: string;
  /** Open this step; `n` changes on every request (the problems list). */
  focus?: { step: number; n: number };
  /** Open the draft in a new tab with the tutorial running (saving first). */
  onTry: () => void;
  trying?: boolean;
  dirty?: boolean;
  /** In a narrow column (the code editor). */
  compact?: boolean;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const cards = useRef(new Map<number, HTMLDivElement>());
  const freshTitle = useRef(false);
  const { data: roleList } = useRoles();
  const roles = useMemo(() => (roleList ?? []).filter((r) => r.key !== "admin").map((r) => ({ value: r.key, label: r.name })), [roleList]);
  const kind = targets.kind;
  const liveV = live ? (live.version ?? 1) : 0;
  const stats = useQuery({
    queryKey: ["tutorial-stats", formId, liveV],
    queryFn: () => api.get<TutorialStats>(`/tutorials/forms/${encodeURIComponent(formId)}`),
    enabled: liveV > 0,
    staleTime: 60_000,
  });

  // The problems list asked for a step.
  useEffect(() => {
    if (!focus) return;
    setOpen(focus.step);
    requestAnimationFrame(() => cards.current.get(focus.step)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }, [focus?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const problems = useMemo<Problem[]>(() => {
    if (!value) return [];
    const ctx = targets.kind === "basic" ? { kind: "basic" as const, fieldIds: targets.fieldIds } : { kind: "code" as const, pages: new Set(targets.pages.map((p) => p.id)) };
    return [...tutorialShapeProblems(value), ...lintTutorial(value, ctx)];
  }, [value, targets]);

  if (!value) {
    return (
      <div className={cn("mx-auto max-w-[760px]", compact ? "p-3" : "p-4 md:p-6")}>
        <Card className="p-6 text-center">
          <GraduationCap className="mx-auto h-8 w-8 text-muted" aria-hidden />
          <p className="mt-2 font-heading text-[16px] font-extrabold text-ink">No tutorial yet</p>
          <p className="mx-auto mt-1 max-w-md text-[13px] text-muted">
            A tutorial walks someone through this form the first time they open it: one thing highlighted at a time, the rest of the screen dimmed and locked. Build it here a step at a time.
          </p>
          <Button
            className="mt-4"
            onClick={() => {
              onChange({ steps: [{ title: `Welcome to ${formTitle || "this form"}`.slice(0, 80), body: "This shows you how to fill it in, one step at a time. Press Skip whenever you like." }] });
              setOpen(0);
            }}
          >
            <Plus className="h-4 w-4" /> Add a tutorial
          </Button>
          {live && <p className="mt-3 text-micro text-muted">The live form still has one ({live.steps.length} step{live.steps.length === 1 ? "" : "s"}). Publish to take it off.</p>}
        </Card>
      </div>
    );
  }

  const t = value;
  const steps = t.steps;
  const version = t.version ?? 1;
  const showAgain = liveV > 0 && version > liveV;
  const unpublished = stable(t) !== stable(live);
  const sameStepsAsLive = Boolean(live) && stable(live!.steps) === stable(steps);
  const general = problems.filter((p) => stepIndex(p.path) === null);

  const setT = (patch: Partial<FormTutorial>) => onChange(tidyTutorial({ ...t, ...patch }));
  const setSteps = (next: TutorialStep[]) => setT({ steps: next });
  const setStep = (i: number, patch: Partial<TutorialStep>) => setSteps(steps.map((s, j) => (j === i ? tidyStep({ ...s, ...patch }, kind) : s)));
  const reveal = (i: number) => requestAnimationFrame(() => cards.current.get(i)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));

  const add = () => {
    const at = open !== null ? open + 1 : steps.length;
    setSteps([...steps.slice(0, at), { title: "New step" }, ...steps.slice(at)]);
    setOpen(at);
    freshTitle.current = true;
    reveal(at);
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    setSteps(next);
    setOpen((o) => (o === i ? j : o === j ? i : o));
  };
  const duplicate = (i: number) => {
    const { id: _id, ...copy } = steps[i];
    setSteps([...steps.slice(0, i + 1), copy, ...steps.slice(i + 1)]);
    setOpen(i + 1);
    reveal(i + 1);
  };
  const remove = (i: number) => {
    setSteps(steps.filter((_, j) => j !== i));
    setOpen((o) => (o === null || o === i ? null : o > i ? o - 1 : o));
  };

  // Code forms: the page each step is on (its own, else the one before it, else the first tab).
  const pageOfStep = stepPagesOf(targets, steps);
  const versionStats = stats.data?.byVersion.find((v) => v.version === liveV);

  return (
    <div className={cn("mx-auto max-w-[760px] space-y-4", compact ? "p-3" : "p-4 md:p-6")}>
      <div className="flex flex-wrap items-center gap-2">
        <GraduationCap className="h-4 w-4 text-muted" aria-hidden />
        <p className="font-heading text-[15px] font-extrabold text-ink">Tutorial</p>
        <span className="text-[12.5px] text-muted">{steps.length} step{steps.length === 1 ? "" : "s"} · version {version}</span>
        {unpublished ? (
          <span className="rounded bg-status-amberBg px-1.5 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.03em] text-status-amberText">{live ? "Changed since publish" : "Not live yet"}</span>
        ) : (
          <span className="rounded bg-status-greenBg px-1.5 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.03em] text-status-greenText">Live</span>
        )}
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={onTry} disabled={trying} title={dirty ? "Saves your changes, then opens the draft with the tutorial running" : "Opens the draft with the tutorial running, in a new tab"}>
          {trying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Try it
        </Button>
      </div>

      {general.length > 0 && (
        <div className="rounded-input bg-status-redBg px-3 py-2 text-[12.5px] text-status-redText">
          {general.map((p, i) => <p key={i}>{p.message}</p>)}
        </div>
      )}

      <Section title="Steps" hint="In order. Each one highlights a single thing and dims the rest; everything outside the highlight is locked, and Skip always gets out.">
        <div className="space-y-2">
          {steps.map((s, i) => {
            const mine = problems.filter((p) => stepIndex(p.path) === i);
            const skips = sameStepsAsLive ? (stats.data?.skippedAtStep[String(i)] ?? 0) : 0;
            return (
              <StepCard
                key={i}
                cardRef={(el) => { if (el) cards.current.set(i, el); else cards.current.delete(i); }}
                step={s}
                index={i}
                count={steps.length}
                open={open === i}
                onToggle={() => setOpen(open === i ? null : i)}
                onChange={(patch) => setStep(i, patch)}
                onMove={(d) => move(i, d)}
                onDuplicate={() => duplicate(i)}
                onRemove={() => remove(i)}
                canDuplicate={steps.length < TUTORIAL_MAX_STEPS}
                problems={mine}
                targets={targets}
                page={pageOfStep[i]}
                prevPage={i > 0 ? pageOfStep[i - 1] : null}
                roles={roles}
                skips={skips}
                autoFocusTitle={open === i && freshTitle.current}
                onFocused={() => { freshTitle.current = false; }}
              />
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={add} disabled={steps.length >= TUTORIAL_MAX_STEPS}>
            <Plus className="h-3.5 w-3.5" /> {open !== null ? `Add a step after ${open + 1}` : "Add a step"}
          </Button>
          {steps.length >= TUTORIAL_MAX_STEPS && <span className="text-micro text-muted">{TUTORIAL_MAX_STEPS} steps at most.</span>}
        </div>
      </Section>

      <Section title="Starting it">
        <Row label="Name" hint="On the tutorial's cards.">
          <Input value={t.title ?? ""} maxLength={80} placeholder={`How to use ${formTitle || "this form"}`} onChange={(e) => setT({ title: e.target.value })} />
        </Row>
        <Toggle
          label="Start it by itself"
          hint="The first time someone opens the form. Off: only from the form's “Show me how” button."
          checked={t.autoStart !== false}
          onChange={(v) => setT({ autoStart: v ? undefined : false })}
        />
        {t.autoStart !== false && (
          <Row label="Start it by itself for" hint="None ticked: everyone who can open the form. “Show me how” works for anyone.">
            <CheckboxList options={roles} value={t.roles ?? []} onChange={(v) => setT({ roles: v })} />
          </Row>
        )}
        {liveV > 0 ? (
          <Toggle
            label="Show it again to everyone"
            hint={
              showAgain
                ? `Publishing makes this version ${version}: it starts again for everyone who finished or skipped version ${liveV}.`
                : `People who've been through version ${liveV} won't get it again. Turn this on after a change they should see.`
            }
            checked={showAgain}
            onChange={(on) => setT({ version: on ? Math.max(version, liveV + 1) : liveV })}
          />
        ) : (
          <p className="text-[12.5px] text-muted">Nothing's live yet: once it's published, everyone gets it the first time they open the form.</p>
        )}
      </Section>

      {liveV > 0 && (
        <Section title="Who's been through it" hint={`The live tutorial (version ${liveV}). Anyone can run it again from “Show me how”; that isn't counted twice.`}>
          {stats.isLoading ? (
            <p className="text-[12.5px] text-muted">Loading…</p>
          ) : !stats.data?.people ? (
            <p className="text-[12.5px] text-muted">Nobody yet.</p>
          ) : (
            <div className="space-y-1.5">
              <div className="flex flex-wrap gap-2">
                <Stat label="Finished" value={stats.data.completed} tone="green" />
                <Stat label="Skipped" value={stats.data.skipped} tone="amber" />
                {versionStats && stats.data.byVersion.length > 1 && <Stat label={`On version ${liveV}`} value={`${versionStats.completed} / ${versionStats.skipped}`} />}
              </div>
              <p className="text-micro text-muted">
                {sameStepsAsLive
                  ? Object.keys(stats.data.skippedAtStep).length
                    ? "Where people skipped shows on each step (counted by the step they were on, of the steps their role and device get)."
                    : "Nobody has skipped part-way."
                  : "Where people skipped shows on the steps again once the draft's steps match the live ones."}
              </p>
            </div>
          )}
        </Section>
      )}

      <div className="flex flex-wrap items-center gap-3 pb-2">
        <Button
          variant="outlineDanger"
          size="sm"
          onClick={() => { if (confirm("Remove this form's tutorial? Publish afterwards to take it off the live form. The record of who's seen it stays.")) onChange(undefined); }}
        >
          <Trash2 className="h-3.5 w-3.5" /> Remove the tutorial
        </Button>
        <p className="text-micro text-muted">It's part of the draft: Save keeps it, Publish makes it live.</p>
      </div>
    </div>
  );
}

/** Each step's page on a code form (the same rule as the app: apps/tutorialAnchors.ts stepPages). */
function stepPagesOf(targets: TutorialTargets, steps: TutorialStep[]): (string | null)[] {
  if (targets.kind !== "code") return steps.map(() => null);
  let page = targets.pages.find((p) => !p.hidden)?.id ?? targets.pages[0]?.id ?? null;
  return steps.map((s) => (page = s.page ?? page));
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "green" | "amber" }) {
  return (
    <div className="min-w-[96px] rounded-input border border-hairline px-3 py-1.5">
      <p className="text-micro font-semibold text-muted">{label}</p>
      <p className={cn("font-heading text-[18px] font-extrabold", tone === "green" ? "text-status-greenText" : tone === "amber" ? "text-status-amberText" : "text-ink")}>{value}</p>
    </div>
  );
}

/** What a step points at, in words. */
function pointsAt(s: TutorialStep, targets: TutorialTargets): string {
  if (targets.kind === "basic") {
    if (s.field) {
      const f = targets.fields.find((x) => x.id === s.field);
      return f ? `Field: ${f.label}` : `Field ${s.field} (not on the form)`;
    }
    if (s.target) return SPOT_NAMES[s.target] ?? `“${s.target}” (unknown)`;
    return "A card in the middle";
  }
  if (!s.target) return "A card in the middle";
  if (s.target === "tabs") return "The row of tabs";
  if (s.target === "help") return SPOT_NAMES.help;
  if (s.target.startsWith("tab:")) {
    const p = targets.pages.find((x) => x.id === s.target!.slice(4));
    return `The “${p?.label ?? s.target.slice(4)}” tab`;
  }
  return `data-tour="${s.target}"`;
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={(e) => { e.stopPropagation(); onClick(); }} className="rounded p-1 text-muted hover:bg-subtle hover:text-ink disabled:opacity-30">
      {children}
    </button>
  );
}

function Segmented<K extends string>({ value, options, onChange, blocked }: { value: K; options: { key: K; label: string }[]; onChange: (k: K) => void; blocked?: (k: K) => string | null }) {
  return (
    <div className="inline-flex flex-wrap rounded-input border border-hairline p-0.5">
      {options.map((o) => {
        const why = blocked?.(o.key) ?? null;
        return (
          <button
            key={o.key}
            type="button"
            disabled={Boolean(why)}
            title={why ?? undefined}
            aria-pressed={value === o.key}
            onClick={() => onChange(o.key)}
            className={cn("rounded-[5px] px-3 py-1 text-[12.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-40", value === o.key ? "bg-navy text-white" : "text-muted hover:text-ink")}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const Badge = ({ children, tone }: { children: React.ReactNode; tone?: "violet" | "red" | "amber" }) => (
  <span
    className={cn(
      "inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10.5px] font-semibold",
      tone === "violet" ? "bg-status-violetBg text-status-violetText" : tone === "red" ? "bg-status-redBg text-status-redText" : tone === "amber" ? "bg-status-amberBg text-status-amberText" : "bg-subtle2 text-muted"
    )}
  >
    {children}
  </span>
);

interface StepCardProps {
  step: TutorialStep;
  index: number;
  count: number;
  open: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<TutorialStep>) => void;
  onMove: (d: -1 | 1) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  canDuplicate: boolean;
  problems: Problem[];
  targets: TutorialTargets;
  /** Code forms: the page this step is on, and the one before it. */
  page: string | null;
  prevPage: string | null;
  roles: { value: string; label: string }[];
  /** People who skipped the live tutorial at this step. */
  skips: number;
  autoFocusTitle: boolean;
  onFocused: () => void;
}

function StepCard({ cardRef, ...p }: StepCardProps & { cardRef: (el: HTMLDivElement | null) => void }) {
  const { step: s, index: i, targets } = p;
  const action = s.action ?? "next";
  const code = targets.kind === "code" ? targets : null;
  const pageInfo = code?.pages.find((x) => x.id === p.page);
  // A data-tour name that isn't written in the step's page (or the files it shares): skipped at run time.
  const missingAnchor = code && code.anchorsLoaded && s.target && !hostTarget(s.target) && !(pageInfo?.anchors ?? []).includes(s.target);

  return (
    <div ref={cardRef} className={cn("rounded-card border bg-surface transition-[border-color,box-shadow] duration-150", p.open ? "border-navy ring-2 ring-navy/20 dark:border-accent" : "border-hairline hover:border-strongline")}>
      <div className="group flex items-center gap-2 px-3 py-2">
        <span className={cn("grid h-6 w-6 flex-none place-items-center rounded-full text-[11.5px] font-bold", p.problems.length ? "bg-status-redBg text-status-redText" : "bg-navsel text-accent dark:text-white")}>{i + 1}</span>
        <button type="button" onClick={p.onToggle} aria-expanded={p.open} className="min-w-0 flex-1 text-left">
          <span className="block truncate text-[13.5px] font-semibold text-ink">{s.title.trim() || "Untitled step"}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1 text-micro text-muted">
            <span className="mr-0.5 max-w-full truncate">{pointsAt(s, targets)}</span>
            {code && pageInfo && (s.page || i === 0) && <Badge>on {pageInfo.label}</Badge>}
            {action === "click" && <Badge tone="violet">Tap it</Badge>}
            {action === "fill" && <Badge tone="violet">Fill it in</Badge>}
            {s.roles?.length ? <Badge>{s.roles.length} role{s.roles.length === 1 ? "" : "s"}</Badge> : null}
            {s.devices?.length ? <Badge>{s.devices.map((d) => DEVICES.find((x) => x.key === d)?.label).join(", ")}</Badge> : null}
            {p.problems.length > 0 && <Badge tone="red"><AlertTriangle className="h-3 w-3" /> {p.problems.length}</Badge>}
            {missingAnchor && <Badge tone="amber">anchor not found</Badge>}
            {p.skips > 0 && <Badge tone="amber">{p.skips} skipped here</Badge>}
          </span>
        </button>
        <div className={cn("flex flex-none gap-0.5", p.open ? "flex" : "hidden group-hover:flex group-focus-within:flex")}>
          <IconBtn label="Move up" disabled={i === 0} onClick={() => p.onMove(-1)}><ArrowUp className="h-3.5 w-3.5" /></IconBtn>
          <IconBtn label="Move down" disabled={i === p.count - 1} onClick={() => p.onMove(1)}><ArrowDown className="h-3.5 w-3.5" /></IconBtn>
          <IconBtn label="Duplicate" disabled={!p.canDuplicate} onClick={p.onDuplicate}><Copy className="h-3.5 w-3.5" /></IconBtn>
          <IconBtn label={p.count === 1 ? "A tutorial needs a step: remove the tutorial instead" : "Delete"} disabled={p.count === 1} onClick={p.onRemove}><Trash2 className="h-3.5 w-3.5 text-status-redText" /></IconBtn>
        </div>
      </div>

      {p.open && (
        <div className="space-y-3 border-t border-hairline p-3">
          <Row label="Title">
            <Input
              value={s.title}
              maxLength={80}
              autoFocus={p.autoFocusTitle}
              onFocus={(e) => { if (p.autoFocusTitle) { e.currentTarget.select(); p.onFocused(); } }}
              onChange={(e) => p.onChange({ title: e.target.value })}
            />
          </Row>
          <Row label="What it says" hint="Plain text. A blank line starts a new paragraph, **bold** works, and {user:first} or {user:name} put in their name.">
            <Textarea value={s.body ?? ""} maxLength={600} rows={3} onChange={(e) => p.onChange({ body: e.target.value })} />
          </Row>
          {code && <PagePicker step={s} pages={code.pages} prevPage={p.prevPage} first={i === 0} onChange={p.onChange} />}
          <TargetPicker step={s} targets={targets} page={p.page} onChange={p.onChange} />
          {missingAnchor && (
            <p className="rounded-input bg-status-amberBg px-3 py-2 text-[12.5px] text-status-amberText">
              data-tour="{s.target}" isn't written in {pageInfo?.file ?? "the page"} or the files it shares. Put it on the element (<code>&lt;div data-tour="{s.target}"&gt;</code>), or pick the step's page; until then the step is skipped.
            </p>
          )}
          <div>
            <p className="mb-1 text-[12px] font-semibold text-muted">What they do</p>
            <Segmented value={action} options={ACTIONS} onChange={(k) => p.onChange({ action: k })} blocked={(k) => actionBlocked(s, targets.kind, k)} />
            <p className="mt-1 text-micro text-muted">{ACTIONS.find((a) => a.key === action)?.hint}</p>
          </div>
          {(s.field || s.target) && (
            <div>
              <p className="mb-1 text-[12px] font-semibold text-muted">Where the card goes</p>
              <Segmented value={s.placement ?? "auto"} options={PLACEMENTS} onChange={(k) => p.onChange({ placement: k })} />
              <p className="mt-1 text-micro text-muted">Next to the highlighted spot. Phones always put it at the top or bottom of the screen.</p>
            </div>
          )}
          <Row label="Only for these roles" hint="None ticked: everyone. Admins see every step.">
            <CheckboxList options={p.roles} value={s.roles ?? []} onChange={(v) => p.onChange({ roles: v })} />
          </Row>
          <div>
            <p className="mb-1 text-[12px] font-semibold text-muted">Only on</p>
            <div className="flex flex-wrap gap-1.5">
              {DEVICES.map(({ key, label, Icon }) => {
                const on = s.devices?.includes(key) ?? false;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => p.onChange({ devices: on ? (s.devices ?? []).filter((d) => d !== key) : [...(s.devices ?? []), key] })}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-input border px-2.5 py-1 text-[12.5px] font-semibold",
                      on ? "border-navy bg-navsel text-accent dark:border-accent dark:text-white" : "border-hairline text-muted hover:border-strongline hover:text-ink"
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" /> {label}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-micro text-muted">None picked: every kind of device.</p>
          </div>
          <Row label="Step name (optional)" hint="Your own name for it, used in progress reports. Letters, digits, - and _.">
            <Input value={s.id ?? ""} maxLength={64} onChange={(e) => p.onChange({ id: e.target.value.trim() || undefined })} placeholder={`step-${i + 1}`} className="max-w-xs font-mono text-[13px]" />
          </Row>
          {p.problems.length > 0 && (
            <div className="rounded-input bg-status-redBg px-3 py-2 text-[12.5px] text-status-redText">
              {p.problems.map((x, k) => <p key={k}>{x.message}</p>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PagePicker({ step: s, pages, prevPage, first, onChange }: {
  step: TutorialStep;
  pages: { id: string; label: string; hidden?: boolean }[];
  prevPage: string | null;
  first: boolean;
  onChange: (patch: Partial<TutorialStep>) => void;
}) {
  const label = (id: string | null) => pages.find((p) => p.id === id)?.label ?? id ?? "—";
  const firstTab = pages.find((p) => !p.hidden)?.id ?? pages[0]?.id ?? null;
  const unknown = s.page && !pages.some((p) => p.id === s.page);
  return (
    <Row label="Page" hint="The tab the step is on. The tutorial opens it before showing the step.">
      <Select value={s.page ?? ""} onChange={(e) => onChange({ page: e.target.value || undefined })}>
        <option value="">{first ? `The first tab (${label(firstTab)})` : `Same as the step before (${label(prevPage)})`}</option>
        {pages.map((p) => <option key={p.id} value={p.id}>{p.label}{p.hidden ? " (hidden tab)" : ""}</option>)}
        {unknown && <option value={s.page}>{s.page} (not in form.json)</option>}
      </Select>
    </Row>
  );
}

function TargetPicker({ step: s, targets, page, onChange }: {
  step: TutorialStep;
  targets: TutorialTargets;
  page: string | null;
  onChange: (patch: Partial<TutorialStep>) => void;
}) {
  const [other, setOther] = useState(false);

  if (targets.kind === "basic") {
    const value = s.field ? `f:${s.field}` : s.target ? `t:${s.target}` : "";
    const known = (s.field && targets.fields.some((f) => f.id === s.field)) || (s.target && s.target in FORM_TUTORIAL_TARGETS) || !value;
    const notHere = (k: string) => (k === "site" && !targets.requireSite) || (["progress", "next", "back"].includes(k) && targets.pages < 2);
    const byPage = new Map<number, typeof targets.fields>();
    for (const f of targets.fields) byPage.set(f.page, [...(byPage.get(f.page) ?? []), f]);
    const hint = s.target ? FORM_TUTORIAL_TARGETS[s.target] : s.field ? "The field's whole row: its label, the answer and any help text." : "No highlight: the card sits in the middle of the screen. Good for a welcome or a last word.";
    return (
      <Row label="Points at" hint={hint}>
        <Select
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v.startsWith("f:") ? { field: v.slice(2), target: undefined } : v.startsWith("t:") ? { target: v.slice(2), field: undefined } : { field: undefined, target: undefined });
          }}
        >
          <option value="">Nothing: a card in the middle of the screen</option>
          {[...byPage.entries()].map(([n, list]) => (
            <optgroup key={n} label={targets.pages > 1 ? `Fields on page ${n}` : "Fields"}>
              {list.map((f) => <option key={f.id} value={`f:${f.id}`}>{(f.label || f.id).slice(0, 70)} ({f.id})</option>)}
            </optgroup>
          ))}
          <optgroup label="Parts of the form">
            {Object.keys(FORM_TUTORIAL_TARGETS).map((k) => <option key={k} value={`t:${k}`}>{SPOT_NAMES[k] ?? k}{notHere(k) ? " (not on this form)" : ""}</option>)}
          </optgroup>
          {!known && <option value={value}>{s.field ?? s.target} (not on the form)</option>}
        </Select>
      </Row>
    );
  }

  const pageInfo = targets.pages.find((p) => p.id === page);
  const anchors = pageInfo?.anchors ?? [];
  const host = ["tabs", "help", ...targets.pages.filter((p) => !p.hidden).map((p) => `tab:${p.id}`)];
  const listed = !s.target || anchors.includes(s.target) || host.includes(s.target);
  const value = other || !listed ? OTHER : (s.target ?? "");
  const hint = !s.target
    ? "No highlight: the card sits in the middle of the screen. Good for a welcome or a last word."
    : s.target === "tabs" ? APP_TUTORIAL_TARGETS.tabs
    : s.target === "help" ? APP_TUTORIAL_TARGETS.help
    : s.target.startsWith("tab:") ? "One tab in the row. With “Tap it”, tapping it opens that page and moves on."
    : "An element in the page's code with this data-tour attribute. Add one with <div data-tour=\"name\">.";
  return (
    <Row label="Points at" hint={hint}>
      <Select
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          setOther(v === OTHER);
          if (v !== OTHER) onChange({ target: v || undefined });
        }}
      >
        <option value="">Nothing: a card in the middle of the screen</option>
        <optgroup label={`On the ${pageInfo?.label ?? page ?? "page"} page`}>
          {anchors.map((a) => <option key={a} value={a}>data-tour="{a}"</option>)}
          {!anchors.length && <option disabled value="__none">{targets.anchorsLoaded ? `No data-tour anchors in ${pageInfo?.file ?? "this page"} yet` : "Reading the page…"}</option>}
        </optgroup>
        <optgroup label="Around the form">
          <option value="tabs">The row of tabs</option>
          {targets.pages.filter((p) => !p.hidden).map((p) => <option key={p.id} value={`tab:${p.id}`}>The “{p.label}” tab</option>)}
          <option value="help">{SPOT_NAMES.help}</option>
        </optgroup>
        <option value={OTHER}>Another data-tour name…</option>
      </Select>
      {value === OTHER && (
        <Input
          autoFocus={other}
          value={s.target ?? ""}
          onChange={(e) => onChange({ target: e.target.value.trim() || undefined })}
          placeholder="e.g. meal-picker"
          className="mt-1.5 max-w-xs font-mono text-[13px]"
          aria-label="data-tour name"
        />
      )}
    </Row>
  );
}
