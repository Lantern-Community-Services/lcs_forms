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
