import express, { Router, type Request } from "express";
import { prisma } from "../prisma.js";
import { asyncHandler, badRequest, contentDisposition, forbidden, notFound } from "../http.js";
import { canAccessSite, requireAuth, requirePermission } from "../auth/middleware.js";
import { actorOf, audit } from "../services/audit.js";
import { caseManagementEnabled } from "../services/settings.js";
import { displayName } from "../services/roster.js";
import { clientTimeline } from "../services/clientTimeline.js";
import {
  addDocument,
  DOCUMENT_ACCEPT,
  DOCUMENT_KINDS,
  documentBytes,
  documentWords,
  findDocument,
  listDocuments,
  MAX_DOCUMENT_BYTES,
  opensInBrowser,
  removeDocument,
} from "../services/clientDocuments.js";

/**
 * A resident's whole record on their page (case management): the timeline of
 * everything about them (services/clientTimeline.ts) and their documents
 * (services/clientDocuments.ts). Mounted beside the roster's own routes at
 * /api/tenants. With case management off every route answers 404; each needs
 * client information (clients.view, Admins have it) and the resident's site,
 * and adding or removing a document needs clients.edit.
 */
export const clientRecordRouter = Router();
clientRecordRouter.use(requireAuth);

async function gate(req: Request, need: "clients.view" | "clients.edit") {
  if (!(await caseManagementEnabled())) throw notFound("Case management is turned off.");
  if (!req.user?.permissions.includes(need)) throw forbidden(need === "clients.edit" ? "Only people who can change client information add or remove documents." : "Only people with client information see this.");
}

/** Checked before an upload's body is read, so nobody else's 20 MB is taken in first. */
const gateFirst = (need: "clients.view" | "clients.edit") =>
  asyncHandler(async (req, _res, next) => {
    await gate(req, need);
    next();
  });

async function loadTenant(req: Request, id: string) {
  const t = await prisma.tenant.findUnique({ where: { id } });
  if (!t || !canAccessSite(req, t.siteId)) throw notFound("Resident not found.");
  return t;
}

const by = (req: Request) => ({ id: req.user?.viewAs?.userId ?? req.user?.userId ?? null, name: actorOf(req).name });

// ── Timeline ─────────────────────────────────────────────────────────────

/** Newest first. ?before= the `next` of the page before; ?limit= up to 100 (30). */
clientRecordRouter.get(
  "/:id/timeline",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    await gate(req, "clients.view");
    const t = await loadTenant(req, req.params.id);
    res.json(await clientTimeline(t, req.user!, { before: req.query.before, limit: req.query.limit }));
  })
);

// ── Documents ────────────────────────────────────────────────────────────

clientRecordRouter.get(
  "/:id/documents",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    await gate(req, "clients.view");
    const t = await loadTenant(req, req.params.id);
    res.json({
      items: await listDocuments(t.id),
      canEdit: req.user!.permissions.includes("clients.edit"),
      kinds: DOCUMENT_KINDS,
      accept: DOCUMENT_ACCEPT,
      maxBytes: MAX_DOCUMENT_BYTES,
    });
  })
);

/**
 * Add one: the file as the raw body (sent as application/octet-stream, so no
 * body parser touches it), its name in X-File-Name and what it is in
 * X-Document-Kind and X-Document-Label, each URI-encoded.
 */
clientRecordRouter.post(
  "/:id/documents",
  requirePermission("roster.view"),
  gateFirst("clients.edit"),
  express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES + 1024 * 1024 }),
  asyncHandler(async (req, res) => {
    const t = await loadTenant(req, req.params.id);
    const header = (h: string) => {
      try {
        return decodeURIComponent(String(req.headers[h] ?? ""));
      } catch {
        throw badRequest(`The ${h} header isn't readable.`);
      }
    };
    if (!Buffer.isBuffer(req.body)) throw badRequest("Send the file as the request body.");
    const doc = await addDocument({ tenant: t, kind: header("x-document-kind"), label: header("x-document-label"), name: header("x-file-name"), data: req.body, by: by(req) });
    await audit({
      actor: actorOf(req),
      action: "client.document_added",
      tenantId: t.id,
      siteId: t.siteId,
      summary: `Added a document to ${displayName(t)}'s record (${documentWords(doc)})`,
      changes: { documentId: doc.id, kind: doc.kind, name: doc.name, size: doc.size },
    });
    res.status(201).json(doc);
  })
);

/** Open it (PDFs and photos show in the browser) or, with ?download=1, save it. Every one is audited. */
clientRecordRouter.get(
  "/:id/documents/:docId",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    await gate(req, "clients.view");
    const t = await loadTenant(req, req.params.id);
    const doc = await findDocument(t.id, req.params.docId);
    if (!doc) throw notFound("That document isn't on this resident's record.");
    const bytes = await documentBytes(doc);
    const inline = opensInBrowser(doc.mime) && req.query.download !== "1";
    await audit({
      actor: actorOf(req),
      action: "client.document_opened",
      tenantId: t.id,
      siteId: t.siteId,
      summary: `${inline ? "Opened" : "Downloaded"} a document on ${displayName(t)}'s record (${documentWords(doc)})`,
      changes: { documentId: doc.id },
    });
    res.setHeader("Content-Disposition", contentDisposition(inline ? "inline" : "attachment", doc.name));
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Resident documents: never kept by a browser or a proxy along the way.
    res.setHeader("Cache-Control", "no-store");
    // Shown as a file, never as a page of this site.
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    res.type(inline ? doc.mime : "application/octet-stream").send(bytes);
  })
);

/** Take it off their record. It's kept, marked removed (services/clientDocuments.ts). */
clientRecordRouter.delete(
  "/:id/documents/:docId",
  requirePermission("roster.view"),
  asyncHandler(async (req, res) => {
    await gate(req, "clients.edit");
    const t = await loadTenant(req, req.params.id);
    const doc = await findDocument(t.id, req.params.docId);
    if (!doc) throw notFound("That document isn't on this resident's record.");
    await removeDocument(doc, by(req));
    await audit({
      actor: actorOf(req),
      action: "client.document_removed",
      tenantId: t.id,
      siteId: t.siteId,
      summary: `Removed a document from ${displayName(t)}'s record (${documentWords(doc)})`,
      changes: { documentId: doc.id },
    });
    res.json({ ok: true });
  })
);
