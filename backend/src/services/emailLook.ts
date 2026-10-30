import { z } from "zod";
import { badRequest } from "../http.js";
import { getSetting, setSetting } from "./settings.js";
import { audit, type Actor } from "./audit.js";

/**
 * How every email from the site looks (Admin → Notifications → Look): the name
 * in the band, the band's, stripe's and button's colors, an optional logo, and
 * the footer line. One setting (emailLook, JSON); Super Admins change it.
 *
 * Read on every email, so it's kept in memory (loaded at start, after a
 * change, and at most a minute old on any server). Colors that white text
 * can't be read on are refused: the band and the button carry white text.
 *
 * The sender's name and address aren't here: an email goes from the MAIL_FROM
 * mailbox under its own name in Microsoft 365.
 */

export const DEFAULT_LOOK = {
  orgName: "Lantern Community Services",
  bandColor: "#2c3453",
  accentColor: "#6baac4",
  buttonColor: "#2c3453",
  logoUrl: "",
  footer: "This is an automated notification from Lantern Forms. Please do not reply to this email.",
};
export type EmailLook = typeof DEFAULT_LOOK;

const hex = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Use a color like #2c3453.").transform((v) => v.toLowerCase());
export const lookInput = z
  .object({
    orgName: z.string().trim().min(1, "Give the name shown in the band.").max(80),
    bandColor: hex,
    accentColor: hex,
    buttonColor: hex,
    logoUrl: z
      .string()
      .trim()
      .max(500)
      .refine((v) => !v || /^https:\/\/[^\s"'<>]+$/.test(v), "A logo needs a full https:// address of an image anyone can open.")
      .default(""),
    footer: z.string().trim().min(1, "Say something in the footer, e.g. that it's automated.").max(300),
  })
  .strict();

/** WCAG contrast of white text on a color: 4.5 is the least for normal text. */
export function whiteContrast(color: string) {
  const c = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return 1.05 / (lum + 0.05);
}

let cached: { at: number; look: EmailLook } | null = null;
const TTL = 60_000;

function parseStored(raw: string): EmailLook {
  if (!raw) return DEFAULT_LOOK;
  try {
    const p = lookInput.safeParse({ ...DEFAULT_LOOK, ...(JSON.parse(raw) as object) });
    return p.success ? { ...DEFAULT_LOOK, ...p.data } : DEFAULT_LOOK;
  } catch {
    return DEFAULT_LOOK;
  }
}

/** Read it again (at start, after a change, and every minute). */
export async function loadLook(): Promise<EmailLook> {
  const look = parseStored(await getSetting("emailLook").catch(() => ""));
  cached = { at: Date.now(), look };
  return look;
}

/** The look now, for brandedEmail (which is synchronous): the cached one, refreshed in the background when old. */
export function currentLook(): EmailLook {
  if (!cached || Date.now() - cached.at > TTL) void loadLook().catch(() => undefined);
  return cached?.look ?? DEFAULT_LOOK;
}

export function checkLook(input: unknown): EmailLook {
  const p = lookInput.safeParse(input);
  if (!p.success) throw badRequest(p.error.issues.map((i) => `${i.path.join(".") || "look"}: ${i.message}`).join("; "));
  const look = { ...DEFAULT_LOOK, ...p.data };
  for (const [k, label] of [["bandColor", "The band"], ["buttonColor", "The button"]] as const) {
    const ratio = whiteContrast(look[k]);
    if (ratio < 4.5) throw badRequest(`${label}'s color is too light for its white text (contrast ${ratio.toFixed(1)}:1; it needs 4.5:1). Pick a darker color.`);
  }
  return look;
}

export async function saveLook(input: unknown, actor: Actor): Promise<EmailLook> {
  const before = await loadLook();
  const look = checkLook(input);
  const same = JSON.stringify(look) === JSON.stringify(DEFAULT_LOOK);
  await setSetting("emailLook", same ? "" : JSON.stringify(look));
  cached = { at: Date.now(), look };
  const changed = (Object.keys(look) as (keyof EmailLook)[]).filter((k) => before[k] !== look[k]);
  await audit({
    actor,
    action: "email.look_changed",
    summary: same ? "Put the email look back to the default" : `Changed how emails look${changed.length ? `: ${changed.join(", ")}` : ""}`,
    changes: Object.fromEntries(changed.map((k) => [k, [before[k], look[k]]])),
  }).catch(() => undefined);
  return look;
}
