#!/usr/bin/env node
/**
 * HTTPS in front of the dev server, for testing on a real iPad.
 *
 * iOS only runs a service worker — offline mode, the home-screen app opening
 * with no signal — on https. `next dev` serves plain http on 5200; this puts a
 * TLS proxy in front of it:
 *
 *   https://<this PC's LAN address>:5443   → the app (proxied to http://localhost:5200, HMR included)
 *   http://<this PC's LAN address>:5480    → the page to set up an iPad (install the certificate)
 *
 * The certificate comes from a local "Lantern Forms dev" certificate authority
 * made on first run, in frontend/.dev-https/ (git-ignored — the repo is public).
 * The authority is name-constrained to localhost and private LAN addresses
 * (10.x, 172.16-31.x, 192.168.x), so even trusted on a device it can't vouch
 * for any real site. The server certificate is remade whenever this PC's LAN
 * address changes; the authority stays, so an iPad only has to trust it once.
 *
 *   npm run dev:https                      (with `npm run dev` running)
 *   npm run dev:https -- --target 5300     (in front of something else, e.g. a production build)
 *
 * Pages served through it report the device's errors here (see "Remote console").
 *
 * Needs OpenSSL: Git for Windows ships one, found automatically.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const TARGET = opt("target", 5200);
const HTTPS_PORT = opt("port", 5443);
const SETUP_PORT = opt("setup-port", 5480);

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", ".dev-https");
const file = (n) => join(dir, n);
mkdirSync(dir, { recursive: true });

// ── OpenSSL ──────────────────────────────────────────────────────────────

function findOpenssl() {
  const candidates = [
    "openssl",
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
    "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe",
  ];
  for (const c of candidates) {
    try {
      execFileSync(c, ["version"], { stdio: "ignore" });
      return c;
    } catch {
      // next
    }
  }
  console.error("OpenSSL not found. Install Git for Windows (it includes OpenSSL), or put openssl on PATH.");
  process.exit(1);
}
const OPENSSL = findOpenssl();
const ssl = (...a) => execFileSync(OPENSSL, a, { stdio: ["ignore", "ignore", "pipe"] });

// ── The authority (once) ─────────────────────────────────────────────────

if (!existsSync(file("ca.key")) || !existsSync(file("ca.crt"))) {
  writeFileSync(
    file("ca.cnf"),
    [
      "[req]",
      "distinguished_name = dn",
      "prompt = no",
      "x509_extensions = ca_ext",
      "[dn]",
      `CN = Lantern Forms dev (${os.hostname()})`,
      "O = Lantern Community Services (development only)",
      "[ca_ext]",
      "basicConstraints = critical, CA:TRUE, pathlen:0",
      "keyUsage = critical, keyCertSign, cRLSign",
      "subjectKeyIdentifier = hash",
      // Only ever valid for this machine and private networks.
      "nameConstraints = critical, permitted;DNS:localhost, permitted;IP:127.0.0.0/255.0.0.0, permitted;IP:10.0.0.0/255.0.0.0, permitted;IP:172.16.0.0/255.240.0.0, permitted;IP:192.168.0.0/255.255.0.0",
      "",
    ].join("\n")
  );
  ssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "3650", "-keyout", file("ca.key"), "-out", file("ca.crt"), "-config", file("ca.cnf"));
  console.log("Made a new Lantern Forms dev certificate authority. Each iPad has to trust it once (see the setup page below).");
}

// ── The server certificate (remade when the LAN address changes) ─────────

const lanAddresses = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address))
    .map((i) => i.address)
    // Wi-Fi/Ethernet (192.168.x, 10.x) before virtual adapters (WSL and Hyper-V use 172.x).
    .sort((a, b) => rank(a) - rank(b));
const rank = (ip) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : 2);

const ips = ["127.0.0.1", ...lanAddresses()];
// v2: key identifiers added. Changing the recipe reissues the certificate (the authority stays).
const wanted = JSON.stringify({ v: 2, ips });
const have = existsSync(file("server.names")) ? readFileSync(file("server.names"), "utf8") : "";
if (have !== wanted || !existsSync(file("server.crt"))) {
  writeFileSync(
    file("server.cnf"),
    [
      "[req]",
      "distinguished_name = dn",
      "prompt = no",
      "[dn]",
      `CN = ${ips[1] ?? "localhost"}`,
      "[ext]",
      "basicConstraints = critical, CA:FALSE",
      "keyUsage = critical, digitalSignature, keyEncipherment",
      "extendedKeyUsage = serverAuth",
      "subjectKeyIdentifier = hash",
      "authorityKeyIdentifier = keyid:always",
      `subjectAltName = DNS:localhost, ${ips.map((ip) => `IP:${ip}`).join(", ")}`,
      "",
    ].join("\n")
  );
  ssl("req", "-newkey", "rsa:2048", "-nodes", "-sha256", "-keyout", file("server.key"), "-out", file("server.csr"), "-config", file("server.cnf"));
  // iOS refuses server certificates valid for more than 825 days.
  ssl("x509", "-req", "-in", file("server.csr"), "-CA", file("ca.crt"), "-CAkey", file("ca.key"), "-CAcreateserial", "-days", "800", "-sha256", "-extfile", file("server.cnf"), "-extensions", "ext", "-out", file("server.crt"));
  writeFileSync(file("server.names"), wanted);
}

// ── The proxy ────────────────────────────────────────────────────────────

const forwardedHeaders = (req) => ({
  ...req.headers,
  "x-forwarded-proto": "https",
  "x-forwarded-host": req.headers.host ?? "",
  "x-forwarded-for": req.socket.remoteAddress ?? "",
});

// ── Remote console (iPads have no dev tools without a Mac) ───────────────
//
// Every HTML page served through here gets a small script first thing in
// <head>. It reports uncaught errors, rejected promises and console errors and
// warnings from the device, plus a snapshot of what's on screen a few seconds
// after load, to /__lcs-dev-log, and they're printed in this window. Off with
// --no-remote-log.

const REMOTE_LOG = !args.includes("--no-remote-log");
const LOG_SCRIPT = String.raw`(() => {
  const send = (kind, data) => { try { navigator.sendBeacon ? navigator.sendBeacon("/__lcs-dev-log", JSON.stringify({ kind, path: location.pathname, data })) : fetch("/__lcs-dev-log", { method: "POST", body: JSON.stringify({ kind, path: location.pathname, data }), keepalive: true }); } catch (e) {} };
  const str = (v) => { try { return v instanceof Error ? (v.stack || v.message) : typeof v === "string" ? v : JSON.stringify(v); } catch (e) { return String(v); } };
  addEventListener("error", (e) => send("error", e.error ? str(e.error) : (e.message || "") + (e.filename ? " @ " + e.filename + ":" + e.lineno : e.target && e.target.src ? " loading " + e.target.src : "")), true);
  addEventListener("unhandledrejection", (e) => send("rejection", str(e.reason)));
  for (const level of ["error", "warn"]) { const orig = console[level]; console[level] = function () { send(level, Array.from(arguments).map(str).join(" ").slice(0, 2000)); return orig.apply(this, arguments); }; }
  const report = (label) => {
    const main = document.querySelector("main");
    const body = document.body;
    const css = (el) => el ? (({ opacity, visibility, display, color, backgroundColor, transform }) => ({ opacity, visibility, display, color, backgroundColor, transform }))(getComputedStyle(el)) : null;
    send("screen", { label, ua: navigator.userAgent, standalone: navigator.standalone === true, sw: !!(navigator.serviceWorker && navigator.serviceWorker.controller), size: innerWidth + "x" + innerHeight,
      bodyChildren: body ? body.children.length : 0, text: (body ? body.innerText : "").replace(/\s+/g, " ").slice(0, 300),
      main: main ? { css: css(main), rect: main.getBoundingClientRect().toJSON(), text: main.innerText.length } : null, body: css(body), root: css(document.documentElement) });
  };
  addEventListener("load", () => { setTimeout(() => report("3s after load"), 3000); setTimeout(() => report("10s after load"), 10000); });
})();`;

function devLog(req, res) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(204).end();
    try {
      const { kind, path, data } = JSON.parse(body);
      const who = (req.socket.remoteAddress ?? "").replace("::ffff:", "");
      const time = new Date().toLocaleTimeString();
      console.log(`[device ${who} ${time}] ${kind.toUpperCase()} ${path}\n  ${typeof data === "string" ? data.split("\n").join("\n  ") : JSON.stringify(data, null, 1).split("\n").join("\n  ")}`);
    } catch {
      // not ours
    }
  });
}

const isPage = (req) => req.method === "GET" && (req.headers.accept ?? "").includes("text/html");

const server = https.createServer({ key: readFileSync(file("server.key")), cert: readFileSync(file("server.crt")) }, (req, res) => {
  if (req.url === "/__lcs-dev-log" && req.method === "POST") return devLog(req, res);
  const inject = REMOTE_LOG && isPage(req);
  const headers = forwardedHeaders(req);
  // A page is rewritten, so ask for it uncompressed.
  if (inject) delete headers["accept-encoding"];
  const upstream = http.request({ host: "127.0.0.1", port: TARGET, method: req.method, path: req.url, headers }, (up) => {
    if (!inject || !String(up.headers["content-type"] ?? "").includes("text/html")) {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
      return;
    }
    const chunks = [];
    up.on("data", (c) => chunks.push(c));
    up.on("end", () => {
      const html = Buffer.concat(chunks).toString("utf8").replace(/<head([^>]*)>/i, (m) => `${m}<script>${LOG_SCRIPT}</script>`);
      const out = { ...up.headers };
      delete out["content-length"];
      delete out["transfer-encoding"];
      res.writeHead(up.statusCode ?? 200, out);
      res.end(html);
    });
  });
  upstream.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(`Couldn't reach http://localhost:${TARGET} (${e.code ?? e.message}). Is the dev server running?`);
  });
  req.pipe(upstream);
});

// A device refusing the certificate shows up here, not as a request. An iPad that
// doesn't trust the dev authority yet ends the handshake with "unknown ca" or
// "bad certificate" (a home-screen app then shows a blank white page).
server.on("tlsClientError", (err, socket) => {
  const who = (socket.remoteAddress ?? "").replace("::ffff:", "");
  const alert = /alert (\w+(?: \w+)*)/i.exec(err.message)?.[1] ?? err.code ?? err.message;
  console.log(`[device ${who} ${new Date().toLocaleTimeString()}] TLS REFUSED: ${alert}${/unknown ca|bad certificate|certificate unknown/i.test(err.message) ? "  ← this device doesn't trust the Lantern Forms dev certificate (setup page, steps 1–3)" : ""}`);
});
// Each page load, so it's clear which device reached the proxy at all.
server.on("request", (req) => {
  if (isPage(req)) console.log(`[device ${(req.socket.remoteAddress ?? "").replace("::ffff:", "")} ${new Date().toLocaleTimeString()}] PAGE ${req.url}`);
});

// WebSockets (the dev server's hot reload): a raw tunnel once the upgrade is asked for.
server.on("upgrade", (req, socket, head) => {
  const up = net.connect(TARGET, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [k, v] of Object.entries(forwardedHeaders(req))) for (const value of [v].flat()) if (value !== undefined) lines.push(`${k}: ${value}`);
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const close = () => {
    up.destroy();
    socket.destroy();
  };
  up.on("error", close);
  socket.on("error", close);
});

server.listen(HTTPS_PORT, "0.0.0.0");

// ── The setup page (plain http, so a device that doesn't trust us yet can open it) ──

const ca = readFileSync(file("ca.crt"));
const primary = ips[1] ?? "localhost";
const appUrl = `https://${primary}:${HTTPS_PORT}`;
const setupPage = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lantern Forms on this iPad</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:560px;margin:24px auto;padding:0 16px;color:#1d2433}
a.btn{display:inline-block;background:#2c3453;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:600}
li{margin:6px 0}code{background:#eef1f5;padding:1px 5px;border-radius:4px}</style>
<h1>Lantern Forms (development) on this iPad</h1>
<p>Do this once per iPad. It lets the iPad trust this PC's development server, so the app works offline over https.</p>
<ol>
<li><a class="btn" href="/lantern-forms-dev-ca.crt">Download the certificate</a> and tap <b>Allow</b>.</li>
<li>Open <b>Settings</b>, tap <b>Profile Downloaded</b> near the top, then <b>Install</b> (enter the passcode).</li>
<li>Open <b>Settings → General → About → Certificate Trust Settings</b> and turn on <b>Lantern Forms dev</b>.</li>
<li>Open <a href="${appUrl}">${appUrl}</a> in Safari. Sign in, then Share → <b>Add to Home Screen</b>. Delete any older Lantern Forms icon first.</li>
</ol>
<p>The certificate only works for this PC and private network addresses, never for real websites. Remove it any time under Settings → General → VPN &amp; Device Management.</p>`;

http
  .createServer((req, res) => {
    if (req.url?.startsWith("/lantern-forms-dev-ca.crt")) {
      res.writeHead(200, { "Content-Type": "application/x-x509-ca-cert", "Content-Disposition": 'attachment; filename="lantern-forms-dev-ca.crt"' });
      res.end(ca);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(setupPage);
  })
  .listen(SETUP_PORT, "0.0.0.0");

console.log(`
HTTPS for the dev server (http://localhost:${TARGET})

  App, on the iPad:   ${appUrl}
  iPad setup (once):  http://${primary}:${SETUP_PORT}
  On this PC:         https://localhost:${HTTPS_PORT}  (or keep using http://localhost:${TARGET})
${ips.length > 2 ? `\n  Other addresses this PC answers on: ${ips.slice(2).join(", ")}\n` : ""}`);
