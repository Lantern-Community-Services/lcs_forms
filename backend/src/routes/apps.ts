import express, { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler, badRequest, forbidden } from "../http.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { actorOf, audit } from "../services/audit.js";
import { buildExport, exportSpec } from "../apps/exports.js";
import { deleteForm, listVersions, setCatalog, setFormStatus } from "../forms/service.js";
import { buildProject } from "../apps/compile.js";
import { checkFiles } from "../apps/project.js";
import { APP_GUIDE } from "../apps/guide.js";
import { SDK_TYPES } from "../apps/sdkText.js";
import { DESIGN_BRIEF } from "../apps/designBrief.js";
import {
  collectionGet, collectionList, collectionPut, collectionRemove, createEntry, findCodeForm, getEntry, isDeveloper, listEntries, loadApp,
  requireOpen, restoreEntry, runAction, voidEntry, updateEntry, entryHistory, type ClientEntryQuery,
} from "../apps/runtime.js";
import { readAppFile, uploadAppFile } from "../apps/files.js";
import {
  createProject, draftFiles, duplicateProject, exportProject, importProject, listProjects, projectDetail, publishProject, restoreProjectVersion,
  saveProject, versionFiles,
} from "../apps/service.js";

/**
 * Code forms.
 *   /api/apps/projects/…   building them (apps.develop: Admins and Developers)
 *   /api/apps/:slug/…      using them — what the SDK in a page calls; access from the form's own form.json
 * `?draft=1` on a runtime call uses the unpublished draft (developers only, for the editor's preview).
 */
export const appsRouter = Router();
appsRouter.use(requireAuth);

// ── Building ─────────────────────────────────────────────────────────────

const dev = requirePermission("apps.develop", "forms.manage");

appsRouter.get("/guide", dev, (_req, res) => res.type("text/markdown").send(APP_GUIDE()));
appsRouter.get("/sdk.d.ts", dev, (_req, res) => res.type("text/plain").send(SDK_TYPES));
/** For design work (Claude Design and the handoff exports): tokens, components, layout rules. */
appsRouter.get("/design-brief", dev, (_req, res) => res.type("text/markdown").send(DESIGN_BRIEF()));

appsRouter.get("/projects", dev, asyncHandler(async (req, res) => res.json(await listProjects({ includeArchived: req.query.archived === "1" }))));

appsRouter.post(
  "/projects",
  dev,
  asyncHandler(async (req, res) => {
    const body = z.object({ title: z.string().max(200).optional(), files: z.unknown().optional(), slug: z.string().optional() }).parse(req.body);
    res.status(201).json(projectDetail(await createProject(body, actorOf(req))));
  })
);

appsRouter.post(
  "/import",
  dev,
  asyncHandler(async (req, res) => {
    const body = z.object({ payload: z.unknown(), withEntries: z.boolean().optional() }).parse(req.body);
    res.status(201).json(await importProject(body.payload, actorOf(req), { withEntries: body.withEntries }));
  })
);

appsRouter.get("/projects/:id", dev, asyncHandler(async (req, res) => res.json(projectDetail(await findCodeForm(req.params.id)))));

appsRouter.put(
  "/projects/:id",
  dev,
  asyncHandler(async (req, res) => {
    const body = z.object({ files: z.unknown(), revision: z.number().int().optional(), slug: z.string().optional() }).parse(req.body);
    res.json(projectDetail(await saveProject(req.params.id, { ...body, files: body.files }, actorOf(req))));
  })
);

/** Compile without saving (the given files, or the saved draft) — errors with file and line. */
appsRouter.post(
  "/projects/:id/build",
  dev,
  asyncHandler(async (req, res) => {
    const form = await findCodeForm(req.params.id);
    const files = req.body?.files ? checkFiles(req.body.files).files : draftFiles(form);
    if (!files) throw badRequest("Those files aren't valid.");
    const r = await buildProject(files);
    res.json(r.ok ? { ok: true, warnings: r.build.warnings, hash: r.build.hash } : r);
  })
);

appsRouter.post(
  "/projects/:id/publish",
  dev,
  asyncHandler(async (req, res) => {
    const { note } = z.object({ note: z.string().max(300).optional() }).parse(req.body ?? {});
    res.json(projectDetail(await publishProject(req.params.id, actorOf(req), note)));
  })
);

appsRouter.post(
  "/projects/:id/status",
  dev,
  asyncHandler(async (req, res) => {
    const { status } = z.object({ status: z.enum(["published", "closed", "archived", "draft"]) }).parse(req.body);
    const form = await findCodeForm(req.params.id);
    res.json(projectDetail(await setFormStatus(form.id, status, actorOf(req))));
  })
);

appsRouter.post("/projects/:id/duplicate", dev, asyncHandler(async (req, res) => res.status(201).json(projectDetail(await duplicateProject(req.params.id, actorOf(req))))));

