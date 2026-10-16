# Azure follow-up survey

Survey of `lantern-community-services/lcs_forms` at commit `06eb532` (branch `claude/gracious-brown-60k09r`, identical to `main` for the files cited). Every answer cites the file that shows it. "Not found" means the repository has no such code or setting. Paths are relative to the repo root unless shown otherwise.

External facts about Prisma's SQL Server connector were checked against the Prisma query-engine source for the pinned version and against the Prisma GitHub issue tracker. The prisma.io docs site and the npm registry page were not reachable from this environment, so those two were not consulted.

---

## A. Database connection and managed identity

### 1. Where the Prisma client is constructed, and how DATABASE_URL reaches it

- Client: `backend/src/prisma.ts` lines 4–6. A single `new PrismaClient({ log })` with no `datasources` or `datasourceUrl` override.
- URL: `backend/prisma/schema.prisma` lines 13–16, `url = env("DATABASE_URL")`. The engine reads the environment variable directly. There is no wrapper that builds or rewrites the URL.
- `backend/src/env.ts` line 17 also copies `process.env.DATABASE_URL` into `env.databaseUrl`, but the only consumer is `backend/src/services/rosterQuery.ts` line 34, which checks `startsWith("file:")` to choose `LIMIT` versus `OFFSET … FETCH` syntax for one raw query. It does not feed the client.
- `.env` and `.env.local` are loaded by `backend/src/env.ts` lines 5–6 (`.env.local` overrides).

### 2. Prisma versions

| Package | package.json (`backend/package.json`) | Lockfile (`backend/package-lock.json`) |
|---|---|---|
| `prisma` (devDependency) | `^5.22.0` (line 54) | `5.22.0` (line 3593) |
| `@prisma/client` | `^5.22.0` (line 29) | `5.22.0` (line 1076) |
| `@prisma/engines` (transitive) | — | `5.22.0` (line 1101) |

`backend/package.json` lines 44–49 (`allowScripts`) pin the same versions for install scripts.

### 3. Existing use of @azure/identity or token-based auth; other Azure SDK packages

- `@azure/identity`: not found.
- `@azure/storage-blob` or any other `@azure/storage-*`: not found.
- The only Azure packages are `@azure/msal-node` `^5.6.0` (`backend/package.json` line 28) and its transitive `@azure/msal-common` (`backend/package-lock.json` lines 55, 64). Used in:
  - `backend/src/auth/entra.ts` line 2 — user sign-in (auth-code + PKCE, scopes `openid profile email User.Read`, line 22).
  - `backend/src/services/mailer.ts` lines 1, 18–29 — client-credentials token for Graph `sendMail`.
- Both use a client secret (`MICROSOFT_CLIENT_SECRET`, `backend/src/env.ts` line 29). No managed identity, certificate, or federated credential anywhere.

### 4. How the connection string is parsed or validated at startup

- Not parsed or validated by application code. `backend/src/env.ts` line 17 defaults it to `""` and nothing checks it. The first failure surfaces when Prisma connects (lazily, on first query; `backend/src/index.ts` lines 10–26 fire startup queries immediately).
- Nothing in `backend/src` assumes a user/password pair exists in the string. The only shape assumption is the `file:` prefix test in `backend/src/services/rosterQuery.ts` line 34.
- The password-bearing example lives only in docs: `backend/.env.example` line 6 and `README.md` line 434 (`…;user=<user>;password=<pw>;encrypt=true`).
- The assumption that does exist is inside Prisma itself: the pinned connector's URL parser only understands `user` and `password` for credentials (see item 7).

### 5. Connections opened outside Prisma

None. Every database access goes through the shared client in `backend/src/prisma.ts`.

| Path | What it does | Connection |
|---|---|---|
| `backend/src/app.ts` lines 61–68 | `/api/health` runs `prisma.$queryRaw\`SELECT 1\`` | Prisma (same client) |
| `backend/Dockerfile` lines 52–53 | `HEALTHCHECK` is an HTTP `fetch` of `/api/health` | No DB connection of its own |
| `backend/prisma/seed.ts` line 3 | `import { prisma } from "../src/prisma.js"` | Prisma |
| `backend/scripts/demo-hot-foods.ts` line 1 | same import | Prisma |
| `backend/scripts/import-tenants.ts` line 2 | same import | Prisma |
| `backend/scripts/forms.ts` line 23 | same import | Prisma |
| `backend/scripts/export-azure-sql.ts` lines 36–41 | shells out to `prisma migrate diff --from-empty --to-schema-datamodel … --script` | No database connection (diff from empty) |
| `backend/scripts/sync-engine.mjs` | copies source files between frontend and backend | No database |
| `backend/docker-entrypoint.sh` line 12 | `prisma db push --skip-generate` | Prisma CLI, same `DATABASE_URL` |

