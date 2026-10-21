import { z } from "zod";
import { TUTORIAL_MAX_STEPS } from "../forms/engine.js";

/**
 * A form's tutorial (FormTutorial in forms/engine.ts), as a zod schema: the
 * "tutorial" key of a basic form's document and of a code form's form.json.
 * Strict like the rest of the format, so "tittle" or "acton" is caught at save
 * time rather than silently ignored. What the shape can't say (a field that
 * doesn't exist, a fill step with nothing to fill) is lintTutorial's job.
 */

const roleList = z.array(z.string().max(64)).max(20);

export const tutorialStepSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z][\w-]{0,63}$/, "Step ids use letters, digits, - and _.").optional(),
    title: z.string().trim().min(1, "Give the step a title.").max(80),
    body: z.string().max(600).optional(),
    field: z.string().max(64).optional(),
    target: z.string().max(70).optional(),
    page: z.string().max(40).optional(),
    placement: z.enum(["auto", "top", "bottom", "left", "right"]).optional(),
    action: z.enum(["next", "click", "fill"]).optional(),
    roles: roleList.optional(),
    devices: z.array(z.enum(["phone", "tablet", "desktop"])).min(1).max(3).optional(),
  })
  .strict();

export const tutorialSchema = z
  .object({
    version: z.number().int().min(1).max(10_000).optional(),
    title: z.string().trim().max(80).optional(),
    autoStart: z.boolean().optional(),
    roles: roleList.optional(),
    steps: z.array(tutorialStepSchema).min(1, "A tutorial needs at least one step.").max(TUTORIAL_MAX_STEPS),
  })
  .strict();
