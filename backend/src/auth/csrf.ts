import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { appBaseUrl, env, isProd } from "../env.js";
import { AUTH_COOKIE, ONBOARDING_COOKIE, VIEW_AS_COOKIE } from "./auth.js";

/**
 * Cross-site request forgery: another website making a signed-in person's
 * browser change something here. The sign-in cookies are SameSite=Lax, which
 * keeps most other websites out — but every page on another
 * lanterncommunity.org address counts as the "same site" to a browser, so a
 * page there (the WordPress forms site, say) could still post here with
 * someone's session.
 *
 * So a request that changes something (anything but GET, HEAD, OPTIONS) and
 * carries one of our sign-in cookies has to show it came from this app, one of
 * two ways:
 *   - its CSRF token: the X-CSRF-Token header matches the lcs_csrf cookie
 *     (double submit). Only this app's own pages can read that cookie; the
 *     app's request helper (frontend lib/api.ts) sends it.
 *   - its Origin (or, without one, its Referer) is one of this app's own
 *     addresses. Browsers always send Origin on these requests and a page
 *     can't change it, so everything the app does passes this way too, even
 *     a request that doesn't send the token.
 * Requests without a sign-in cookie aren't affected: API keys, the MCP server,
 * OAuth, inbound hooks, public forms filled in signed out. Nor is a request
 * with no Origin, Referer or Sec-Fetch-Site at all: that's not a browser.
 */

/** The token's cookie is lcs_csrf (spelled out where it's used, so code scanning sees the check). */
export const CSRF_HEADER = "x-csrf-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SIGNED_IN_COOKIES = [AUTH_COOKIE, ONBOARDING_COOKIE, VIEW_AS_COOKIE];
const TOKEN_RE = /^[a-f0-9]{64}$/;

function originOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** This app's own addresses: CORS_ORIGIN and APP_BASE_URL. */
const OWN_ORIGINS = new Set([...env.corsOrigins, appBaseUrl].map(originOf).filter((o): o is string => Boolean(o)));

/** The token in the cookie and the one sent back match (constant time). */
export function csrfTokenValid(cookieToken: unknown, sent: unknown): boolean {
  if (typeof cookieToken !== "string" || typeof sent !== "string" || !TOKEN_RE.test(cookieToken) || !TOKEN_RE.test(sent)) return false;
  return crypto.timingSafeEqual(Buffer.from(cookieToken), Buffer.from(sent));
}

/** The request says it came from this app's own pages (Origin, else Referer). */
export function fromOwnOrigin(req: Pick<Request, "get">): boolean {
  const origin = req.get("origin");
  // A sandboxed frame or a file says "null": never ours.
  if (origin === "null") return false;
  const claimed = origin ? originOf(origin) : originOf(req.get("referer"));
  if (!claimed) {
    if (origin) return false;
    // No Origin and no Referer: not a browser asking from another page — unless it says it is.
    const site = req.get("sec-fetch-site");
    return !site || site === "same-origin" || site === "none";
  }
  if (OWN_ORIGINS.has(claimed)) return true;
  // The address the request was sent to (Next passes it on as X-Forwarded-Host): same address, same origin.
  const host = (req.get("x-forwarded-host") ?? req.get("host") ?? "").split(",")[0].trim().toLowerCase();
  return Boolean(host) && new URL(claimed).host.toLowerCase() === host;
}

export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  const signedIn = SIGNED_IN_COOKIES.some((name) => Boolean(req.cookies?.[name]));
  // A signed-in browser gets a token to send back (readable by the app's own pages only).
  if (signedIn && !TOKEN_RE.test(String(req.cookies?.lcs_csrf ?? ""))) {
    res.cookie("lcs_csrf", crypto.randomBytes(32).toString("hex"), { httpOnly: false, sameSite: "lax", secure: isProd, path: "/" });
  }
  if (SAFE_METHODS.has(req.method) || !signedIn) return next();
  if (csrfTokenValid(req.cookies?.lcs_csrf, req.get(CSRF_HEADER))) return next();
  if (fromOwnOrigin(req)) return next();
  res.status(403).json({ error: "That didn't come from a Lantern Forms page, so nothing was changed. Reload the page and try again." });
}