`mssql`, `tedious`, `better-sqlite3`, `sqlite3`: not found in `backend/package.json` or the lockfile.

### 6. Where migrations run

- Entrypoint: `backend/docker-entrypoint.sh` lines 10–13.
  ```sh
  if [ "${DB_PUSH_ON_START:-true}" = "true" ]; then
    echo "[entrypoint] prisma db push"
    ./node_modules/.bin/prisma db push --skip-generate
  fi
  exec "$@"
  ```
- The gate variable is `DB_PUSH_ON_START` (default `true`), wired through `docker-compose.yml` line 28 and documented in `.env.example` lines 26–29. `RUN_MIGRATIONS`: not found.
- Command is `prisma db push`, not `prisma migrate deploy`. There is no `backend/prisma/migrations/` directory (`backend/prisma/` holds only `schema.prisma` and `seed.ts`). `README.md` lines 284–286 and `backend/docker-entrypoint.sh` lines 8–9 say to switch to `migrate deploy` before production.
- Same `DATABASE_URL` as the app: the CLI reads the process environment, and `backend/Dockerfile` line 32 sets the container default `DATABASE_URL=file:/data/lantern-forms.db`, overridden by `docker-compose.yml` line 17.

### 7. Estimated change to connect with a managed-identity access token

**What the pinned connector accepts.** The SQL Server URL parser in Prisma engines 5.22.0 (`quaint/src/connector/mssql/url.rs` at tag `5.22.0`) recognises only these keys: `user`, `password`, `database`, `schema`, `connectionLimit`/`connection_limit`, `isolationLevel`/`isolation_level`, `loginTimeout`/`connectTimeout`/`connectionTimeout` (and snake_case forms), `poolTimeout`/`pool_timeout`, `socketTimeout`/`socket_timeout`, `encrypt`, `trustServerCertificate`/`trust_server_certificate`, `trustServerCertificateCA`, `max_connection_lifetime`, `max_idle_connection_lifetime`. There is **no** `authentication=`, `accessToken=`, `integratedSecurity`, or any Entra/AAD parameter. Absent `user`/`password` are stored as `None` and the engine then attempts SQL authentication with no credentials. So with Prisma 5.22.0 as pinned, **managed identity is not possible through the connection string.**

**What Prisma supports upstream.** Prisma issue prisma/prisma#13853 ("Support Azure Managed Identities via SQL Server connection string", open since Jun 2022) records that Entra ID authentication landed in the `@prisma/adapter-mssql` driver adapter via PR #28156 (contributor comment, 8 Oct 2025), while the CLI (`db push`, `migrate`) still cannot use the adapter and so cannot authenticate with a token (user comment, 19 Nov 2025, who runs migrations with the `mssql` package instead). Related open issues: #12562, #7673. The driver adapter requires Prisma 6.x; the npm page for `@prisma/adapter-mssql` was not reachable from here, so the exact minimum 6.x version should be confirmed before planning.

**Files that would change (runtime path):**

