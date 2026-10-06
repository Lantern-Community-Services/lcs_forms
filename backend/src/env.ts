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

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4200),
  databaseUrl: process.env.DATABASE_URL ?? "",
  corsOrigins: list(process.env.CORS_ORIGIN, "http://localhost:5200"),
  jwtSecret: process.env.JWT_SECRET ?? "dev-only-change-me",

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
   * The "Lantern Calendar" mailbox that organizes the calendar's Outlook
   * meetings and invites people to them (Graph, app-only; see
   * services/outlookSync.ts). Empty = nothing is sent to Outlook.
   */
  calendarOrganizer: (process.env.CALENDAR_ORGANIZER ?? "").trim(),

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
   * Entra app registration exists. Refused outright in production.
   */
  devAuth: (process.env.DEV_AUTH ?? "true").toLowerCase() === "true",
};

export const isProd = env.nodeEnv === "production";

export const ssoConfigured = Boolean(
  env.microsoft.tenantId && env.microsoft.clientId && env.microsoft.clientSecret
);

/** Dev sign-in is never available in production, whatever DEV_AUTH says. */
export const devAuthEnabled = env.devAuth && !isProd;

export const appBaseUrl = env.appBaseUrl || env.corsOrigins[0] || "http://localhost:5200";
