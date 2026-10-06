import type { Request, Response } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { prisma } from "../prisma.js";
import { appBaseUrl } from "../env.js";
import { HttpError } from "../http.js";
import type { Actor } from "../services/audit.js";
import type { ResolvedKey } from "../services/apiKeys.js";
import { formJsonSchema } from "../routes/builder.js";
import {
  ADDRESS_PARTS, CODE_BLOCK_API, EXPRESSION_FUNCTIONS, FIELD_TYPES, NAME_PARTS, newField,
  type Field, type FieldType, type FormDoc,
} from "./engine.js";
import { parseFormDoc } from "./schema.js";
import {
  DocError, createForm, deleteForm, duplicateForm, exportForms, findAnyForm, findForm, formDetail, importPayload, listForms, listVersions,
  publishForm, readDoc, restoreVersion, saveDraft, setCatalog, setFormStatus,
} from "./service.js";
import { docForEntry, entryRow, entryWhere, submitEntry } from "./entries.js";
import { registerCodeTools } from "../apps/mcpTools.js";
import { registerCatalogTools } from "./catalogTools.js";

/**
 * MCP server for building forms with an LLM — Claude Code, Claude Desktop,
 * anything that speaks MCP over Streamable HTTP.
 *
 *   URL:   <backend>/mcp
 *   Auth:  Authorization: Bearer lrk_…   (Admin → API keys, scope forms:build;
 *          add entries:read / entries:write to let it read or submit entries)
 *
 * Stateless: every POST gets a fresh server, so it scales like the rest of the
 * API and needs no session store. Every tool goes through forms/service.ts,
 * so an LLM's form passes exactly the checks a builder-made form does, and
 * lands as a draft an admin can review before it's published.
 */

export const MCP_GUIDE = () => `# Lantern Forms — building forms

A form is ONE JSON document ("lcs-form"). Build it, validate it, save it as a draft, then publish.
Workflow: get_reference → create_form (or patch_form to edit) → validate_form if unsure → publish_form.
Forms open at ${appBaseUrl}/f/<slug> (public forms at /p/<slug>). New forms are drafts until published.

## Document shape
{
  "format": "lcs-form", "version": 1,
  "title": "Incident report",
  "description": "optional HTML shown above the form",
  "fields": [ Field, … ],              // in order; a "page" field starts a new page
  "settings": { … }                    // see below
}

## Field (common keys)
id (required, unique, a-z 0-9 _ starting with a letter — entries, rules and calculations use it),
type (required), label (required), description, placeholder, required, defaultValue (merge tags OK),
width ("full" | "half" | "third"), adminOnly, readOnly, cssClass,
conditional: { "action": "show"|"hide", "match": "all"|"any", "rules": [{ "field": "<id>", "op": "<op>", "value": "…" }] }
Rule ops: is, is_not, gt, lt, gte, lte, contains, not_contains, starts_with, ends_with, empty, not_empty.
For choice fields compare against the choice VALUE. Name/address parts: "field": "applicant.first".
A section's or page's conditional hides everything under it.

## Field types
${FIELD_TYPES.map((t) => `- ${t.type} (${t.label}, ${t.group}) — ${t.description} Value: ${t.value}.`).join("\n")}

Choices: [{ "label": "Yes", "value": "yes" }] — values unique within the field.
Name parts: ${Object.keys(NAME_PARTS).join(", ")}. Address parts: ${Object.keys(ADDRESS_PARTS).join(", ")}.
Text validation: minLength, maxLength, pattern (regex, whole value), patternMessage.
Number: min, max, step, prefix, suffix. Date: minDate/maxDate as YYYY-MM-DD or "today", "today+7".
Repeater: "fields": [sub-fields] (no page/file/signature/code/resident/repeater inside), minRows, maxRows, addLabel.
Likert: "choices" = the scale, "statements" = the rows.
Resident: "siteField": "<id of a site field>" (else the form's site). Logs roster activity unless logActivity:false.

## Calculations ("calculation" field, "expression")
{qty} * {price}, + - * / % ^, comparisons == != > < >= <=, && || !, "text".
Functions: ${EXPRESSION_FUNCTIONS.join(", ")}. decimals (default 2), display: number|currency|percent.

## Merge tags (defaultValue, html content, confirmation, notifications)
{field_id}  {field_id.part}  {field_id:value}  {all_fields}  {form:title}  {entry:id}  {entry:url}
{user:name}  {user:email}  {site:name}  {date:today}  {date:now}

## Custom code ("code" field)
"code": { "html": "…", "css": "…", "js": "…", "height": 120 } runs in a sandboxed iframe with:
${CODE_BLOCK_API}

## settings
submitLabel; progressBar; saveDrafts (default true); customCss; icon (catalog icon key);
access: { mode: "signed_in" | "roles" | "public", roles: [role keys] }  (public forms can't use site/resident fields);
entriesRoles: [role keys that can read entries; Admin always can];
requireSite: true to ask which site the entry is for (entries are then limited to that site's staff);
limits: { maxEntries, perUser: { count, period: day|week|month|ever }, opensAt, closesAt (ISO), closedMessage };
confirmation: { type: "message"|"redirect", message (HTML, merge tags), url, showSummary };
notifications: [{ id, name, enabled, kind: "email"|"webhook", to, subject, body, url, secret, conditional }].
Role keys: admin, main_office, site_admin, site_manager, site_staff.

## Example
${JSON.stringify(EXAMPLE, null, 2)}
`;