appsRouter.put(
  "/projects/:id/catalog",
  dev,
  asyncHandler(async (req, res) => {
    const { categoryId } = z.object({ categoryId: z.string().nullable() }).parse(req.body);
    const form = await findCodeForm(req.params.id);
    await setCatalog(form.id, categoryId, actorOf(req));
    res.json(projectDetail(await findCodeForm(form.id)));
  })
);

appsRouter.get("/projects/:id/versions", dev, asyncHandler(async (req, res) => res.json(await listVersions((await findCodeForm(req.params.id)).id))));

appsRouter.get(
  "/projects/:id/versions/:version",
  dev,
  asyncHandler(async (req, res) => {
    const files = await versionFiles((await findCodeForm(req.params.id)).id, Number(req.params.version));
    if (!files) throw badRequest("No such version.");
    res.json({ files });
  })
);

appsRouter.post(
  "/projects/:id/versions/:version/restore",
  dev,
  asyncHandler(async (req, res) => res.json(projectDetail(await restoreProjectVersion(req.params.id, Number(req.params.version), actorOf(req)))))
);

appsRouter.get(
  "/projects/:id/export",
  dev,
  asyncHandler(async (req, res) => {
    const bundle = await exportProject(req.params.id, { data: req.query.data === "1" });
    res.setHeader("Content-Disposition", `attachment; filename="${bundle.slug}.lcsapp.json"`);
    res.type("application/json").send(JSON.stringify(bundle, null, 2));
  })
);

appsRouter.delete(
  "/projects/:id",
  dev,
  asyncHandler(async (req, res) => {
    const form = await findCodeForm(req.params.id);
    await deleteForm(form.id, actorOf(req));
    res.json({ ok: true });
  })
);

// ── Using ────────────────────────────────────────────────────────────────

async function appFor(req: Request) {
  const draft = req.query.draft === "1";
  if (draft && !isDeveloper(req.user)) throw forbidden("Only developers can open a draft.");
  const form = await findCodeForm(req.params.slug);
  return loadApp(form, draft);
}

/** Everything the host needs to show a code form to this person. */
appsRouter.get(
  "/:slug/runtime",
  asyncHandler(async (req, res) => {
    const app = await appFor(req);
    const a = requireOpen(app, req.user!);
    const u = req.user!;
    res.json({
      form: { id: app.form.id, slug: app.form.slug, title: app.manifest.title, status: app.form.status, version: app.form.liveVersion, draft: app.draft },
      pages: a.pages.map((p) => ({ id: p.id, label: p.label, fullHeight: Boolean(p.fullHeight), hidden: Boolean(p.hidden), nav: p.nav ?? "auto" })),
      code: Object.fromEntries(Object.entries(app.build.pages).filter(([k]) => a.pages.some((p) => p.id === k.split("@")[0]))),
      css: app.build.css,
      hash: app.build.hash,
      user: { id: u.userId, name: u.name, email: u.email, roleKey: u.roleKey, roleName: u.roleName, permissions: u.permissions, siteIds: u.siteIds },
      canEdit: isDeveloper(u),
      offlineActions: app.manifest.offline?.actions ?? [],
    });
  })
);

const entryQuery = (q: Request["query"]): ClientEntryQuery => ({
  site: typeof q.site === "string" && q.site ? q.site : undefined,
  tenantId: typeof q.tenantId === "string" ? q.tenantId : undefined,
  from: typeof q.from === "string" && q.from ? q.from : undefined,
  to: typeof q.to === "string" && q.to ? q.to : undefined,
  status: q.status === "voided" || q.status === "all" ? q.status : "active",
  search: typeof q.search === "string" ? q.search : undefined,
  mine: q.mine === "1" || q.mine === "true",
  fields: typeof q.fields === "string" && q.fields ? q.fields.split(",").slice(0, 50) : undefined,
  order: q.order === "oldest" ? "oldest" : "newest",
  limit: q.limit ? Number(q.limit) : undefined,
  offset: q.offset ? Number(q.offset) : undefined,
});

appsRouter.get("/:slug/entries", asyncHandler(async (req, res) => res.json(await listEntries(await appFor(req), req.user!, entryQuery(req.query)))));
appsRouter.get("/:slug/entries/:id", asyncHandler(async (req, res) => res.json(await getEntry(await appFor(req), req.user!, req.params.id))));

appsRouter.post(
  "/:slug/entries",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        data: z.record(z.unknown()),
        site: z.string().max(80).nullable().optional(),
        tenantId: z.string().max(60).nullable().optional(),
        occurredAt: z.string().max(40).nullable().optional(),
        clientId: z.string().max(100).nullable().optional(),
        override: z.string().max(500).nullable().optional(),
      })
      .parse(req.body);
    const app = await appFor(req);
    const out = await createEntry(app, req.user!, body);
    const status = out.status === "saved" ? 201 : out.status === "needs_override" ? 409 : 422;
    res.status(status).json({ ...out, logs: app.draft ? out.logs : undefined });
  })
);