| File | Change |
|---|---|
| `backend/package.json` | Upgrade `prisma` and `@prisma/client` from 5.22 to a 6.x that includes the Entra-capable `@prisma/adapter-mssql`; add `@prisma/adapter-mssql`, `mssql`, and `@azure/identity`. Update the `allowScripts` pins (lines 44–49). |
| `backend/prisma/schema.prisma` | `provider = "sqlserver"` (line 14), add `@db.NVarChar(n)` sizes (see C13), and whatever preview flag the chosen 6.x needs for driver adapters. |
| `backend/src/prisma.ts` | Construct `PrismaClient({ adapter })` where the adapter wraps an `mssql` config using `authentication: { type: "azure-active-directory-default" }` or `"azure-active-directory-access-token"` with a token from `DefaultAzureCredential` (scope `https://database.windows.net/.default`). Token refresh must be handled; a static token in the pool config expires after about an hour. |
| `backend/src/env.ts` line 17 and `backend/src/services/rosterQuery.ts` line 34 | The `file:` sniff still works (returns false), but `DATABASE_URL` would no longer carry a password; the server/database fields would need to come from separate variables or a passwordless URL. |
| `backend/docker-entrypoint.sh`, `backend/Dockerfile` line 32 | The `prisma db push` step cannot use managed identity. Either keep a SQL-auth login for schema deployment as a separate release step (`migrate deploy` with a password-bearing URL), or run the generated SQL yourself through `mssql` with a token (the approach in the issue thread). |
| `backend/scripts/*.ts`, `backend/prisma/seed.ts` | No code change; they inherit the client from `backend/src/prisma.ts`. |
| `backend/.env.example`, `.env.example`, `docker-compose.yml`, `README.md` lines 430–435 | Document the new variables. |

**Bottom line:** feasible only with a Prisma major upgrade (5 → 6) and the driver-adapter path; not feasible by editing the connection string on the pinned version. Migrations need a separate answer either way.

---

## B. File uploads and storage

### 8. Where AZURE_STORAGE_ACCOUNT_URL is read, and the database/blob switch

- `AZURE_STORAGE_ACCOUNT_URL`: not found. No container name variable, no connection-string variable, no storage switch of any kind.
- All uploads are stored in the database (`FormFile.data`, see item 10). The comment at `backend/prisma/schema.prisma` lines 472–473 states this on purpose: "Stored in the database so the app has one thing to back up."

### 9. Blob storage authentication

Not applicable. No blob storage code and no `@azure/storage-blob` package (see item 3).

### 10. Database storage model, column type, size limits

- Model: `FormFile`, `backend/prisma/schema.prisma` lines 474–493. Bytes live in `data Bytes` (line 485) alongside `name`, `mime`, `size`, `fieldId`, `formId`, nullable `entryId`.
- Column type: Prisma `Bytes` maps to `BLOB` on SQLite today. On SQL Server Prisma's default for `Bytes` is `VARBINARY(MAX)`, but note that `database/azure-sql-schema.sql` is stale: it contains no `FormFile` table at all (regenerate with `npm run sql:azure`).
- Size limits enforced in code:
  - Hard cap `MAX_FILE_BYTES = 10 * 1024 * 1024` — `backend/src/forms/entries.ts` line 29.
  - Per-field cap `min(MAX_FILE_BYTES, field.maxSizeMb * 1 MB)`, default 10 MB — `backend/src/forms/entries.ts` lines 289–291 (`saveUpload`). Empty files rejected (line 290); oversize returns HTTP 413 (line 291); `accept` list enforced (lines 292, 302–309).
  - Body parser cap for the upload route `express.raw({ limit: "11mb" })` — `backend/src/routes/fill.ts` line 82.
  - Name truncated to 200 chars, mime to 100 — `backend/src/forms/entries.ts` line 296.
- Download path: `backend/src/routes/fill.ts` lines 260–276 (`GET /api/f/:slug/files/:fileId`), served from `file.data` with a sandboxing CSP.

### 11. Field types that produce an upload; where signatures live

Field types are defined in `backend/src/forms/engine.ts` (copied to `frontend/src/lib/formEngine.ts` by `npm run sync:engine`).

| Field type | Defined at | Stored as | Model |
|---|---|---|---|
| `file` ("File upload") | `backend/src/forms/engine.ts` line 262 | Binary row per file; the entry's JSON keeps `[{ id, name, size, mime }]` (`entries.ts` lines 155–159) | `FormFile` |
| `signature` ("Signature") | `backend/src/forms/engine.ts` line 263 | **Base64 PNG data URL as text**, inside the entry's JSON `data` column | `FormEntry.data String` (`schema.prisma` lines 416–418) |
| photo / camera / image | not found as a field type (`camera` appears only as an icon name, `backend/src/routes/forms.ts` line 43) | — | — |

Built-in (non-builder) forms also store signatures as PNG data-URL text, never as files:

