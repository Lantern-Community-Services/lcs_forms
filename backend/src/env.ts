import dotenv from "dotenv";

// `.env` holds tracked, non-secret config. `.env.local` holds real secrets
// (Entra client secret), is git-ignored, and overrides `.env`.
dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const list = (value: string | undefined, fallback = "") =>
  (value ?? fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** A positive number from the environment, or the fallback when it's unset or isn't one. */
function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * TRUST_PROXY: how many proxies stand between the client and this process, so
 * req.ip is the client's address (Express "trust proxy"). 1 = one front end
 * (local dev behind Next's /api proxy, or the API called straight through App
 * Service). Behind App Service with the web app proxying /api to the API app
 * there are two (both apps' front ends): set 2. "false" trusts no header.
 */
function trustProxy(value: string | undefined): number | false {
  if (value === undefined || value.trim() === "") return 1;
  if (value.trim().toLowerCase() === "false") return false;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`TRUST_PROXY must be a number of proxies or "false", not "${value}".`);
  return n;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4200),
  /** Containers listen on every interface; App Service reaches them from outside. */
  host: process.env.HOST ?? "0.0.0.0",
  trustProxy: trustProxy(process.env.TRUST_PROXY),
  databaseUrl: process.env.DATABASE_URL ?? "",
  corsOrigins: list(process.env.CORS_ORIGIN, "http://localhost:5200"),
  jwtSecret: process.env.JWT_SECRET ?? "dev-only-change-me",

  /**
   * Key for what's encrypted in the database (people's Microsoft refresh
   * tokens): 32 random bytes, base64 (`openssl rand -base64 32`). From Key Vault
   * in Azure. Required in production for anything to go to Outlook; locally a
   * key is derived from JWT_SECRET when it's not set. See services/secretBox.ts.
   */
  tokenEncryptionKey: (process.env.TOKEN_ENCRYPTION_KEY ?? "").trim(),

  /**
   * Where uploaded files (File fields, code forms' photos and signatures) are
   * kept: Azure Blob Storage when either of these is set, otherwise the
   * database (local development). See services/fileStore.ts.
   *   AZURE_STORAGE_ACCOUNT_URL         https://<account>.blob.core.windows.net, signed in with
   *                                     the app's managed identity (Storage Blob Data Contributor)
   *   AZURE_STORAGE_CONNECTION_STRING   a connection string instead (Azurite, local tests)
   */
  blob: {
    accountUrl: (process.env.AZURE_STORAGE_ACCOUNT_URL ?? "").trim().replace(/\/$/, ""),
    connectionString: (process.env.AZURE_STORAGE_CONNECTION_STRING ?? "").trim(),
    container: (process.env.AZURE_STORAGE_CONTAINER ?? "form-files").trim() || "form-files",
  },

  /**
   * Microsoft Entra ID — the production sign-in. Google Workspace users sign in
   * through the same flow as Entra B2B guests federated with Google, so the app
   * itself only ever speaks OIDC to one authority. See README "Sign-in".
   */
  microsoft: {
    tenantId: process.env.MICROSOFT_TENANT_ID ?? "",
    clientId: process.env.MICROSOFT_CLIENT_ID ?? "",
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? "",
    redirectUri:
      process.env.MICROSOFT_REDIRECT_URI ?? "http://localhost:5200/api/auth/microsoft/callback",
  },

  appBaseUrl: (process.env.APP_BASE_URL ?? "").replace(/\/$/, ""),

  /**
   * Mailbox form notifications are sent from (Graph sendMail, app-only). Empty
   * = email notifications are recorded on the entry but not sent. See
   * services/mailer.ts for the Entra permission it needs.
   */
  mailFrom: process.env.MAIL_FROM ?? "",

  /**
   * The calendar in people's Outlook (services/outlookSync.ts), through each
   * person's own delegated Microsoft sign-in. On whenever Microsoft sign-in is
   * configured and tokens can be stored; OUTLOOK_SYNC=false turns it off.
   */
  outlookSync: (process.env.OUTLOOK_SYNC ?? "true").toLowerCase() !== "false",

  /**
   * Backup of every built form to a GitHub repository (services/formBackup.ts).
   * FORM_BACKUP_REPO is "owner/name"; FORM_BACKUP_TOKEN a token that can write
   * that repository's contents (put it in .env.local). Either empty = no backup.
   */
  formBackup: {
    repo: (process.env.FORM_BACKUP_REPO ?? "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, ""),
    token: (process.env.FORM_BACKUP_TOKEN ?? "").trim(),
    branch: (process.env.FORM_BACKUP_BRANCH ?? "main").trim() || "main",
  },

  /**
   * Email domains always allowed to sign in. Admins add partner / Google
   * Workspace domains at runtime in Admin → Sign-in access; those are unioned
   * with this list. Empty = any account the tenant admits.
   */
  ssoAllowedDomains: list(process.env.SSO_ALLOWED_DOMAINS, "lanterncommunity.org").map((s) =>
    s.toLowerCase().replace(/^@/, "")
  ),

  /**
   * Local-only "pick a demo user" sign-in, so the prototype runs before an
   * Entra app registration exists. Off unless DEV_AUTH=true, and refused
   * outright in production (see devAuthEnabled).
   */
  devAuth: (process.env.DEV_AUTH ?? "false").toLowerCase() === "true",

  /**
   * Super Admins (comma-separated emails): the only way anyone becomes one.
   * Nothing in the app or the API can make, change or remove a Super Admin.
   * At start-up this list is applied to the database (services/superAdmins.ts):
   * listed people become active Super Admins, and a Super Admin who's no longer
   * listed goes back to a plain Admin. A listed address with no account yet
   * gets one at its first Microsoft sign-in. GLOBAL_ADMINS is the old name,
   * still read when SUPER_ADMINS isn't set.
   */
  superAdmins: list(process.env.SUPER_ADMINS || process.env.GLOBAL_ADMINS).map((s) => s.toLowerCase()),

  /** Demo rows (demo accounts, a backdated review queue) in production: never, unless this is "true". */
  allowDemoData: (process.env.ALLOW_DEMO_DATA ?? "false").toLowerCase() === "true",

  /**
   * Admin → Dev log (services/devlog.ts). On unless DEVLOG=false.
   *   DEVLOG_SLOW_REQUEST_MS   a request this slow is logged on its own (2000)
   *   DEVLOG_SLOW_QUERY_MS     likewise a database query (500)
   *   DEVLOG_RETENTION_DAYS    how long the log is kept (30)
   * APP_VERSION (a commit or build number, set by the pipeline) is shown on
   * each server start, so a change in the numbers can be matched to a deploy.
   */
  devlog: {
    enabled: (process.env.DEVLOG ?? "true").toLowerCase() !== "false",
    slowRequestMs: positive(process.env.DEVLOG_SLOW_REQUEST_MS, 2000),
    slowQueryMs: positive(process.env.DEVLOG_SLOW_QUERY_MS, 500),
    retentionDays: positive(process.env.DEVLOG_RETENTION_DAYS, 30),
    appVersion: (process.env.APP_VERSION ?? process.env.GIT_SHA ?? "").trim().slice(0, 64),
  },
};

export const isProd = env.nodeEnv === "production";

/** Running in Azure App Service (it sets WEBSITE_SITE_NAME in every app). */
export const onAppService = Boolean(process.env.WEBSITE_SITE_NAME);

// Sessions are signed with JWT_SECRET: production never runs on the development default.
if ((isProd || onAppService) && (!process.env.JWT_SECRET || process.env.JWT_SECRET === "dev-only-change-me")) {
  throw new Error("JWT_SECRET must be set in production (a long random string).");
}

export const ssoConfigured = Boolean(
  env.microsoft.tenantId && env.microsoft.clientId && env.microsoft.clientSecret
);

/**
 * Dev sign-in is never available in production, whatever DEV_AUTH says: not
 * with NODE_ENV=production, and not on App Service even if NODE_ENV was
 * changed there.
 */
export const devAuthEnabled = env.devAuth && !isProd && !onAppService;

/**
 * Scripts that write demo rows call this first. In production they stop unless
 * ALLOW_DEMO_DATA=true, which the pipeline never sets.
 */
export function assertDemoDataAllowed(what: string) {
  if ((isProd || onAppService) && !env.allowDemoData) {
    throw new Error(`${what} writes demo data, and this is production (NODE_ENV=production, or App Service). Refusing; set ALLOW_DEMO_DATA=true to override.`);
  }
}

export const appBaseUrl = env.appBaseUrl || env.corsOrigins[0] || "http://localhost:5200";
