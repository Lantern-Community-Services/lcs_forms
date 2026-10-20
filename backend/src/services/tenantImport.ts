import { parse } from "csv-parse/sync";
import { prisma } from "../prisma.js";
import type { Actor } from "./audit.js";
import { audit } from "./audit.js";
import { HttpError } from "../http.js";

/**
 * Import a property-management tenant list (Property, Unit, Tenant columns).
 *
 * Idempotent: a person already on the site's active roster at the same unit
 * with the same name is left alone, so the same export can be re-run safely.
 * The importer only ever ADDS — someone missing from a later export is not
 * archived automatically; that decision belongs to the review queue, where a
 * person makes it.
 */

export interface ParsedName {
  firstName: string;
  lastName: string;
  preferredName: string | null;
}

/**
 * Split a free-text name. (Examples are invented — never put real residents in code.)
 *   "Jane Example"                 → Jane / Example
 *   "Sample, Robert"               → Robert / Sample
 *   'Sample, Robert "Bobby"'       → Robert / Sample, preferred Bobby
 *   "Maria (Mimi) Placeholder"     → Maria / Placeholder, preferred Mimi
 *   "Alex “Lex” Testperson"         → Alex / Testperson, preferred Lex
 */
export function parseName(raw: string): ParsedName {
  let s = raw.replace(/[“”„«»]/g, '"').replace(/\s+/g, " ").trim();
  let preferredName: string | null = null;
  const nick = s.match(/["(]\s*([^")]+?)\s*[")]/);
  if (nick) {
    preferredName = nick[1].trim() || null;
    s = s.replace(nick[0], " ").replace(/\s+/g, " ").trim();
  }
  let firstName: string;
  let lastName: string;
  if (s.includes(",")) {
    const [last, ...rest] = s.split(",");
    lastName = last.trim();
    firstName = rest.join(" ").trim();
  } else {
    const parts = s.split(" ");
    lastName = parts.length > 1 ? parts.pop()! : "";
    firstName = parts.join(" ");
  }
  if (!firstName) {
    firstName = lastName;
    lastName = "";
  }
  return { firstName, lastName, preferredName };
}

/** "Amber Hall LP" → { name: "Amber Hall", code: "amber-hall" } */
export function siteFromEntity(entity: string) {
  const name = entity.replace(/\s+(LP|LLC|HDFC|Inc\.?|L\.P\.)$/i, "").trim();
  const code = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return { name, code };
}

/** Exports come out of Excel on Windows: try UTF-8, fall back to cp1252. */
export function decodeCsv(buf: Buffer): string {
  const utf8 = buf.toString("utf8");
  if (!utf8.includes("�")) return utf8.replace(/^﻿/, "");
  return new TextDecoder("windows-1252").decode(buf);
}

export interface ImportRow {
  property: string;
  unit: string;
  tenant: string;
}

const HEADERS = {
  property: ["property", "site", "building"],
  unit: ["unit", "apt", "room", "bed"],
  tenant: ["tenant", "name", "resident", "client"],
};

/**
 * Rows from the CSV text. A file split into parts may leave the header off
 * the later parts: with no recognisable header the columns are read in the
 * export's order — Property, Unit, Tenant.
 */
export function readRows(text: string): ImportRow[] {
  const records = parse(text, { skip_empty_lines: true, trim: true, relax_column_count: true }) as string[][];
  if (records.length === 0) return [];
  const head = records[0].map((h) => h.trim().toLowerCase());
  const col = (names: string[]) => head.findIndex((h) => names.includes(h));
  const hasHeader = col(HEADERS.property) >= 0 && col(HEADERS.tenant) >= 0;
  const [p, u, t] = hasHeader ? [col(HEADERS.property), col(HEADERS.unit), col(HEADERS.tenant)] : [0, 1, 2];
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  return (hasHeader ? records.slice(1) : records).map((r) => ({ property: cell(r, p), unit: cell(r, u), tenant: cell(r, t) }));
}

export interface ImportSummary {
  rows: number;
  skippedBlank: number;
  sitesCreated: string[];
  added: number;
  alreadyPresent: number;
  bySite: { site: string; added: number; alreadyPresent: number }[];
  samples: { site: string; unit: string; raw: string; parsed: ParsedName }[];
}

/** Rows per INSERT: 7 columns each keeps a batch well under SQL Server's 2,100 parameters. */
const INSERT_BATCH = 200;

/** One import call reads at most this many rows; split bigger files into parts. */
export const MAX_IMPORT_ROWS = 5000;

/**
 * The same person on the same unit, compared the way SQL Server's default
 * collation would (case-insensitive) so the in-memory check matches what the
 * row-by-row lookup used to find.
 */
const personKey = (siteId: string, unit: string | null, first: string, last: string) =>
  [siteId, unit ?? "", first, last].map((v) => v.toLowerCase()).join("\u0000");

/**
 * Set-based so a whole export fits in one request: one query for the sites,
 * one for who's already on their rosters, then batched inserts in a single
 * transaction (all of this call's rows land, or none do).
 *
 * part/parts label the audit event when a file arrives in pieces; each piece
 * is its own call and is safe to re-send.
 */