const EXAMPLE: FormDoc = {
  format: "lcs-form",
  version: 1,
  title: "Maintenance request",
  description: "<p>Tell us what needs fixing.</p>",
  fields: [
    { id: "site", type: "site", label: "Site", required: true, width: "half" },
    { id: "resident", type: "resident", label: "Resident", siteField: "site", width: "half" },
    { id: "area", type: "select", label: "Where is the problem?", required: true, choices: [{ label: "Kitchen", value: "kitchen" }, { label: "Bathroom", value: "bathroom" }, { label: "Other", value: "other" }] },
    { id: "area_other", type: "text", label: "Describe where", required: true, conditional: { action: "show", match: "all", rules: [{ field: "area", op: "is", value: "other" }] } },
    { id: "urgent", type: "radio", label: "Is it urgent?", choices: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], defaultValue: "no" },
    { id: "details", type: "textarea", label: "Details", rows: 4 },
    { id: "photos", type: "file", label: "Photos", accept: "image/*", maxFiles: 3 },
  ],
  settings: {
    submitLabel: "Send request",
    access: { mode: "signed_in" },
    confirmation: { type: "message", message: "<p>Thanks, {user:name}. We've logged it.</p>" },
    notifications: [{ id: "urgent", name: "Urgent to facilities", enabled: true, kind: "email", to: "facilities@lanterncommunity.org", subject: "URGENT: {area} at {site}", body: "{all_fields}", conditional: { action: "show", match: "all", rules: [{ field: "urgent", op: "is", value: "yes" }] } }],
  },
};

export type ToolRegistrar = <S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean }
) => unknown;

type ToolResult = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };

/** A tool's answer as MCP content blocks (an image, say) rather than JSON text. */
export class McpContent {
  constructor(public content: ToolResult["content"]) {}
}

const ok = (data: unknown): ToolResult =>
  data instanceof McpContent ? { content: data.content } : { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };

