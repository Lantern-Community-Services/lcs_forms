import { z } from "zod";
import { prisma } from "../prisma.js";
import { fileBytes } from "../services/fileStore.js";
import { appBaseUrl } from "../env.js";
import { HttpError } from "../http.js";
import type { Actor } from "../services/audit.js";
import type { ResolvedKey } from "../services/apiKeys.js";
import { McpContent, type ToolRegistrar } from "../forms/mcp.js";
import { APP_GUIDE } from "./guide.js";
import { DESIGN_BRIEF } from "./designBrief.js";
import { buildProject } from "./compile.js";
import { createEntry, entryOut, findCodeForm, loadApp, runAction } from "./runtime.js";
import { createProject, draftFiles, listProjects, patchFiles, publishProject } from "./service.js";

/**
 * MCP tools for code forms. An assistant works on one the way it would on a
 * repository: list, read, write and edit files, build (with file:line errors),
 * try server actions and test entries against the draft, then publish.
 * Needs the apps:build scope; reading entries needs entries:read.
 */
export function registerCodeTools(tool: ToolRegistrar, need: (scope: string) => void, actor: Actor, key: ResolvedKey) {
  const ref = z.string().describe("The code form's id or slug.");
  const where = (row: { id: string; slug: string }) => ({ url: `${appBaseUrl}/apps/${row.slug}`, editorUrl: `${appBaseUrl}/admin/apps/${row.id}` });

  async function buildReport(id: string) {
    const form = await findCodeForm(id);
    const res = await buildProject(draftFiles(form));
    return res.ok
      ? { builds: true, warnings: res.build.warnings, pages: Object.keys(res.build.pages), server: Boolean(res.build.server) }
      : { builds: false, problems: res.problems.map((p) => `${p.file}${p.line ? `:${p.line}:${(p.column ?? 0) + 1}` : ""}: ${p.message}`) };
  }

  tool("get_code_reference", "The full guide to code forms: project layout, form.json, how entries/collections/actions/offline work, patterns, and the complete SDK type definitions (@lcs/sdk, @lcs/ui, @lcs/charts, @lcs/server). Read before writing a code form.", {}, async () => APP_GUIDE(), { readOnlyHint: true });

  tool(
    "get_design_kit",
    "The Lantern design system for design work: who the screens are for, every component and chart, the Tailwind token names (light and dark), layout rules for iPad/phone/desktop, and how a design should be handed back. Use it to turn a Claude Design handoff into code-form pages that match the app exactly.",
    {},
    async () => DESIGN_BRIEF(),
    { readOnlyHint: true }
  );

  tool("list_code_forms", "Every code form with its status and entry count.", { includeArchived: z.boolean().optional() }, async ({ includeArchived }) => {
    need("apps:build");
    return (await listProjects({ includeArchived })).map((p) => ({ ...p, ...where(p) }));
  }, { readOnlyHint: true });

  tool(
    "create_code_form",
    "Create a code form. Pass files for a whole project ({ path: source }, must include form.json), or just a title for the starter project (a record page, an entries page, a server rule).",
    { title: z.string().optional(), files: z.record(z.string()).optional(), slug: z.string().optional() },
    async ({ title, files, slug }) => {
      need("apps:build");
      const row = await createProject({ title, files, slug }, actor);
      return { id: row.id, slug: row.slug, title: row.title, revision: row.revision, ...where(row), build: await buildReport(row.id) };
    }
  );

  tool("list_files", "The draft's files with sizes, plus its revision.", { form: ref }, async ({ form }) => {
    need("apps:build");
    const row = await findCodeForm(form);
    const files = draftFiles(row);
    return { id: row.id, slug: row.slug, revision: row.revision, status: row.status, liveVersion: row.liveVersion, files: Object.fromEntries(Object.entries(files).map(([p, s]) => [p, `${s.split("\n").length} lines`])) };
  }, { readOnlyHint: true });

  tool("read_files", "Read draft files (all of them when paths is omitted).", { form: ref, paths: z.array(z.string()).optional() }, async ({ form, paths }) => {
    need("apps:build");
    const files = draftFiles(await findCodeForm(form));
    const pick = paths?.length ? paths : Object.keys(files);
    const missing = pick.filter((p) => files[p] === undefined);
    if (missing.length) throw new HttpError(404, `No such file: ${missing.join(", ")}. Files: ${Object.keys(files).join(", ")}`);
    return Object.fromEntries(pick.map((p) => [p, files[p]]));
  }, { readOnlyHint: true });

  tool(
    "write_files",
    "Create, replace or delete draft files in one save (null deletes). Returns the build result, so you see compile errors straight away.",
    { form: ref, files: z.record(z.string().nullable()), revision: z.number().int().optional().describe("The revision you read, to avoid overwriting someone else's save") },
    async ({ form, files, revision }) => {
      need("apps:build");
      const row = await patchFiles((await findCodeForm(form)).id, files, actor, revision);
      return { revision: row.revision, build: await buildReport(row.id) };
    }
  );

  tool(
    "edit_file",
    "Replace an exact piece of text in one draft file (like a code editor's find/replace). old_text must appear exactly once unless replace_all is true.",
    { form: ref, path: z.string(), old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().optional() },
    async ({ form, path, old_text, new_text, replace_all }) => {
      need("apps:build");
      const row = await findCodeForm(form);
      const src = draftFiles(row)[path];
      if (src === undefined) throw new HttpError(404, `No file ${path}.`);
      const count = src.split(old_text).length - 1;
      if (count === 0) throw new HttpError(400, `old_text wasn't found in ${path}. Read the file again — it may have changed.`);
      if (count > 1 && !replace_all) throw new HttpError(400, `old_text appears ${count} times in ${path}; add more context or set replace_all.`);
      const next = replace_all ? src.split(old_text).join(new_text) : src.replace(old_text, () => new_text);
      const saved = await patchFiles(row.id, { [path]: next }, actor);
      return { revision: saved.revision, replaced: replace_all ? count : 1, build: await buildReport(saved.id) };
    }
  );

  tool("build_code_form", "Compile the draft and report errors with file:line.", { form: ref }, async ({ form }) => {
    need("apps:build");
    return buildReport((await findCodeForm(form)).id);
  }, { readOnlyHint: true });

  tool(
    "run_action",
    "Run one of the draft's server actions (server/index.ts actions) as this API key — to test server code. Returns the value and anything it logged.",
    { form: ref, name: z.string(), args: z.unknown().optional() },
    async ({ form, name, args }) => {
      need("apps:build");
      const app = await loadApp(await findCodeForm(form), true);
      const r = await runAction(app, null, name, args);
      return r.ok ? { value: r.value, logs: r.logs } : { error: r.error, stack: r.stack, logs: r.logs };
    }
  );

  tool(
    "test_entry",
    "Submit a test entry to the DRAFT, through its beforeCreate rules, as this API key. Saved as a 'preview' entry (hidden from the live form). Shows whether it saves, is refused, or needs an override.",
    { form: ref, data: z.record(z.unknown()), site: z.string().optional(), tenantId: z.string().optional(), override: z.string().optional() },
    async ({ form, data, site, tenantId, override }) => {
      need("apps:build");
      const app = await loadApp(await findCodeForm(form), true);
      return createEntry(app, null, { data, site, tenantId, override }, { actorName: actor.name, machineSiteId: key.siteId });
    }
  );

  tool("publish_code_form", "Build and publish the draft as a new live version.", { form: ref, note: z.string().optional() }, async ({ form, note }) => {
    need("apps:build");
    const row = await publishProject((await findCodeForm(form)).id, actor, note);
    return { id: row.id, slug: row.slug, status: row.status, liveVersion: row.liveVersion, ...where(row) };
  });

  tool(
    "list_code_entries",
    "A code form's entries (live ones, newest first).",
    { form: ref, from: z.string().optional().describe("ISO time"), limit: z.number().int().min(1).max(500).optional(), includePreview: z.boolean().optional() },
    async ({ form, from, limit, includePreview }) => {
      need("entries:read");
      const row = await findCodeForm(form);
      const rows = await prisma.formEntry.findMany({
        where: { formId: row.id, ...(includePreview ? {} : { source: { not: "preview" } }), ...(from ? { occurredAt: { gte: new Date(from) } } : {}), ...(key.siteId ? { siteId: key.siteId } : {}) },
        orderBy: { occurredAt: "desc" },
        take: limit ?? 50,
      });
      const sites = new Map((await prisma.site.findMany({ select: { id: true, code: true, name: true } })).map((s) => [s.id, s]));
      return rows.map((e) => entryOut(e, sites));
    },
    { readOnlyHint: true }
  );

  tool(
    "get_entry_file",
    "A photo or file attached to a code form's entry (a { fileId } in its data). Images come back as images; other files as their name, type and size, plus base64 when asked.",
    { form: ref, fileId: z.string(), base64: z.boolean().optional() },
    async ({ form, fileId, base64 }) => {
      need("entries:read");
      const row = await findCodeForm(form);
      const file = await prisma.formFile.findFirst({ where: { id: fileId, formId: row.id }, include: { entry: { select: { siteId: true } } } });
      if (!file || !file.entryId) throw new HttpError(404, "No such file on a saved entry of this form.");
      if (key.siteId && file.entry?.siteId !== key.siteId) throw new HttpError(403, "That entry is for another site.");
      const info = { fileId: file.id, name: file.name, mime: file.mime, size: file.size, entryId: file.entryId };
      if (/^image\/(png|jpe?g|gif|webp)$/.test(file.mime) && file.size <= 5 * 1024 * 1024) {
        return new McpContent([
          { type: "text", text: JSON.stringify(info) },
          { type: "image", data: (await fileBytes(file)).toString("base64"), mimeType: file.mime },
        ]);
      }
      return base64 ? { ...info, base64: (await fileBytes(file)).toString("base64") } : info;
    },
    { readOnlyHint: true }
  );

  tool("read_collection", "Read one of a code form's collections (its settings, lists).", { form: ref, name: z.string() }, async ({ form, name }) => {
    need("apps:build");
    const row = await findCodeForm(form);
    const docs = await prisma.formRecord.findMany({ where: { formId: row.id, collection: name }, orderBy: { createdAt: "asc" } });
    return docs.map((d) => ({ id: d.docId, data: JSON.parse(d.data) }));
  }, { readOnlyHint: true });

  tool(
    "write_collection_doc",
    "Create or replace a document in a code form's collection (e.g. seed a settings or options list). null data deletes it.",
    { form: ref, name: z.string(), id: z.string(), data: z.unknown() },
    async ({ form, name, id, data }) => {
      need("apps:build");
      const row = await findCodeForm(form);
      if (data === null) {
        await prisma.formRecord.deleteMany({ where: { formId: row.id, collection: name, docId: id } });
        return { deleted: true };
      }
      const json = JSON.stringify(data);
      await prisma.formRecord.upsert({
        where: { formId_collection_docId: { formId: row.id, collection: name, docId: id } },
        create: { formId: row.id, collection: name, docId: id, data: json, updatedByName: actor.name },
        update: { data: json, updatedByName: actor.name },
      });
      return { id, saved: true };
    }
  );
}
