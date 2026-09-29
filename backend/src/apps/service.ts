import type { BuiltForm } from "@prisma/client";
import { prisma } from "../prisma.js";
import { HttpError, badRequest, notFound } from "../http.js";
import { audit, type Actor } from "../services/audit.js";
import { checkSlug, syncCatalogUrl, uniqueSlug } from "../forms/service.js";
import { buildProject } from "./compile.js";
import { APP_FORMAT, checkFiles, readManifest, starterProject, titleOf, type FileProblem, type Files } from "./project.js";
import { findCodeForm } from "./runtime.js";

/**
 * Code form projects: create, save files, build, publish, version, import and
 * export. Used by routes/apps.ts, the MCP server and the CLI alike.
 */

export class ProjectError extends HttpError {
  constructor(public problems: FileProblem[], message = "The project has problems.") {
    super(422, message, { problems });
  }
}

export const draftFiles = (row: BuiltForm): Files => (JSON.parse(row.draftSchema) as { files: Files }).files;
export const liveFiles = (row: BuiltForm): Files | null => (row.liveSchema ? (JSON.parse(row.liveSchema) as { files: Files }).files : null);

function validFiles(files: unknown): Files {
  const r = checkFiles(files);
  if (!r.files) throw new ProjectError(r.problems);
  return r.files;
}

