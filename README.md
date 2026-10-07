# Lantern Forms

The replacement for **forms.lanterncommunity.org** (WordPress + Gravity Forms). The forms have
outgrown what WordPress can do without a custom plugin for everything, so this is a custom site
built to be extended with LLM help.

**v1 is:**

- **Forms**, the home screen: the forms catalog, with search, per-person pins (synced across
  devices) and a category filter. The catalog starts empty. Forms are rebuilt here one at a time
  (form builder or code forms) and added to it as they're ready; a form that lives elsewhere is a
  card linking out. The desktop sidebar lists the same forms by category. (The old WordPress
  links the catalog used to start with are taken out once on startup:
  `retireLegacyCatalog` in `backend/src/services/formCatalog.ts`.)
- **Roster**, which replaces the **Tenant Updater** form. This is the Lantern Roster app
  (`LCS_TenentManagement`) carried over whole: roster, 48-hour review queue, attendance, activity
  log, exports, public API and the WordPress connector. It is one sidebar entry with tabs:
  Residents (`/roster`), Review, Attendance, Activity and Overview (`/roster/review`, …). The
  roster app's old paths (`/review`, `/dashboard`, `/attendance`, `/activity`) redirect to the tabs.
- **Hot Foods** (`/apps/hot-foods`), which replaces Gravity Forms form 21: a code form. See below.
- **Admin → Forms catalog**, where admins add, edit, hide, reorder and recategorize the links
  without a deploy.
- **Calendar** (`/calendar`): events for every site or for chosen sites, with repeat rules. Admins
  add them; everyone sees the ones for their sites. See below.

The UI shell (sidebar, bottom tab bar, themes, sign-in, design tokens) comes from `lcs_invoices`
through the roster app, so all three apps look and behave the same. Invoices are not part of this
site.

### Moving a form off WordPress

New forms are built **in the app**, not in this codebase: the form builder (`/f/…`) for plain
fill-in forms, and **code forms** (`/apps/…`) for anything with its own screens, rules, photos,
dashboards or reports — in the in-app editor or by an AI over the MCP server. The site's code
only changes when the platform itself needs something new.

1. Build the form (Admin → Form builder, or Admin → Code forms, or the MCP tools) and publish it.
2. Put it on the Forms screen: the form editor's catalog setting, or MCP `add_to_catalog`. If it
   replaces a WordPress form, edit that card in **Admin → Forms catalog** instead and change its
   link to the new path (`/apps/incident-report`): the card, its favorites and search words stay.
