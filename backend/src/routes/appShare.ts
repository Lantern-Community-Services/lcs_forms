import express, { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler, badRequest, HttpError } from "../http.js";
import { createEntry, guestFor, requireOpen, runAction } from "../apps/runtime.js";
import { uploadAppFile } from "../apps/files.js";
import { fillMetaFields } from "../forms/fillMeta.js";
import { formIncludesOffice, notOffice, OFFICE } from "../services/officeSites.js";
import { linkUsed, resolveShare } from "../services/shareLinks.js";

/**
 * A code form filled in through an employee's share link (/s/<token>), not
 * signed in. Only what form.json "shareLink" opens: its one page, one new
 * entry at a time with its photos, and the server actions it lists — each
 * as a guest (apps/runtime.ts guestFor) with the sites of whoever shared the
 * link. Nothing here reads an entry back. Every call checks the link again,
 * so turning it off (or the owner losing the form) stops it at once.
 */
export const appShareRouter = Router();

/** The link, its code form, and the guest it stands for — or 410, saying nothing about the form. */
async function guestOf(req: Request) {
  const share = await resolveShare(req.params.token);
  if (!share.app) throw new HttpError(410, "This link doesn't work any more. Ask the person who shared it with you for a new one.");
  const guest = guestFor(share.owner);
  return { ...share, app: share.app, guest };
}

appShareRouter.get(
  "/:token/runtime",
  asyncHandler(async (req, res) => {
    const { app, guest, link } = await guestOf(req);
    const a = requireOpen(app, guest);
    // The sites the page may choose from, with where they are (for picking the one you're standing at):
    // the link owner's, and the Main Office when the form includes it.
    const office = await formIncludesOffice(app.form.id);
    const mine = guest.siteIds;
    const sites = await prisma.site.findMany({
      where: { active: true, ...(mine ? (office ? { OR: [{ id: { in: mine } }, { siteType: OFFICE }] } : { id: { in: mine } }) : {}), ...(office ? {} : notOffice) },
      orderBy: { name: "asc" },
      select: { id: true, code: true, name: true, siteType: true, latitude: true, longitude: true, geofenceMeters: true },
    });
    res.json({
      form: { id: app.form.id, slug: app.form.slug, title: app.manifest.title, status: app.form.status, version: app.form.liveVersion, draft: false },
      pages: a.pages.map((p) => ({ id: p.id, label: p.label, fullHeight: Boolean(p.fullHeight), hidden: false, nav: "never", width: p.width ?? "tablet" })),
      code: Object.fromEntries(Object.entries(app.build.pages).filter(([k]) => a.pages.some((p) => p.id === k.split("@")[0]))),
      css: app.build.css,
      hash: app.build.hash,
      user: { id: "", name: guest.name, email: "", roleKey: guest.roleKey, roleName: guest.roleName, permissions: [], siteIds: guest.siteIds, guest: true, sharedBy: guest.sharedBy },
      canEdit: false,
      canReadAll: false,
      offlineActions: [],
      tutorial: null,
      share: { sharedBy: link.userName, expiresAt: link.expiresAt, sites },
    });
  })
);

appShareRouter.post(
  "/:token/entries",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        data: z.record(z.unknown()),
        site: z.string().max(80).nullable().optional(),
        occurredAt: z.string().max(40).nullable().optional(),
        clientId: z.string().max(100).nullable().optional(),
        override: z.string().max(500).nullable().optional(),
        ...fillMetaFields,
      })
      .parse(req.body);
    const { app, guest, link } = await guestOf(req);
    // The same entry sent again (a retry) is answered "saved" but doesn't count against the link twice.
    const again = body.clientId ? await prisma.formEntry.findFirst({ where: { formId: app.form.id, clientId: body.clientId }, select: { id: true } }) : null;
    const out = await createEntry(app, guest, { ...body, ip: req.ip, userAgent: req.headers["user-agent"] }, {
      source: "share",
      share: { linkId: link.id, userId: link.userId, userName: link.userName },
    });
    if (out.status === "saved" && !again) await linkUsed(link);
    // The server's own logs never go to a guest.
    res.status(out.status === "saved" ? 201 : out.status === "needs_override" ? 409 : 422).json({ ...out, logs: undefined });
  })
);

/** A photo for the entry being filled in, as the raw body (like /api/apps/:slug/files). */
appShareRouter.post(
  "/:token/files",
  express.raw({ type: () => true, limit: "11mb" }),
  asyncHandler(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw badRequest("Send the file as the request body.");
    const header = (h: string) => decodeURIComponent(String(req.headers[h] ?? ""));
    const { app, guest } = await guestOf(req);
    res.status(201).json(await uploadAppFile(app, guest, { name: header("x-file-name") || "file", mime: header("x-file-type"), label: header("x-file-label"), data: req.body }));
  })
);

/** Only the actions form.json "shareLink.actions" lists (runAction refuses the rest for a guest). */
appShareRouter.post(
  "/:token/actions/:name",
  asyncHandler(async (req, res) => {
    const { app, guest } = await guestOf(req);
    const r = await runAction(app, guest, req.params.name, req.body?.args);
    if (!r.ok) return res.status(r.userError ? 400 : 500).json({ error: r.userError ? r.error : "Something went wrong. Try again in a moment." });
    res.json({ value: r.value });
  })
);
