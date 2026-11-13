import { Router } from "express";
import { asyncHandler, HttpError } from "../http.js";
import { currentUserById } from "../auth/middleware.js";
import { actorOf, audit } from "../services/audit.js";
import { openPdfLink } from "../apps/entryPdf.js";

/**
 * GET /api/pdf/<slug>.<token>: a PDF of a code form's entries that Claude (or an API key) asked for
 * (apps/entryPdf.ts). Opens only for the person who asked, signed in — or their own API key. Someone
 * not signed in is sent to sign in and brought back here.
 */
export const entryPdfRouter = Router();

entryPdfRouter.get(
  "/:link",
  asyncHandler(async (req, res) => {
    const link = req.params.link;
    // A key opens it as the admin who made it: only a key that reads entries at every site that person has.
    const key = req.apiKey && req.apiKey.scopes.includes("entries:read") && !req.apiKey.siteId ? req.apiKey : null;
    const userId = req.user?.viewAs ? req.user.viewAs.userId : req.user?.userId ?? key?.createdById ?? null;
    if (!userId && !req.headers.authorization && req.accepts(["html", "json"]) === "html") {
      res.redirect(`/signin?returnTo=${encodeURIComponent(`/api/pdf/${link}`)}`);
      return;
    }
    try {
      // Someone viewing as another person opens it as themself, never as the one they're viewing.
      const out = await openPdfLink(link, { userId, user: req.user && !req.user.viewAs ? req.user : null, loadUser: currentUserById });
      await audit({ actor: actorOf(req), action: "apps.exported", summary: `Opened a PDF of ${out.count} ${out.count === 1 ? "entry" : "entries"} (“${out.title}”) from code form “${out.app.manifest.title}”, made by Claude` });
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(out.file.filename)}"`);
      res.setHeader("Cache-Control", "private, no-store");
      res.type(out.file.mime).send(out.file.body);
    } catch (e) {
      if (!(e instanceof HttpError) || req.accepts(["html", "json"]) !== "html") throw e;
      res.status(e.status).type("html").send(page(e.message));
    }
  })
);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const page = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lantern Forms</title>` +
  `<body style="font-family:system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 16px;color:#232a3a"><h1 style="font-size:20px">Can't open this PDF</h1><p>${esc(msg)}</p><p><a href="/">Lantern Forms</a></p></body>`;
