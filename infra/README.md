# Lantern Forms – Azure infrastructure

How the app is hosted, what everything is called, and how a change gets to production.
Build commands are in `build.sh`; the full playbook with rationale lives with IT.

## Where it runs

Subscription **LCS-Forms** (`8572bc7a-71e9-4c54-bf3a-8a8222bc11f4`), created Oct 2026 for this app only.
Two environments, built from the same script, each in its own resource group. A third resource
group holds what both share.

```
rg-forms-shared   container registry, Log Analytics, deploy identity, private DNS zones
rg-forms-dev      everything development
rg-forms-prod     everything production
```

Region is **East US 2** for everything except the SQL servers, which are in **East US** because the
subscription is not permitted to create SQL servers in East US 2. Private endpoints in the East US 2
VNets reach them across regions; the app never notices.

## Naming

`<type>-forms-<env>` with Azure CAF abbreviations. Globally unique resources (registry, Key Vault,
SQL server) carry an `lcs` prefix because the plain names were already taken by other tenants.

| Resource | Dev | Prod |
|---|---|---|
| Resource group | `rg-forms-dev` | `rg-forms-prod` |
| VNet | `vnet-forms-dev` (10.20.0.0/24) | `vnet-forms-prod` (10.21.0.0/24) |
| App Service plan | `asp-forms-dev` (B2 Linux) | `asp-forms-prod` (P1v3 Linux) |
| Web app, frontend | `app-forms-web-dev` | `app-forms-web-prod` |
| Web app, backend | `app-forms-api-dev` | `app-forms-api-prod` |
| Key Vault | `kv-lcsforms-dev` | `kv-lcsforms-prod` |
| SQL server / database | `sql-lcsforms-dev` / `sqldb-forms-dev` (Basic) | `sql-lcsforms-prod` / `sqldb-forms-prod` (GP serverless) |
| App Insights | `appi-forms-dev` | `appi-forms-prod` |
| Entra app registration | Lantern Forms (Dev) `af86fc4c-…` | Lantern Forms `7678724c-…` |
| Sending mailbox | forms-dev@lanterncommunity.org | forms@lanterncommunity.org |
| Hostname | app-forms-web-dev.azurewebsites.net | lcsforms.lanterncommunity.org |

Shared: `acrlcsforms` (registry), `log-forms-shared`, `id-forms-deploy` (GitHub deploy identity).

Every resource is tagged `environment`, `app`, `owner`, `cost-center`, `data-classification`.
The `environment` tag is the source of truth for what is production, not the name.

> **Note on the PO app.** The LCS PO system's Azure resources are named `-dev` but are production,
> and its `-test` resources are development. That is a historical accident in a different
> subscription. Lantern Forms does not follow it: here `-dev` is development and `-prod` is production.

## How a change ships

1. Branch from `main`, open a PR. `main` is protected; nobody pushes to it directly.
2. Merge → `.github/workflows/cd-forms.yml` builds both images, tags them with the commit SHA, pushes
   to `acrlcsforms`, and deploys to **dev**. The api runs `prisma migrate deploy` on that first start
   (`RUN_MIGRATIONS=true` for the deploy, cleared after).
3. The **prod** job waits for an approval in GitHub (Environments → prod → required reviewers).
   Approve, and the same images go to production.
4. Rollback = rerun the workflow on the last good commit, or set the previous image tag on the web apps.
   Schema never rolls back; write a forward migration.

The workflow authenticates with OIDC against `id-forms-deploy`; there are no stored cloud secrets in
GitHub. Per-environment values are GitHub environment variables (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`, `RG`, `BACKEND_URL`, `WEB_HOST`).

## Configuration and secrets

App settings are set on the web apps by `build.sh`. Anything secret is a Key Vault reference
(`@Microsoft.KeyVault(SecretUri=…)`) resolved by App Service with the app's managed identity:
`JWT_SECRET`, `MICROSOFT_CLIENT_SECRET`, `DATABASE_URL`. Nothing secret lives in the repo, in
GitHub, or in plain app settings.

Production guards set in app settings: `NODE_ENV=production`, `DEV_AUTH=false`,
`DB_PUSH_ON_START=false`, `SEED_DEMO_QUEUE=false`. The code must refuse demo/seed operations when
`NODE_ENV=production` unless `ALLOW_DEMO_DATA=true`, which the pipeline never sets.

## Graph permissions

- `Mail.Send` (application), restricted by an Exchange application access policy to the one sending
  mailbox per environment. Notification emails are link-only.
- `Calendars.ReadWrite` + `offline_access` (delegated). The app writes to the signed-in user's own
  calendar with that user's token; other people are reached as attendees. No application-level
  access to staff calendars.

## Database access

The SQL servers are Entra-only. The app connects as a contained database user `forms_app`
(`infra/sql/forms_app.sql`), whose password lives only in Key Vault as part of `DATABASE_URL`.
Steven is the Entra admin on both servers; developers test against a local SQL Server container
or the dev database, never prod.

## Operations

- Logs: Application Insights per environment, SQL auditing and App Service logs in `log-forms-shared`.
- Backups (prod): 35-day point-in-time restore; long-term weekly 12w, monthly 12m, yearly 7y.
- Prod resource group carries a `CanNotDelete` lock.
- Secret rotation, access reviews and incident steps are in the IT playbook.
