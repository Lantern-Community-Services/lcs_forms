import express, { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { HttpError, asyncHandler, badRequest, forbidden, notFound, unauthorized } from "../http.js";
import { findForm, readDoc } from "../forms/service.js";
import {
  canReadEntries, canVoidEntries, closedReason, docForEntry, entryRow, entryWhere, exportEntries, fillBlocker, isFormAdmin,
  entryScope, liveDoc, saveUpload, submitEntry, updateEntry, type EntryFilter,
} from "../forms/entries.js";

/**
 * Filling in a built form (/f/<slug>, or /p/<slug> when public) and reading
 * its entries. Mounted without requireAuth: a public form works signed out,
 * and every handler below decides for itself (see forms/entries.ts).
 */
export const fillRouter = Router();

async function liveForm(req: Request) {
  const form = await findForm(req.params.slug);
  // Admins may open a form that isn't live yet (to try it); nobody else can tell it exists.
  const doc = liveDoc(form) ?? (isFormAdmin(req.user) ? readDoc(form.draftSchema) : null);
  if (!doc || (form.status === "archived" && !isFormAdmin(req.user))) throw notFound("This form isn't available.");
  return { form, doc };
}

fillRouter.get(
  "/:slug",
  asyncHandler(async (req, res) => {
    const { form, doc } = await liveForm(req);
    const blocker = form.liveSchema ? fillBlocker(form, doc, req.user) : null;
    if (blocker && !isFormAdmin(req.user)) {
      if (blocker.status === 401) throw unauthorized(blocker.message);
      throw new HttpError(blocker.status, blocker.message);
    }
    res.json({
      form: { id: form.id, slug: form.slug, title: form.title, status: form.status, version: form.liveVersion, isDraft: !form.liveSchema },
      doc,
      closed: form.liveSchema ? await closedReason(form, doc, req.user) : "This form hasn't been published yet — you're seeing the draft because you're an admin. Submitting is off.",
      user: req.user ? { name: req.user.name, email: req.user.email } : null,
      canReadEntries: canReadEntries(doc, req.user),
      isAdmin: isFormAdmin(req.user),
    });
  })
);

const submitBody = z.object({
  values: z.record(z.unknown()),
  siteCode: z.string().max(80).nullable().optional(),
  clientId: z.string().max(100).nullable().optional(),
  codeErrors: z.record(z.string().max(300)).optional(),
  /** Honeypot: a hidden input real people never fill in. */
  website_hp: z.string().optional(),
});

fillRouter.post(
  "/:slug/submit",
  asyncHandler(async (req, res) => {
    const body = submitBody.parse(req.body);
    const form = await findForm(req.params.slug);
    const doc = liveDoc(form);
    if (!doc) throw notFound("This form isn't available.");
    // A bot filled the trap: act as if it worked so it doesn't try harder.
    if (body.website_hp) return res.status(201).json({ id: "ok", confirmation: doc.settings.confirmation ?? null });
    const { entry, duplicate } = await submitEntry({
      form,
      values: body.values,
      siteCode: body.siteCode,
      clientId: body.clientId,
      codeErrors: body.codeErrors,
      user: req.user,
      source: req.user ? "app" : "public",
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.status(duplicate ? 200 : 201).json({ id: entry.id, duplicate, values: JSON.parse(entry.data) });
  })
);

/** One file for a File field, sent as the raw request body (X-File-Name header). */
fillRouter.post(
  "/:slug/files",
  express.raw({ type: () => true, limit: "11mb" }),
  asyncHandler(async (req, res) => {
    const form = await findForm(req.params.slug);
    const doc = liveDoc(form) ?? (isFormAdmin(req.user) ? readDoc(form.draftSchema) : null);
    if (!doc) throw notFound("This form isn't available.");
    const blocker = form.liveSchema ? fillBlocker(form, doc, req.user) : null;
    if (blocker && !isFormAdmin(req.user)) throw new HttpError(blocker.status, blocker.message);
    const field = String(req.query.field ?? "");
    const name = decodeURIComponent(String(req.headers["x-file-name"] ?? "upload"));
    if (!Buffer.isBuffer(req.body)) throw badRequest("Send the file as the request body.");
    const row = await saveUpload(form, doc, field, { name, mime: String(req.headers["content-type"] ?? ""), data: req.body });
    res.status(201).json(row);
  })
);

// ── Entries ──────────────────────────────────────────────────────────────

async function readable(req: Request) {
  if (!req.user) throw unauthorized();
  const form = await findForm(req.params.slug);
  const doc = liveDoc(form) ?? readDoc(form.draftSchema);
  if (!canReadEntries(doc, req.user)) throw forbidden("You can't see this form's entries.");
  return { form, doc };
}

function filterOf(req: Request): EntryFilter {
  const q = req.query;
  return {
    q: typeof q.q === "string" ? q.q : undefined,
    from: typeof q.from === "string" && q.from ? q.from : undefined,
    to: typeof q.to === "string" && q.to ? q.to : undefined,
    status: q.status === "voided" || q.status === "all" ? q.status : "active",
    starred: q.starred === "1",
    site: typeof q.site === "string" && q.site ? q.site : undefined,
  };
}

async function siteNames() {
  const sites = await prisma.site.findMany({ select: { id: true, name: true, code: true } });
  return new Map(sites.map((s) => [s.id, { name: s.name, code: s.code }]));
}

fillRouter.get(
  "/:slug/entries",
  asyncHandler(async (req, res) => {
    const { form, doc } = await readable(req);
    const where = entryWhere(form, req.user, filterOf(req));
    const take = Math.min(200, Math.max(1, Number(req.query.take) || 50));
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const [rows, total, sites] = await Promise.all([
      prisma.formEntry.findMany({ where, orderBy: { createdAt: "desc" }, take, skip, include: { _count: { select: { notes: true } } } }),
      prisma.formEntry.count({ where }),
      siteNames(),
    ]);
    res.json({
      form: { id: form.id, slug: form.slug, title: form.title, status: form.status, version: form.liveVersion },
      doc,
      total,
      items: rows.map((e) => entryRow({ ...e, site: e.siteId ? sites.get(e.siteId) ?? null : null })),
      canVoid: canVoidEntries(doc, req.user),
      isAdmin: isFormAdmin(req.user),
    });
  })
);

fillRouter.get(
  "/:slug/entries-export",
  asyncHandler(async (req, res) => {
    const { form, doc } = await readable(req);
    const format = req.query.format === "xlsx" ? "xlsx" : "csv";
    const file = await exportEntries(form, doc, entryWhere(form, req.user, filterOf(req)), format);
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.type(file.mime).send(file.body);
  })
);

async function entryIn(req: Request, formId: string) {
  const entry = await prisma.formEntry.findFirst({ where: { id: req.params.id, formId } });
  if (!entry) throw notFound("No such entry.");
  const ids = req.user?.siteIds;
  if (ids && entry.siteId && !ids.includes(entry.siteId)) throw forbidden("This entry is for a site you aren't assigned to.");
  return entry;
}

fillRouter.get(
  "/:slug/entries/:id",
  asyncHandler(async (req, res) => {
    const { form, doc: liveOrDraft } = await readable(req);
    const entry = await entryIn(req, form.id);
    const [doc, notes, sites, neighbours] = await Promise.all([
      docForEntry(form, entry.formVersion),
      prisma.formEntryNote.findMany({ where: { entryId: entry.id }, orderBy: { createdAt: "asc" } }),
      siteNames(),
      Promise.all([
        prisma.formEntry.findFirst({ where: { formId: form.id, status: entry.status, createdAt: { gt: entry.createdAt }, ...entryScope(req.user) }, orderBy: { createdAt: "asc" }, select: { id: true } }),
        prisma.formEntry.findFirst({ where: { formId: form.id, status: entry.status, createdAt: { lt: entry.createdAt }, ...entryScope(req.user) }, orderBy: { createdAt: "desc" }, select: { id: true } }),
      ]),
    ]);
    res.json({
      form: { id: form.id, slug: form.slug, title: form.title },
      doc,
      entry: entryRow({ ...entry, site: entry.siteId ? sites.get(entry.siteId) ?? null : null }),
      notes,
      newerId: neighbours[0]?.id ?? null,
      olderId: neighbours[1]?.id ?? null,
      canVoid: canVoidEntries(liveOrDraft, req.user),
      isAdmin: isFormAdmin(req.user),
    });
  })
);

fillRouter.patch(
  "/:slug/entries/:id",
  asyncHandler(async (req, res) => {
    const { form } = await readable(req);
    if (!isFormAdmin(req.user)) throw forbidden("Only admins can edit entries.");
    const entry = await entryIn(req, form.id);
    const { values } = z.object({ values: z.record(z.unknown()) }).parse(req.body);
    const updated = await updateEntry(form, entry, values, req.user!.name);
    res.json(entryRow(updated));
  })
);

fillRouter.post(
  "/:slug/entries/:id/void",
  asyncHandler(async (req, res) => {
    const { form, doc } = await readable(req);
    if (!canVoidEntries(doc, req.user)) throw forbidden("You can't void entries.");
    const entry = await entryIn(req, form.id);
    const { reason, restore } = z.object({ reason: z.string().trim().max(500).optional(), restore: z.boolean().optional() }).parse(req.body);
    if (restore) {
      if (!isFormAdmin(req.user)) throw forbidden("Only admins can restore a voided entry.");
      await prisma.formEntry.update({ where: { id: entry.id }, data: { status: "active", voidedAt: null, voidedByName: null, voidReason: null } });
      await prisma.formEntryNote.create({ data: { entryId: entry.id, kind: "system", authorName: req.user!.name, body: "Restored (no longer void)." } });
    } else {
      if (!reason) throw badRequest("Say why this entry is being voided.");
      await prisma.formEntry.update({ where: { id: entry.id }, data: { status: "voided", voidedAt: new Date(), voidedByName: req.user!.name, voidReason: reason } });
      await prisma.formEntryNote.create({ data: { entryId: entry.id, kind: "system", authorName: req.user!.name, body: `Voided: ${reason}` } });
    }
    res.json({ ok: true });
  })
);

fillRouter.post(
  "/:slug/entries/:id/star",
  asyncHandler(async (req, res) => {
    const { form } = await readable(req);
    const entry = await entryIn(req, form.id);
    const { starred } = z.object({ starred: z.boolean() }).parse(req.body);
    await prisma.formEntry.update({ where: { id: entry.id }, data: { starred } });
    res.json({ ok: true });
  })
);

fillRouter.post(
  "/:slug/entries/:id/notes",
  asyncHandler(async (req, res) => {
    const { form } = await readable(req);
    const entry = await entryIn(req, form.id);
    const { body } = z.object({ body: z.string().trim().min(1).max(4000) }).parse(req.body);
    const note = await prisma.formEntryNote.create({ data: { entryId: entry.id, kind: "note", authorName: req.user!.name, body } });
    res.status(201).json(note);
  })
);

fillRouter.delete(
  "/:slug/entries/:id",
  asyncHandler(async (req, res) => {
    const { form } = await readable(req);
    if (!isFormAdmin(req.user)) throw forbidden("Only admins can delete entries.");
    const entry = await entryIn(req, form.id);
    await prisma.formFile.deleteMany({ where: { entryId: entry.id } });
    await prisma.formEntry.delete({ where: { id: entry.id } });
    res.json({ ok: true });
  })
);

fillRouter.get(
  "/:slug/files/:fileId",
  asyncHandler(async (req, res) => {
    const { form } = await readable(req);
    const file = await prisma.formFile.findFirst({ where: { id: req.params.fileId, formId: form.id } });
    if (!file) throw notFound("No such file.");
    if (file.entryId) {
      req.params.id = file.entryId;
      await entryIn(req, form.id);
    }
    const inline = /^(image\/|application\/pdf$)/.test(file.mime) && req.query.download !== "1";
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(file.name)}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Uploaded content is shown as a file, never as a page of this site.
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    res.type(inline ? file.mime : "application/octet-stream").send(Buffer.from(file.data));
  })
);
