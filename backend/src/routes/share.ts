import { Router } from "express";
import { prisma } from "../prisma.js";
import { asyncHandler, forbidden, notFound } from "../http.js";
import { requireAuth } from "../auth/middleware.js";
import { actorOf } from "../services/audit.js";
import { findForm, readDoc } from "../forms/service.js";
import { isFormAdmin } from "../forms/entries.js";
import { canShare, formLinks, linkView, loadSharing, makeLink, myLink, saveSharing, turnOffLink } from "../services/shareLinks.js";

/**
 * Share links (services/shareLinks.ts): an employee's own link and QR code for
 * a form anyone can fill in through a link, and the form's sharing settings
 * and everyone's links for Admins (forms.manage).
 */
export const shareRouter = Router();
shareRouter.use(requireAuth);

/** My link for this form (if I have one that works), whether I can have one, and the form's settings. */
shareRouter.get(
  "/:form",
  asyncHandler(async (req, res) => {
    const form = await findForm(req.params.form);
    const can = await canShare(form, req.user);
    const link = await myLink(form, req.user!.userId);
    const settings = await loadSharing(form.id);
    const fromMine = await prisma.formEntry.count({ where: { formId: form.id, sharedById: req.user!.userId, status: "active" } });
    res.json({
      form: { id: form.id, slug: form.slug, title: form.title },
      canShare: can.ok,
      why: can.ok ? null : can.why,
      settings,
      link: link ? linkView(link) : null,
      entriesFromMyLinks: fromMine,
      isAdmin: isFormAdmin(req.user),
    });
  })
);

/** Make my link, or refresh it (the old one stops working): { length: { days } | { until } | { never: true } }. */
shareRouter.post(
  "/:form",
  asyncHandler(async (req, res) => {
    const form = await findForm(req.params.form);
    res.status(201).json(linkView(await makeLink(form, req.user!, req.body?.length)));
  })
);

/** Turn my link off. */
shareRouter.delete(
  "/:form/mine",
  asyncHandler(async (req, res) => {
    const form = await findForm(req.params.form);
    const link = await myLink(form, req.user!.userId);
    if (link) await turnOffLink(link, form, actorOf(req));
    res.json({ ok: true });
  })
);

// ── Admins ───────────────────────────────────────────────────────────────

/**
 * Admin → Share links: every form shared by link (live, or being set up in a
 * draft), each with its settings and everyone's links. Before "/:form" so
 * "all" isn't read as a form.
 */
shareRouter.get(
  "/all/forms",
  asyncHandler(async (req, res) => {
    if (!isFormAdmin(req.user)) throw forbidden("Only Admins see every form's share links.");
    const forms = await prisma.builtForm.findMany({ where: { kind: "basic", status: { not: "archived" } }, orderBy: { title: "asc" } });
    const out = [];
    for (const f of forms) {
      const mode = (d: string | null) => (d ? readDoc(d).settings.access?.mode : undefined);
      const live = mode(f.liveSchema) === "link";
      const draft = mode(f.draftSchema) === "link";
      if (!live && !draft) continue;
      const links = await formLinks(f);
      const entries = await prisma.formEntry.count({ where: { formId: f.id, status: "active", shareLinkId: { not: null } } });
      out.push({
        form: { id: f.id, slug: f.slug, title: f.title, status: f.status },
        live,
        settings: await loadSharing(f.id),
        working: links.filter((l) => linkView(l).live).length,
        entries,
        mine: links.some((l) => l.userId === req.user!.userId && linkView(l).live),
      });
    }
    res.json({ forms: out });
  })
);

shareRouter.get(
  "/:form/links",
  asyncHandler(async (req, res) => {
    if (!isFormAdmin(req.user)) throw forbidden("Only Admins see everyone's links.");
    const form = await findForm(req.params.form);
    res.json({ settings: await loadSharing(form.id), links: (await formLinks(form)).map(linkView) });
  })
);

shareRouter.put(
  "/:form/settings",
  asyncHandler(async (req, res) => {
    if (!isFormAdmin(req.user)) throw forbidden("Only Admins change how a form is shared.");
    const form = await findForm(req.params.form);
    res.json(await saveSharing(form, req.body, actorOf(req)));
  })
);

/** Turn off anyone's link (Admins), or your own. */
shareRouter.delete(
  "/links/:id",
  asyncHandler(async (req, res) => {
    const link = await prisma.formShareLink.findUnique({ where: { id: req.params.id } });
    if (!link) throw notFound("No such link.");
    if (link.userId !== req.user!.userId && !isFormAdmin(req.user)) throw forbidden("Only Admins turn off someone else's link.");
    const form = await findForm(link.formId);
    res.json(linkView(await turnOffLink(link, form, actorOf(req))));
  })
);
