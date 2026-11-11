import { Router } from "express";
import { asyncHandler } from "../http.js";
import { receiveInbound } from "../apps/inbound.js";

/**
 * Inbound hooks (apps/inbound.ts): another system POSTs here when something
 * is filed there. No sign-in: the unguessable token in the address is the
 * key, and it only ever adds entries to its one form through that form's own
 * converter action. The answer says what was saved, nothing more.
 */
export const appInboundRouter = Router();

appInboundRouter.post(
  "/:token",
  asyncHandler(async (req, res) => {
    const out = await receiveInbound(req.params.token, req.body);
    res.status(out.status).json(out.body);
  })
);
