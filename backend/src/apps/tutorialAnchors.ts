import type { FileProblem, Files, Manifest } from "./project.js";

/**
 * A code form's tutorial points at data-tour="…" anchors in its pages. Pages are
 * code, so the anchors are found by reading the sources: written out literally
 * (data-tour="meal", data-tour={"meal"}). One built from a variable can't be
 * seen here, so a missing anchor is a warning, never an error — at run time a
 * step whose anchor isn't on the screen is skipped.
 */

const ANCHOR_RE = /data-tour\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`$]*)["'`]\s*\})/g;
const HOST_TARGET = (t: string) => t === "tabs" || t === "help" || t.startsWith("tab:");

function anchorsIn(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(ANCHOR_RE)) {
    const name = m[1] ?? m[2] ?? m[3];
    if (name) out.add(name);
  }
  return [...out];
}

/**
 * Each page's anchors: those in its own file (and per-device views), plus those
 * in every file that isn't a page (shared components a page may import).
 */
export function pageAnchors(files: Files, manifest: Manifest): Record<string, string[]> {
  const pageFiles = new Set(manifest.pages.flatMap((p) => [p.file, ...Object.values(p.views ?? {}).filter((f): f is string => Boolean(f))]));
  const shared = Object.entries(files)
    .filter(([path]) => /\.(tsx|jsx)$/.test(path) && !pageFiles.has(path) && !path.startsWith("server/"))
    .flatMap(([, src]) => anchorsIn(src));
  return Object.fromEntries(
    manifest.pages.map((p) => {
      const own = [p.file, ...Object.values(p.views ?? {})].filter((f): f is string => Boolean(f)).flatMap((f) => anchorsIn(files[f] ?? ""));
      return [p.id, [...new Set([...own, ...shared])].sort()];
    })
  );
}

/** The page each step is on: its own `page`, else the one before it, else the first page. */
export function stepPages(manifest: Manifest): string[] {
  let page = manifest.pages[0]?.id ?? "";
  return (manifest.tutorial?.steps ?? []).map((s) => (page = s.page ?? page));
}

/** Warnings for tutorial steps whose anchor isn't written anywhere on their page. */
export function tutorialAnchorWarnings(files: Files, manifest: Manifest): FileProblem[] {
  const t = manifest.tutorial;
  if (!t) return [];
  const anchors = pageAnchors(files, manifest);
  const pages = stepPages(manifest);
  const out: FileProblem[] = [];
  t.steps.forEach((s, i) => {
    if (!s.target || HOST_TARGET(s.target)) return;
    const page = pages[i];
    if ((anchors[page] ?? []).includes(s.target)) return;
    const file = manifest.pages.find((p) => p.id === page)?.file ?? "the page";
    out.push({
      file: "form.json",
      message: `tutorial.steps[${i}] (“${s.title}”) points at data-tour="${s.target}", which isn't in ${file} (page "${page}") or the files it shares. Put it on the element, or set the step's page; until then the step is skipped.`,
    });
  });
  return out;
}