- Hot Foods: `HotFoodEntry.signature String` (`backend/prisma/schema.prisma` lines 242–243), validated as `data:image/png;base64,…` with `.max(400_000)` at `backend/src/routes/hotFoods.ts` line 175; JSON body limit 2 MB (`backend/src/app.ts` line 52).
- Attendance: `AttendanceEntry.signature String?` (`backend/prisma/schema.prisma` lines 194–195), same regex and `.max(400_000)` at `backend/src/routes/attendance.ts` line 133; JSON body limit 20 MB (`backend/src/app.ts` line 50).
- Built-form submissions carrying signatures: JSON body limit 5 MB (`backend/src/app.ts` line 55).

`scripts/export-azure-sql.ts` line 21 lists `signature` among columns sized `NVarChar(Max)` for SQL Server.

### 12. Cleanup and retention

- On entry delete (admins only): `backend/src/routes/fill.ts` lines 247–257 runs `prisma.formFile.deleteMany({ where: { entryId } })` then deletes the entry. Needed because the `FormFile → FormEntry` relation is `onDelete: NoAction` (`schema.prisma` line 480).
- On form delete (only allowed when the form has zero entries): `backend/src/forms/service.ts` lines 211–218 deletes the form's files first. The `FormFile → BuiltForm` relation is `onDelete: Cascade` (line 477).
- Orphan sweep: every upload first deletes files with `entryId = null` older than 24 hours — `backend/src/forms/entries.ts` line 294 (comment: "cheap and needs no scheduler").
- Scheduled purge or retention policy for entries, files, or signatures: not found. Voided entries (`FormEntry.status = "voided"`) keep their files.

---

## C. Status of the Phase 3 issue items

No file in the repository mentions "Phase 3"; the items below are assessed against the code as it stands.

| # | Item | Status | Evidence |
|---|---|---|---|
| 13 | Prisma provider = sqlserver with NVarChar sizes | **Not done** | `backend/prisma/schema.prisma` line 14 is `provider = "sqlite"`. No `@db.NVarChar` anywhere in the schema (the only `@db`-style annotation is none; the only non-String scalar of note is `data Bytes`, line 485). The NVarChar sizing rule exists only in `backend/scripts/export-azure-sql.ts` lines 16–28, applied to a temp copy when generating `database/azure-sql-schema.sql`, which is itself out of date (no `FormFile`, `FormRecord`, `BuiltForm*`, `FormEntry*` tables). |
| 14 | `trust proxy` in `backend/src/app.ts` | **Not done** | `backend/src/app.ts` lines 40–41: the line is present but commented out (`// app.set("trust proxy", 1);`). `README.md` line 285 lists it as a before-production step. |
| 15 | `/api/health` when DB unreachable | **Done** (fails, does not return 200) | `backend/src/app.ts` lines 61–68: `SELECT 1` via Prisma; on error responds `503 { ok: false, database: "unreachable", error }`. `backend/Dockerfile` lines 52–53 `HEALTHCHECK` exits non-zero on a non-2xx, so the container is marked unhealthy. |
| 16 | `BACKEND_URL` build arg vs runtime | **Still a build arg** | `frontend/Dockerfile` lines 21–23 (`ARG BACKEND_URL=http://backend:4200`, copied to `ENV` for the build stage); `frontend/next.config.mjs` line 2 reads it when `rewrites()` is evaluated at build; `docker-compose.yml` lines 36–38 pass it under `build.args`; `README.md` lines 282–283 document that changing it means rebuilding the image. |
| 17 | Demo/seed guard in production | **Partial** | `backend/scripts/demo-hot-foods.ts` line 15 throws when `NODE_ENV=production` (no override variable). `backend/prisma/seed.ts` has **no** production guard; its demo review-queue backdating runs unless `SEED_DEMO_QUEUE=false` (line 61, default is on). `ALLOW_DEMO_DATA`: not found anywhere. `backend/scripts/import-tenants.ts` and `backend/scripts/forms.ts`: no guard (they import real data / form definitions, not demo data). |
| 18 | `DEV_AUTH` guard in production | **Done** | `backend/src/env.ts` lines 56–66: `devAuthEnabled = env.devAuth && !isProd`, `isProd = NODE_ENV === "production"`. Enforced at `backend/src/routes/auth.ts` lines 143 (404) and 157 (403). `docker-compose.yml` line 15 defaults `NODE_ENV` to `production` and line 22 defaults `DEV_AUTH` to `false`. |
| 19 | Calendar delegated flow; refresh-token storage; extended property tagging | **Not done** | No calendar integration exists. Sign-in scopes are `openid profile email User.Read` (`backend/src/auth/entra.ts` line 22): no `offline_access`, no `Calendars.*`. No refresh tokens are requested or stored; the `User` model (`backend/prisma/schema.prisma` lines 512–543) has no token or secret columns. `singleValueExtendedProperties` / extended property: not found. |
| 20 | Notification and invite templates: field values in the body, or link-only? | **Field values are in the body by default** | Email: `backend/src/forms/entries.ts` lines 266–274 render `n.body || "{all_fields}"`; `{all_fields}` expands via `allFieldsText` (`backend/src/forms/engine.ts` lines 846–856) to a label/value table of every visible answer, including a `resident` field's name and unit (resolved from the roster at `entries.ts` lines 150–154). The entry link is available as `{entry:url}` (`engine.ts` line 875) but is not the default. Webhook: `entries.ts` lines 243–254 POST `values` and a `display` map of every answer plus `url`. Roster webhooks (`backend/src/services/webhooks.ts` lines 43–65) POST the event `data` object (tenant payload). Invite: `backend/src/routes/users.ts` lines 99–122 only pre-creates the user row with `status: "invited"`; **no invite email is sent** (the only `sendMail` caller is `backend/src/forms/entries.ts` line 268). |

