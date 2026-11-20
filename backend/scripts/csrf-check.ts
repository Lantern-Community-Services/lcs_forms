/**
 * Checks auth/csrf.ts on a tiny app: which changes with a sign-in cookie get
 * through, and which are refused. No database needed.
 *   npx tsx scripts/csrf-check.ts
 */
import express from "express";
import cookieParser from "cookie-parser";
import type { AddressInfo } from "node:net";
import { csrfProtection } from "../src/auth/csrf.js";
import { AUTH_COOKIE } from "../src/auth/auth.js";
import { appBaseUrl } from "../src/env.js";

const app = express();
app.use(cookieParser());
app.use(csrfProtection);
app.all("/thing", (_req, res) => res.json({ ok: true }));
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://localhost:${port}`;
const TOKEN = "a".repeat(64);
const session = `${AUTH_COOKIE}=x`;

let failed = 0;
async function check(name: string, init: { method?: string; headers?: Record<string, string> }, want: number) {
  const res = await fetch(`${base}/thing`, { method: init.method ?? "POST", headers: init.headers });
  const ok = res.status === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} (got ${res.status}, want ${want})`);
  return res;
}

const own = appBaseUrl;
const evil = "https://evil.lanterncommunity.org";

const first = await check("GET with a session", { method: "GET", headers: { Cookie: session } }, 200);
const setCookie = first.headers.get("set-cookie") ?? "";
console.log(`${/lcs_csrf=[a-f0-9]{64}/.test(setCookie) ? "PASS" : (failed++, "FAIL")} a signed-in visit gets a CSRF token cookie`);
await check("POST without any sign-in cookie (API key, hook, public form)", { headers: { Origin: evil } }, 200);
await check("POST with a session from this app's own address", { headers: { Cookie: session, Origin: own } }, 200);
await check("POST with a session from another lanterncommunity.org page", { headers: { Cookie: session, Origin: evil } }, 403);
await check("…the same, with the right token", { headers: { Cookie: `${session}; lcs_csrf=${TOKEN}`, Origin: evil, "X-CSRF-Token": TOKEN } }, 200);
await check("…the same, with a wrong token", { headers: { Cookie: `${session}; lcs_csrf=${TOKEN}`, Origin: evil, "X-CSRF-Token": "b".repeat(64) } }, 403);
await check("…a token with no cookie to match", { headers: { Cookie: session, Origin: evil, "X-CSRF-Token": TOKEN } }, 403);
await check("PUT and DELETE are checked too", { method: "DELETE", headers: { Cookie: session, Origin: evil } }, 403);
await check("Origin null (a sandboxed frame)", { headers: { Cookie: session, Origin: "null" } }, 403);
await check("No Origin, Referer from another site", { headers: { Cookie: session, Referer: `${evil}/page` } }, 403);
await check("No Origin, Referer from this app", { headers: { Cookie: session, Referer: `${own}/f/x` } }, 200);
await check("No Origin or Referer, Sec-Fetch-Site cross-site", { headers: { Cookie: session, "Sec-Fetch-Site": "cross-site" } }, 403);
await check("No Origin or Referer, Sec-Fetch-Site same-site", { headers: { Cookie: session, "Sec-Fetch-Site": "same-site" } }, 403);
await check("No Origin, Referer or Sec-Fetch-Site (not a browser)", { headers: { Cookie: session } }, 200);
await check("Origin matching the address it was sent to (Host)", { headers: { Cookie: session, Origin: base } }, 200);
await check("Origin matching X-Forwarded-Host (behind Next)", { headers: { Cookie: session, Origin: "https://other-name.azurewebsites.net", "X-Forwarded-Host": "other-name.azurewebsites.net" } }, 200);
await check("GET from another site is left alone", { method: "GET", headers: { Cookie: session, Origin: evil } }, 200);

server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exitCode = failed ? 1 : 0;
