import type { BuiltForm, Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { HttpError, badRequest, notFound } from "../http.js";
import { audit, type Actor } from "../services/audit.js";
import { FORM_ICONS } from "../routes/forms.js";
import { FORMAT, FORMAT_VERSION, emptyForm, type FormDoc } from "./engine.js";
import { parseFormDoc, type DocProblem } from "./schema.js";
import { convertGravityForms, looksLikeGravityForms } from "./gravityImport.js";

/**
 * Built forms: create, save, publish, version, duplicate, import and export.
 * The REST routes (routes/builder.ts), the MCP server (forms/mcp.ts) and the
 * CLI (scripts/forms.ts) all call these, so a form made by an LLM goes through
 * exactly the checks a form made in the builder does.
 */

/** 422 carrying every problem with a document, each with a JSON path. */
export class DocError extends HttpError {
  constructor(public problems: DocProblem[], message = "The form has problems — fix them and save again.") {
    super(422, message, { problems });
  }
}

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Paths under /f/ the app itself uses. */
const RESERVED_SLUGS = new Set(["new", "entries", "edit", "admin", "api", "projects", "import", "guide", "sdk", "sdk.d.ts"]);

export function readDoc(json: string): FormDoc {
  return JSON.parse(json) as FormDoc;
}

export function toSlug(text: string) {
  return text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "form";
}

export async function uniqueSlug(base: string, excludeId?: string): Promise<string> {
  const root = toSlug(base);
  for (let i = 1; i < 500; i++) {
    const slug = i === 1 && !RESERVED_SLUGS.has(root) ? root : `${root}-${i}`;
    const hit = await prisma.builtForm.findUnique({ where: { slug }, select: { id: true } });
    if (!hit || hit.id === excludeId) return slug;
  }
  throw badRequest("Couldn't find a free URL name for this form.");
}

export async function checkSlug(slug: string, excludeId?: string) {
  if (!SLUG_RE.test(slug) || slug.length > 60) throw badRequest("The URL name uses lowercase letters, digits and dashes (max 60).");
  if (RESERVED_SLUGS.has(slug)) throw badRequest(`"${slug}" is reserved. Pick another URL name.`);
  const hit = await prisma.builtForm.findUnique({ where: { slug }, select: { id: true } });
  if (hit && hit.id !== excludeId) throw badRequest(`Another form already uses /f/${slug}.`);
}

export function validDoc(input: unknown): FormDoc {
  const res = parseFormDoc(input);
  if (!res.doc) throw new DocError(res.problems);
  return res.doc;
}

/** A basic (drag-and-drop) form. Code forms are found with apps/runtime findCodeForm. */
export async function findForm(idOrSlug: string): Promise<BuiltForm> {
  const row = await prisma.builtForm.findFirst({ where: { kind: "basic", OR: [{ id: idOrSlug }, { slug: idOrSlug }] } });
  if (!row) throw notFound(`No form "${idOrSlug}".`);
  return row;
}

/** Either kind — for what both share (status, catalog, versions, delete). */
export async function findAnyForm(idOrSlug: string): Promise<BuiltForm> {
  const row = await prisma.builtForm.findFirst({ where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] } });
  if (!row) throw notFound(`No form "${idOrSlug}".`);
  return row;
}