Done: 2 of 8 (items 15, 18). Partial: 1 (item 17). Not done: 5 (items 13, 14, 16, 19, 20 in the sense asked).

---

## D. Anything else an operator should know

### 21. Environment variables read by the backend that are not in `backend/.env.example`

Every `process.env.*` read in `backend/src`, `backend/scripts`, `backend/prisma` was listed. Missing from `backend/.env.example`:

| Variable | Read at | Purpose | Default |
|---|---|---|---|
| `NODE_ENV` | `backend/src/env.ts` line 15; `backend/src/prisma.ts` line 5; `backend/scripts/demo-hot-foods.ts` line 15 | prod gating, log level | `development` |
| `TENANT_CSV` | `backend/prisma/seed.ts` line 37 | path to the resident list the seed imports | `../data/tenant_list.csv` |
| `SEED_DEMO_QUEUE` | `backend/prisma/seed.ts` line 61 | backdate ~7% of residents into the review queue | on unless `false` |
| `DB_PUSH_ON_START` | `backend/docker-entrypoint.sh` line 10 (shell, not Node) | run `prisma db push` before start | `true` |

Present in `backend/.env.example`: `DATABASE_URL`, `PORT`, `CORS_ORIGIN`, `JWT_SECRET`, `DEV_AUTH`, `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REDIRECT_URI`, `APP_BASE_URL`, `SSO_ALLOWED_DOMAINS`, `MAIL_FROM`. `JWT_SECRET` falls back to `"dev-only-change-me"` with no production check (`backend/src/env.ts` line 19); only `docker-compose.yml` line 18 makes it required.

Frontend build-time only: `BACKEND_URL`, `NEXT_PUBLIC_API_BASE_URL` (`frontend/Dockerfile` lines 21–24).

### 22. Outbound network calls besides Graph and SQL

| Destination | File | Trigger |
|---|---|---|
| `https://login.microsoftonline.com/<tenant>` | `backend/src/auth/entra.ts` line 61; `backend/src/services/mailer.ts` line 22 | sign-in; mail token |
| `https://graph.microsoft.com/v1.0/me` | `backend/src/auth/entra.ts` line 177 | each sign-in (best effort, 5 s timeout) |
| `https://graph.microsoft.com/v1.0/users/<MAIL_FROM>/sendMail` | `backend/src/services/mailer.ts` line 34 | form notification emails |
| `https://geosearch.planninglabs.nyc/v2/search` (NYC Planning Labs geocoder, no key) | `backend/src/services/siteLocations.ts` lines 76–80 | admin typing a site address (`backend/src/routes/sites.ts` line 90) |
| Admin-configured form-notification webhook URLs (any `https://`) | `backend/src/forms/entries.ts` line 261 | after each built-form submission, HMAC signed, 8 s timeout |
| Admin-configured roster webhook URLs | `backend/src/services/webhooks.ts` line 54 | roster events, HMAC signed, 5 s timeout, at-most-once |

