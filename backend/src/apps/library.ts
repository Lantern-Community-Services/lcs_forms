import { prisma } from "../prisma.js";
import type { Files } from "./project.js";

/**
 * The component library as the compiler sees it. A code form imports a shared
 * component as `@lcs/components/<name>` (or `@lcs/components/<name>/<file>`);
 * before a build, the components it uses (and the ones those use) are added
 * to its files under `_components/<name>/…`, where the compiler finds them.
 * Drafts build with each component's latest version; a published form keeps
 * the build it was published with, so a component change reaches a live form
 * only when it's published again.
 */

export const COMPONENT_DIR = "_components";
export const COMPONENT_PREFIX = "@lcs/components/";
export const COMPONENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{1,79}$/;

/** `@lcs/components/<name>` imports in some source text. */
export function importedComponents(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/["']@lcs\/components\/([A-Za-z][A-Za-z0-9_]*)(?:\/[^"']*)?["']/g)) out.add(m[1]);
  return [...out];
}

const isSource = (path: string) => /\.(tsx?|jsx?)$/.test(path);

export interface LibraryEntry {
  name: string;
  version: number;
  files: Files;
}

let cached: { at: number; byName: Map<string, LibraryEntry> } | null = null;

/** Every component, read at most every few seconds (saving one clears it). */
export async function loadLibrary(): Promise<Map<string, LibraryEntry>> {
  if (cached && Date.now() - cached.at < 5_000) return cached.byName;
  const rows = await prisma.uiComponent.findMany({ select: { name: true, version: true, files: true } });
  const byName = new Map(rows.map((r) => [r.name, { name: r.name, version: r.version, files: JSON.parse(r.files) as Files }]));
  cached = { at: Date.now(), byName };
  return byName;
}

export function forgetLibrary() {
  cached = null;
}

/**
 * The project's files plus every library component it imports (and theirs),
 * and the version of each it got. Anything already under _components/ in the
 * project is replaced: that folder belongs to the library. `extra` stands in
 * for (or adds) library entries, e.g. a component being checked before it's saved.
 */
export async function withLibrary(files: Files, extra: LibraryEntry[] = []): Promise<{ files: Files; used: Record<string, number> }> {
  const out: Files = {};
  for (const [path, src] of Object.entries(files)) if (!path.startsWith(`${COMPONENT_DIR}/`)) out[path] = src;
  const wanted = new Set<string>();
  for (const [path, src] of Object.entries(out)) if (isSource(path)) for (const n of importedComponents(src)) wanted.add(n);
  if (!wanted.size && !extra.length) return { files: out, used: {} };

  const lib = new Map(await loadLibrary());
  for (const e of extra) lib.set(e.name, e);
  const used: Record<string, number> = {};
  const queue = [...wanted];
  while (queue.length) {
    const name = queue.shift()!;
    if (name in used) continue;
    const entry = lib.get(name);
    if (!entry) continue; // the compiler reports it ("No component …")
    used[name] = entry.version;
    for (const [path, src] of Object.entries(entry.files)) {
      out[`${COMPONENT_DIR}/${name}/${path}`] = src;
      if (isSource(path)) for (const n of importedComponents(src)) if (!(n in used)) queue.push(n);
    }
  }
  return { files: out, used };
}
