import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/prisma.js";
import { decodeCsv, importTenants, readRows } from "../src/services/tenantImport.js";
import { ensureSiteLocations } from "../src/services/siteLocations.js";

/**
 * Seed for the local prototype:
 *   1. demo staff accounts for the dev sign-in screen (at least one per role)
 *   2. (the forms catalog starts empty: forms are added as they're built)
 *   3. the real tenant list from data/tenant_list.csv
 *   4. DEMO ONLY — backdates the attention clock on a slice of residents so the
 *      48-hour review queue has something in it on day one. Nothing is written
 *      to the activity log; these people simply look "not seen since import".
 *      Skip with SEED_DEMO_QUEUE=false.
 */
const DEMO_USERS = [
  { name: "Collin Falkowski", email: "cfalkowski@lanterncommunity.org", roleKey: "admin", avatarColor: "#1d4ed8", title: "Systems" },
  { name: "Jordan Main Office", email: "mainoffice.demo@lanterncommunity.org", roleKey: "main_office", avatarColor: "#be185d" },
  { name: "Avery Site Admin", email: "siteadmin.demo@lanterncommunity.org", roleKey: "site_admin", avatarColor: "#0369a1" },
  { name: "Morgan Site Manager", email: "manager.demo@lanterncommunity.org", roleKey: "site_manager", avatarColor: "#7c3aed" },
  { name: "Riley Case Worker", email: "staff.demo@lanterncommunity.org", roleKey: "site_staff", avatarColor: "#0f766e" },
  { name: "Pat Partner", title: "Partner org (Google Workspace)", email: "partner.demo@partnerorg.org", roleKey: "site_staff", avatarColor: "#c2410c", identityProvider: "google.com" },
];

async function main() {
  for (const u of DEMO_USERS) {
    await prisma.user.upsert({ where: { email: u.email }, create: { ...u, status: "active" }, update: {} });
  }
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: DEMO_USERS[0].email } });

  const csvPath = path.resolve(process.cwd(), process.env.TENANT_CSV ?? "../data/tenant_list.csv");
  if (fs.existsSync(csvPath)) {
    const summary = await importTenants(readRows(decodeCsv(fs.readFileSync(csvPath))), {
      commit: true,
      actor: { id: admin.id, name: `${admin.name} (seed import)` },
    });
    console.log(`Imported ${summary.added} residents (${summary.alreadyPresent} already present) across ${summary.bySite.length} sites.`);
  } else {
    console.warn(`No tenant list at ${csvPath} — skipping import.`);
  }

  const located = await ensureSiteLocations();
  if (located) console.log(`Filled in the location of ${located} sites from the site map.`);

  // Scope the demo staff to a couple of sites so site access is visible.
  const scoped = await prisma.site.findMany({ where: { code: { in: ["amber-hall", "rockaway-terrace"] } } });
  // Assignment is strict: a non-admin with no sites sees no rosters.
  const staff = await prisma.user.findMany({ where: { roleKey: { in: ["site_admin", "site_manager", "site_staff"] } } });
  for (const u of staff) {
    for (const s of scoped) {
      await prisma.userSite.upsert({ where: { userId_siteId: { userId: u.id, siteId: s.id } }, create: { userId: u.id, siteId: s.id }, update: {} });
    }
  }

  if ((process.env.SEED_DEMO_QUEUE ?? "true") !== "false") {
    const active = await prisma.tenant.findMany({ where: { status: "active", lastActivityAt: null, lastKeptAt: null }, select: { id: true } });
    let aged = 0;
    for (const t of active) {
      // ~7% of residents, deterministic by id so re-seeding is stable.
      const h = [...t.id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);
      if (h % 100 >= 7) continue;
      const hoursAgo = 49 + (h % 120);
      // createdAt moves with it so the card doesn't say "added today, quiet 5 days".
      const at = new Date(Date.now() - hoursAgo * 3600_000);
      await prisma.tenant.update({ where: { id: t.id }, data: { attentionClockAt: at, createdAt: at } });
      aged++;
    }
    console.log(`Demo: ${aged} residents placed in the 48-hour review queue.`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
