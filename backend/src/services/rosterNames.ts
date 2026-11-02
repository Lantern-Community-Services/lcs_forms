import { prisma } from "../prisma.js";
import { HttpError } from "../http.js";

/**
 * Residents' names don't belong in a form's definition.
 *
 * A form's definition (its fields, choices, descriptions, a code form's files)
 * is shown to everyone who opens the form, kept in its version history, and
 * copied to the form backup on GitHub (services/formBackup.ts). A dropdown of
 * "enrolled tenants" puts their names, and the fact that they're in the
 * program, in all of those places. A Resident field picks from the roster
 * instead, and the name lands only in the entry.
 *
 * So saving or publishing a definition that contains a name from the roster
 * (anyone on it, archived too) is refused, and the backup leaves out anything
 * that still has one. Matching is on whole words, "first last" or
 * "preferred last", ignoring case, accents, punctuation and _/- (so a choice
 * value like "maria_lopez" counts too).
 */

const TTL_MS = 5 * 60_000;
/** A name of more words than this isn't looked for (none on the roster comes close). */
const MAX_WORDS = 6;

let cache: { at: number; names: Set<string> } | null = null;

/** Lowercase words, without accents or punctuation; "_" and "-" separate words. */
function words(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z]+/)
    .filter(Boolean);
}

const key = (parts: string[]) => parts.join(" ");

/** Every roster name, as word lists joined by spaces. Read again every few minutes. */
export async function rosterNames(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.names;
  const rows = await prisma.tenant.findMany({ select: { firstName: true, lastName: true, preferredName: true } });
  const names = new Set<string>();
  for (const t of rows) {
    const last = words(t.lastName);
    if (!last.length) continue;
    for (const first of [t.firstName, t.preferredName]) {
      const given = words(first ?? "");
      // A last name alone ("Ibarra Vance") isn't a person.
      if (!given.length) continue;
      const w = [...given, ...last];
      // "Al Li" would match too much ordinary text; a name needs some substance.
      if (w.length >= 2 && w.length <= MAX_WORDS && key(w).length >= 6) names.add(key(w));
    }
  }
  cache = { at: Date.now(), names };
  return names;
}

/** After the roster changes wholesale (made-up data on a test site). */
export function forgetRosterNames() {
  cache = null;
}

/** The roster names that appear in `texts`, as written in the roster's word form ("maria lopez"), at most `limit`. */
export function namesIn(texts: string | string[], names: Set<string>, limit = 5): string[] {
  if (!names.size) return [];
  const found = new Set<string>();
  for (const text of Array.isArray(texts) ? texts : [texts]) {
    const w = words(text);
    for (let i = 0; i < w.length; i++) {
      for (let n = 2; n <= MAX_WORDS && i + n <= w.length; n++) {
        const k = key(w.slice(i, i + n));
        if (names.has(k)) found.add(k);
      }
      if (found.size >= limit) return [...found];
    }
  }
  return [...found];
}

const titleCase = (k: string) => k.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * Refuse a definition with residents' names in it. `what` names it for the
 * message ("This form", "server/index.ts").
 */
export async function refuseRosterNames(what: string, texts: string | string[]) {
  const found = namesIn(texts, await rosterNames());
  if (!found.length) return;
  throw new HttpError(
    400,
    `${what} has residents' names in it (${found.map(titleCase).join(", ")}${found.length === 5 ? ", …" : ""}). ` +
      "Names from the roster can't go in a form's fields, choices or code: everyone who opens the form sees them, and they're copied to the form backup. " +
      "Use a Resident field (it picks from the roster) instead.",
    { residentNames: found.length }
  );
}
