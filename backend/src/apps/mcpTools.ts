import { z } from "zod";
import { prisma } from "../prisma.js";
import { fileBytes } from "../services/fileStore.js";
import { appBaseUrl } from "../env.js";
import { HttpError } from "../http.js";
import { audit, type Actor } from "../services/audit.js";
import { permissionsFor, roleFor } from "../services/permissions.js";
import type { ResolvedKey } from "../services/apiKeys.js";
import { McpContent, type ToolRegistrar } from "../forms/mcp.js";
import { APP_GUIDE } from "./guide.js";
import { DESIGN_BRIEF } from "./designBrief.js";
import { buildProject } from "./compile.js";
import { createEntry, entryOut, findCodeForm, loadApp, runAction } from "./runtime.js";
import { createProject, draftFiles, duplicateProject, exportProject, importProject, listProjects, patchFiles, publishProject, restoreProjectVersion, versionFiles } from "./service.js";
import { componentVersionFiles, deleteComponent, getComponent, listComponents, saveComponent } from "./components.js";

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

  // ── The component library ──

  tool(
    "list_components",
    "The shared component library: UI pieces and helpers any code form imports as @lcs/components/<name> (on top of @lcs/ui). CALL THIS BEFORE WRITING A CODE FORM'S UI, and reuse what fits instead of writing your own; get_component shows one's code and props. Each lists what it is, its exports (api), its version and which forms use it. search and category narrow it.",
    { search: z.string().optional(), category: z.string().optional() },
    async ({ search, category }) => {
      need("apps:build");
      return listComponents({ search, category });
    },
    { readOnlyHint: true }
  );

  tool(
    "get_component",
    "One library component: its description, exports and props (api), an example (usage), its files, the forms that use it and its versions. Import it in a code form with: import { … } from \"@lcs/components/<name>\". version: an older version's files instead.",
    { name: z.string(), version: z.number().int().min(1).optional() },
    async ({ name, version }) => {
      need("apps:build");
      return version ? { name, version, files: await componentVersionFiles(name, version) } : getComponent(name);
    },
    { readOnlyHint: true }
  );

  tool(
    "save_component",
    "Add a component to the library, or save a new version. Save here anything a second form could use (a picker, a card, a row, a formatting helper) rather than keeping it in one form, and generalise it first (props, not one form's types). files: { path: source } with index.tsx (or index.ts) as what the import gives; it may import react, @lcs/ui, @lcs/sdk, @lcs/charts, lucide-react, other components and its own files. It must build. A new one needs title, description (what it is, when to use it), category (Inputs, Display, Layout, Lists, Helpers…), and should have api (each export and its props) and usage (a short example). Leave out files to change only the words. Drafts of forms that use it build with the new version at once (their build results come back here); published forms keep theirs until republished.",
    {
      name: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      category: z.string().optional(),
      files: z.record(z.string()).optional(),
      api: z.string().nullable().optional(),
      usage: z.string().nullable().optional(),
      note: z.string().optional().describe("What changed, kept with the version"),
    },
    async (input) => {
      need("apps:build");
      const saved = await saveComponent(input, actor);
      // The drafts that use it build with this version now: say whether they still do.
      const users = (await getComponent(saved.name)).usedBy;
      const forms = await Promise.all(users.map(async (u) => ({ form: u.slug, build: await buildReport(u.slug) })));
      return { ...saved, forms };
    }
  );

  tool(
    "delete_component",
    "Remove a component from the library. Refused while any code form imports it. Needs confirm: true.",
    { name: z.string(), confirm: z.boolean().optional() },
    async ({ name, confirm }) => {
      need("apps:build");
      if (confirm !== true) throw new HttpError(400, "Pass confirm: true to remove the component.");
      return deleteComponent(name, actor);
    },
    { destructiveHint: true }
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
    "import_code_entries",
    "Migrate entries from an old system (e.g. a Gravity Forms export) into a code form's live entries, saved exactly as given: the form's beforeCreate/afterCreate don't run, so nobody is notified and nothing is routed. Shape `data` the way the form's own server code saves it. Each entry needs an externalId (e.g. \"gf20:36541\"); one already imported into this form is skipped, so a batch can be sent again safely. Up to 500 a call, all or nothing: any problem and none are saved. dryRun checks without saving. The key's creator must be an Admin. Pass confirm: true to save.",
    {
      form: ref,
      entries: z
        .array(
          z.object({
            externalId: z.string().min(1).max(200),
            data: z.record(z.unknown()),
            site: z.string().optional().describe("Site code"),
            tenantId: z.string().optional().describe("Roster id of the resident it's about"),
            occurredAt: z.string().optional().describe("ISO time it happened"),
            createdByName: z.string().max(255).optional().describe("Who filed it in the old system"),
          })
        )
        .min(1)
        .max(500),
      dryRun: z.boolean().optional(),
      confirm: z.boolean().optional(),
    },
    async ({ form, entries, dryRun, confirm }) => {
      need("entries:manage");
      const creator = key.createdById ? await prisma.user.findUnique({ where: { id: key.createdById } }) : null;
      if (!creator || !permissionsFor(roleFor(creator.roleKey), creator).includes("forms.manage")) throw new HttpError(403, "Only an Admin's key can import entries.");
      if (!dryRun && confirm !== true) throw new HttpError(400, "This saves entries to the live form without running its rules. Pass confirm: true (or dryRun: true to check first).");
      const row = await findCodeForm(form);

      const problems: { externalId: string; problem: string }[] = [];
      const seen = new Set<string>();
      for (const e of entries) {
        if (seen.has(e.externalId)) problems.push({ externalId: e.externalId, problem: "Sent twice in this batch." });
        seen.add(e.externalId);
        if (e.occurredAt && Number.isNaN(Date.parse(e.occurredAt))) problems.push({ externalId: e.externalId, problem: `occurredAt "${e.occurredAt}" isn't a date.` });
        if (JSON.stringify(e.data).length > 200_000) problems.push({ externalId: e.externalId, problem: "data is over 200 KB." });
      }
      const codes = [...new Set(entries.map((e) => e.site).filter((s): s is string => Boolean(s)))];
      const sites = new Map((await prisma.site.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } })).map((s) => [s.code, s.id]));
      const tenantIds = [...new Set(entries.map((e) => e.tenantId).filter((t): t is string => Boolean(t)))];
      const tenants = new Map((await prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, siteId: true } })).map((t) => [t.id, t.siteId]));
      for (const e of entries) {
        if (e.site && !sites.has(e.site)) problems.push({ externalId: e.externalId, problem: `No site with code "${e.site}".` });
        if (e.tenantId && !tenants.has(e.tenantId)) problems.push({ externalId: e.externalId, problem: `No resident with id "${e.tenantId}".` });
      }

      const clientIdOf = (externalId: string) => `import:${externalId}`;
      const existing = new Set(
        (await prisma.formEntry.findMany({ where: { formId: row.id, clientId: { in: entries.map((e) => clientIdOf(e.externalId)) } }, select: { clientId: true } })).map((x) => x.clientId)
      );
      const fresh = entries.filter((e) => !existing.has(clientIdOf(e.externalId)));
      const skipped = entries.filter((e) => existing.has(clientIdOf(e.externalId))).map((e) => e.externalId);
      if (problems.length || dryRun) return { saved: 0, wouldSave: problems.length ? 0 : fresh.length, skipped, problems, dryRun: Boolean(dryRun) };

      await prisma.formEntry.createMany({
        data: fresh.map((e) => ({
          formId: row.id,
          formVersion: row.liveVersion,
          data: JSON.stringify(e.data),
          siteId: e.site ? sites.get(e.site)! : null,
          tenantId: e.tenantId ?? null,
          occurredAt: e.occurredAt ? new Date(e.occurredAt) : new Date(),
          source: "import",
          clientId: clientIdOf(e.externalId),
          createdByName: e.createdByName?.trim() || "Imported",
        })),
      });
      if (fresh.length) await audit({ actor, action: "apps.entriesImported", summary: `Imported ${fresh.length} entries into “${row.title}”`, changes: { form: row.slug, count: fresh.length, skipped: skipped.length } });
      return { saved: fresh.length, skipped, problems: [] };
    },
    { destructiveHint: true }
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

  tool("duplicate_code_form", "Copy a code form's draft into a new code form (title gets \"(copy)\").", { form: ref }, async ({ form }) => {
    need("apps:build");
    const row = await duplicateProject((await findCodeForm(form)).id, actor);
    return { id: row.id, slug: row.slug, title: row.title, ...where(row) };
  });

  tool("get_code_version", "The files of one published version of a code form (list_versions shows them).", { form: ref, version: z.number().int().min(1) }, async ({ form, version }) => {
    need("apps:build");
    const files = await versionFiles((await findCodeForm(form)).id, version);
    if (!files) throw new HttpError(404, "No such version.");
    return { version, files };
  }, { readOnlyHint: true });

  tool("restore_code_version", "Copy an old published version's files back into the draft (publish_code_form to make it live).", { form: ref, version: z.number().int().min(1) }, async ({ form, version }) => {
    need("apps:build");
    const row = await restoreProjectVersion((await findCodeForm(form)).id, version, actor);
    return { id: row.id, slug: row.slug, revision: row.revision, ...where(row) };
  });

  tool(
    "export_code_form",
    "Export a code form as an lcs-app-bundle (its draft files). data: true adds its collections and entries (needs entries:read too).",
    { form: ref, data: z.boolean().optional() },
    async ({ form, data }) => {
      need("apps:build");
      if (data) need("entries:read");
      if (data && key.siteId) throw new HttpError(403, "An export with data holds every site's entries, so a key limited to one site can't make one.");
      return exportProject((await findCodeForm(form)).id, { data });
    },
    { readOnlyHint: true }
  );

  tool(
    "import_code_form",
    "Import an lcs-app-bundle (or { files }) as a new code form draft, with its collections. withEntries: true also loads its entries (needs entries:write too).",
    { payload: z.union([z.record(z.unknown()), z.string()]).describe("The bundle (object or JSON text)"), withEntries: z.boolean().optional() },
    async ({ payload, withEntries }) => {
      need("apps:build");
      if (withEntries) need("entries:write");
      const row = await importProject(typeof payload === "string" ? JSON.parse(payload) : payload, actor, { withEntries });
      return row;
    }
  );
}
