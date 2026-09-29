import { appBaseUrl } from "../env.js";
import { SDK_TYPES } from "./sdkText.js";

/** How to build a code form — served to the editor, the AI (MCP get_code_reference) and `forms pull`. */
export const APP_GUIDE = () => `# Lantern code forms

A code form is a small project — like working in the site's codebase, scoped to one form.
It opens at ${appBaseUrl}/apps/<slug>, with one tab per page. Edits are a draft (preview it in the
editor) until published; every publish is a version you can restore.

## Files
form.json            manifest: title, icon, pages (tabs), who sees each, entry and collection rules
pages/*.tsx          React pages (default export a component). Run in a sandboxed frame in the browser.
server/index.ts      optional: export default defineServer({ beforeCreate, afterCreate, actions })
styles.css           optional; Tailwind classes with the app's tokens work everywhere
anything else        .ts/.tsx/.json helpers you import with relative paths ("../lib/rules")

## form.json
{
  "title": "Hot Foods",
  "icon": "soup",
  "access": { "roles": ["*"] },                     // who can open it (omit = anyone signed in)
  "pages": [
    { "id": "record", "label": "Record", "file": "pages/record.tsx", "fullHeight": true },
    { "id": "reports", "label": "Reports", "file": "pages/reports.tsx", "roles": ["main_office", "site_admin", "site_manager"] }
  ],
  "entries": { "read": ["main_office", "site_admin", "site_manager"], "void": ["site_admin", "site_manager"], "undoMinutes": 10 },
  "collections": { "mealTypes": { "read": ["*"], "write": ["admin"] } },
  "reads": ["other-form-slug"]
}
Role keys: admin, developer, main_office, site_admin, site_manager, site_staff. "*" = everyone with access.
Admins and developers pass every role check.

## How data flows
- entries: the form's records. Each has free-form JSON "data", plus site, tenantId (a resident's roster id),
  occurredAt and who made it. People without entries.read can still list their own (mine: true).
- collections: the form's other data (lists admins edit, settings) — JSON documents by id.
- Server code decides: beforeCreate can refuse (errors), demand a reason (needsOverride), or rewrite data.
  The page gets { status: "needs_override", problems } and re-sends with override: "<reason>".
- actions: server functions pages call (actions.call("today", { site })) — for anything that needs data the
  person can't read directly (e.g. counts across everyone's entries for a limit or a sort order).
- Offline: entries.create(entry, { offline: true }) saves on the device and uploads in the background.
  offlineOverride is sent automatically if the server asks for a reason later.
- Everything runs as the person using the form. Pages can't reach the network or the app directly —
  only the SDK. Server code can't reach anything but ctx (no fetch, no files); 3 s and 64 MB per call.

## Phones, iPads and desktops
- Tailwind breakpoints (sm: md: lg: xl:) and portrait: / landscape: follow the DEVICE's window, not the
  frame, so markup copied from the app's own screens lays out the same. Also: phone: tablet: desktop:.
- useDevice() gives { kind: "phone" | "tablet" | "desktop", orientation, width, height, touch } live.
- A completely different screen per device: in form.json give the page
  "views": { "phone": "pages/record.phone.tsx", "tablet": "pages/record.ipad.tsx" } (others use "file").
- The app's sidebar: page option "nav": "auto" (folds on a portrait iPad, the default), "tablet" (folds on any
  tablet), "always", or "never".

## Patterns
- Guided steps on an iPad: set "fullHeight": true on the page and lay out with h-screen flex columns.
- Pages are transparent: they sit on the app's own background (bg-surface). Use bg-sidebar for side panels,
  as the app does.
- A dashboard is just a page: list entries with a date range (dates.today(), dates.addDays) and use @lcs/charts.
- Admin settings tab: a page limited to ["admin"] that reads/writes a collection; server code reads the same.
- Export: build CSV text in the page and app.download("report.csv", csv).

## SDK (lcs-sdk.d.ts)
\`\`\`ts
${SDK_TYPES}
\`\`\`
`;