export async function importTenants(
  rows: ImportRow[],
  opts: { commit: boolean; actor: Actor; part?: { index: number; total: number } }
): Promise<ImportSummary> {
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new HttpError(413, `That's ${rows.length} rows; send at most ${MAX_IMPORT_ROWS} at a time (split the file into parts — re-sending a part is safe).`);
  }
  const summary: ImportSummary = {
    rows: rows.length,
    skippedBlank: 0,
    sitesCreated: [],
    added: 0,
    alreadyPresent: 0,
    bySite: [],
    samples: [],
  };

  // ── Sites: one lookup for every property in the file ──
  const properties = [...new Set(rows.filter((r) => r.property && r.tenant).map((r) => r.property))];
  const wanted = properties.map((property) => ({ property, ...siteFromEntity(property) }));
  const found = wanted.length
    ? await prisma.site.findMany({
        where: { OR: [{ entityName: { in: properties } }, { code: { in: wanted.map((w) => w.code) } }] },
        select: { id: true, code: true, entityName: true },
      })
    : [];
  const siteIds = new Map<string, string>();
  const toCreateSites: { code: string; name: string; entityName: string }[] = [];
  for (const w of wanted) {
    const existing = found.find((s) => s.entityName === w.property) ?? found.find((s) => s.code === w.code);
    if (existing) siteIds.set(w.property, existing.id);
    else if (!toCreateSites.some((s) => s.code === w.code)) {
      // Two spellings that slug the same ("Amber Hall LP", "Amber Hall") share one new site.
      toCreateSites.push({ code: w.code, name: w.name, entityName: w.property });
      summary.sitesCreated.push(w.name);
    }
  }
  if (opts.commit) {
    for (const s of toCreateSites) {
      const created = await prisma.site.create({ data: s, select: { id: true } });
      for (const w of wanted) if (w.code === s.code && !siteIds.has(w.property)) siteIds.set(w.property, created.id);
    }
  } else {
    for (const w of wanted) if (!siteIds.has(w.property)) siteIds.set(w.property, `new:${w.code}`);
  }

  // ── Who's already there: one read of those sites' active rosters ──
  const present = new Set<string>();
  const realSiteIds = [...new Set(siteIds.values())].filter((id) => !id.startsWith("new:"));
  if (realSiteIds.length) {
    const roster = await prisma.tenant.findMany({
      where: { siteId: { in: realSiteIds }, status: "active" },
      select: { siteId: true, unit: true, firstName: true, lastName: true },
    });
    for (const t of roster) present.add(personKey(t.siteId, t.unit, t.firstName, t.lastName));
  }

  const per = new Map<string, { added: number; alreadyPresent: number }>();
  const toCreate: { siteId: string; unit: string | null; firstName: string; lastName: string; preferredName: string | null; createdById: string | null }[] = [];
  for (const row of rows) {
    if (!row.property || !row.tenant) {
      summary.skippedBlank++;
      continue;
    }
    const { name } = siteFromEntity(row.property);
    const siteId = siteIds.get(row.property)!;
    const parsed = parseName(row.tenant);
    if (summary.samples.length < 12 && (parsed.preferredName || row.tenant.includes(","))) {
      summary.samples.push({ site: name, unit: row.unit, raw: row.tenant, parsed });
    }
    const bucket = per.get(name) ?? { added: 0, alreadyPresent: 0 };
    per.set(name, bucket);

    const unit = row.unit || null;
    const key = personKey(siteId, unit, parsed.firstName, parsed.lastName);
    if (present.has(key)) {
      summary.alreadyPresent++;
      bucket.alreadyPresent++;
      continue;
    }
    // A person listed twice in the file is added once.
    present.add(key);
    summary.added++;
    bucket.added++;
    toCreate.push({ siteId, unit, ...parsed, createdById: opts.actor.id });
  }

  if (opts.commit && toCreate.length) {
    const batches = [];
    for (let i = 0; i < toCreate.length; i += INSERT_BATCH) batches.push(prisma.tenant.createMany({ data: toCreate.slice(i, i + INSERT_BATCH) }));
    await prisma.$transaction(batches);
  }

  summary.bySite = [...per.entries()]
    .map(([site, v]) => ({ site, ...v }))
    .sort((a, b) => a.site.localeCompare(b.site));

  if (opts.commit) {
    const part = opts.part ? ` (part ${opts.part.index} of ${opts.part.total})` : "";
    await audit({
      actor: opts.actor,
      action: "import.completed",
      summary: `Imported ${summary.added} resident${summary.added === 1 ? "" : "s"} across ${summary.bySite.length} site${summary.bySite.length === 1 ? "" : "s"}${part}`,
      changes: { added: summary.added, alreadyPresent: summary.alreadyPresent, sitesCreated: summary.sitesCreated, ...(opts.part ? { part: opts.part } : {}) },
    });
  }
  return summary;
}
