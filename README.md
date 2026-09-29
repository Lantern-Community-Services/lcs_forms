# Lantern Forms

The replacement for **forms.lanterncommunity.org** (WordPress + Gravity Forms). The forms have
outgrown what WordPress can do without a custom plugin for everything, so this is a custom site
built to be extended with LLM help.

**v1 is:**

- **Forms**, the home screen. Every form from the WordPress site, in the groups staff already
  know, with search, per-person favorites (synced across devices) and a category filter. The forms
  themselves still live on WordPress: each card opens the WordPress form in a new tab. The desktop
  sidebar lists the same forms by type, as groups that expand to show their forms.
- **Roster**, which replaces the **Tenant Updater** form. This is the Lantern Roster app
  (`LCS_TenentManagement`) carried over whole: roster, 48-hour review queue, attendance, activity
  log, exports, public API and the WordPress connector. It is one sidebar entry with tabs:
  Residents (`/roster`), Review, Attendance, Activity and Overview (`/roster/review`, …). The
  roster app's old paths (`/review`, `/dashboard`, `/attendance`, `/activity`) redirect to the tabs.
- **Hot Foods** (`/forms/hot-foods`), which replaces Gravity Forms form 21. See below.
- **Admin → Forms catalog**, where admins add, edit, hide, reorder and recategorize the links
  without a deploy.

The UI shell (sidebar, bottom tab bar, themes, sign-in, design tokens) comes from `lcs_invoices`
through the roster app, so all three apps look and behave the same. Invoices are not part of this
site.

### Moving a form off WordPress

1. Build the form as a screen here (route in `frontend/src/App.tsx`, API route in `backend/src/routes/`).
2. In **Admin → Forms catalog**, change that form's link from its WordPress URL to the app path
   (for example `/forms/incident-report`). The card, its favorites and its search words stay as
   they are. An app path shows **→** instead of **↗** and opens in place.
3. If the new screen needs a permission, add its path to `INTERNAL_NEEDS` in
   `frontend/src/lib/formIcons.ts`. People without the permission then see a locked card instead
   of a dead link.

The Roster card (`/roster`, whose search words include "tenant updater") was the first one done
this way. Hot Foods (`/forms/hot-foods`) was the second.

---

## Hot Foods

Replaces the WordPress **Hot Foods Form** (Gravity Forms form 21). One sidebar entry with three tabs:

| Tab | Who | What |
|---|---|---|
| **Record** (`/forms/hot-foods`) | anyone with `roster.edit` at a site | Resident → meal → signature, one step per phone screen. "Next resident" keeps the site and the meal for the next person in line. |
| **Entries** (`/forms/hot-foods/entries`) | `entries.view` (not Site Staff) | Filter by sites, dates and search; Print and Export (CSV, Excel, PDF) of exactly what's shown. Each entry opens with its signature, a printable receipt, and **Void** (`entries.void`: Admin, Site Admin, Site Manager). |
| **Reports** (`/forms/hot-foods/reports`) | `entries.view` | Meals served, residents, meals per day, by site, by meal type, a weekday × hour grid and entries by staff member. Print, or export as a **PDF report** (charts drawn in) or an **Excel workbook** (one sheet per breakdown). |

- **Daily limit, per meal type.** At supportive housing a resident gets 1 meal of each meal type a
  day; at a shelter 3, with a 60-minute cooldown between two meals of the same type. Going over
  either is allowed with a reason, which is stored and counted in Reports. The numbers, the meal
  types and which sites are shelters are all set in **Admin → Hot Foods**. The check lives in
  `ruleProblems` (backend `services/hotFoods.ts`, mirrored in frontend `lib/hotFoodRules.ts`, so
  staff are asked for a reason before Save). Days are New York calendar days.
- **Nothing is edited or deleted.** A mistake is voided with a reason; voided entries stop counting
  toward the limit and every report but stay on record (Entries → Status → Voided).
- **Report colors mean something.** Each meal type has its own color (Manage meal types → Report
  color), used on every chart, range and export: Meals per day is stacked by meal type, Meals by
  type uses the same colors, Meals by site is colored by site type (supportive / shelter), and the
  weekday × hour grid is a light-to-dark blue scale with a key. The eight colors are a palette
  checked for colorblind safety in light and dark mode (`--viz-*` in `frontend/src/index.css`;
  the PDF uses the same values). Everyday meals sit on the first three colors, which stay
  distinguishable in any combination, and the holiday ones on the next two; give two meals the
  same color and they'll look the same on the charts.
- **Meal types** replace `wp-content/uploads/CSVs/hotfood.csv`. Admins with `forms.manage` edit
  them from **Manage meal types** on the Record screen. Hidden, never deleted; entries keep the name
  they were recorded under. The pictures still point at the WordPress media library.