function fail(err: unknown): ToolResult {
  if (err instanceof DocError) {
    return { isError: true, content: [{ type: "text", text: `${err.message}\n${err.problems.map((p) => `- ${p.path || "(document)"}: ${p.message}`).join("\n")}` }] };
  }
  if (err instanceof HttpError) {
    const probs = (err.details as { problems?: { file?: string; path?: string; line?: number; column?: number; message: string }[] } | undefined)?.problems;
    if (Array.isArray(probs)) {
      const lines = probs.map((p) => `- ${p.file ?? p.path ?? "(project)"}${p.line ? `:${p.line}${p.column !== undefined ? `:${p.column + 1}` : ""}` : ""}: ${p.message}`);
      return { isError: true, content: [{ type: "text", text: `${err.message}\n${lines.join("\n")}` }] };
    }
    return { isError: true, content: [{ type: "text", text: `${err.message}${err.details ? `\n${JSON.stringify(err.details, null, 2)}` : ""}` }] };
  }
  if (err instanceof z.ZodError) return { isError: true, content: [{ type: "text", text: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n") }] };
  console.error("[mcp] tool failed:", err);
  return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
}

const formRef = z.string().describe("The form's id or its slug (URL name).");

function summarize(row: Awaited<ReturnType<typeof findForm>>) {
  if (row.kind === "code") {
    return { id: row.id, slug: row.slug, title: row.title, kind: "code", status: row.status, revision: row.revision, liveVersion: row.liveVersion, url: `${appBaseUrl}/apps/${row.slug}`, editorUrl: `${appBaseUrl}/admin/apps/${row.id}` };
  }
  const d = formDetail(row);
  return {
    id: d.id,
    slug: d.slug,
    title: d.title,
    status: d.status,
    revision: d.revision,
    liveVersion: d.liveVersion,
    unpublishedChanges: d.unpublishedChanges,
    url: `${appBaseUrl}/${d.draft.settings.access?.mode === "public" ? "p" : "f"}/${d.slug}`,
    editorUrl: `${appBaseUrl}/admin/builder/${d.id}`,
  };
}

/** One patch operation on a draft. */
const patchOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add_field"),
    field: z.record(z.unknown()).describe("At least { type, label }. id is made from the label when missing; other keys override the type's defaults."),
    after: z.string().optional().describe("Insert after this field id. Default: at the end."),
    index: z.number().int().optional().describe("Or insert at this position (0 = first)."),
  }),
  z.object({
    op: z.literal("update_field"),
    id: z.string(),
    changes: z.record(z.unknown()).describe("Keys to set. A key set to null is removed."),
  }),
  z.object({ op: z.literal("remove_field"), id: z.string() }),
  z.object({ op: z.literal("move_field"), id: z.string(), after: z.string().optional(), index: z.number().int().optional() }),
  z.object({ op: z.literal("set_title"), value: z.string() }),
  z.object({ op: z.literal("set_description"), value: z.string() }),
  z.object({
    op: z.literal("update_settings"),
    changes: z.record(z.unknown()).describe("Merged into settings (objects like access/limits/confirmation merge one level deep; notifications replaces the list)."),
  }),
]);

type PatchOp = z.infer<typeof patchOp>;

function applyOps(doc: FormDoc, ops: PatchOp[]): FormDoc {
  const next: FormDoc = JSON.parse(JSON.stringify(doc));
  const indexOf = (id: string) => {
    const i = next.fields.findIndex((f) => f.id === id);
    if (i < 0) throw new HttpError(400, `No field with id "${id}". Ids: ${next.fields.map((f) => f.id).join(", ") || "(none)"}`);
    return i;
  };
  const place = (field: Field, after?: string, index?: number) => {
    if (after) next.fields.splice(indexOf(after) + 1, 0, field);
    else if (index !== undefined) next.fields.splice(Math.max(0, Math.min(index, next.fields.length)), 0, field);
    else next.fields.push(field);
  };
  for (const op of ops) {
    switch (op.op) {
      case "add_field": {
        const type = String(op.field.type ?? "") as FieldType;
        if (!FIELD_TYPES.some((t) => t.type === type)) throw new HttpError(400, `Unknown field type "${type}". Types: ${FIELD_TYPES.map((t) => t.type).join(", ")}`);
        const base = newField(type, next.fields.map((f) => f.id), typeof op.field.label === "string" ? op.field.label : undefined);
        const field = { ...base, ...op.field } as Field;
        if (next.fields.some((f) => f.id === field.id)) throw new HttpError(400, `A field with id "${field.id}" already exists.`);
        place(field, op.after, op.index);
        break;
      }
      case "update_field": {
        const i = indexOf(op.id);
        const f = { ...next.fields[i] } as Record<string, unknown>;
        for (const [k, v] of Object.entries(op.changes)) {
          if (v === null) delete f[k];
          else f[k] = v;
        }
        next.fields[i] = f as unknown as Field;
        break;
      }
      case "remove_field":
        next.fields.splice(indexOf(op.id), 1);
        break;
      case "move_field": {
        const [f] = next.fields.splice(indexOf(op.id), 1);
        place(f, op.after, op.index);
        break;
      }
      case "set_title":
        next.title = op.value;
        break;
      case "set_description":
        next.description = op.value;
        break;
      case "update_settings": {
        const s = next.settings as Record<string, unknown>;
        for (const [k, v] of Object.entries(op.changes)) {
          if (v === null) delete s[k];
          else if (v && typeof v === "object" && !Array.isArray(v) && s[k] && typeof s[k] === "object" && !Array.isArray(s[k])) s[k] = { ...(s[k] as object), ...(v as object) };
          else s[k] = v;
        }
        break;
      }
    }
  }
  return next;
}

