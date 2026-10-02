import { createApp } from "./app.js";
import { devAuthEnabled, env, ssoConfigured } from "./env.js";
import { ensureDefaultCatalog, ensureFormIcons } from "./services/formCatalog.js";
import { migrateLegacyRoles } from "./services/permissions.js";
import { ensureDefaultHotFoodItems } from "./services/hotFoods.js";
import { ensureSiteLocations } from "./services/siteLocations.js";
import { ensureDefaultCalendarCategories } from "./services/calendar.js";

// A fresh database (a new deployment) opens with the forms already listed.
// Logged, never fatal: the API is still worth serving without a catalog.
ensureDefaultCatalog()
  .then((wrote) => wrote && console.log("  Forms catalog: wrote the default catalog."))
  .then(() => ensureFormIcons())
  .then((n) => n && console.log(`  Forms catalog: gave ${n} forms their default icons.`))
  .catch((err) => console.error("[forms] could not write the default catalog:", err));

ensureDefaultHotFoodItems()
  .then((wrote) => wrote && console.log("  Hot Foods: wrote the default meal types."))
  .catch((err) => console.error("[hot-foods] could not write the default meal types:", err));

ensureDefaultCalendarCategories()
  .then((wrote) => wrote && console.log("  Calendar: wrote the default categories."))
  .catch((err) => console.error("[calendar] could not write the default categories:", err));

ensureSiteLocations()
  .then((n) => n && console.log(`  Sites: filled in the location of ${n} sites from the site map.`))
  .catch((err) => console.error("[sites] could not fill in site locations:", err));

migrateLegacyRoles()
  .then((n) => n && console.log(`  Roles: moved ${n} people off retired roles.`))
  .catch((err) => console.error("[roles] could not migrate retired roles:", err));

createApp().listen(env.port, () => {
  console.log(`\n  Lantern Forms backend listening on http://localhost:${env.port}`);
  console.log(`  Microsoft sign-in: ${ssoConfigured ? "configured" : "NOT configured (set MICROSOFT_* in .env.local)"}`);
  if (devAuthEnabled) console.log("  Dev sign-in: ON (local prototype only — DEV_AUTH=false to disable)");
  console.log(`  Public API: http://localhost:${env.port}/api/v1  (API key required)\n`);
});