export function projectDetail(row: BuiltForm) {
  const files = draftFiles(row);
  const live = liveFiles(row);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    status: row.status,
    revision: row.revision,
    liveVersion: row.liveVersion,
    unpublishedChanges: live !== null && JSON.stringify(live) !== JSON.stringify(files),
    files,
    catalogLinkId: row.catalogLinkId,
    createdByName: row.createdByName,
    updatedByName: row.updatedByName,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listProjects(opts: { includeArchived?: boolean } = {}) {
  const rows = await prisma.builtForm.findMany({
    where: { kind: "code", ...(opts.includeArchived ? {} : { status: { not: "archived" } }) },
    orderBy: { updatedAt: "desc" },
  });
  const counts = await prisma.formEntry.groupBy({ by: ["formId"], where: { status: "active", source: { not: "preview" }, formId: { in: rows.map((r) => r.id) } }, _count: { _all: true } });
  const byForm = new Map(counts.map((c) => [c.formId, c._count._all]));
  return rows.map((r) => {
    const d = projectDetail(r);
    let icon: string | null = null;
    try {
      icon = JSON.parse(d.files["form.json"] ?? "{}").icon ?? null;
    } catch {
      /* broken manifest */
    }
    const { files, ...rest } = d;
    return { ...rest, icon, fileCount: Object.keys(files).length, entryCount: byForm.get(r.id) ?? 0 };
  });
}

export async function createProject(input: { title?: string; files?: unknown; slug?: string }, actor: Actor): Promise<BuiltForm> {
  const files = input.files === undefined ? starterProject(input.title?.trim() || "Untitled code form") : validFiles(input.files);
  const title = titleOf(files);
  if (input.slug) await checkSlug(input.slug);
  const slug = input.slug ?? (await uniqueSlug(title));
  const row = await prisma.builtForm.create({
    data: { kind: "code", slug, title, draftSchema: JSON.stringify({ format: APP_FORMAT, version: 1, files }), createdById: actor.id, createdByName: actor.name, updatedByName: actor.name },
  });
  await audit({ actor, action: "apps.created", summary: `Created code form “${title}” (/apps/${slug})` });
  return row;
}

/** Save the draft's files. Broken code saves fine (it just won't build); only paths and sizes are checked. */
export async function saveProject(id: string, input: { files: unknown; revision?: number; slug?: string }, actor: Actor): Promise<BuiltForm> {
  const before = await findCodeForm(id);
  if (input.revision !== undefined && input.revision !== before.revision) {
    throw new HttpError(409, `${before.updatedByName ?? "Someone"} saved this form after you opened it. Reload to get their changes.`, { revision: before.revision });
  }
  const files = validFiles(input.files);
  if (input.slug && input.slug !== before.slug) await checkSlug(input.slug, before.id);
  const row = await prisma.builtForm.update({
    where: { id: before.id },
    data: {
      title: titleOf(files),
      draftSchema: JSON.stringify({ format: APP_FORMAT, version: 1, files }),
      revision: { increment: 1 },
      updatedByName: actor.name,
      ...(input.slug ? { slug: input.slug } : {}),
    },
  });
  if (input.slug && input.slug !== before.slug) await syncCatalogUrl(row);
  return row;
}

/** Change some files and leave the rest (the MCP server's write/edit tools). null deletes a file. */
export async function patchFiles(id: string, changes: Record<string, string | null>, actor: Actor, revision?: number) {
  const form = await findCodeForm(id);
  const files = { ...draftFiles(form) };
  for (const [path, src] of Object.entries(changes)) {
    if (src === null) delete files[path];
    else files[path] = src;
  }
  return saveProject(form.id, { files, revision }, actor);
}

export async function publishProject(id: string, actor: Actor, note?: string): Promise<BuiltForm> {
  const form = await findCodeForm(id);
  const files = draftFiles(form);
  const res = await buildProject(files);
  if (!res.ok) throw new ProjectError(res.problems, "Fix the build errors before publishing.");
  const version = form.liveVersion + 1;
  const [row] = await prisma.$transaction([
    prisma.builtForm.update({
      where: { id: form.id },
      data: { liveSchema: JSON.stringify({ files, build: res.build }), liveVersion: version, status: form.status === "closed" ? "closed" : "published", publishedAt: new Date(), updatedByName: actor.name },
    }),
    prisma.builtFormVersion.create({ data: { formId: form.id, version, schema: JSON.stringify({ files }), note: note?.slice(0, 300) ?? null, publishedByName: actor.name } }),
  ]);
  await syncCatalogUrl(row);
  await audit({ actor, action: "apps.published", summary: `Published code form “${row.title}” version ${version}${note ? `: ${note}` : ""}` });
  return row;
}

export async function versionFiles(formId: string, version: number): Promise<Files | null> {
  const v = await prisma.builtFormVersion.findUnique({ where: { formId_version: { formId, version } } });
  return v ? (JSON.parse(v.schema) as { files: Files }).files : null;
}

export async function restoreProjectVersion(id: string, version: number, actor: Actor) {
  const form = await findCodeForm(id);
  const files = await versionFiles(form.id, version);
  if (!files) throw notFound(`Version ${version} doesn't exist.`);
  return saveProject(form.id, { files }, actor);
}

export async function duplicateProject(id: string, actor: Actor) {
  const src = await findCodeForm(id);
  const files = { ...draftFiles(src) };
  try {
    const m = JSON.parse(files["form.json"]);
    m.title = `${m.title} (copy)`;
    files["form.json"] = JSON.stringify(m, null, 2);
  } catch {
    /* leave it */
  }
  return createProject({ files }, actor);
}

// ── Import / export ──────────────────────────────────────────────────────

export const APP_BUNDLE = "lcs-app-bundle";

export async function exportProject(id: string, opts: { data?: boolean } = {}) {
  const form = await findCodeForm(id);
  const out: Record<string, unknown> = { format: APP_BUNDLE, version: 1, exportedAt: new Date().toISOString(), slug: form.slug, title: form.title, files: draftFiles(form) };
  if (opts.data) {
    const records = await prisma.formRecord.findMany({ where: { formId: form.id } });
    out.collections = records.map((r) => ({ collection: r.collection, id: r.docId, data: JSON.parse(r.data) }));
    const sites = new Map((await prisma.site.findMany({ select: { id: true, code: true } })).map((s) => [s.id, s.code]));
    const entries = await prisma.formEntry.findMany({ where: { formId: form.id, source: { not: "preview" } }, orderBy: { occurredAt: "asc" } });
    out.entries = entries.map((e) => ({
      data: JSON.parse(e.data), site: e.siteId ? sites.get(e.siteId) ?? null : null, tenantId: e.tenantId, occurredAt: e.occurredAt.toISOString(),
      createdByName: e.createdByName, status: e.status, overrideReason: e.overrideReason, voidReason: e.voidReason, clientId: e.clientId,
    }));
  }
  return out;
}

/** A code form bundle, or a bare { files }. Lands as a new draft; collections (settings, lists) come too, and entries if asked. */
export async function importProject(payload: unknown, actor: Actor, opts: { withEntries?: boolean } = {}) {
  const p = payload as { format?: string; slug?: string; files?: unknown; collections?: { collection: string; id: string; data: unknown }[]; entries?: Record<string, unknown>[] };
  if (!p || typeof p !== "object" || !p.files) throw badRequest("This isn't a code form bundle (it has no files).");
  const files = validFiles(p.files);
  const { manifest, problems } = readManifest(files);
  if (!manifest) throw new ProjectError(problems, "The bundle's form.json has problems.");
  const slug = await uniqueSlug(p.slug && /^[a-z0-9-]+$/.test(p.slug) ? p.slug : manifest.title);
  const row = await createProject({ files, slug }, actor);
  for (const c of p.collections ?? []) {
    await prisma.formRecord.create({ data: { formId: row.id, collection: c.collection, docId: c.id, data: JSON.stringify(c.data ?? null), updatedByName: actor.name } }).catch(() => undefined);
  }
  let entries = 0;
  if (opts.withEntries && p.entries?.length) {
    const sites = new Map((await prisma.site.findMany({ select: { id: true, code: true } })).map((s) => [s.code, s.id]));
    const rows = p.entries.map((e) => ({
      formId: row.id, formVersion: 0, data: JSON.stringify(e.data ?? {}), siteId: typeof e.site === "string" ? sites.get(e.site) ?? null : null,
      tenantId: (e.tenantId as string) ?? null, occurredAt: e.occurredAt ? new Date(String(e.occurredAt)) : new Date(), source: "import",
      createdByName: String(e.createdByName ?? "Imported"), status: e.status === "voided" ? "voided" : "active", overrideReason: (e.overrideReason as string) ?? null,
      voidReason: (e.voidReason as string) ?? null,
    }));
    for (let i = 0; i < rows.length; i += 500) await prisma.formEntry.createMany({ data: rows.slice(i, i + 500) });
    entries = rows.length;
  }
  await audit({ actor, action: "apps.imported", summary: `Imported code form “${row.title}”${entries ? ` with ${entries} entries` : ""}` });
  return { id: row.id, slug: row.slug, title: row.title, entries };
}