function buildServer(key: ResolvedKey): McpServer {
  const actor: Actor = { id: null, name: `API key: ${key.name} (MCP)` };
  const can = (scope: string) => key.scopes.includes(scope as never);
  const need = (scope: string) => {
    if (!can(scope)) throw new HttpError(403, `This API key lacks the ${scope} scope. An admin can add it in Admin → API keys.`);
  };
  const server = new McpServer(
    { name: "lantern-forms", version: "1.0.0" },
    { instructions: "Build and manage forms on the Lantern Forms site. Two kinds: basic forms (one JSON document — call get_reference) and code forms (a project of React pages + server code + form.json, for custom screens, rules, offline use and dashboards — call get_code_reference). The Forms catalog (the home screen and sidebar) is list_catalog / save_catalog_card: add_to_catalog for a form built here, save_catalog_card for a link to a form on another site. Everything you make is a draft until published." }
  );

  const tool: ToolRegistrar = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } = {}
  ) =>
    server.registerTool(name, { description, inputSchema: shape, annotations }, (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return ok(await run(args));
      } catch (err) {
        return fail(err);
      }
    }) as never);

  server.registerResource("guide", "lcs-forms://guide", { title: "How to build a Lantern form", mimeType: "text/markdown" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: MCP_GUIDE() }],
  }));
  server.registerResource("json-schema", "lcs-forms://json-schema", { title: "lcs-form JSON Schema", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(formJsonSchema(), null, 2) }],
  }));

  tool("get_reference", "The full guide to the lcs-form format: document shape, every field type and its options, conditional logic, calculations, merge tags, custom code blocks, settings, and a complete example. Read this before building.", {}, async () => MCP_GUIDE(), { readOnlyHint: true });

  tool("get_json_schema", "The JSON Schema of an lcs-form document, for exact key names and types.", {}, async () => formJsonSchema(), { readOnlyHint: true });

  tool("list_forms", "Every built form with its status, entry count and URLs.", { includeArchived: z.boolean().optional() }, async ({ includeArchived }) => {
    need("forms:build");
    return (await listForms({ includeArchived })).map((f) => ({ ...f, url: `${appBaseUrl}/${f.access === "public" ? "p" : "f"}/${f.slug}`, editorUrl: `${appBaseUrl}/admin/builder/${f.id}` }));
  }, { readOnlyHint: true });

  tool("get_form", "A form's full document (the draft by default) plus its status and revision.", { form: formRef, which: z.enum(["draft", "live"]).optional().describe("draft (default) or the live published version") }, async ({ form, which }) => {
    need("forms:build");
    const row = await findForm(form);
    const doc = which === "live" ? (row.liveSchema ? readDoc(row.liveSchema) : null) : readDoc(row.draftSchema);
    if (!doc) throw new HttpError(404, "This form hasn't been published yet — ask for the draft.");
    return { ...summarize(row), doc };
  }, { readOnlyHint: true });

  tool("validate_form", "Check a document without saving it. Returns every problem with its JSON path.", { doc: z.record(z.unknown()).describe("An lcs-form document") }, async ({ doc }) => {
    const res = parseFormDoc(doc);
    return res.doc ? { ok: true, fields: res.doc.fields.length } : { ok: false, problems: res.problems };
  }, { readOnlyHint: true });

  tool(
    "create_form",
    "Create a new form from a full lcs-form document (or just a title for an empty one). It's saved as a draft unless publish is true.",
    {
      doc: z.record(z.unknown()).optional().describe("A full lcs-form document"),
      title: z.string().optional().describe("Title for an empty form, when no doc is given"),
      slug: z.string().optional().describe("URL name (lowercase-with-dashes). Made from the title when omitted."),
      publish: z.boolean().optional(),
    },
    async ({ doc, title, slug, publish }) => {
      need("forms:build");
      let row = await createForm({ doc, title, slug }, actor);
      if (publish) row = await publishForm(row.id, actor, "Published by MCP");
      return summarize(row);
    }
  );

  tool(
    "update_form",
    "Replace a form's whole draft with a new document. Pass the revision you read (from get_form) to avoid overwriting someone else's edit.",
    { form: formRef, doc: z.record(z.unknown()), revision: z.number().int().optional(), slug: z.string().optional() },
    async ({ form, doc, revision, slug }) => {
      need("forms:build");
      const row = await findForm(form);
      return summarize(await saveDraft(row.id, { doc, revision, slug }, actor));
    },
    { idempotentHint: true }
  );

  tool(
    "patch_form",
    "Edit a draft with small operations instead of resending the whole document: add_field, update_field, remove_field, move_field, set_title, set_description, update_settings. All operations apply together, or none do.",
    { form: formRef, operations: z.array(patchOp).min(1), revision: z.number().int().optional() },
    async ({ form, operations, revision }) => {
      need("forms:build");
      const row = await findForm(form);
      const doc = applyOps(readDoc(row.draftSchema), operations);
      const saved = await saveDraft(row.id, { doc, revision }, actor);
      return { ...summarize(saved), fieldIds: readDoc(saved.draftSchema).fields.map((f) => `${f.id} (${f.type})`) };
    }
  );

  tool("publish_form", "Make the current draft live as a new version. People fill in the live version.", { form: formRef, note: z.string().optional().describe("What changed, for the version history") }, async ({ form, note }) => {
    need("forms:build");
    return summarize(await publishForm((await findForm(form)).id, actor, note));
  });

  tool("set_form_status", "published (taking entries), closed (live but not taking entries), archived (hidden, entries kept), or draft (unarchive).", { form: formRef, status: z.enum(["published", "closed", "archived", "draft"]) }, async ({ form, status }) => {
    need("forms:build");
    return summarize(await setFormStatus((await findAnyForm(form)).id, status, actor));
  });

  tool("duplicate_form", "Copy a form's draft into a new form.", { form: formRef }, async ({ form }) => {
    need("forms:build");
    return summarize(await duplicateForm((await findForm(form)).id, actor));
  });

  tool("delete_form", "Delete a form that has no entries. A form with entries must be archived instead.", { form: formRef }, async ({ form }) => {
    need("forms:build");
    await deleteForm((await findAnyForm(form)).id, actor);
    return { deleted: true };
  }, { destructiveHint: true });

  tool("list_versions", "A form's published versions.", { form: formRef }, async ({ form }) => {
    need("forms:build");
    return listVersions((await findAnyForm(form)).id);
  }, { readOnlyHint: true });

  tool("restore_version", "Copy an old published version back into the draft (publish to make it live).", { form: formRef, version: z.number().int() }, async ({ form, version }) => {
    need("forms:build");
    return summarize(await restoreVersion((await findForm(form)).id, version, actor));
  });

  tool("export_forms", "Export forms as an lcs-form bundle (JSON), optionally with their entries.", { forms: z.array(formRef).min(1), entries: z.boolean().optional() }, async ({ forms, entries }) => {
    need("forms:build");
    if (entries) need("entries:read");
    const ids = await Promise.all(forms.map(async (f) => (await findForm(f)).id));
    return exportForms(ids, { entries });
  }, { readOnlyHint: true });

  tool(
    "import_forms",
    "Import forms: an lcs-form document, an lcs-form bundle, or a Gravity Forms export / form object (conditional logic, merge tags and calculations are converted). Each becomes a new draft.",
    { payload: z.union([z.record(z.unknown()), z.array(z.unknown()), z.string()]).describe("The JSON (object, array or JSON text)"), publish: z.boolean().optional() },
    async ({ payload, publish }) => {
      need("forms:build");
      const data = typeof payload === "string" ? JSON.parse(payload) : payload;
      return importPayload(data, actor, { publish });
    }
  );

  tool("list_catalog_categories", "Categories on the Forms screen, for add_to_catalog (list_catalog shows the cards too).", {}, async () => {
    need("forms:build");
    return prisma.formCategory.findMany({ orderBy: { sortOrder: "asc" }, select: { id: true, name: true } });
  }, { readOnlyHint: true });

  tool("add_to_catalog", "Show a form built here (a basic form or a code form) on the Forms screen and sidebar under a category; null category removes it. The card then follows the form (its title, URL and roles). For a link to a form on another site use save_catalog_card.", { form: formRef, categoryId: z.string().nullable() }, async ({ form, categoryId }) => {
    need("forms:build");
    const row = await findAnyForm(form);
    await setCatalog(row.id, categoryId, actor);
    return summarize(await findAnyForm(row.id));
  });

  tool(
    "list_entries",
    "Entries of a form, newest first.",
    {
      form: formRef,
      q: z.string().optional().describe("Search text"),
      from: z.string().optional().describe("YYYY-MM-DD"),
      to: z.string().optional().describe("YYYY-MM-DD"),
      status: z.enum(["active", "voided", "all"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ form, q, from, to, status, limit }) => {
      need("entries:read");
      const row = await findForm(form);
      const where = entryWhere(row, undefined, { q, from, to, status });
      if (key.siteId) (where.AND as object[]).push({ siteId: key.siteId });
      const [items, total] = await Promise.all([prisma.formEntry.findMany({ where, orderBy: { createdAt: "desc" }, take: limit ?? 50 }), prisma.formEntry.count({ where })]);
      return { total, items: items.map((e) => entryRow(e)) };
    },
    { readOnlyHint: true }
  );

  tool("get_entry", "One entry, with the labels of the form version it was filled against, and its notes.", { form: formRef, id: z.string() }, async ({ form, id }) => {
    need("entries:read");
    const row = await findForm(form);
    const entry = await prisma.formEntry.findFirst({ where: { id, formId: row.id, ...(key.siteId ? { siteId: key.siteId } : {}) } });
    if (!entry) throw new HttpError(404, "No such entry.");
    const doc = await docForEntry(row, entry.formVersion);
    const notes = await prisma.formEntryNote.findMany({ where: { entryId: entry.id }, orderBy: { createdAt: "asc" } });
    return { entry: entryRow(entry), fields: doc.fields.map((f) => ({ id: f.id, type: f.type, label: f.label })), notes };
  }, { readOnlyHint: true });

  tool(
    "submit_entry",
    "Submit an entry to a live form, validated exactly like a person's submission. Values are keyed by field id.",
    { form: formRef, values: z.record(z.unknown()), site: z.string().optional().describe("Site code, for forms that require a site") },
    async ({ form, values, site }) => {
      need("entries:write");
      const row = await findForm(form);
      const { entry } = await submitEntry({ form: row, values, siteCode: site, user: undefined, actorName: actor.name, source: "mcp", machineSiteIds: key.siteId ? [key.siteId] : null });
      return { id: entry.id, values: JSON.parse(entry.data), url: `${appBaseUrl}/f/${row.slug}/entries/${entry.id}` };
    }
  );

  registerCodeTools(tool, need, actor, key);
  registerCatalogTools(tool, need, actor);
  return server;
}

/** POST /mcp — one JSON-RPC exchange. GET/DELETE aren't used in stateless mode. */
export async function handleMcp(req: Request, res: Response) {
  if (!req.apiKey) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Send an API key: Authorization: Bearer lrk_… (Admin → API keys, scope forms:build)." }, id: null });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "This MCP server is stateless; use POST." }, id: null });
    return;
  }
  const server = buildServer(req.apiKey);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