Not outbound from the backend: the Hot Foods `imageUrl` values (`backend/src/services/hotFoods.ts` lines 57–61) and catalog links (`backend/src/services/formCatalog.ts`) are URLs handed to the browser. The code-form sandbox (`backend/src/apps/sandbox.ts`, QuickJS) has no `fetch`. No packages are downloaded at runtime; `npm ci` runs in the build stage (`backend/Dockerfile` line 20). The browser loads Google Fonts (`frontend/src/app/layout.tsx` lines 21–27), which matters only for a CSP.

### 23. Background timers and schedulers inside the process

- Recurring timers (`setInterval`, cron): **none**.
- Startup one-shots, `backend/src/index.ts` lines 10–26, run once per boot, logged and never fatal: write the default forms catalog and icons (`ensureDefaultCatalog`, `ensureFormIcons`), default Hot Foods meal types (`ensureDefaultHotFoodItems`), fill site coordinates from a built-in map (`ensureSiteLocations`, `backend/src/services/siteLocations.ts` lines 46–69, no network), and migrate retired roles (`migrateLegacyRoles`).
- Piggybacked work: orphaned upload sweep on every upload (`backend/src/forms/entries.ts` line 294); notifications dispatched after the HTTP response (`entries.ts` line 224, `void runNotifications(...)`); roster webhook fan-out is fire-and-forget (`backend/src/services/webhooks.ts` lines 83–92).
- Per-run kill timer for code-form server code: `backend/src/apps/sandbox.ts` line 216 (`setTimeout`, timeout + 5 s).

Operational consequences: nothing retries failed webhooks or emails (outcome is written as a system note on the entry, `entries.ts` line 287); nothing purges old data; a restart loses in-flight notifications.

---

## Summary

| Question | Answer |
|---|---|
| **MI feasible** | **Needs change.** Not possible on the pinned Prisma 5.22.0: its SQL Server URL parser accepts only `user`/`password` for credentials and has no token or `authentication=` parameter. Runtime support exists upstream only through `@prisma/adapter-mssql` on Prisma 6.x (Entra auth added Oct 2025 per prisma/prisma#13853). Schema deployment via the Prisma CLI still cannot use MI. |
| **Files to change for MI** | `backend/package.json` (Prisma 5→6, add `@prisma/adapter-mssql`, `mssql`, `@azure/identity`), `backend/prisma/schema.prisma` (provider, NVarChar sizes, adapter flag), `backend/src/prisma.ts` (adapter + token provider with refresh), `backend/docker-entrypoint.sh` and `backend/Dockerfile` line 32 (migrations need SQL auth or a custom token-based runner), `backend/src/env.ts` line 17 / `backend/src/services/rosterQuery.ts` line 34 (URL shape), docs and `docker-compose.yml`. |
| **Upload storage today** | Database only. `FormFile.data Bytes` (`backend/prisma/schema.prisma` line 485), 10 MB hard cap per file (`backend/src/forms/entries.ts` line 29). Signatures are base64 PNG text in `FormEntry.data`, `HotFoodEntry.signature`, `AttendanceEntry.signature`. |
| **Blob auth method** | None. No blob storage code, no `AZURE_STORAGE_ACCOUNT_URL`, no `@azure/storage-blob`. |
| **Phase 3 items done/total** | 2 done (health 503, DEV_AUTH guard), 1 partial (demo guard: `demo:hot-foods` yes, `seed` no, no `ALLOW_DEMO_DATA`), 5 not done (sqlserver provider, trust proxy, BACKEND_URL runtime, calendar, link-only templates). **2/8.** |
| **Open questions for Steven** | 1. Is a Prisma 5→6 upgrade acceptable to get MI, and should schema deployment keep a SQL-auth login or move to a custom token-based migration runner? 2. Should uploads move to Blob Storage before go-live, given 10 MB binaries and base64 signatures in SQL rows (and the stale `database/azure-sql-schema.sql` that lacks `FormFile`)? 3. Should the `seed` script get the same production refusal as `demo:hot-foods`, and should `ALLOW_DEMO_DATA` be introduced? 4. Should notification emails default to `{entry:url}` (link-only) instead of `{all_fields}` since resident names and answers currently go out in mail and webhook bodies? 5. Is the calendar delegated flow still in scope (nothing exists yet, and no `offline_access` scope is requested)? 6. `JWT_SECRET` has a hard-coded dev fallback with no production check; should startup refuse it when `NODE_ENV=production`? |
