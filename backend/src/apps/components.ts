import { prisma } from "../prisma.js";
import { HttpError, badRequest, notFound } from "../http.js";
import { audit, type Actor } from "../services/audit.js";
import { checkComponent } from "./compile.js";
import { COMPONENT_NAME_RE, COMPONENT_PREFIX, forgetLibrary, importedComponents } from "./library.js";
import type { FileProblem, Files } from "./project.js";

/**
 * The component library (UiComponent): shared code-form UI and helpers that
 * any code form imports as `@lcs/components/<name>`. The MCP form builder
 * lists these before writing a form's UI, and saves a reusable piece here
 * rather than into one form. Saving checks that the component builds, and
 * keeps every version.
 */

const PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_.\-/]*\.(tsx?|jsx?|css|json|md)$/;
const MAX_BYTES = 300_000;

export class ComponentError extends HttpError {
  constructor(public problems: FileProblem[], message = "The component has problems.") {
    super(422, message, { problems });
  }
}

/** Which code forms import each component (their draft or live files). */
async function usage(): Promise<Map<string, { slug: string; title: string }[]>> {
  const forms = await prisma.builtForm.findMany({ where: { kind: "code", status: { not: "archived" } }, select: { slug: true, title: true, draftSchema: true, liveSchema: true } });
  const out = new Map<string, { slug: string; title: string }[]>();
  for (const f of forms) {
    const names = new Set<string>();
    for (const doc of [f.draftSchema, f.liveSchema]) {
      if (!doc) continue;
      const files = (JSON.parse(doc) as { files: Files }).files ?? {};
      for (const src of Object.values(files)) for (const n of importedComponents(src)) names.add(n);
    }
    for (const n of names) out.set(n, [...(out.get(n) ?? []), { slug: f.slug, title: f.title }]);
  }
  return out;
}

export async function listComponents(q?: { search?: string; category?: string }) {
  const rows = await prisma.uiComponent.findMany({ orderBy: [{ category: "asc" }, { name: "asc" }], select: { name: true, title: true, description: true, category: true, api: true, version: true, updatedAt: true, updatedByName: true } });
  const used = await usage();
  const s = q?.search?.trim().toLowerCase();
  return rows
    .filter((r) => !q?.category || r.category.toLowerCase() === q.category.toLowerCase())
    .filter((r) => !s || `${r.name} ${r.title} ${r.description} ${r.category} ${r.api ?? ""}`.toLowerCase().includes(s))
    .map((r) => ({ ...r, import: `${COMPONENT_PREFIX}${r.name}`, usedBy: (used.get(r.name) ?? []).map((f) => f.slug) }));
}

async function findComponent(name: string) {
  const row = await prisma.uiComponent.findUnique({ where: { name } });
  if (!row) throw notFound(`No component "${name}". list_components shows what there is.`);
  return row;
}

export async function getComponent(name: string) {
  const row = await findComponent(name);
  const versions = await prisma.uiComponentVersion.findMany({ where: { componentId: row.id }, orderBy: { version: "desc" }, take: 50, select: { version: true, note: true, createdByName: true, createdAt: true } });
  return {
    name: row.name,
    import: `${COMPONENT_PREFIX}${row.name}`,
    title: row.title,
    description: row.description,
    category: row.category,
    api: row.api,
    usage: row.usage,
    version: row.version,
    files: JSON.parse(row.files) as Files,
    usedBy: (await usage()).get(row.name) ?? [],
    versions,
    updatedByName: row.updatedByName ?? row.createdByName,
    updatedAt: row.updatedAt,
  };
}

export async function componentVersionFiles(name: string, version: number): Promise<Files> {
  const row = await findComponent(name);
  const v = await prisma.uiComponentVersion.findUnique({ where: { componentId_version: { componentId: row.id, version } } });
  if (!v) throw notFound(`${name} has no version ${version}.`);
  return JSON.parse(v.files) as Files;
}

export interface ComponentInput {
  name: string;
  title?: string;
  description?: string;
  category?: string;
  /** The whole component ({ path: source }, with index.tsx or index.ts); omit to keep the files and change only the words. */
  files?: Files;
  api?: string | null;
  usage?: string | null;
  note?: string;
}