3. A form that lives somewhere else (Microsoft Forms, a vendor's site, WordPress) is just a card
   with an `https://` link — **Admin → Forms catalog → Add**, or MCP `save_catalog_card`. It
   shows **↗** and opens in a new tab.

The Roster (`/roster`) was built into the codebase before code forms existed and sits beside Home
and Calendar in the navigation rather than in the catalog. `INTERNAL_NEEDS` in
`frontend/src/lib/formIcons.ts` locks a card for an app path that needs a permission.

**Keeping the forms you build:** the database is the real copy. Every form is also backed up to
GitHub automatically — see "Form backup" below.

### Form backup

Every form built in the app — form builder forms and code forms — is backed up to
[Lantern-Community-Services/lcs_forms_form_backup](https://github.com/Lantern-Community-Services/lcs_forms_form_backup)
(private), `backend/src/services/formBackup.ts`:

- **What's in it:** each form's draft and published definition, every published version, a code
  form's collections (its settings and lists), and `catalog.json` (the Forms screen, including links
  to forms on other sites). `basic/<slug>/` for form builder forms, `code/<slug>/` for code forms (the
  folder is the project, so `app:push` works on it). **Not** in it: entries, uploaded photos, people.
- **When:** the server checks every 10 minutes and commits only when a form changed, with the changed
  forms in the commit message. **Back up now** on Admin → Form builder and Admin → Code forms; the same
  bar shows the last backup or the last error.
- **Setup:** `FORM_BACKUP_REPO` (in `.env`) and `FORM_BACKUP_TOKEN` in `.env.local` — a fine-grained
  GitHub token with **Contents: read and write** on that one repository. On a server, set both as
  app settings. No git is needed on the server; it uses the GitHub API.
- **From a computer instead** (your own git login): clone the repo, then
  `npm run forms -- backup --dir <clone> --push`.
- **Restore:** `npm run forms -- backup:restore <clone> [slug ...] [--publish]` creates missing forms
  and replaces the drafts of existing ones; `--publish` also publishes the backed-up live version.
  A code form's settings come back only into a form that has none. Put restored forms back on the
  Forms screen from their editor (`catalog.json` says where they were).

---

## Hot Foods

Replaces the WordPress **Hot Foods Form** (Gravity Forms form 21). It is a **code form**
(`/apps/hot-foods`), built with the AI form builder (MCP) and kept in the database like any other
form — edit it in **Admin → Code forms**; its source is backed up with the rest (see "Form backup").
It replaced a version that was built into this codebase (`/forms/hot-foods`, its own tables and
Admin → Hot Foods), which was removed with its data on 2026-10-07.

| Tab | Who | What |
|---|---|---|
| **Record** | Admin, Developer, Site Admin, Site Manager, Site Staff | Meal → Resident → Sign, then Saved with Next resident and Undo. The meal is picked once per shift; most frequent residents first. Works offline: entries queue on the device and upload behind the scenes. |
| **Entries** | Main Office, Site Admin, Site Manager, Developer | Filter by sites, dates, status and search; Print, and Export (CSV, Excel, PDF) of everything the filters match. Each entry opens with its signature, Print, and **Void** (Site Admin, Site Manager). |
| **Reports** | same as Entries | Meals served, residents, meals per day (with a table), by site, by meal type, a weekday × hour grid and entries by staff member. Print, or export as a PDF report (charts drawn in) or an Excel workbook (one sheet per breakdown). |
| **Settings** | Admin | Meals per day (supportive, shelter), the shelter cooldown, and the meal types with their report colors. |

- **Daily limit, per meal type.** At supportive housing 1 meal of each type a day; at a shelter 3,
  with a 60-minute cooldown between two of the same type. Going over is allowed with a reason, kept
  on the entry and counted in Reports. The rule is one file (`lib/rules.ts` in the form) used by the
  Record page and the server's `beforeCreate`, which has the final word. A site's type is set in
  Admin → Sites.
- **Over-limit entries** today show on the Forms home under "Needs your attention" for the roles that
  read entries (the form's `home` action).
- **Meal types** live in the form's `mealTypes` collection, seeded with the WordPress set on first
  use. Hidden, never deleted; entries keep the name and color they were recorded with. The pictures
  still point at the WordPress media library.
- **Site from location**, as before: the site you're standing at, never overriding one picked by hand.
- **The roster hears about it**: each entry is logged as activity on the resident.
- **Print and the PDF report draw the charts** on the server (app.print / app.export with `charts`),
  in the same colors as the screen; "Entries by staff member" wears each person's avatar color
  (`ctx.people`). Not carried over: a per-entry PDF receipt with the signature (the entry page prints
  from the browser). The ~18,600 historical WordPress entries were never imported.

---

## Form builder

Admins build forms inside the app, so a new form no longer needs WordPress or a plugin. Everything
lives under **Admin → Form builder** (`/admin/builder`); only the Admin role (`forms.manage`) can
create or change forms.

**A form is one JSON document** (the `lcs-form` format). The builder, the Code tab, export files,
the CLI and the AI form builder all read and write exactly that document, and every path into the
database goes through the same checks (`backend/src/forms/schema.ts` for the shape, `lintForm` in
the engine for the meaning: duplicate ids, rules pointing at missing fields, bad formulas).

| | |
|---|---|
| **Field types** | Single line, paragraph, number, email, phone, website, date, time, hidden · dropdown, multi-select, multiple choice, checkboxes, consent, likert/matrix · name, address, file upload, signature, rating, slider, repeater, calculation · **site** and **resident** (Lantern roster lookups; a resident logs roster activity) · section, content block, page break · **custom code** |
| **Logic** | Show/hide rules on any field, section or page (all/any, 12 operators), rules on notifications, multi-page forms with a progress bar |
| **Calculations** | A small expression language (`{qty} * {price}`, `if()`, `sum()`, `round()`, `age()`, `days_between()`…). Parsed, never `eval`'d, and recomputed on the server, so a submitted total can't be forged |
| **Merge tags** | `{field_id}`, `{all_fields}`, `{user:name}`, `{entry:url}`, `{date:today}`… in defaults, content, confirmations and notifications |
| **Custom code** | A Custom code field holds your own HTML/CSS/JS, run in a sandboxed iframe (no access to the app, cookies or network). It talks to the form through `lcs.setValue()`, `lcs.values`, `lcs.onChange()`, `lcs.setValid()`. The form's own CSS goes in Settings → Custom CSS, scoped to that form |
| **Settings** | Who can fill it in (anyone signed in, some roles, or **public** at `/p/<slug>` with a spam trap and rate limit), who can read entries, ask-for-a-site (entries limited to that site's staff), total and per-person limits, open/close dates, confirmation message or redirect, email and webhook notifications, drafts kept on the device |
| **Versions** | The builder edits a draft; **Publish** makes it live as a numbered version. Each entry keeps the version it was filled against, and old versions can be viewed or restored. Two admins (or an admin and an AI) can't overwrite each other: saves carry a revision number |
| **Entries** | `/f/<slug>/entries`: search, dates, starred, voided; CSV and Excel export; each entry has notes (notifications write their outcome there), star, print, void with a reason, and admin edit (logged) or delete |
| **Forms screen** | Settings → Forms screen lists the form under a category (card, sidebar, favourites), following its access setting |

The engine (`backend/src/forms/engine.ts`) runs on both sides. `frontend/src/lib/formEngine.ts` is
a generated copy: edit the backend file, then `npm run sync:engine` (backend); `npm run
check:engine` fails if they differ.

### Import and export

- **Export** one or several forms (the list's checkboxes, or a row's menu) as a `.lcsform.json`
  bundle, optionally with their entries.
- **Import** a Lantern form or bundle, or a **Gravity Forms export** (Forms → Import/Export → Export
  Forms). GF field numbers become readable ids and every reference is rewritten: conditional logic,
  merge tags, calculation formulas, notifications (routing rules become one rule-based notification
  per recipient), limits and schedules. Lantern's own GF add-on fields become Site and Resident
  fields. Anything with no equivalent is listed as a warning, never dropped silently. Tested against
  eight live forms (up to 110 fields); all converted.

### Forms as code

Keep forms in the repo as JSON (`forms/*.json`) and push them:

```
npm run forms -- push ../forms/intake.json --publish --note "first version"
npm run forms -- pull intake            # writes ../forms/intake.json
npm run forms -- validate ../forms/intake.json
npm run forms -- import gravityforms-export.json
npm run forms -- export intake --entries > intake.lcsform.json
```

Add `"$schema": "http://localhost:4200/api/builder/json-schema"` to a file for autocomplete and
checking in VS Code. The builder's **Code** tab edits the same document live.

### AI form builder (MCP)

`/api/mcp` is an MCP server (Streamable HTTP, stateless) so Claude or any MCP client can build
forms. **Admin → AI form builder** makes the API key (scope `forms:build`; add `entries:read` /
`entries:write` to let it read or submit entries) and shows the Claude Code, Claude Desktop and VS
Code setup. Tools: `get_reference` (the full format guide), `create_form`, `patch_form`
(add/update/move/remove fields and settings in one atomic call), `update_form`, `validate_form`,
`publish_form`, `import_forms`, `export_forms`, `list_entries`, `submit_entry` and more
(`backend/src/forms/mcp.ts`). The assistant acts as its key, and its changes are drafts until
someone publishes.

### Email

Notifications send through Microsoft Graph as the mailbox in `MAIL_FROM`, which needs the
**Mail.Send** application permission on the Entra app (ideally fenced to that mailbox with an
Exchange application access policy). Until it's set, each email is noted on the entry as "not
sent"; webhooks work regardless.

## Code forms

When a form needs more than fields and rules (custom screens, server-side logic, offline recording,
dashboards), build it as a **code form**: a small project of its own, like working in this codebase
but scoped to one form. **Admin → Code forms** (`/admin/apps`), for Admins and the **Developer** role
(`apps.develop`). A code form opens at `/apps/<slug>` with one tab per page.

```
form.json          title, icon, pages (tabs) and who sees each, who reads / voids entries, collections
pages/*.tsx        React pages. Import react, @lcs/sdk, @lcs/ui, @lcs/charts, lucide-react, and your own files
server/index.ts    export default defineServer({ beforeCreate, afterCreate, actions })
lib/…  styles.css  anything else; Tailwind classes with the app's tokens work everywhere
```

- **Pages run sandboxed.** Each page runs in an iframe with an opaque origin and no network access,
  so a bug or a bad AI edit can't touch the rest of the site or anyone's session. The page talks to the
  host through `@lcs/sdk` (`frontend/app-runtime/sdk.ts` ↔ `frontend/src/apps/AppFrame.tsx`), and the
  host makes every request as the signed-in person with the normal permission checks. The UI kit is
  the app's own components, so a code form looks exactly like the rest of the site and follows dark
  mode and themes.
- **Server code runs in a sandbox too.** Each call gets a fresh QuickJS interpreter in a worker
  thread (`backend/src/apps/sandbox.ts`): no Node, files or network, a 3-second limit and 64 MB.
  `ctx.db` (the form's entries and collections), `ctx.roster` and `ctx.time` are the only way out.
  Cross-form reads have to be listed in `form.json` "reads" and still require the person to be allowed
  to read that form.
- **Data:** entries (free-form JSON plus site, resident, when, who; void and undo built in) and
  **collections** (the form's own lists and settings). `beforeCreate` can refuse an entry, ask for an
  override reason, or rewrite it. **Offline:** `entries.create(entry, { offline: true })` queues on the
  device (`frontend/src/apps/queue.ts`) and uploads in the background.
- **Building:** the in-app editor has a file tree, a code editor, a live preview of the draft, a
  console (page and server logs), problems with file:line, versions, and the SDK reference. Drafts
  can be previewed; entries made in preview are marked `preview` and hidden from the live form.
  Publish makes a version; each version is kept and can be restored.
- **From your own editor:** `npm run forms -- app:pull <slug>` writes the project plus
  `lcs-sdk.d.ts` and a `tsconfig.json`, so VS Code and `tsc` type-check it; `app:build <dir>` compiles
  locally; `app:push <dir> [--publish]` sends it back.
- **With AI:** the MCP server has code tools (scope `apps:build`): `get_code_reference`,
  `create_code_form`, `list_files`, `read_files`, `write_files`, `edit_file` (each returns the build
  result), `run_action`, `test_entry`, `publish_code_form`, `list_code_entries`, `get_entry_file`
  (entries:read), collection read/write — and catalog tools (scope `forms:build`): `list_catalog`,
  `add_to_catalog`, `save_catalog_card` (links to forms elsewhere), `delete_catalog_card`,
  `save_catalog_category`.
- **Import / export:** a code form exports as one `.lcsapp.json` (code, optionally with its data).
- **Photos and files:** `<PhotoInput>` / `device.takePhoto()` open the camera in the app itself (the
  sandboxed frame has no camera), with a live preview and "Choose a photo". Photos are shrunk to
  1600px JPEG and stored in `FormFile`; any `{ fileId }` in an entry's data is attached when it saves.
  Offline, photos wait on the device and upload ahead of their entry (`frontend/src/apps/queue.ts`).
  `form.json` `"files"` sets size and types.
- **Editing entries:** `entries.update` for `form.json` `entries.edit` roles (default admins and
  developers) or the maker within `editOwnMinutes`; server `beforeUpdate` can refuse; every change,
  void and restore is kept (`<EntryHistory>`).
- **The rest of the site:** `calendar.*` (read, and write with the person's own calendar rights),
  `roster.resident()` and `ctx.roster.logActivity()`, and `form.json` `"home"` — a server action whose
  attention items and stat tiles appear on the Forms home (`backend/src/apps/home.ts`).
- **Approvals and the form's own calendar events** (for workflows like event requests):
  - `ctx.db.entries.update(id, data, { reason, ifUpdatedAt })` lets server code change its own entries
    (e.g. record an approval after checking `ctx.user`). It skips `entries.edit` and `beforeUpdate`, keeps
    history, and refuses with `CONFLICT…` if the entry was saved since it was read.
  - `form.json` `"calendar": { "ownEvents": true }` turns on `ctx.calendar.form`. Server code can then
    add, change and remove the form's own events for any site, without the person's calendar rights,
    but never for every site.
  - `pending: true` shows an event on the calendar striped and outlined, marked "Needs approval", and
    keeps it out of Outlook (`syncEvent` gives it no recipients, which also takes back anything already
    sent).
  - The calendar shows these events read-only, with "Open in <form>" linking to `/apps/<slug>?ref=<ref>`.
    `CalendarEvent.sourceFormId`, `sourceRef` and `pending` record the owner, its reference and the
    approval state.
  - In the draft, these calls are simulated (`preview:` ids).
  - `ctx.directory({ search, roles, site })` lists active staff (name, email, role, sites), for choosing
    approvers.
  - `ctx.roster.sites({ all: true })` lists every active site, not just the person's own, and `ctx.url`
    is the form's address, for links in emails.
  - `form.json` `"share": { "forms": ["other-slug"] }` lets another code form's server code read this
    form's entries whoever is using it (that form lists this one in `"reads"` and decides what to show).
    Event Requests and Encounter Events share with each other.
- **Bundling and schedules** (`backend/src/apps/jobs.ts`, `schedule.ts`):
  - `ctx.db.form(slug).entries.create(...)` queues an entry in another code form that accepts this one
    (`"share": { "create": [...] }`). A worker saves it through that form's own rules, as the person who
    caused it (`currentUserById`), copying files over. Jobs are kept in `FormJob`; see them with `ctx.jobs.list`
    and resend one with `ctx.jobs.retry`. Doing it after the call keeps one sandbox from waiting on another.
  - `ctx.db.form(slug).collections` reads a sharing form's lists, and `ctx.files.read` returns a form's own file
    as a data: URL.
  - `form.json` `"schedule"` runs actions once a New York day: daily, on weekdays, or monthly. They run as nobody,
    with args `{ scheduled: true, day }`. `SCHEDULE_DISABLED=true` turns the timer off.
  - `ctx.email.send` can attach export specs (Excel/PDF/CSV, built when it sends).
  - The first forms built this way are **Event Requests** (`/apps/events`) and **Encounter Events**
    (`/apps/encounters`, which records attendance against approved events), built through MCP on
    2026-10-07.
- **Dashboards and reports:** `TrendChart`, `ColumnChart`, `DonutChart` beside the original charts (`DailyBars`, `RankedBars`, `HeatGrid`, `StatTile`);
  `app.export()` makes Excel / PDF / CSV on the server (`backend/src/apps/exports.ts`), audited.
- **Email:** `ctx.email.send()` from server code, queued through the Graph mailbox (see Email below —
  not set up yet), to Lantern addresses unless `form.json` `"email"` lists others.
- **Phones, iPads, desktops:** inside a page, Tailwind's `sm:` `md:` `lg:` `xl:` and `portrait:` /
  `landscape:` follow the device's window (not the frame), so markup from the app's own screens lays
  out the same; `phone:` `tablet:` `desktop:` variants and `useDevice()` are there for device-specific
  touches, and a page can have a separate file per device (`"views": { "tablet": "pages/record.ipad.tsx" }`
  in form.json). Pages are transparent, so they sit on the app's own background.
- **Sidebar:** a page's `"nav"` in form.json decides how the app's sidebar behaves while it's open —
  `auto` (folds to icons on a portrait iPad, like every form), `tablet` (folds on any tablet), `always`,
  `never`. Built forms (`/f/…`) and code forms fold like the built-in forms by default.

### Claude Design

- **Design kit** (Admin → Code forms → *Design kit*, or Admin → AI form builder): one HTML file with
  the app's real components, charts, colors and type in light and dark, plus the design brief. Add it
  to Claude Design as the design system to design with.
- **Design handoff** (a code form's editor → *Export for Claude Design*): one HTML file with every page
  of that form, clickable, on phone / iPad portrait / iPad landscape / desktop, running the form's real
  code on sample data only — `design/fixtures.json` in the project (method → answer, e.g.
  `"actions.call:today"`; `"params:entry": { "id": "…" }` opens a hidden page on a record), or made-up defaults. Never real residents. It includes the brief and the source.
- **Back into code:** Claude Design's hand-off to Claude Code, with the MCP server connected
  (`apps:build`), goes straight into the form's pages as a draft. The MCP tool `get_design_kit` (and
  `/api/apps/design-brief`) gives the assistant the tokens, components and layout rules
  (`backend/src/apps/designBrief.ts`).
- **Shared files:** `npm run sync:engine` (backend) copies the Tailwind theme to the server (code forms'
  CSS is compiled with the app's tokens) and the SDK types to where the editor, the CLI and the AI
  read them. The runtime bundle (`public/app-runtime/`) is built by `npm run build:runtime` (frontend),
  which also runs before `dev` and `build`.

## Calendar

One calendar for the whole organization, at `/calendar`: **Calendar** under Home in the desktop
sidebar, a slot in the iPad dock next to Roster, and (the phone dock's five slots being full) the
top of the phone's **All forms** sheet.

- **Who sees what.** Everyone signed in reads it. An event is for **every site** or for **chosen
  sites**; people see the every-site events plus those for the sites they're assigned to (admins:
  all). The site picker narrows that further and is the same selection the roster screens use. A
  request for a site you aren't assigned to is a 403, the same as the roster.
- **Who changes it.**
  - **Admin** (`calendar.manage`, the Admin role only): everything, including events for every
    site and the categories.
  - **Calendar editors**: anyone, whatever their role, with **Can edit the calendar** switched on
    in Admin → People & roles (`User.calendarEditor`, which gives `calendar.edit`). They add,
    change and remove events for their own sites only. They can't make an every-site event, touch
    one that also reaches a site they aren't at, or edit the categories. A Site Manager keeps all of
    their roster access. Only an Admin can turn the switch on or off. Site Admins see it but can't
    change it, and it's in the audit log. People with it carry a "Calendar" tag in the list.
  - **Everyone else** gets the same screens without New event, Edit or Delete.

  The server decides each event: every occurrence comes back with `canEdit`, and writes outside a
  person's reach are refused (403). All checked for each role against every write endpoint.
- **Views.** It opens on **Week**. Month, Week, Day and List on a computer or an iPad; on a phone
  (too narrow for a week of columns, so it opens on Month), Month (day numbers with a dot per event,
  the chosen day's events underneath, swipe to change month), Day and List. The view and the day
  are in the URL (`?view=month&date=2026-10-06`), so a link or a pull-to-refresh keeps them; opening
  the Calendar fresh is always Week. On a computer: ← → move, T today, M/W/D/L views, N new event.
  Anyone who can add events can also click an empty day (an all-day event) or an hour in Week/Day
  (an hour-long one) to start one there.
- **Repeating.** Quick choices worded for the start day (every day, every weekday, every week on
  Friday, every 2 weeks, every month on day 2, on the first Friday, on the last Friday, on the last
  day, every year on October 2), or **Custom**: every N days / weeks / months / years; for weeks,
  any days of the week; for days, only certain days of the week; for months and years, a day of the
  month (1–31 or the last day) or *the first / second / third / fourth / fifth / second-to-last /
  last* Monday … Sunday, day, weekday or weekend day ("the last weekday of the month", "the fourth
  Thursday of November"); for years, any months. It ends never, on a date, or after a number of
  times. The editor shows the rule in words and the next six dates as you build it. A month without
  the day (a 31st, a fifth Monday) is skipped, as in Outlook and Google.
- **Changing one day of a series.** Edit or Delete on a repeating event asks *this event*, *this and
  following events* or *all events*. "This event" moves, retimes, renames or cancels that day alone
  (`CalendarException`); only what differs from the series is kept, so later changes to the series
  still reach it. "This and following" ends the series the day before and starts a new one from
  there, carrying over that day's changes; a series that ran a number of times keeps its total.
  Removing one day has an Undo.
- **Categories** (Meeting, Training, Resident event, Inspection, Deadline, Holiday to start) give each
  event its color, from the same colorblind-checked palette as the charts. Admins edit them
  from the tag button beside New event; deleting one leaves its events uncategorized. Anyone can hide
  categories from view (remembered per device).
- **Times are New York wall-clock times.** Days and times are stored as text (`"2026-10-06"`,
  `"09:30"`), so a 9:30 meeting stays at 9:30 every week through clock changes. The rule logic is
  `backend/src/calendar/recurrence.ts`, copied to `frontend/src/lib/recurrence.ts` by
  `npm run sync:engine` so the editor's preview and the server agree; edit the backend copy.
- **API** (`/api/calendar`, signed-in session): `GET /?from=&to=&site=` (days inclusive, up to 400
  days; each occurrence comes back with the series id and its date), `GET /events/:id`,
  `POST /events`, `PATCH /events/:id` (`{ scope, date, event }`), `DELETE /events/:id?scope=&date=`,
  `POST /events/:id/restore`, and `/categories`. Writes are in the audit log as `calendar.*`.
- **Offline**, on iPads and phones: this month and next are saved with the rest of the site, so the
  calendar opens without a connection. Changes need one.
- **Not done yet:** reminders or email, and showing upcoming events on the Home dashboard.

### Calendar in Outlook

Events go into each person's **own** Outlook calendar. The app is still where events are made and
changed; Outlook is told about each change (one way: edits made in Outlook aren't brought back).
Nobody sets anything up in Outlook.

- **What each person gets.** The first time someone opens the calendar, a popup asks (the Outlook
  button reopens it):
  - **Sites:** "Events for every site" and any of their own sites (all ticked to start).
  - **Categories:** untick one (Training, say) and its events stay out of their Outlook; "No
    category" too. New categories are in by default.
  - **How they arrive:** an **invite** from the **Lantern Calendar** mailbox, which emails them, or
    added **quietly**, written straight into their calendar with no email. By default Teams
    meetings come as invites and everything else quietly.
  - **For quiet ones:** their reminder (none to a day before, default 15 minutes) and whether
    all-day events show as free (default yes).
  "None for me" is an answer too. Someone with no mailbox in this organization (a partner account)
  gets invites whatever they chose.
- **Colors.** Quiet copies are tagged with the event's category, and the app creates that category
  in the person's Outlook in the calendar's color (the nearest of Outlook's colors), so it shows
  colored with no setup. Invites can't carry a category (Outlook doesn't send one with a meeting),
  so invites arrive uncolored.
- **Can't be changed in Outlook for everyone.** Invites are Lantern Calendar's meetings: attendees
  can't edit them, and "propose new time" is off. A quiet copy belongs to the person, so they could
  edit their own copy; it changes nothing for anyone else, and it's put back the next time the event
  changes here.
- **Teams.** An event with **Teams meeting** on always has Lantern Calendar's meeting, since that's
  where the Teams link comes from; invites carry it and quiet copies get the join link in their
  notes, and the calendar shows "Join the Teams meeting". Once Outlook has made the link it can't be
  removed, so the switch then stays on. A Teams meeting's notes aren't updated in Outlook after it's
  sent (a new body would wipe out the join details). If the organizer can't host Teams meetings,
  the event says so and gets the link once it can.
- **Few emails.** The meeting is only re-sent (an "updated" email to invitees) when the meeting
  itself changed: not when a quiet copy, a category color or someone else's choices change.
- **What's sent.** Title, times (New York), location, notes with a link back here, the repeat rule,
  and single days changed or cancelled. Deleting an event cancels the meeting and removes the quiet
  copies. Repeat patterns Outlook can't express (a "fifth" or "second-to-last" day, yearly in several
  months, every few days on some weekdays only, days 29–31 of the month) stay on this calendar only;
  the editor says so.
- **How.** `backend/src/services/outlookSync.ts`. A save marks the event; about 15 seconds later (so
  an Undo cancels out) the server sends it through Microsoft Graph, app-only. Unchanged events aren't
  re-sent. Failures are retried every 5 minutes, and every 6 hours each upcoming event's recipients
  are checked again, since people's sites change. Admins can see where it stands at
  `GET /api/calendar/outlook/status` and re-check everything now with `POST /api/calendar/outlook/run`.
- **Restoring a cancelled day** after Outlook already cancelled it doesn't bring it back in Outlook.

**Setting it up (once).** The app uses its existing Entra app registration and client secret (the
ones sign-in uses).

1. **Create the organizer.** In the Microsoft 365 admin center, create a user
   `calendar@lanterncommunity.org`, display name **Lantern Calendar**, with a license that includes
   Exchange Online and Teams (Teams is needed for it to organize Teams meetings). Nobody needs to
   sign in as it.
2. **Find the app's two IDs.** Entra admin center → **Enterprise applications** (not App
   registrations, which shows different values) → the Lantern Forms app → Overview. Copy the
   **Application ID** and the **Object ID**.
3. **Give the app its Exchange access** by running
   `powershell -ExecutionPolicy Bypass -File .\backend\scripts\setup-outlook-calendar.ps1` as an
   Exchange admin (Organization Management). It grants Calendars.ReadWrite on Lantern Calendar and on
   staff mailboxes (for quiet copies), and MailboxSettings.ReadWrite on staff mailboxes (for the
   colored categories); "staff" is every user mailbox unless you pass `-StaffFilter`. The commands it
   runs, for reference (organizer part): Don't add Calendars.ReadWrite under API permissions in
   Entra: an Entra grant reaches every mailbox in the organization, and Exchange can't fence it.

   ```powershell
   Connect-ExchangeOnline
   New-ServicePrincipal -AppId <Application ID> -ObjectId <Object ID> -DisplayName "Lantern Forms"
   New-ManagementScope -Name "Lantern Calendar only" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'calendar@lanterncommunity.org'"
   New-ManagementRoleAssignment -App <Object ID> -Role "Application Calendars.ReadWrite" -CustomResourceScope "Lantern Calendar only"
   Test-ServicePrincipalAuthorization -Identity <Object ID> -Resource calendar@lanterncommunity.org
   ```

   The test should list Application Calendars.ReadWrite with InScope True. Exchange can take 30
   minutes to 2 hours to apply it.
4. **Tell the server.** Set `CALENDAR_ORGANIZER=calendar@lanterncommunity.org` (with the
   `MICROSOFT_*` values sign-in already uses) and restart. The log says
   "Calendar: sending events to Outlook."
5. **Check it.** Turn on Teams for a test event, save, and wait about 15 seconds. The invite arrives
   from Lantern Calendar, and `GET /api/calendar/outlook/status` shows it sent. If the Teams link
   doesn't appear, check Teams admin center → Meetings → Meeting policies → the Outlook add-in is on
   for Lantern Calendar's policy.

## Offline mode

Site internet drops, so the app keeps working without it. **iPads and phones only**: on a computer
there's no service worker, stored copies, background download or kept roster, and the app reads
everything from the server as before (`offlineEnabled()` in `lib/offline.ts`, decided by
`isMobileDevice()` in `lib/device.ts`: touch as the main pointer, or an iPhone/iPad/Android device by
name, so an iPad with a trackpad keyboard still counts). A computer that had them from before
deletes them on its next load. Entries that lose their connection mid-save still queue and upload
on any device.

- **The app opens with no connection.** `frontend/public/sw.js` (a service worker, registered by
  `lib/offline.ts`) keeps the app's files and a copy of every screen's data (each GET `/api` answer)
  on the device. Online, everything comes from the server as usual and refreshes the copy; offline, or
  when Wi-Fi is up but the internet behind it isn't (a request that hangs past 6 s), the copy answers.
- **What's ready offline: the whole site, saved a little at a time while it's used**
  (`lib/snapshot.ts`). In the background, one request about every second, and only while no screen is
  waiting on one of its own, the app reads every screen the person can open. That covers the
  residents at all of the person's sites first (so any form's resident picker works offline,
  whichever site is chosen), then the forms and their definitions, each resident's page at the device's sites, Review, Overview,
  Activity and attendance, this month's and next month's calendar, plus form entries for roles that
  can read them. (A code form lists its own offline reads in form.json "offline".) Each read uses the screen's own URL and default filters, so
  the worker's copy is what the screen will ask for. Each item is refreshed on its own schedule (entries
  every half hour, a resident's page daily). The pill at the top shows the first download as it
runs ("Saving for offline use · 34 of 120", with a progress line), then "Ready to work offline".
Profile → Offline shows it too. With Low
  Data Mode on, only what's needed to fill in forms is read.
- **Lists that rarely change are answered from the device first:** the forms list, sites
  and archive reasons (`DEVICE_FIRST` in `sw.js`). They show instantly, are checked with the server
  behind the scenes, and the screen refreshes itself if the server's copy differs. A save to one of
  them drops the device's copy, so an admin's edit is never hidden behind it.
- **The roster is kept on the device** (`lib/rosterStore.ts`, IndexedDB) for every site the device
  opens, so Roster, a code form's resident list, a form's resident picker and attendance show the list at once,
  online or offline. After the first load only changes travel: `GET /api/tenants/sync?since=` returns
  who changed at any of the person's sites (archived and moved people included, so they drop off),
  pulled every 20 s while the app is open, on focus, on reconnect and right after any roster edit. A
  full reload every 12 hours catches anything a delta can't see. The Archived tab still asks the server.
- **Entries are queued on the device** and upload by themselves when the connection is back, from
  whichever screen is open: built forms (`lib/fillQueue.ts`,
  files attached offline included) and code forms (`apps/queue.ts`). Each carries a `clientId`, so a
  retry never saves twice.
- **The offline pill** floating over the top of every screen (`components/shell/OfflineBar.tsx`;
  it takes no room and slides in and out) says when the app is offline, how many entries are waiting, and how old the data on screen is. It turns red when the
  server refused an entry. Tap it to see, retry or discard what's on the device.
- **Code forms:** reads through the SDK (roster, entries, collections) work offline like any screen.
  Server actions are POSTs, so list the read-only ones in form.json:
  `"offline": { "actions": ["mealTypes", "today"] }`.
- **Whose data:** the stored copies (and the kept roster) belong to whoever is signed in. They're cleared on sign-out, and
  when a different person signs in on the device. Queued entries stay and upload under the person
  who made them. Signing in needs the internet; someone already signed in stays signed in offline.

Needs https (or `localhost`). On plain http, e.g. the dev server opened from an iPad by LAN
address, there's no service worker: entries still queue, but the app can't be reopened offline.
To test offline on a computer, open the app on localhost, then switch DevTools → Network to
Offline and reload. `NEXT_PUBLIC_OFFLINE=off` at build time removes the worker and its copies from
every device that opens the app.

### Testing on an iPad (local https)

`npm run dev:https` in `frontend/` (started by `start-site.bat` too) puts https in front of the dev
server: **https://&lt;this PC's LAN address&gt;:5443** is the app, and
**http://&lt;LAN address&gt;:5480** is a setup page for the iPad. The script prints both addresses.
The certificate comes from a "Lantern Forms dev" certificate authority made on first run, in
`frontend/.dev-https/` (git-ignored: it holds the authority's private key). The authority can only
vouch for localhost and private network addresses, never a real site.

Once per iPad, open the setup page in Safari:
1. Download the certificate, then in Settings tap **Profile Downloaded → Install**.
2. In Settings → General → About → **Certificate Trust Settings**, turn on **Lantern Forms dev**.
3. Open the https address, sign in (the dev sign-in, since `DEV_AUTH=true`; Microsoft sign-in would
   need this address added as a redirect URI in Entra), then Share → **Add to Home Screen**. Delete
   the old http icon first: it's a different site to iOS, with its own storage.

**Offline needs the production build.** The dev server can't be tested offline: a `next dev` page
waits on the dev server to compile and send it code, so with no connection it stays blank.
`npm run preview:https` (in `frontend/`, with the backend running) builds the app, starts it, and
serves it at **https://&lt;LAN address&gt;:5444** with the same certificate. iOS treats 5444 as a
separate app from the dev server on 5443, with its own icon and stored copies. Code changes need a
rebuild: stop it and run it again.

To test offline, add **:5444** to the home screen and open it from the icon online once. That installs
the service worker and starts the snapshot. Wait for Profile → Offline to say the site is saved, then
turn on Airplane Mode, swipe the app closed, and open it from the icon again.

Pages served through the https proxy report the device's errors to its window (a remote console for
iPads, which have no dev tools without a Mac), and a device that doesn't trust the certificate shows
there as `TLS REFUSED`. A home-screen app shows a blank white page in that case.

If the PC's LAN address changes, the server certificate is remade on the next start and the iPad
keeps working (it trusts the authority, not the address). `npm run dev:https -- --target 5300` puts
the same https in front of something else, such as a production build.

## Quick start (local prototype)

Needs Node 20+. No database server: the prototype runs on SQLite.

```bash
cd backend && npm install && npx prisma db push && npm run seed && npm run dev
```

```bash
cd frontend && npm install && npm run dev
```

Or run `start-site.bat` to start both. Open **http://localhost:5200**. The ports are 4200/5200 so
this can run next to the old roster app on 4100/5273. Until Entra is configured, the sign-in screen
offers **Prototype sign-in** with six demo accounts: admin, site manager, staff, a partner "Google
Workspace" staff member, viewer, and a forms-only **Staff member**. Prototype sign-in is always off
when `NODE_ENV=production` or `DEV_AUTH=false`.

The seed writes the default forms catalog (`backend/src/services/formCatalog.ts`). The backend also
writes it on first start against an empty database, so a new deployment opens with the forms
listed. It is written **once**. After that the catalog belongs to admins and nothing overwrites it.

The seed imports the tenant list from `data/tenant_list.csv` if it's there, or from the path in
`TENANT_CSV`. **That file is not in the repository** and must never be committed: it's real
resident data, and `data/` is git-ignored. Without it, the seed still creates the demo accounts and
the forms catalog, and you can import later from Admin → Import tenant list. **Demo only:** it also
backdates the review clock on ~7% of residents so the 48-hour queue has people in it on day one.
Set `SEED_DEMO_QUEUE=false` to skip that. `npm run db:reset` starts over.

---

## Running in Docker

Two images, one per service: `backend/Dockerfile` (Express + Prisma) and `frontend/Dockerfile`
(Next.js standalone build). Both run as a non-root user and have health checks.

```bash
cp .env.example .env     # set JWT_SECRET and the MICROSOFT_* values
docker compose up --build
```

Open **http://localhost:5200**. Only the frontend is published; it proxies `/api/*` to the backend
over the compose network, so the browser sees one origin (no CORS, cookies stay first-party).

- **Sign-in.** The containers run with `NODE_ENV=production`, where prototype sign-in is refused, so
  Entra has to be configured. For a local smoke test set `NODE_ENV=development` and `DEV_AUTH=true`
  in `.env`. If 5200 is taken (for example by `npm run dev`), set `FRONTEND_PORT`.
- **Database.** SQLite in the `lantern-data` volume (`/data`), created and brought up to date by
  `prisma db push` each time the backend starts. That command refuses changes that would lose data,
  so a bad schema change stops the container instead of dropping a column. Back up the volume.
  The seed and importers work in the container: `docker compose exec backend npm run seed`.
- **`BACKEND_URL` is a build argument.** Next bakes the `/api` rewrite into the build, so changing
  where the backend lives means rebuilding the frontend image (`build.args` in `docker-compose.yml`).
- **Before production:** move to Azure SQL (see Database), set `DB_PUSH_ON_START=false` and deploy
  schema changes with `prisma migrate deploy`, and uncomment `app.set("trust proxy", 1)` in
  `backend/src/app.ts` so the rate limiters see the real client IP behind the proxy.

---

## Who gets in

| Role | Can |
|---|---|
| Staff member | Use the Forms screen. No rosters. **Every new Lantern account starts here.** |
| Viewer | Staff member + see rosters at their sites |
| Site staff | Add, edit, keep, remove at their sites |
| Site manager | Site staff + restore removed residents + full audit history |
| Administrator | Everything, every site: forms catalog, sites, people, sign-in access, integrations, rules |

**Admin → Sign-in access → Let Lantern staff in on their first sign-in** is on by default. With it
on, anyone who signs in with a `lanterncommunity.org` account (`SSO_ALLOWED_DOMAINS`) gets in
straight away as a Staff member, so the forms work for everyone on day one. Roster access is always
a deliberate promotion in **People & roles**. Partner domains file an access request that an admin
approves, and so does everyone when the switch is off.

Unlike the WordPress site, this site needs a sign-in to see the forms list. That's deliberate:
forms rebuilt here will show resident names from the roster. The WordPress forms themselves are
unchanged and still open without one.

---

## Roster: how it works

| Concept | What it means |
|---|---|
| **Roster ID** | Every resident has a permanent id. Forms and WordPress store the id, never the name, so a spelling fix can't make someone look inactive. |
| **Attention clock** | Latest of: added to roster, named on a form (`/api/v1/activity`), or a staff member tapping **Keep** / **Still here**. Editing details does *not* reset it. |
| **Review queue** | Active residents whose clock is older than the threshold (48h org-wide, overridable per site, e.g. 24h for shelters). |
| **Remove** | Archives, never deletes. A reason is required; Undo is offered right away, and site managers can restore any time later. |
| **Concurrency** | Every edit carries the version it was loaded from. If a colleague saved first, you get a "someone else changed this" prompt instead of silently overwriting them. |
| **Audit** | Every add/edit/remove/keep/restore is recorded with who, when and why (Activity screen, and on each resident's page). |

### Site locations

Every site has an address, coordinates and an "at this site" radius, edited in **Admin → Sites**
(Location section): **Look up** geocodes the address with NYC Planning Labs GeoSearch (only the
typed site address is sent), **Use this device's location** captures it while standing there, or
type the coordinates. The sites table flags any site whose location is **Not set**. On first start the
backend fills in all 21 sites from [Lantern Maps](https://lantern-sitemap.netlify.app/)
(`services/siteLocations.ts`, written once, never overwriting an admin's edit). Two go by other names
on the map: Cedar Hall is City Cedars, Leeward Hall is Mi Casa. Location needs HTTPS in production
(browsers only share it with secure pages).

### Site access

Site access is assigned per person in Admin → People & roles. Everyone except administrators
sees **only** the rosters of their assigned sites (no sites assigned = no rosters); the API enforces
this on every request, including a hand-typed `?site=` for a site they aren't on.

Every site filter (Dashboard, Roster, Review, Activity) is a multi-select that defaults to **All my
sites** and lists only the sites the person is assigned to. Pick one site, any combination, or All.
The selection is kept in the URL (`?site=amber-hall,jasper`) and remembered per device, so all four
screens open on the same view. The API takes the same comma-separated `site` parameter.

### Export and print

The Roster screen has **Print** and **Export** (CSV, Excel, PDF) buttons; on a phone both sit in the
"…" menu next to Add. Every format contains exactly what's on screen: the selected sites, the
current tab (On roster / Review / Removed) and any search text.

- **CSV:** UTF-8 with a BOM so Excel opens accented names correctly. Cells that look like
  formulas are neutralised.
- **Excel:** a single sheet holding a real Excel table named `Roster`, with filter buttons,
  banded rows, a frozen header and date formatting.
- **PDF:** US Letter, grouped by site, with the column header repeated on every page. Each row has
  an empty "Seen" box so a printout doubles as a headcount sheet, and residents due for review are
  marked with an amber dot.
- **Print:** opens the same PDF in the browser's print dialog. On iPhone and Android it opens the
  PDF in a new tab instead, where Print is in the share menu.

Staff notes are left out of every format. Each export and printout is recorded in the Activity
log with the sites, the tab and the row count. The API equivalent is
`GET /api/tenants/export?format=csv|xlsx|pdf&site=…&status=…&q=…` (it needs a signed-in session).

---

## Getting rosters into WordPress

Three ways, pick per need. All use an API key from **Admin → API keys**
(`Authorization: Bearer lrk_…`).

1. **Pull** — `GET /api/v1/sites/{code}/roster` (JSON), or `GET /api/v1/sites/{code}/choices`,
   already shaped as a Gravity Forms `choices` array.
2. **Push** — **Admin → Webhooks** POSTs `tenant.created | updated | archived | restored | kept |
   activity` events, HMAC-SHA256 signed (`X-Lantern-Signature: sha256=…`).
3. **Sync** — `GET /api/v1/roster/changes?since=<ISO>` returns everything changed since a
   timestamp (removals included) plus a `next` cursor. Use it to catch up after a missed webhook.

**Activity back into the roster:** `POST /api/v1/activity` with `{ label, externalRef, tenantIds: [...] }`.
`externalRef` (e.g. `gf-12-5531`) makes retries idempotent. Forms that only captured free text
can send `{ match: [{ site, unit, name }] }`. An ambiguous match is reported and never guessed.

### The connector plugin

`integrations/wordpress/lantern-roster-connector.php` does all of this for Gravity Forms:

- a field with CSS classes `lantern-roster lantern-site-amber-hall` is filled with the live roster
  (cached 5 min, falling back to the last good copy if the API is down);
- on submit, the selected residents are posted to `/activity` (failures are queued and retried hourly);
- `POST /wp-json/lantern-roster/v1/webhook` verifies the signature and refreshes dropdowns immediately;
- `[lantern_roster site="…"]` renders a roster table for logged-in staff only.

Setup steps are also on **Admin → WordPress setup** inside the app.

---

## Sign-in: Microsoft, Google Workspace and partners

The app speaks OIDC to **one** authority, Lantern's Entra tenant. It's the same auth code as
Lantern AP (MSAL, PKCE, signed session cookie). Everyone outside Lantern comes through Entra
External ID as a B2B guest:

- **Google Workspace partner orgs:** SAML federation with Google Workspace as the IdP
  (Entra → External Identities → SAML/WS-Fed). Microsoft documents the built-in "Google"
  provider as Gmail-only, so Workspace domains need the SAML route.
- **Individual Gmail users:** Entra's built-in Google identity provider.
- **Anyone else:** Entra email one-time passcode, or their own Entra tenant.

Access is still decided here. An unknown account files an access request. Admins either invite
specific people (People & roles) or admit a partner domain (Sign-in access). The `idp` claim is
recorded, so you can see who signed in via Google.

To enable it, register an app in Entra (single tenant, Web redirect
`http://localhost:5200/api/auth/microsoft/callback`, plus `https://<host>/api/auth/microsoft/callback` for production) and put `MICROSOFT_TENANT_ID`,
`MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` in `backend/.env.local`.

---

## Database

- `backend/prisma/schema.prisma` is the source of truth. Tables: `FormCategory`, `FormLink`, `FormFavorite`,
  `CalendarCategory`, `CalendarEvent`,
  `CalendarEventSite`, `CalendarException`, `Site`, `Tenant`,
  `TenantActivity`, `AuditEvent`, `User`, `UserSite`, `ApiKey`, `Webhook`, `WebhookDelivery`,
  `Setting`.
- `database/azure-sql-schema.sql` is the same schema as T-SQL for Azure SQL, regenerated with
  `npm run sql:azure`. String columns are sized so every index fits SQL Server's key limit.
- The schema avoids enums, scalar lists and JSON columns, and has no nullable unique columns
  (SQL Server allows only one NULL per unique index), so it runs unchanged on SQLite and SQL Server.

### Moving to Azure SQL

1. In `schema.prisma`, set `provider = "sqlserver"` and add `@db.NVarChar(n)` sizes matching
   `scripts/export-azure-sql.ts`.
2. Set `DATABASE_URL="sqlserver://<server>.database.windows.net:1433;database=lantern-roster;…;encrypt=true"`.
3. Run `npx prisma migrate dev --name init`, then `npm run seed` (or the importer below).

### Importing a tenant list

From the app: **Admin → Import tenant list** (preview first, then commit). From the CLI:

```bash
npm run import:tenants -- ../data/            (git-ignored) local tenant list CSV — resident data, never committed
```

```bash
npm run import:tenants -- ../data/tenant_list.csv --commit
```

Expects `Property, Unit, Tenant` columns and handles Excel's Windows-1252 encoding. It parses
`"Last, First"`, nicknames in quotes or parentheses (`Sample, Robert "Bobby"` becomes Robert Sample,
goes by Bobby), and legal suffixes on site names (`Amber Hall LP` becomes site `amber-hall`). It is
re-runnable and **only adds**: a person missing from a new export is left for the review queue
rather than removed automatically.

---

## Layout

```
backend/    Express + Prisma API (port 4200)
  prisma/schema.prisma, seed.ts
  src/routes/     forms, calendar, auth, tenants, attendance, sites, activity, users, admin, publicApi (/api/v1)
  src/calendar/   recurrence.ts (repeat rules; shared with the frontend)
  src/services/   formCatalog (retires the old default catalog), calendar, roster (attention clock), tenantImport, webhooks, audit, apiKeys, settings, permissions
  scripts/        import-tenants.ts, export-azure-sql.ts, forms.ts (forms as code, backups)
frontend/   Next.js-hosted React SPA (port 5200, proxies /api → backend)
  src/screens/    Forms (home), calendar/*, builder/*, Dashboard, Roster, Review, TenantDetail, Attendance, Activity, Profile, More, admin/*
  src/components/ shell (from lcs_invoices), ui (from lcs_invoices), roster/*
integrations/wordpress/lantern-roster-connector.php
database/azure-sql-schema.sql
data/            (git-ignored) local tenant list CSV — resident data, never committed
```

## Known gaps (prototype)

- The WordPress Tenant Updater page still works. Once this site is live, point it (or redirect it)
  at the Roster here so nobody keeps using the old one.

- No automated tests yet. The flows were exercised by hand and through the API.
- Outbound webhooks are sent once, with no retry queue. Receivers catch up via `/roster/changes`.
- The WordPress plugin hasn't been run against a real WordPress yet (no PHP on the dev box).
  Test it on a staging copy of forms.lanterncommunity.org first.
- Only a few forms produce activity until the connector is on them. Until then, expect the
  review queue to be busy and rely on **Keep**.
- Hosting: the intended target is Azure App Service + Azure SQL. No deployment scripts yet.
