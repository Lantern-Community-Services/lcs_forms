import crypto from "node:crypto";
import { z } from "zod";
import type { BuiltForm, FormShareLink } from "@prisma/client";
import { prisma } from "../prisma.js";
import { HttpError, badRequest, forbidden } from "../http.js";
import { appBaseUrl } from "../env.js";
import { currentUserById, type CurrentUser } from "../auth/middleware.js";
import { fillBlocker, liveDoc } from "../forms/entries.js";
import { audit, type Actor } from "./audit.js";

/**
 * Forms anyone can fill in through an employee's own link (access mode
 * "link"): LCS Art Submissions and the like, without another service.
 *
 * Every employee who can open such a form has their own link (/s/<token>) and
 * QR code. Refreshing turns the old link off and makes a new one; links
 * expire (90 days unless they pick otherwise, never past the form's longest);
 * and a link stops working when its owner can no longer open the form (they
 * left, or lost access). Entries through a link record whose it is, so they
 * can see them and routes can tell them.
 *
 * The form itself has no open address: signed out, it opens only through a
 * live link. Its sharing settings (FormRecord "sharing"/"settings") are
 * Admins': on or off, the default length and the longest.
 */

const COLLECTION = "sharing";
const DOC = "settings";
const DAY = 86_400_000;

export const sharingSchema = z
  .object({
    /** Off: nobody can make a link, and every link stops working. */
    enabled: z.boolean().default(true),
    /** A new link lasts this many days unless its owner picks otherwise. */
    defaultDays: z.number().int().min(1).max(3650).default(90),
    /** The longest a link may last; null = no limit (a link may never expire). */
    maxDays: z.number().int().min(1).max(3650).nullable().default(365),
  })
  .strict();
export type SharingSettings = z.infer<typeof sharingSchema>;
const DEFAULTS: SharingSettings = { enabled: true, defaultDays: 90, maxDays: 365 };

export async function loadSharing(formId: string): Promise<SharingSettings> {
  const row = await prisma.formRecord.findUnique({ where: { formId_collection_docId: { formId, collection: COLLECTION, docId: DOC } } });
  if (!row) return DEFAULTS;
  const p = sharingSchema.safeParse(JSON.parse(row.data));
  return p.success ? p.data : DEFAULTS;
}

export async function saveSharing(form: BuiltForm, input: unknown, actor: Actor): Promise<SharingSettings> {
  const p = sharingSchema.safeParse(input);
  if (!p.success) throw badRequest(p.error.issues.map((i) => `${i.path.join(".") || "sharing"}: ${i.message}`).join("; "));
  const s = p.data;
  if (s.maxDays !== null && s.defaultDays > s.maxDays) throw badRequest(`A new link can't last longer (${s.defaultDays} days) than the longest a link may last (${s.maxDays}).`);
  await prisma.formRecord.upsert({
    where: { formId_collection_docId: { formId: form.id, collection: COLLECTION, docId: DOC } },
    create: { formId: form.id, collection: COLLECTION, docId: DOC, data: JSON.stringify(s), updatedByName: actor.name.slice(0, 255) },
    update: { data: JSON.stringify(s), updatedByName: actor.name.slice(0, 255) },
  });
  await audit({ actor, action: "forms.sharing_changed", summary: `“${form.title}” share links: ${s.enabled ? `on, ${s.defaultDays} days by default, ${s.maxDays ? `at most ${s.maxDays}` : "no limit"}` : "off"}` }).catch(() => undefined);
  return s;
}

const isLinkForm = (form: BuiltForm) => {
  const doc = liveDoc(form);
  return Boolean(doc && doc.settings.access?.mode === "link");
};

/** Whether this person may have a link for this form: it's shared by link, sharing is on, and they can open it. */
export async function canShare(form: BuiltForm, user: CurrentUser | null | undefined): Promise<{ ok: true; settings: SharingSettings } | { ok: false; why: string }> {
  if (!user) return { ok: false, why: "Sign in to share this form." };
  const doc = liveDoc(form);
  if (!doc) return { ok: false, why: "This form isn't published yet." };
  if (doc.settings.access?.mode !== "link") return { ok: false, why: "This form isn't set to be shared by link. An Admin turns that on under Settings → Who can fill it in." };
  const settings = await loadSharing(form.id);
  if (!settings.enabled) return { ok: false, why: "Sharing this form by link is turned off." };
  const blocked = fillBlocker(form, doc, user);
  if (blocked) return { ok: false, why: blocked.message };
  return { ok: true, settings };
}

const live = (l: FormShareLink, now = Date.now()) => !l.revokedAt && (!l.expiresAt || l.expiresAt.getTime() > now);

/** A link as its owner (and Admins) see it. */
export function linkView(l: FormShareLink) {
  return {
    id: l.id,
    url: `${appBaseUrl}/s/${l.token}`,
    token: l.token,
    userId: l.userId,
    userName: l.userName,
    createdAt: l.createdAt,
    expiresAt: l.expiresAt,
    revokedAt: l.revokedAt,
    revokedByName: l.revokedByName,
    entries: l.entries,
    lastUsedAt: l.lastUsedAt,
    live: live(l),
  };
}

