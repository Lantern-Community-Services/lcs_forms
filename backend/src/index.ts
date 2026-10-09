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
import { fileStorageLabel } from "./services/fileStore.js";

// First, so what the startup work below logs is in the dev log too.
startDevlog();

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

ensureSiteLocations()
  .then((n) => n && console.log(`  Sites: filled in the location of ${n} sites from the site map.`))
  .catch((err) => console.error("[sites] could not fill in site locations:", err));

migrateLegacyRoles()
  .then((n) => n && console.log(`  Roles: moved ${n} people off retired roles.`))
  .catch((err) => console.error("[roles] could not migrate retired roles:", err));

syncSuperAdmins()
  .then((r) => r && (r.promoted || r.demoted) && console.log(`  Super Admins: ${r.promoted} made, ${r.demoted} removed (SUPER_ADMINS).`))
  .catch((err) => console.error("[users] could not apply SUPER_ADMINS:", err));

createApp().listen(env.port, env.host, () => {
  console.log(`\n  Lantern Forms backend listening on http://${env.host}:${env.port}`);
  console.log(`  Microsoft sign-in: ${ssoConfigured ? "configured" : "NOT configured (set MICROSOFT_* in .env.local)"}`);
  console.log(`  Uploaded files: ${fileStorageLabel()}`);
  if (devAuthEnabled) console.log("  Dev sign-in: ON (local prototype only — DEV_AUTH=false to disable)");
  console.log(`  Public API: http://localhost:${env.port}/api/v1  (API key required)\n`);
  noteBoot();
});
