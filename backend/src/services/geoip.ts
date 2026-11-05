import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import maxmind, { type CityResponse, type Reader } from "maxmind";

/**
 * Where an IP address is, roughly (city, region, country), for the audit log
 * and sign-ins. The lookup is a local file read: no IP address ever leaves
 * the server. The file is DB-IP's free "IP to City Lite" database (CC BY 4.0,
 * https://db-ip.com: the Activity page credits it), downloaded over HTTPS
 * once a month; no account or key. Until it's downloaded, or with GEOIP=false,
 * places are simply blank and IP addresses are still recorded.
 */

const DIR = process.env.GEOIP_DIR?.trim() || path.join(os.tmpdir(), "lantern-geoip");
const FILE = path.join(DIR, "dbip-city-lite.mmdb");
/** DB-IP publishes a new file each month; refresh a little after that. */
const MAX_AGE_MS = 35 * 86_400_000;
const urlFor = (d: Date) => `https://download.db-ip.com/free/dbip-city-lite-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}.mmdb.gz`;

let reader: Reader<CityResponse> | null = null;
let timer: NodeJS.Timeout | null = null;

async function download(): Promise<void> {
  fs.mkdirSync(DIR, { recursive: true });
  const now = new Date();
  // This month's file may not be out yet on the 1st: fall back to last month's.
  const tries = [now, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))];
  for (const d of tries) {
    const res = await fetch(urlFor(d));
    if (!res.ok || !res.body) continue;
    const tmp = `${FILE}.${process.pid}.tmp`;
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), zlib.createGunzip(), fs.createWriteStream(tmp));
    fs.renameSync(tmp, FILE);
    return;
  }
  throw new Error("DB-IP's free city database couldn't be downloaded.");
}

async function refresh(): Promise<void> {
  const fresh = fs.existsSync(FILE) && Date.now() - fs.statSync(FILE).mtimeMs < MAX_AGE_MS;
  if (!fresh) await download();
  reader = await maxmind.open<CityResponse>(FILE);
}

/** Open (downloading if needed) the location file, then check it daily. Never holds up the server. */
export function startGeoip() {
  if (process.env.GEOIP?.trim().toLowerCase() === "false" || timer) return;
  const run = () =>
    refresh()
      .then(() => console.log("  IP locations: DB-IP City Lite ready (looked up on this server)."))
      .catch((err) => console.error("[geoip] no IP locations for now:", err instanceof Error ? err.message : err));
  void run();
  timer = setInterval(() => void refresh().catch(() => undefined), 86_400_000);
  timer.unref();
}

/** "::ffff:203.0.113.5" → "203.0.113.5". */
export function cleanIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v = ip.trim().replace(/^::ffff:/i, "");
  // Only an address: an in-process call's "internal" isn't one.
  return /^[0-9a-f:.]+$/i.test(v) ? v.slice(0, 64) : null;
}

function isPrivate(ip: string): boolean {
  return (
    ip === "::1" || ip.startsWith("127.") || ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip)
  );
}

/** "Brooklyn, New York, US"; "Local network" for a private address; null when unknown. */
export function locate(ip: string | null | undefined): string | null {
  const v = cleanIp(ip);
  if (!v) return null;
  if (isPrivate(v)) return "Local network";
  if (!reader || !maxmind.validate(v)) return null;
  try {
    const r = reader.get(v);
    if (!r) return null;
    const parts = [r.city?.names?.en, r.subdivisions?.[0]?.names?.en, r.country?.iso_code ?? r.country?.names?.en].filter(Boolean);
    return parts.length ? [...new Set(parts)].join(", ").slice(0, 255) : null;
  } catch {
    return null;
  }
}

/** "Edge on Windows", "Safari on iPad": enough to tell devices apart, from the browser's own description. */
export function deviceFrom(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const os_ = /iPad/.test(ua) ? "iPad" : /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : null;
  if (/claude/i.test(ua)) return "Claude (MCP)";
  const app = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /node|undici|curl|python|axios/i.test(ua) ? "A program" : null;
  if (!app && !os_) return null;
  return app && os_ ? `${app} on ${os_}` : (app ?? os_);
}
