import { noteBoot, startDevlog } from "./services/devlog.js";
import { createApp } from "./app.js";
import { devAuthEnabled, env, ssoConfigured } from "./env.js";
import { retireLegacyCatalog } from "./services/formCatalog.js";
import { migrateLegacyRoles } from "./services/permissions.js";
import { syncSuperAdmins } from "./services/superAdmins.js";
import { ensureSiteLocations } from "./services/siteLocations.js";
import { ensureDefaultCalendarCategories } from "./services/calendar.js";
import { startOutlookSync } from "./services/outlookSync.js";
import { startFormBackup } from "./services/formBackup.js";
import { startScheduler } from "./apps/schedule.js";
import { startJobs } from "./apps/jobs.js";
import { startNotificationMail } from "./services/notifications.js";
import { startEmailReports } from "./services/emailReports.js";
import { startFollowUpReminders } from "./services/followUp.js";
import { fileStorageLabel } from "./services/fileStore.js";
import { accessReady, ensureStartingGroups, startAccessRefresh } from "./services/staffGroups.js";

// First, so what the startup work below logs is in the dev log too.
startDevlog();

// A background task's promise that fails with nobody listening (a timer's
// database call while Azure SQL is waking up) is logged, not fatal: Node would
// otherwise stop the whole API and App Service would restart it in a loop.
process.on("unhandledRejection", (err) => console.error("[server] unhandled rejection:", err));

// The catalog starts empty and forms are added as they're rebuilt here; a
// database seeded with the old WordPress links has them taken out, once.
// Logged, never fatal.
retireLegacyCatalog()
  .then((r) => r && console.log(`  Forms catalog: removed the old default catalog (${r.cards} cards, ${r.categories} categories).`))
  .catch((err) => console.error("[forms] could not remove the old default catalog:", err));

ensureDefaultCalendarCategories()
  .then((wrote) => wrote && console.log("  Calendar: wrote the default categories."))
  .catch((err) => console.error("[calendar] could not write the default categories:", err));

if (startOutlookSync()) console.log("  Calendar: sending events to Outlook.");
if (startFormBackup()) console.log(`  Forms: backing up built forms to ${env.formBackup.repo}.`);
if (startScheduler()) console.log("  Code forms: running scheduled actions.");
startJobs();
startNotificationMail();
startEmailReports();
startFollowUpReminders();

ensureSiteLocations()
  .then((n) => n && console.log(`  Sites: filled in the location of ${n} sites from the site map.`))
  .catch((err) => console.error("[sites] could not fill in site locations:", err));

migrateLegacyRoles()
  .then((n) => n && console.log(`  Roles: moved ${n} people off retired roles.`))
  .catch((err) => console.error("[roles] could not migrate retired roles:", err));

// Staff groups (which limited forms each person sees): the starting set on an
// empty table, then the in-memory copy, kept fresh once a minute.
ensureStartingGroups()
  .then((n) => n && console.log(`  Staff groups: wrote the ${n} starting groups.`))
  .then(() => accessReady())
  .catch((err) => console.error("[groups] could not load staff groups:", err));
startAccessRefresh();

syncSuperAdmins()
  .then((r) => r && (r.promoted || r.demoted) && console.log(`  Super Admins: ${r.promoted} made, ${r.demoted} removed (SUPER_ADMINS).`))
  .catch((err) => console.error("[users] could not apply SUPER_ADMINS:", err));

const server = createApp().listen(env.port, env.host, () => {
  console.log(`\n  Lantern Forms backend listening on http://${env.host}:${env.port}`);
  console.log(`  Microsoft sign-in: ${ssoConfigured ? "configured" : "NOT configured (set MICROSOFT_* in .env.local)"}`);
  console.log(`  Uploaded files: ${fileStorageLabel()}`);
  if (devAuthEnabled) console.log("  Dev sign-in: ON (local prototype only — DEV_AUTH=false to disable)");
  console.log(`  Public API: http://localhost:${env.port}/api/v1  (API key required)\n`);
  noteBoot();
});

// Keep idle connections open longer than the proxies in front of this one (the
// web app's /api proxy, App Service's front end) keep theirs: Node's default of
// 5 s let a proxy reuse a connection just as it closed, and the request failed
// with "socket hang up" / ECONNRESET.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
