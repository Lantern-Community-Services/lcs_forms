import { createHash, randomBytes } from "node:crypto";
import type { Router } from "express";
import { prisma } from "../prisma.js";
import { appBaseUrl } from "../env.js";
import { HttpError } from "../http.js";
import type { CurrentUser } from "../auth/middleware.js";
import { callRoute, type CallFrom, type RouteCall } from "../ops/callRoute.js";

/**
 * Download links for files Claude (or an API key) asks for: a PDF of incident
 * reports, a roster in Excel, a CSV of entries.
 *
 * An MCP tool can't hand back a file, so it makes the file here and gets a link.
 * The file is made by the site's own export route, run in-process as the person
 * (ops/callRoute.ts) — the same permission checks, site limits and audit entry as
 * the Export button on screen; nothing about who may export what is copied here.
 *
 * The finished file is kept for an hour in the Setting table under
 * "download:<sha256 of the token>" and opens only for that person, signed in
 * (routes/download.ts) — or their own key. Expired files are cleared whenever a
 * link is made or opened.
 */

const PREFIX = "download:";
const LINK_MINUTES = 60;
const MAX_BYTES = 20 * 1024 * 1024;

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

interface Stored {
  userId: string;
  filename: string;
  mime: string;
  expiresAt: string;
  /** base64 */
  file: string;
}

async function clearExpired() {
  await prisma.setting.deleteMany({ where: { key: { startsWith: PREFIX }, updatedAt: { lt: new Date(Date.now() - LINK_MINUTES * 60_000) } } });
}

function filenameOf(disposition: string | undefined, fallback: string) {
  const m = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? "") ?? /filename="?([^";]+)"?/i.exec(disposition ?? "");
  if (!m) return fallback;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** Run an export route as the person and keep what it sends behind a one-hour link. */
export async function makeDownload(router: Router, call: RouteCall, user: CurrentUser, opts: { from?: CallFrom; fallbackName?: string } = {}) {
  const out = await callRoute(router, call, { user, from: opts.from });
  if (out.status >= 400 || !out.file) {
    const b = out.body as { error?: string; details?: unknown } | null;
    throw new HttpError(out.status >= 400 ? out.status : 500, b?.error ?? "That export didn't make a file.", b?.details);
  }
  if (out.file.bytes.length > MAX_BYTES) throw new HttpError(413, `That file is ${Math.round(out.file.bytes.length / 1048576)} MB, more than a link can hold (20 MB). Narrow it down (dates, site) and try again.`);
  const filename = filenameOf(out.file.disposition, opts.fallbackName ?? "export");
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + LINK_MINUTES * 60_000).toISOString();
  const stored: Stored = { userId: user.userId, filename, mime: out.file.type ?? "application/octet-stream", expiresAt, file: out.file.bytes.toString("base64") };
  await clearExpired();
  await prisma.setting.create({ data: { key: PREFIX + hashOf(token), value: JSON.stringify(stored) } });
  return {
    url: `${appBaseUrl}/api/download/${token}`,
    filename,
    sizeKb: Math.max(1, Math.round(out.file.bytes.length / 1024)),
    expiresAt,
    opens: `Only for ${user.name}, signed in to Lantern Forms, until ${expiresAt} (an hour). Give them the link to open; you can't fetch it.`,
  };
}

/** The file behind a link, if `userId` is the person it was made for. */
export async function openDownload(token: string, userId: string | null) {
  if (!/^[\w-]{20,64}$/.test(token)) throw new HttpError(404, "That link isn't right.");
  const row = await prisma.setting.findUnique({ where: { key: PREFIX + hashOf(token) } });
  const stored = row ? (JSON.parse(row.value) as Stored) : null;
  if (!stored || Date.parse(stored.expiresAt) < Date.now()) {
    await clearExpired();
    throw new HttpError(410, "This download link has expired (they last an hour). Ask Claude for a new one.");
  }
  if (!userId) throw new HttpError(401, "Sign in to open this file.");
  if (userId !== stored.userId) throw new HttpError(403, "This link was made for someone else.");
  return { filename: stored.filename, mime: stored.mime, bytes: Buffer.from(stored.file, "base64") };
}
