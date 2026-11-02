import fs from "node:fs";
import { prisma } from "../src/prisma.js";
import { decodeCsv, importTenants, readRows } from "../src/services/tenantImport.js";

/**
 * Import a tenant list CSV (Property, Unit, Tenant).
 *
 *   npm run import:tenants -- ../data/tenant_list.csv            # dry run
 *   npm run import:tenants -- ../data/tenant_list.csv --commit   # write
 *
 * Re-runnable: people already on the roster at that unit are skipped.
 *
 * A real tenant list goes only into the live site's database: on a computer
 * this counts as a test site (env.ts testSite) and refuses, unless
 * DATA_MODE=real says DATABASE_URL is the live one.
 */
async function main() {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const commit = process.argv.includes("--commit");
  if (!file) throw new Error("Usage: npm run import:tenants -- <file.csv> [--commit]");
  const rows = readRows(decodeCsv(fs.readFileSync(file)));
  const summary = await importTenants(rows, { commit, actor: { id: null, name: "CLI import" } });
  console.log(commit ? "COMMITTED" : "DRY RUN (add --commit to write)");
  console.log(`  rows ${summary.rows}, blank skipped ${summary.skippedBlank}`);
  console.log(`  new sites: ${summary.sitesCreated.join(", ") || "none"}`);
  console.log(`  to add ${summary.added}, already present ${summary.alreadyPresent}`);
  for (const s of summary.bySite) console.log(`    ${s.site.padEnd(24)} +${s.added}  (=${s.alreadyPresent})`);
  if (summary.samples.length) {
    console.log("  name parsing samples:");
    for (const x of summary.samples) console.log(`    ${JSON.stringify(x.raw)} → ${x.parsed.firstName} | ${x.parsed.lastName} | pref ${x.parsed.preferredName ?? "-"}`);
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
