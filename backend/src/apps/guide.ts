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
  "reads": ["other-form-slug"],
  "calendar": { "ownEvents": true },                                // server code manages the form's own calendar events
  "files": { "maxMb": 10, "accept": "image/*,application/pdf" },   // photos and uploads (default: 10 MB, images, PDF, office files)
  "home": { "action": "home", "roles": ["site_manager"] },          // cards on the Forms home (see below)
  "email": { "to": ["vendor@example.com", "@partner.org"] }         // who server code may email besides Lantern addresses
}
entries also takes "edit": [roles] (who can change anyone's entry; default admins and developers only) and
"editOwnMinutes": N (people can change their own entry for N minutes; default 0).
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
  offlineOverride is sent automatically if the server asks for a reason later. (Without offline: true, a save
  that loses its connection is queued the same way and returns { status: "queued" }.)
- Offline reads: the app opens with no connection, and roster, entries and collections reads return what the
  device last loaded. Actions are POSTs, so list the ones that only read in form.json
  "offline": { "actions": ["mealTypes", "today"] }; offline they return the device's last answer. Never list an
  action that saves anything. An answer can be from an earlier day: put the day in it (day: ctx.today) and
  have the page ignore day-specific parts (today's counts) when it isn't dates.today().
- Everything runs as the person using the form. Pages can't reach the network or the app directly —
  only the SDK. Server code can't reach anything but ctx (no fetch, no files); 3 s and 64 MB per call.

## What a form can use
- Photos: <PhotoInput value={photos} onChange={setPhotos} /> (or device.takePhoto()) opens the camera in the app —
  live preview plus "Choose a photo" — and gives FileRefs. Put them anywhere in an entry's data; every { fileId }
  is attached when the entry saves. Show one with <Photo file={ref} />. Files: <FileInput accept=".pdf" />, or
  files.choose() from a tap. Photos are shrunk to 1600px JPEG and work offline (they upload ahead of the entry).
- Location: device.location() — with roster.sites() latitude/longitude and distanceMeters() to pick the nearest site.
- Editing: entries.update(id, data, { reason }) — every change is kept; show it with <EntryHistory entryId={id} />.
  Server code can check edits in beforeUpdate.
- Roster: roster.sites(), roster.residents(siteCode) (instant, offline), roster.resident(id) (full record and recent
  activity), roster.open(id). Server: ctx.roster.*, and ctx.roster.logActivity(tenantId) to reset a resident's review clock.
- Calendar: calendar.events({ from, to }), categories(), create / update / remove with the person's own calendar rights
  (the preview won't write). Server: ctx.calendar.events / categories / create (e.g. from afterCreate).
- The form's own calendar events: form.json "calendar": { "ownEvents": true } lets server code use ctx.calendar.form
  (list / create / update / setPending / remove) for any site, whatever the person's calendar rights. create(event,
  { ref: entryId, pending: true }) puts a request on the calendar marked "Needs approval" (kept out of Outlook);
  setPending(id, false) confirms it and sends it to Outlook. Occurrences carry pending and source { slug, ref }. Nobody
  edits these on the calendar itself; its "Open in <form>" button opens /apps/<slug>?ref=<ref>, so the form's first page
  should read params.ref and show that record. In the preview they're simulated ("preview:" ids).
- Approvals and other server-side changes: ctx.db.entries.update(id, data, { reason, ifUpdatedAt: entry.updatedAt })
  in an action that checks who's asking (ctx.user). It skips entries.edit and beforeUpdate, keeps history, and throws
  "CONFLICT…" if someone saved the entry meanwhile — read it again and retry once.
- Staff: ctx.directory({ search, roles, site, ids }) lists active staff (name, email, role, sites) to choose approvers
  in a settings page (through an action) or to find a site's managers to email.
- Forms home: form.json "home": { "action": "home" }. That action runs as each person when the home screen loads and
  returns { attention: [{ title, detail, action, page, params, tone: "warn" | "info" }], tiles: [{ label, value, hint, page }] }.
  Keep it to a count or two (it has 4 s; answers are kept a minute). Return {} when there's nothing to show.
- Dashboards: @lcs/charts TrendChart, ColumnChart, DonutChart, RankedBars, HeatGrid, StatTile, DailyBars. Colors come
  from palette slots (slotColor 0-7, null = "Other"); give each thing the same slot everywhere.
- Reports: app.export({ format: "xlsx" | "pdf" | "csv", filename, title, stats, charts, sheets: [{ name, columns, rows }] }) makes
  the file on the server in the app's export style. charts (PDF): dailyBars, rankedBars, heatGrid — the screen's charts
  redrawn for paper, same colors. Print a page with charts as app.print(spec) (the same spec, no format): it prints that
  PDF, as the app's own reports do. Plain app.print() prints the page as the browser sees it (charts don't print well).
- Who recorded it: ctx.people(ids) in server code gives each person's name and avatarColor, so a "by staff member"
  chart can color each bar like their avatar (<Avatar color> and the chart row's color; null = #2c3453).
- Email: ctx.email.send({ to, subject, text | html }) from server code (afterCreate, actions). Queued, Lantern addresses
  unless form.json "email" lists others, never from the draft.
- Other parts of the app: app.openApp("/calendar"), roster.open(id). Links to forms elsewhere go on the Forms catalog
  (MCP save_catalog_card), not in a code form.

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
- Export: app.export({ format: "xlsx", title, sheets }) for Excel / PDF / CSV, or build text and app.download(name, text).
- Entry page: a hidden page ("hidden": true) reached with app.navigate("entry", { id }), showing the data, its photos,
  <EntryHistory>, and Edit / Void buttons for the people form.json allows.

## SDK (lcs-sdk.d.ts)
\`\`\`ts
${SDK_TYPES}
\`\`\`
`;
