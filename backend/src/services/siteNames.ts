import { prisma } from "../prisma.js";
import { setSiteNameLookup } from "../forms/engine.js";

/**
 * Site codes → names, so a Site question's answer reads as the site's name
 * wherever the server shows it (forms/engine.ts formatValue: exports, emails,
 * merge tags, reports, the MCP's answers). Loaded at startup and kept fresh
 * once a minute; until then, or for a code it doesn't know, the code shows.
 */
let names = new Map<string, string>();
setSiteNameLookup((code) => names.get(code));

export async function loadSiteNames(): Promise<number> {
  const rows = await prisma.site.findMany({ select: { code: true, name: true } });
  names = new Map(rows.map((s) => [s.code, s.name]));
  return names.size;
}

export function startSiteNames() {
  const load = () => void loadSiteNames().catch((err) => console.error("[sites] could not load site names:", err));
  load();
  setInterval(load, 60_000).unref();
}