/** This person's link for the form that still works, if they have one. */
export async function myLink(form: BuiltForm, userId: string) {
  const rows = await prisma.formShareLink.findMany({ where: { formId: form.id, userId, revokedAt: null }, orderBy: { createdAt: "desc" } });
  return rows.find((l) => live(l)) ?? null;
}

/** How long a new link lasts: "days" (clamped to the form's longest), a date, or "never" (only with no limit). */
const lengthSchema = z.union([
  z.object({ days: z.number().int().min(1).max(3650) }).strict(),
  z.object({ until: z.string().datetime() }).strict(),
  z.object({ never: z.literal(true) }).strict(),
]);

function expiryOf(input: unknown, s: SharingSettings, now = Date.now()): Date | null {
  const p = input === undefined || input === null ? { success: true as const, data: { days: s.defaultDays } } : lengthSchema.safeParse(input);
  if (!p.success) throw badRequest("Say how long the link lasts: a number of days, a date, or never.");
  const d = p.data as { days?: number; until?: string; never?: true };
  if (d.never) {
    if (s.maxDays !== null) throw badRequest(`A link to this form lasts at most ${s.maxDays} days.`);
    return null;
  }
  const at = d.until ? Date.parse(d.until) : now + d.days! * DAY;
  if (at <= now + 60_000) throw badRequest("Pick a time in the future.");
  if (s.maxDays !== null && at > now + s.maxDays * DAY + 60_000) throw badRequest(`A link to this form lasts at most ${s.maxDays} days.`);
  return new Date(at);
}

/**
 * Make this person a new link: their old one (if any) stops working at once.
 * That's both the first link and "Refresh".
 */
export async function makeLink(form: BuiltForm, user: CurrentUser, length?: unknown) {
  const can = await canShare(form, user);
  if (!can.ok) throw forbidden(can.why);
  const expiresAt = expiryOf(length, can.settings);
  const old = await prisma.formShareLink.updateMany({ where: { formId: form.id, userId: user.userId, revokedAt: null }, data: { revokedAt: new Date(), revokedByName: user.name.slice(0, 255) } });
  // 24 characters of base64url: 144 random bits, not guessable.
  const token = crypto.randomBytes(18).toString("base64url");
  const row = await prisma.formShareLink.create({ data: { formId: form.id, userId: user.userId, userName: user.name.slice(0, 255), token, expiresAt } });
  await audit({
    actor: { id: user.userId, name: user.name },
    action: old.count ? "forms.share_link_refreshed" : "forms.share_link_made",
    summary: `${old.count ? "Refreshed" : "Made"} ${user.name}'s share link to “${form.title}”${expiresAt ? `, until ${expiresAt.toISOString().slice(0, 10)}` : ", no end date"}`,
  }).catch(() => undefined);
  return row;
}

/** Turn a link off: its owner, or an Admin. */
export async function turnOffLink(link: FormShareLink, form: BuiltForm, actor: Actor) {
  if (link.revokedAt) return link;
  const row = await prisma.formShareLink.update({ where: { id: link.id }, data: { revokedAt: new Date(), revokedByName: actor.name.slice(0, 255) } });
  await audit({ actor, action: "forms.share_link_off", summary: `Turned off ${link.userName}'s share link to “${form.title}”` }).catch(() => undefined);
  return row;
}

export async function formLinks(form: BuiltForm) {
  return prisma.formShareLink.findMany({ where: { formId: form.id }, orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }], take: 500 });
}

/** What someone opening a link that doesn't work is told: nothing about the form. */
const GONE = "This link doesn't work any more. Ask the person who shared it with you for a new one.";

export interface ShareContext {
  link: FormShareLink;
  form: BuiltForm;
}

/**
 * The form a share link opens, if the link works now: not turned off or past
 * its date, sharing still on, the form still shared by link and live, and its
 * owner still able to open it. Anything else is the same "doesn't work" answer.
 */
export async function resolveShare(token: string | null | undefined): Promise<ShareContext> {
  if (!token || !/^[A-Za-z0-9_-]{10,64}$/.test(token)) throw new HttpError(410, GONE);
  const link = await prisma.formShareLink.findUnique({ where: { token } });
  if (!link || !live(link)) throw new HttpError(410, GONE);
  const form = await prisma.builtForm.findUnique({ where: { id: link.formId } });
  if (!form || form.kind !== "basic" || !isLinkForm(form) || form.status === "archived" || form.status === "draft") throw new HttpError(410, GONE);
  if (!(await loadSharing(form.id)).enabled) throw new HttpError(410, GONE);
  const owner = await currentUserById(link.userId);
  if (!owner || fillBlocker(form, liveDoc(form)!, owner)) throw new HttpError(410, GONE);
  return { link, form };
}

/** Count an entry against the link it came through. */
export async function linkUsed(link: FormShareLink) {
  await prisma.formShareLink.update({ where: { id: link.id }, data: { entries: { increment: 1 }, lastUsedAt: new Date() } }).catch(() => undefined);
}