/** What a list of forms shows. */
export async function listForms(opts: { includeArchived?: boolean } = {}) {
  const rows = await prisma.builtForm.findMany({
    where: { kind: "basic", ...(opts.includeArchived ? {} : { status: { not: "archived" } }) },
    orderBy: { updatedAt: "desc" },
  });
  const counts = await prisma.formEntry.groupBy({ by: ["formId"], where: { status: "active" }, _count: { _all: true }, _max: { createdAt: true } });
  const byForm = new Map(counts.map((c) => [c.formId, c]));
  return rows.map((r) => {
    const draft = readDoc(r.draftSchema);
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      status: r.status,
      liveVersion: r.liveVersion,
      revision: r.revision,
      /** The draft differs from what's live. */
      unpublishedChanges: r.liveSchema !== null && r.liveSchema !== r.draftSchema,
      fieldCount: draft.fields.length,
      access: draft.settings.access?.mode ?? "signed_in",
      icon: draft.settings.icon ?? null,
      entryCount: byForm.get(r.id)?._count._all ?? 0,
      lastEntryAt: byForm.get(r.id)?._max.createdAt ?? null,
      catalogLinkId: r.catalogLinkId,
      createdByName: r.createdByName,
      updatedByName: r.updatedByName,
      publishedAt: r.publishedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
}

export function formDetail(r: BuiltForm) {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    status: r.status,
    revision: r.revision,
    liveVersion: r.liveVersion,
    unpublishedChanges: r.liveSchema !== null && r.liveSchema !== r.draftSchema,
    draft: readDoc(r.draftSchema),
    live: r.liveSchema ? readDoc(r.liveSchema) : null,
    catalogLinkId: r.catalogLinkId,
    createdByName: r.createdByName,
    updatedByName: r.updatedByName,
    publishedAt: r.publishedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function createForm(input: { doc?: unknown; title?: string; slug?: string }, actor: Actor): Promise<BuiltForm> {
  const doc = input.doc === undefined ? emptyForm(input.title?.trim() || "Untitled form") : validDoc(input.doc);
  if (input.slug) await checkSlug(input.slug);
  const slug = input.slug ?? (await uniqueSlug(doc.title));
  const row = await prisma.builtForm.create({
    data: {
      slug,
      title: doc.title,
      draftSchema: JSON.stringify(doc),
      createdById: actor.id,
      createdByName: actor.name,
      updatedByName: actor.name,
    },
  });
  await audit({ actor, action: "builder.created", summary: `Created form “${row.title}” (/f/${row.slug})` });
  return row;
}

/**
 * Save the working copy. `revision` is the one the caller loaded: if someone
 * saved in between, this refuses rather than overwrite their work. Omit it to
 * overwrite regardless (the CLI's --force).
 */
export async function saveDraft(id: string, input: { doc: unknown; revision?: number; slug?: string }, actor: Actor): Promise<BuiltForm> {
  const before = await findForm(id);
  if (input.revision !== undefined && input.revision !== before.revision) {
    throw new HttpError(409, `${before.updatedByName ?? "Someone"} saved this form after you opened it. Reload to see their changes.`, { revision: before.revision });
  }
  const doc = validDoc(input.doc);
  if (input.slug && input.slug !== before.slug) await checkSlug(input.slug, before.id);
  const row = await prisma.builtForm.update({
    where: { id: before.id },
    data: {
      title: doc.title,
      draftSchema: JSON.stringify(doc),
      revision: { increment: 1 },
      updatedByName: actor.name,
      ...(input.slug ? { slug: input.slug } : {}),
    },
  });
  if (input.slug && input.slug !== before.slug) await syncCatalogUrl(row);
  return row;
}

/** Make the draft live, as a new numbered version. */
export async function publishForm(id: string, actor: Actor, note?: string): Promise<BuiltForm> {
  const before = await findForm(id);
  const doc = validDoc(readDoc(before.draftSchema));
  const version = before.liveVersion + 1;
  const json = JSON.stringify(doc);
  const [row] = await prisma.$transaction([
    prisma.builtForm.update({
      where: { id: before.id },
      data: { liveSchema: json, liveVersion: version, status: before.status === "closed" ? "closed" : "published", publishedAt: new Date(), updatedByName: actor.name },
    }),
    prisma.builtFormVersion.create({ data: { formId: before.id, version, schema: json, note: note?.slice(0, 300) ?? null, publishedByName: actor.name } }),
  ]);
  await syncCatalogUrl(row);
  await audit({ actor, action: "builder.published", summary: `Published “${row.title}” version ${version}${note ? `: ${note}` : ""}` });
  return row;
}

/** published ⇄ closed (stops taking entries), or archive / unarchive. */
export async function setFormStatus(id: string, status: "published" | "closed" | "archived" | "draft", actor: Actor): Promise<BuiltForm> {
  const before = await findAnyForm(id);
  if ((status === "published" || status === "closed") && !before.liveSchema) throw badRequest("Publish the form first.");
  // Unarchiving lands on whatever it was before archiving would have been: live if it has a live version.
  const next = status === "draft" && before.liveSchema ? "published" : status;
  const row = await prisma.builtForm.update({ where: { id: before.id }, data: { status: next, updatedByName: actor.name } });
  if (before.catalogLinkId) {
    await prisma.formLink.updateMany({ where: { id: before.catalogLinkId }, data: { active: next === "published" || next === "closed" } });
  }
  await audit({ actor, action: "builder.status", summary: `Form “${row.title}” is now ${next}` });
  return row;
}

export async function duplicateForm(id: string, actor: Actor): Promise<BuiltForm> {
  const src = await findForm(id);
  const doc = readDoc(src.draftSchema);
  doc.title = `${doc.title} (copy)`;
  return createForm({ doc }, actor);
}

/** Delete outright — only a form nobody has filled in. Otherwise archive it. */
export async function deleteForm(id: string, actor: Actor): Promise<void> {
  const form = await findAnyForm(id);
  const n = await prisma.formEntry.count({ where: { formId: form.id } });
  if (n > 0) throw badRequest(`This form has ${n} entr${n === 1 ? "y" : "ies"}. Archive it instead, so they're kept.`);
  if (form.catalogLinkId) await prisma.formLink.deleteMany({ where: { id: form.catalogLinkId } });
  await prisma.formFile.deleteMany({ where: { formId: form.id } });
  await prisma.builtForm.delete({ where: { id: form.id } });
  await audit({ actor, action: "builder.deleted", summary: `Deleted form “${form.title}” (/f/${form.slug})` });
}

export async function listVersions(id: string) {
  const form = await findAnyForm(id);
  return prisma.builtFormVersion.findMany({
    where: { formId: form.id },
    orderBy: { version: "desc" },
    select: { version: true, note: true, publishedByName: true, createdAt: true },
  });
}

export async function versionDoc(formId: string, version: number): Promise<FormDoc | null> {
  const v = await prisma.builtFormVersion.findUnique({ where: { formId_version: { formId, version } } });
  return v ? readDoc(v.schema) : null;
}

/** Copy an old version into the draft (not live until published). */
export async function restoreVersion(id: string, version: number, actor: Actor): Promise<BuiltForm> {
  const form = await findForm(id);
  const doc = await versionDoc(form.id, version);
  if (!doc) throw notFound(`Version ${version} doesn't exist.`);
  const row = await saveDraft(form.id, { doc }, actor);
  await audit({ actor, action: "builder.restored", summary: `Restored version ${version} of “${row.title}” into the draft` });
  return row;
}

// ── Forms catalog ────────────────────────────────────────────────────────

/** Where a form opens, what icon its card wears, and which roles see it. */
export function catalogMeta(row: BuiltForm): { url: string; icon: string | null; roles: string | null; description: string | null } {
  const known = (i: unknown) => (typeof i === "string" && (FORM_ICONS as readonly string[]).includes(i) ? i : null);
  if (row.kind === "code") {
    const files = (JSON.parse(row.liveSchema ?? row.draftSchema) as { files: Record<string, string> }).files;
    let m: { icon?: string; access?: { roles?: string[] }; description?: string } = {};
    try {
      m = JSON.parse(files["form.json"] ?? "{}");
    } catch {
      /* an unparseable manifest can't be published anyway */
    }
    const roles = m.access?.roles?.filter((r) => r !== "*");
    return { url: `/apps/${row.slug}`, icon: known(m.icon), roles: roles?.length ? roles.join(",") : null, description: m.description?.slice(0, 300) ?? null };
  }
  const doc = readDoc(row.liveSchema ?? row.draftSchema);
  const mode = doc.settings.access?.mode;
  return {
    url: `/${mode === "public" ? "p" : "f"}/${row.slug}`,
    icon: known(doc.settings.icon),
    roles: mode === "roles" && doc.settings.access?.roles?.length ? doc.settings.access.roles.join(",") : null,
    description: doc.description?.replace(/<[^>]+>/g, "").slice(0, 300) || null,
  };
}

export async function syncCatalogUrl(row: BuiltForm) {
  if (!row.catalogLinkId) return;
  const meta = catalogMeta(row);
  await prisma.formLink.updateMany({
    where: { id: row.catalogLinkId },
    data: { url: meta.url, title: row.title, roles: meta.roles, ...(meta.icon ? { icon: meta.icon } : {}) },
  });
}

/**
 * Put the form on the Forms screen (and sidebar) in a category, or take it off
 * (categoryId null). Visibility by role follows the form's access setting.
 */
export async function setCatalog(id: string, categoryId: string | null, actor: Actor) {
  const form = await findAnyForm(id);
  if (!categoryId) {
    if (form.catalogLinkId) await prisma.formLink.deleteMany({ where: { id: form.catalogLinkId } });
    await prisma.builtForm.update({ where: { id: form.id }, data: { catalogLinkId: null } });
    await audit({ actor, action: "builder.catalog", summary: `Took “${form.title}” off the Forms catalog` });
    return null;
  }
  const cat = await prisma.formCategory.findUnique({ where: { id: categoryId } });
  if (!cat) throw badRequest("Pick a category.");
  const meta = catalogMeta(form);
  const active = form.status === "published" || form.status === "closed";
  const existing = form.catalogLinkId ? await prisma.formLink.findUnique({ where: { id: form.catalogLinkId } }) : null;
  let linkId: string;
  if (existing) {
    const moving = existing.categoryId !== categoryId;
    const last = moving ? await prisma.formLink.aggregate({ where: { categoryId }, _max: { sortOrder: true } }) : null;
    await prisma.formLink.update({
      where: { id: existing.id },
      data: { categoryId, url: meta.url, title: form.title, roles: meta.roles, icon: meta.icon, active, ...(last ? { sortOrder: (last._max.sortOrder ?? -1) + 1 } : {}) },
    });
    linkId = existing.id;
  } else {
    const last = await prisma.formLink.aggregate({ where: { categoryId }, _max: { sortOrder: true } });
    const link = await prisma.formLink.create({
      data: { categoryId, title: form.title, description: meta.description, url: meta.url, roles: meta.roles, icon: meta.icon, active, sortOrder: (last._max.sortOrder ?? -1) + 1 },
    });
    linkId = link.id;
  }
  await prisma.builtForm.update({ where: { id: form.id }, data: { catalogLinkId: linkId } });
  await audit({ actor, action: "builder.catalog", summary: `Listed “${form.title}” under “${cat.name}” on the Forms catalog` });
  return linkId;
}

// ── Import / export ──────────────────────────────────────────────────────

export const BUNDLE_FORMAT = "lcs-form-bundle";

export interface ExportedForm {
  slug: string;
  status: string;
  form: FormDoc;
  entries?: { id: string; createdAt: string; createdByName: string; source: string; status: string; site: string | null; values: Record<string, unknown> }[];
}

/** A bundle of forms (and optionally their entries), as one JSON file. */
export async function exportForms(ids: string[], opts: { entries?: boolean; live?: boolean } = {}) {
  const forms = await prisma.builtForm.findMany({ where: { id: { in: ids } }, orderBy: { title: "asc" } });
  const out: ExportedForm[] = [];
  for (const f of forms) {
    const item: ExportedForm = { slug: f.slug, status: f.status, form: readDoc(opts.live && f.liveSchema ? f.liveSchema : f.draftSchema) };
    if (opts.entries) {
      const rows = await prisma.formEntry.findMany({ where: { formId: f.id }, orderBy: { createdAt: "asc" } });
      const sites = await prisma.site.findMany({ select: { id: true, code: true } });
      const code = new Map(sites.map((s) => [s.id, s.code]));
      item.entries = rows.map((e) => ({
        id: e.id,
        createdAt: e.createdAt.toISOString(),
        createdByName: e.createdByName,
        source: e.source,
        status: e.status,
        site: e.siteId ? code.get(e.siteId) ?? null : null,
        values: JSON.parse(e.data),
      }));
    }
    out.push(item);
  }
  return { format: BUNDLE_FORMAT, version: 1, exportedAt: new Date().toISOString(), forms: out };
}

export interface ImportResult {
  created: { id: string; slug: string; title: string; entries: number }[];
  warnings: string[];
  /** Forms that couldn't be imported, with why. */
  failed: { title: string; problems: DocProblem[] }[];
}

/**
 * Import anything we know how to read:
 *   - one lcs-form document                     { format: "lcs-form", … }
 *   - an lcs-form bundle                        { format: "lcs-form-bundle", forms: [...] }
 *   - a Gravity Forms export (Forms → Import/Export → Export Forms), or one GF form object
 * Every form lands as a new draft; nothing existing is overwritten. Entries in
 * a bundle come along when `withEntries` is set.
 */
export async function importPayload(payload: unknown, actor: Actor, opts: { withEntries?: boolean; publish?: boolean } = {}): Promise<ImportResult> {
  const result: ImportResult = { created: [], warnings: [], failed: [] };
  let items: { slug?: string; form: unknown; entries?: ExportedForm["entries"] }[] = [];

  if (looksLikeGravityForms(payload)) {
    const converted = convertGravityForms(payload);
    result.warnings.push(...converted.warnings);
    items = converted.forms.map((form) => ({ form }));
  } else if (payload && typeof payload === "object" && (payload as { format?: string }).format === BUNDLE_FORMAT) {
    const forms = (payload as { forms?: unknown }).forms;
    if (!Array.isArray(forms)) throw badRequest("This bundle has no forms list.");
    items = forms.map((f) => (f && typeof f === "object" && "form" in f ? (f as { slug?: string; form: unknown; entries?: ExportedForm["entries"] }) : { form: f }));
  } else if (payload && typeof payload === "object" && (payload as { format?: string }).format === FORMAT) {
    items = [{ form: payload }];
  } else if (Array.isArray(payload)) {
    items = payload.map((form) => ({ form }));
  } else {
    throw badRequest("This file isn't a Lantern form, a Lantern form bundle, or a Gravity Forms export.");
  }

  for (const item of items) {
    const title = (item.form as { title?: string })?.title ?? "Untitled";
    const parsed = parseFormDoc(item.form);
    if (!parsed.doc) {
      result.failed.push({ title, problems: parsed.problems });
      continue;
    }
    const wanted = item.slug && SLUG_RE.test(item.slug) ? item.slug : parsed.doc.title;
    const slug = await uniqueSlug(wanted);
    let row = await createForm({ doc: parsed.doc, slug }, actor);
    if (opts.publish) row = await publishForm(row.id, actor, "Imported");
    let entryCount = 0;
    if (opts.withEntries && item.entries?.length) {
      const sites = await prisma.site.findMany({ select: { id: true, code: true } });
      const byCode = new Map(sites.map((s) => [s.code, s.id]));
      const data: Prisma.FormEntryCreateManyInput[] = item.entries.map((e) => ({
        formId: row.id,
        formVersion: row.liveVersion,
        data: JSON.stringify(e.values ?? {}),
        siteId: e.site ? byCode.get(e.site) ?? null : null,
        source: "import",
        status: e.status === "voided" ? "voided" : "active",
        createdByName: e.createdByName || "Imported",
        createdAt: e.createdAt ? new Date(e.createdAt) : new Date(),
      }));
      for (let i = 0; i < data.length; i += 500) await prisma.formEntry.createMany({ data: data.slice(i, i + 500) });
      entryCount = data.length;
    }
    result.created.push({ id: row.id, slug: row.slug, title: row.title, entries: entryCount });
  }
  await audit({
    actor,
    action: "builder.imported",
    summary: `Imported ${result.created.length} form${result.created.length === 1 ? "" : "s"}${result.failed.length ? ` (${result.failed.length} failed)` : ""}`,
    changes: { created: result.created.map((c) => c.slug) },
  });
  return result;
}

export { FORMAT, FORMAT_VERSION };

// ── Catalog cards made from Admin → Forms catalog ────────────────────────

/** The built form a catalog URL points at (/f/x, /p/x or /apps/x), if any. */
export function builtSlugOf(url: string): string | null {
  return /^\/(?:f|p|apps)\/([a-z0-9-]+)\/?$/.exec(url)?.[1] ?? null;
}

/** Every built form (both kinds) as the catalog editor offers them. */
export async function builtFormsForCatalog() {
  const rows = await prisma.builtForm.findMany({ where: { status: { not: "archived" } }, orderBy: { title: "asc" } });
  return rows.map((r) => {
    const meta = catalogMeta(r);
    return { id: r.id, kind: r.kind, slug: r.slug, title: r.title, status: r.status, live: r.liveSchema !== null, catalogLinkId: r.catalogLinkId, ...meta, roles: meta.roles ? meta.roles.split(",") : [] };
  });
}

/**
 * A catalog card was saved pointing at a built form: tie them together, so the
 * card follows the form (a new URL name, its title on publish, archiving) the
 * same way as a card added from the form's own editor. A form keeps its first
 * card; a second card to the same form is left as an ordinary link.
 */
export async function linkCatalogCard(linkId: string, url: string) {
  const slug = builtSlugOf(url);
  await prisma.builtForm.updateMany({ where: { catalogLinkId: linkId, ...(slug ? { slug: { not: slug } } : {}) }, data: { catalogLinkId: null } });
  if (!slug) return;
  const form = await prisma.builtForm.findUnique({ where: { slug } });
  if (!form) return;
  const current = form.catalogLinkId ? await prisma.formLink.findUnique({ where: { id: form.catalogLinkId }, select: { id: true } }) : null;
  if (!current) await prisma.builtForm.update({ where: { id: form.id }, data: { catalogLinkId: linkId } });
}

export async function unlinkCatalogCard(linkId: string) {
  await prisma.builtForm.updateMany({ where: { catalogLinkId: linkId }, data: { catalogLinkId: null } });
}
