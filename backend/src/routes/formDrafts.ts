import { Router } from "express";
import { z } from "zod";
import { asyncHandler, badRequest, notFound } from "../http.js";
import { caseManagementEnabled } from "../services/settings.js";
import { DRAFT_ID, discardDraft, draftForm, draftFull, draftSummary, listDrafts, ownDraft, saveDraft } from "../services/formDrafts.js";

/**
 * A basic form's unfinished answers, saved to the person's account
 * (services/formDrafts.ts): /api/f/<slug>/drafts. Mounted inside the fill
 * router; every route is the signed-in person's own drafts and nobody else's.
 */
export const formDraftsRouter = Router({ mergeParams: true });

// For now only while case management is on (Admin → Settings), with the rest of the PlanStreet
// work; otherwise unfinished answers stay on the device, as before (the app doesn't ask).
formDraftsRouter.use(
  asyncHandler(async (_req, _res, next) => {
    if (!(await caseManagementEnabled())) throw notFound("Saving unfinished answers to your account is part of case management, which is turned off.");
    next();
  })
);

const idOf = (raw: string) => {
  if (!DRAFT_ID.test(raw)) throw badRequest("That isn't a draft id.");
  return raw;
};

/** Mine for this form, newest first, without their answers. */
formDraftsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { form, me } = await draftForm(req.params.slug, req.user);
    res.json({ drafts: (await listDrafts(form, me)).map(draftSummary), version: form.liveVersion });
  })
);

/** One of mine, with its answers: resuming it. */
formDraftsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { form, me } = await draftForm(req.params.slug, req.user);
    res.json(draftFull(await ownDraft(form, me, idOf(req.params.id))));
  })
);

const saveBody = z.object({
  values: z.record(z.unknown()),
  label: z.string().max(200).nullable().optional(),
  siteCode: z.string().max(80).nullable().optional(),
  page: z.number().int().min(0).max(500).optional(),
  formVersion: z.number().int().positive().nullable().optional(),
  writer: z.string().regex(DRAFT_ID),
  base: z.string().max(40).nullable().optional(),
});

/** Save a draft under the id the device made for it: a new one, or over the old one. */
formDraftsRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = idOf(req.params.id);
    const body = saveBody.parse(req.body);
    const { form, doc, me } = await draftForm(req.params.slug, req.user);
    const { draft, dropped } = await saveDraft(form, doc, me, id, body);
    // dropped: a signature or file was left out; the page says those are asked for again.
    res.json({ ...draft, dropped });
  })
);

formDraftsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const removed = await discardDraft(req.params.slug, req.user, idOf(req.params.id));
    res.json({ ok: true, removed });
  })
);
