import { Router } from "express";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { asyncHandler, badRequest } from "../http.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { actorOf } from "../services/audit.js";
import { CODE_BLOCK_API, EXPRESSION_FUNCTIONS, FIELD_TYPES, emptyForm } from "../forms/engine.js";
import { formDocSchema, parseFormDoc } from "../forms/schema.js";
import {
  createForm, deleteForm, duplicateForm, exportForms, findForm, formDetail, importPayload, listForms, listVersions,
  publishForm, restoreVersion, saveDraft, setCatalog, setFormStatus, versionDoc,
} from "../forms/service.js";
import { mailConfigured } from "../services/mailer.js";
import { ROLES } from "../services/permissions.js";
import { MCP_GUIDE } from "../forms/mcp.js";

/**
 * Admin → Form builder. Everything here needs forms.manage, which only the
 * Admin role holds: creating and changing forms is Admin-only by design.
 */
export const builderRouter = Router();
builderRouter.use(requireAuth, requirePermission("forms.manage"));

/** What the builder needs to draw its palette and pickers, and the docs the MCP server serves. */
export function builderReference() {
  return {
    fieldTypes: FIELD_TYPES,
    expressionFunctions: EXPRESSION_FUNCTIONS,
    codeBlockApi: CODE_BLOCK_API,
    roles: ROLES.map((r) => ({ key: r.key, name: r.name })),
    mailConfigured: mailConfigured(),
    blank: emptyForm(),
  };
}

let jsonSchemaCache: unknown;
export function formJsonSchema() {
  jsonSchemaCache ??= zodToJsonSchema(formDocSchema, { name: "LcsForm", $refStrategy: "none" });
  return jsonSchemaCache;
}

builderRouter.get("/reference", (_req, res) => res.json(builderReference()));

/** The format guide the MCP server gives LLMs (Markdown) — shown on Admin → AI form builder too. */
builderRouter.get("/guide", (_req, res) => res.type("text/markdown").send(MCP_GUIDE()));

/** JSON Schema of the lcs-form format — point an editor's "$schema" at it for autocomplete. */
builderRouter.get("/json-schema", (_req, res) => res.json(formJsonSchema()));

builderRouter.get(
  "/forms",
  asyncHandler(async (req, res) => res.json(await listForms({ includeArchived: req.query.archived === "1" })))
);

builderRouter.post(
  "/forms",
  asyncHandler(async (req, res) => {
    const body = z.object({ title: z.string().max(200).optional(), slug: z.string().optional(), doc: z.unknown().optional() }).parse(req.body);
    const row = await createForm(body, actorOf(req));
    res.status(201).json(formDetail(row));
  })
);

/** Check a document without saving it — the code editor calls this as you type. */
builderRouter.post("/validate", (req, res) => {
  const result = parseFormDoc(req.body?.doc ?? req.body);
  res.json({ ok: Boolean(result.doc), problems: result.problems, doc: result.doc });
});

builderRouter.post(
  "/import",
  asyncHandler(async (req, res) => {
    const body = z.object({ payload: z.unknown(), withEntries: z.boolean().optional(), publish: z.boolean().optional() }).parse(req.body);
    if (body.payload === undefined) throw badRequest("Nothing to import.");
    res.json(await importPayload(body.payload, actorOf(req), { withEntries: body.withEntries, publish: body.publish }));
  })
);

/** Several forms as one bundle file: ?ids=a,b&entries=1&live=1 */
builderRouter.get(
  "/export",
  asyncHandler(async (req, res) => {
    const ids = String(req.query.ids ?? "").split(",").filter(Boolean);
    if (!ids.length) throw badRequest("Pick at least one form.");
    const bundle = await exportForms(ids, { entries: req.query.entries === "1", live: req.query.live === "1" });
    const name = bundle.forms.length === 1 ? bundle.forms[0].slug : `lantern-forms-${bundle.forms.length}`;
    res.setHeader("Content-Disposition", `attachment; filename="${name}.lcsform.json"`);
    res.type("application/json").send(JSON.stringify(bundle, null, 2));
  })
);

builderRouter.get(
  "/forms/:id",
  asyncHandler(async (req, res) => res.json(formDetail(await findForm(req.params.id))))
);

builderRouter.put(
  "/forms/:id",
  asyncHandler(async (req, res) => {
    const body = z.object({ doc: z.unknown(), revision: z.number().int().optional(), slug: z.string().optional() }).parse(req.body);
    const row = await saveDraft(req.params.id, { ...body, doc: body.doc }, actorOf(req));
    res.json(formDetail(row));
  })
);

builderRouter.post(
  "/forms/:id/publish",
  asyncHandler(async (req, res) => {
    const { note } = z.object({ note: z.string().max(300).optional() }).parse(req.body ?? {});
    res.json(formDetail(await publishForm(req.params.id, actorOf(req), note)));
  })
);

builderRouter.post(
  "/forms/:id/status",
  asyncHandler(async (req, res) => {
    const { status } = z.object({ status: z.enum(["published", "closed", "archived", "draft"]) }).parse(req.body);
    res.json(formDetail(await setFormStatus(req.params.id, status, actorOf(req))));
  })
);

builderRouter.post(
  "/forms/:id/duplicate",
  asyncHandler(async (req, res) => res.status(201).json(formDetail(await duplicateForm(req.params.id, actorOf(req)))))
);

builderRouter.put(
  "/forms/:id/catalog",
  asyncHandler(async (req, res) => {
    const { categoryId } = z.object({ categoryId: z.string().nullable() }).parse(req.body);
    await setCatalog(req.params.id, categoryId, actorOf(req));
    res.json(formDetail(await findForm(req.params.id)));
  })
);

builderRouter.get(
  "/forms/:id/versions",
  asyncHandler(async (req, res) => res.json(await listVersions(req.params.id)))
);

builderRouter.get(
  "/forms/:id/versions/:version",
  asyncHandler(async (req, res) => {
    const form = await findForm(req.params.id);
    const doc = await versionDoc(form.id, Number(req.params.version));
    if (!doc) throw badRequest("No such version.");
    res.json(doc);
  })
);

builderRouter.post(
  "/forms/:id/versions/:version/restore",
  asyncHandler(async (req, res) => res.json(formDetail(await restoreVersion(req.params.id, Number(req.params.version), actorOf(req)))))
);

builderRouter.delete(
  "/forms/:id",
  asyncHandler(async (req, res) => {
    const { withEntries } = z.object({ withEntries: z.boolean().optional() }).parse(req.body ?? {});
    await deleteForm(req.params.id, actorOf(req), { withEntries });
    res.json({ ok: true });
  })
);