- **Site from location.** For someone with more than one site, Record asks the browser for its
  location and picks the site they're standing at (within the site's radius, 200 m by default);
  the site list is sorted nearest-first either way. It never overrides a site picked by hand, and if
  location is off it falls back to the last site used. The position is compared on the device and
  never sent to the server. Reusable for other forms: `components/forms/SiteLocator.tsx`.
- **The roster hears about it.** Each entry is logged as activity on the resident, so being served a
  meal resets their review clock.
- **Demo data:** `npm run demo:hot-foods` (backend) writes ~60 days of made-up entries (`source =
  "demo"`) so Entries and Reports have something in them; `-- --clear` removes them. Never run it
  against production.
- **Not done yet:** the ~18,600 historical WordPress entries are not imported. Their tenant is free
  text, so each has to be matched to a roster ID (site from the `LP` entity name, then name and
  room); unmatched ones would need a review step.

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
  device (`frontend/src/apps/queue.ts`) and uploads in the background, like Hot Foods.
- **Building:** the in-app editor has a file tree, a code editor, a live preview of the draft, a
  console (page and server logs), problems with file:line, versions, and the SDK reference. Drafts
  can be previewed; entries made in preview are marked `preview` and hidden from the live form.
  Publish makes a version; each version is kept and can be restored.
- **From your own editor:** `npm run forms -- app:pull <slug>` writes the project plus
  `lcs-sdk.d.ts` and a `tsconfig.json`, so VS Code and `tsc` type-check it; `app:build <dir>` compiles
  locally; `app:push <dir> [--publish]` sends it back.
- **With AI:** the MCP server has code tools (scope `apps:build`): `get_code_reference`,
  `create_code_form`, `list_files`, `read_files`, `write_files`, `edit_file` (each returns the build
  result), `run_action`, `test_entry`, `publish_code_form`, `list_code_entries`, collection read/write.
- **Import / export:** a code form exports as one `.lcsapp.json` (code, optionally with its data).
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
  `"actions.call:today"`), or made-up defaults. Never real residents. It includes the brief and the source.
- **Back into code:** Claude Design's hand-off to Claude Code, with the MCP server connected
  (`apps:build`), goes straight into the form's pages as a draft. The MCP tool `get_design_kit` (and
  `/api/apps/design-brief`) gives the assistant the tokens, components and layout rules
  (`backend/src/apps/designBrief.ts`).
- **Shared files:** `npm run sync:engine` (backend) copies the Tailwind theme to the server (code forms'
  CSS is compiled with the app's tokens) and the SDK types to where the editor, the CLI and the AI
  read them. The runtime bundle (`public/app-runtime/`) is built by `npm run build:runtime` (frontend),
  which also runs before `dev` and `build`.

**Hot Foods, as a code form:** `forms/hot-foods-code/` is Hot Foods rebuilt this way, at
`/apps/hot-foods-code`, beside the real one. It has the same guided Meal → Resident → Sign screen for
iPad, the same per-meal-type limits and shelter cooldown with override reasons (one `lib/rules.ts`
shared by the page and the server), offline recording, site-from-location, most-frequent-first
sorting, Entries, Reports and an admin Settings tab. Locally it holds a copy of the Hot Foods demo
entries (`source = "demo"`) so Reports has data. The real Hot Foods is untouched.

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
  `HotFoodItem`, `HotFoodEntry`, `HotFoodEntryItem`, `Site`, `Tenant`,
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
  src/routes/     forms, hotFoods, auth, tenants, attendance, sites, activity, users, admin, publicApi (/api/v1)
  src/services/   formCatalog (default forms), hotFoods + hotFoodsExport, roster (attention clock), tenantImport, webhooks, audit, apiKeys, settings, permissions
  scripts/        import-tenants.ts, export-azure-sql.ts, demo-hot-foods.ts
frontend/   Next.js-hosted React SPA (port 5200, proxies /api → backend)
  src/screens/    Forms (home), hotfoods/*, Dashboard, Roster, Review, TenantDetail, Attendance, Activity, Profile, More, admin/*
  src/components/ shell (from lcs_invoices), ui (from lcs_invoices), roster/*
integrations/wordpress/lantern-roster-connector.php
database/azure-sql-schema.sql
data/            (git-ignored) local tenant list CSV — resident data, never committed
```

## Known gaps (prototype)

- The form descriptions in the default catalog are one-line placeholders written from each form's
  title. Review them in Admin → Forms catalog.
- The WordPress Tenant Updater page still works. Once this site is live, point it (or redirect it)
  at the Roster here so nobody keeps using the old one.

- No automated tests yet. The flows were exercised by hand and through the API.
- Outbound webhooks are sent once, with no retry queue. Receivers catch up via `/roster/changes`.
- The WordPress plugin hasn't been run against a real WordPress yet (no PHP on the dev box).
  Test it on a staging copy of forms.lanterncommunity.org first.
- Only a few forms produce activity until the connector is on them. Until then, expect the
  review queue to be busy and rely on **Keep**.
- Hosting: the intended target is Azure App Service + Azure SQL. No deployment scripts yet.
