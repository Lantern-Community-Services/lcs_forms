import { setSiteNameLookup } from "./formEngine";

/**
 * Site codes → names the app has seen (its site lists, entries' sites), so a
 * Site question's answer reads as the site's name (formEngine formatValue). A
 * code it hasn't seen shows as itself. Filled as the data arrives, before the
 * screens showing it render.
 */
const names = new Map<string, string>();
setSiteNameLookup((code) => names.get(code));

type Named = { code?: string | null; name?: string | null } | null | undefined;

export function rememberSites(sites: readonly Named[] | null | undefined) {
  for (const s of sites ?? []) if (s?.code && s.name) names.set(s.code, s.name);
}
