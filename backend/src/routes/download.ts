import { Router } from "express";
import { asyncHandler, contentDisposition, HttpError } from "../http.js";
import { actorOf, audit } from "../services/audit.js";
import { openDownload } from "../services/exportLinks.js";

/**
 * GET /api/download/<token>: a file Claude (or an API key) asked for (services/exportLinks.ts).
 * Opens only for the person it was made for, signed in — or their own key with entries:read at
 * every site. Someone not signed in is sent to sign in and brought back here.
 */
export const downloadRouter = Router();

downloadRouter.get(
  "/:token",
  asyncHandler(async (req, res) => {
    const token = req.params.token;
    const key = req.apiKey && req.apiKey.scopes.includes("entries:read") && !req.apiKey.siteId ? req.apiKey : null;
    // Someone viewing as another person opens it as themself.
    const userId = req.user?.viewAs ? req.user.viewAs.userId : req.user?.userId ?? key?.createdById ?? null;
    const browser = req.accepts(["html", "json"]) === "html";
    if (!userId && !req.headers.authorization && browser) {
      res.redirect(`/signin?returnTo=${encodeURIComponent(`/api/download/${token}`)}`);
      return;
    }
    try {
      const file = await openDownload(token, userId);
      await audit({ actor: actorOf(req), action: "download.opened", summary: `Opened “${file.filename}”, made for them by Claude` });
      const inline = /pdf/.test(file.mime);
      res.setHeader("Content-Disposition", contentDisposition(inline ? "inline" : "attachment", file.filename));
      res.setHeader("Cache-Control", "private, no-store");
      res.type(file.mime).send(file.bytes);
    } catch (e) {
      if (!(e instanceof HttpError) || !browser) throw e;
      res.status(e.status).type("html").send(page(e.message));
    }
  })
);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const page = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lantern Forms</title>` +
  `<body style="font-family:system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 16px;color:#232a3a"><h1 style="font-size:20px">Can't open this file</h1><p>${esc(msg)}</p><p><a href="/">Lantern Forms</a></p></body>`;