appsRouter.put(
  "/:slug/entries/:id",
  asyncHandler(async (req, res) => {
    const body = z.object({ data: z.record(z.unknown()), reason: z.string().max(500).nullable().optional() }).parse(req.body);
    const app = await appFor(req);
    const out = await updateEntry(app, req.user!, req.params.id, body);
    res.status(out.status === "saved" ? 200 : 422).json({ ...out, logs: app.draft ? out.logs : undefined });
  })
);

appsRouter.get("/:slug/entries/:id/history", asyncHandler(async (req, res) => res.json(await entryHistory(await appFor(req), req.user!, req.params.id))));

/**
 * A photo or file, sent as the raw body (always application/octet-stream, so no
 * body parser touches it); its name, type and label ride in headers.
 */
appsRouter.post(
  "/:slug/files",
  express.raw({ type: () => true, limit: "11mb" }),
  asyncHandler(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw badRequest("Send the file as the request body.");
    const header = (h: string) => decodeURIComponent(String(req.headers[h] ?? ""));
    const ref = await uploadAppFile(await appFor(req), req.user!, { name: header("x-file-name") || "file", mime: header("x-file-type"), label: header("x-file-label"), data: req.body });
    res.status(201).json(ref);
  })
);

appsRouter.get(
  "/:slug/files/:fileId",
  asyncHandler(async (req, res) => {
    const app = await appFor(req);
    requireOpen(app, req.user!);
    const file = await readAppFile(app, req.user!, req.params.fileId, (entryId) => getEntry(app, req.user!, entryId));
    const inline = /^(image\/(png|jpe?g|gif|webp|heic|heif)|application\/pdf)$/.test(file.mime) && req.query.download !== "1";
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(file.name)}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=3600");
    // Uploaded content is shown as a file, never as a page of this site.
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    res.type(inline ? file.mime : "application/octet-stream").send(Buffer.from(file.data));
  })
);

/** An Excel / PDF / CSV file of what a page is showing (app.export). */
appsRouter.post(
  "/:slug/export",
  asyncHandler(async (req, res) => {
    const spec = exportSpec.parse(req.body);
    const app = await appFor(req);
    requireOpen(app, req.user!);
    const file = await buildExport(spec, req.user!.name);
    await audit({ actor: actorOf(req), action: "apps.exported", summary: `Exported “${spec.title}” (${spec.format}) from code form “${app.manifest.title}”` });
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(file.filename)}"`);
    res.type(file.mime).send(file.body);
  })
);

appsRouter.post(
  "/:slug/entries/:id/void",
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().max(500) }).parse(req.body);
    await voidEntry(await appFor(req), req.user!, req.params.id, reason);
    res.json({ ok: true });
  })
);

appsRouter.post(
  "/:slug/entries/:id/restore",
  asyncHandler(async (req, res) => {
    await restoreEntry(await appFor(req), req.user!, req.params.id);
    res.json({ ok: true });
  })
);

appsRouter.get(
  "/:slug/collections/:name",
  asyncHandler(async (req, res) => {
    const app = await appFor(req);
    if (!requireOpen(app, req.user!).collection(req.params.name, "read")) throw forbidden(`You can't read ${req.params.name}.`);
    res.json(await collectionList(app.form.id, req.params.name));
  })
);

appsRouter.get(
  "/:slug/collections/:name/:docId",
  asyncHandler(async (req, res) => {
    const app = await appFor(req);
    if (!requireOpen(app, req.user!).collection(req.params.name, "read")) throw forbidden(`You can't read ${req.params.name}.`);
    res.json(await collectionGet(app.form.id, req.params.name, req.params.docId));
  })
);

appsRouter.put(
  ["/:slug/collections/:name", "/:slug/collections/:name/:docId"],
  asyncHandler(async (req, res) => {
    const app = await appFor(req);
    if (!requireOpen(app, req.user!).collection(req.params.name, "write")) throw forbidden(`You can't change ${req.params.name}.`);
    res.json(await collectionPut(app.form.id, req.params.name, req.params.docId ?? null, req.body?.data, req.user!.name));
  })
);

appsRouter.delete(
  "/:slug/collections/:name/:docId",
  asyncHandler(async (req, res) => {
    const app = await appFor(req);
    if (!requireOpen(app, req.user!).collection(req.params.name, "write")) throw forbidden(`You can't change ${req.params.name}.`);
    await collectionRemove(app.form.id, req.params.name, req.params.docId);
    res.json({ ok: true });
  })
);

appsRouter.post(
  "/:slug/actions/:name",
  asyncHandler(async (req, res) => {
    const app = await appFor(req);
    const r = await runAction(app, req.user!, req.params.name, req.body?.args);
    const logs = app.draft ? r.logs : undefined;
    if (!r.ok) return res.status(r.userError ? 400 : 500).json({ error: r.userError ? r.error : `The form's server code failed: ${r.error}`, stack: app.draft ? r.stack : undefined, logs });
    res.json({ value: r.value, logs });
  })
);