function checkFilesOf(files: unknown): Files {
  if (!files || typeof files !== "object" || Array.isArray(files)) throw badRequest("files must be an object of { path: source }.");
  const problems: FileProblem[] = [];
  let total = 0;
  for (const [path, src] of Object.entries(files as Record<string, unknown>)) {
    if (typeof src !== "string") problems.push({ file: path, message: "File contents must be text." });
    else if (!PATH_RE.test(path) || path.includes("..")) problems.push({ file: path, message: "Use a relative path like index.tsx or parts/Row.tsx." });
    else total += src.length;
  }
  const out = files as Files;
  if (!out["index.tsx"] && !out["index.ts"]) problems.push({ file: "index.tsx", message: "A component needs index.tsx (or index.ts): it's what the import gives." });
  if (total > MAX_BYTES) problems.push({ file: "", message: "A component is at most 300 KB." });
  if (problems.length) throw new ComponentError(problems);
  return out;
}

/** Add a component, or save a new version of one. It must build (with the library's others as they are). */
export async function saveComponent(input: ComponentInput, actor: Actor) {
  const name = String(input.name ?? "").trim();
  if (!COMPONENT_NAME_RE.test(name)) throw badRequest("name: letters, digits and _, starting with a letter (PascalCase for UI, e.g. SitePicker; camelCase for helpers, e.g. formatting).");
  const existing = await prisma.uiComponent.findUnique({ where: { name } });
  if (!existing && !input.files) throw badRequest("A new component needs files.");
  if (!existing && (!input.title?.trim() || !input.description?.trim() || !input.category?.trim())) throw badRequest("A new component needs a title, a description (what it is and when to use it) and a category.");
  const files = input.files ? checkFilesOf(input.files) : (JSON.parse(existing!.files) as Files);
  const version = existing ? existing.version + (input.files ? 1 : 0) : 1;

  if (input.files) {
    const problems = await checkComponent({ name, version, files });
    if (problems.length) throw new ComponentError(problems, "The component doesn't build.");
  }
  const words = {
    ...(input.title !== undefined ? { title: input.title.trim().slice(0, 160) } : {}),
    ...(input.description !== undefined ? { description: input.description.trim().slice(0, 4000) } : {}),
    ...(input.category !== undefined ? { category: input.category.trim().slice(0, 60) } : {}),
    ...(input.api !== undefined ? { api: input.api?.slice(0, 8000) || null } : {}),
    ...(input.usage !== undefined ? { usage: input.usage?.slice(0, 8000) || null } : {}),
  };
  const row = existing
    ? await prisma.uiComponent.update({ where: { id: existing.id }, data: { ...words, ...(input.files ? { files: JSON.stringify(files), version } : {}), updatedByName: actor.name } })
    : await prisma.uiComponent.create({
        data: { name, title: words.title!, description: words.description!, category: words.category!, api: words.api ?? null, usage: words.usage ?? null, files: JSON.stringify(files), version, createdByName: actor.name },
      });
  if (input.files) {
    await prisma.uiComponentVersion.create({ data: { componentId: row.id, version, files: JSON.stringify(files), note: input.note?.slice(0, 500) ?? null, createdByName: actor.name } });
  }
  forgetLibrary();
  await audit({
    actor,
    action: existing ? "apps.component_updated" : "apps.component_created",
    summary: existing ? `Changed component ${name}${input.files ? ` (version ${version})` : ""}${input.note ? `: ${input.note}` : ""}` : `Added component ${name} to the library`,
  });
  return { name: row.name, version: row.version, import: `${COMPONENT_PREFIX}${row.name}`, created: !existing };
}

/** Remove a component no code form imports. */
export async function deleteComponent(name: string, actor: Actor) {
  const row = await findComponent(name);
  const users = (await usage()).get(name) ?? [];
  if (users.length) throw badRequest(`${name} is used by ${users.map((u) => u.title).join(", ")}. Take it out of them first.`);
  await prisma.uiComponent.delete({ where: { id: row.id } });
  forgetLibrary();
  await audit({ actor, action: "apps.component_deleted", summary: `Removed component ${name} from the library` });
  return { deleted: name };
}
