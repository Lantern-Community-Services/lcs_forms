import { z } from "zod";
import { prisma } from "../prisma.js";
import type { BuiltForm } from "@prisma/client";

/**
 * Entries from an old system saved straight into a code form's live entries:
 * the MCP tool import_code_entries and inbound hooks (apps/inbound.ts) share
 * this. Saved exactly as given: beforeCreate/afterCreate don't run, so nobody
 * is notified. Each entry has an externalId; one this form already has is
 * skipped, so sending the same entry again is safe. All or nothing.
 */
export const importedEntry = z.object({
  externalId: z.string().min(1).max(200),
  data: z.record(z.unknown()),
  site: z.string().optional().describe("Site code"),
  tenantId: z.string().optional().describe("Roster id of the resident it's about"),
  occurredAt: z.string().optional().describe("ISO time it happened"),
  createdByName: z.string().max(255).optional().describe("Who filed it in the old system"),
});
export type ImportedEntry = z.infer<typeof importedEntry>;

export interface ImportResult {
  saved: number;
  wouldSave?: number;
  skipped: string[];
  problems: { externalId: string; problem: string }[];
  /** The ids of the entries just saved, by externalId. */
  ids?: Record<string, string>;
}

const clientIdOf = (externalId: string) => `import:${externalId}`;

export async function importEntries(row: BuiltForm, entries: ImportedEntry[], opts: { dryRun?: boolean } = {}): Promise<ImportResult> {
  const problems: { externalId: string; problem: string }[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.externalId)) problems.push({ externalId: e.externalId, problem: "Sent twice in this batch." });
    seen.add(e.externalId);
    if (e.occurredAt && Number.isNaN(Date.parse(e.occurredAt))) problems.push({ externalId: e.externalId, problem: `occurredAt "${e.occurredAt}" isn't a date.` });
    if (JSON.stringify(e.data).length > 200_000) problems.push({ externalId: e.externalId, problem: "data is over 200 KB." });
  }
  const codes = [...new Set(entries.map((e) => e.site).filter((s): s is string => Boolean(s)))];
  const sites = new Map((await prisma.site.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } })).map((s) => [s.code, s.id]));
  const tenantIds = [...new Set(entries.map((e) => e.tenantId).filter((t): t is string => Boolean(t)))];
  const tenants = new Map((await prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, siteId: true } })).map((t) => [t.id, t.siteId]));
  for (const e of entries) {
    if (e.site && !sites.has(e.site)) problems.push({ externalId: e.externalId, problem: `No site with code "${e.site}".` });
    if (e.tenantId && !tenants.has(e.tenantId)) problems.push({ externalId: e.externalId, problem: `No resident with id "${e.tenantId}".` });
  }

  const existing = new Set(
    (await prisma.formEntry.findMany({ where: { formId: row.id, clientId: { in: entries.map((e) => clientIdOf(e.externalId)) } }, select: { clientId: true } })).map((x) => x.clientId)
  );
  const fresh = entries.filter((e) => !existing.has(clientIdOf(e.externalId)));
  const skipped = entries.filter((e) => existing.has(clientIdOf(e.externalId))).map((e) => e.externalId);
  if (problems.length || opts.dryRun) return { saved: 0, wouldSave: problems.length ? 0 : fresh.length, skipped, problems };

  await prisma.formEntry.createMany({
    data: fresh.map((e) => ({
      formId: row.id,
      formVersion: row.liveVersion,
      data: JSON.stringify(e.data),
      siteId: e.site ? sites.get(e.site)! : null,
      tenantId: e.tenantId ?? null,
      occurredAt: e.occurredAt ? new Date(e.occurredAt) : new Date(),
      source: "import",
      clientId: clientIdOf(e.externalId),
      createdByName: e.createdByName?.trim() || "Imported",
    })),
  });
  const ids: Record<string, string> = {};
  if (fresh.length) {
    const rows = await prisma.formEntry.findMany({ where: { formId: row.id, clientId: { in: fresh.map((e) => clientIdOf(e.externalId)) } }, select: { id: true, clientId: true } });
    for (const r of rows) if (r.clientId) ids[r.clientId.slice("import:".length)] = r.id;
  }
  return { saved: fresh.length, skipped, problems: [], ids };
}
