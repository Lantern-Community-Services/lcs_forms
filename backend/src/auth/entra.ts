import crypto from "node:crypto";
import { ConfidentialClientApplication, CryptoProvider, LogLevel, type AccountInfo } from "@azure/msal-node";
import jwt from "jsonwebtoken";
import { env, isProd, ssoConfigured } from "../env.js";
import { CALENDAR_SCOPES, graphTokensEnabled } from "../services/graphTokens.js";

/**
 * Microsoft Entra ID sign-in (OIDC authorization-code flow + PKCE).
 *
 * Single-tenant: the authority is pinned to the Lantern directory, so only
 * accounts in that tenant can even reach the consent screen. We ask for
 * identity (`openid profile email User.Read`) and, when the calendar goes to
 * Outlook, delegated `Calendars.ReadWrite offline_access`: the refresh token
 * that comes back is kept, encrypted, so the calendar can write to this
 * person's own Outlook later (services/graphTokens.ts). Both are consented for
 * the organization on the app registration, so nobody sees a consent screen.
 *
 * Between the two legs of the flow we have to remember the PKCE verifier and
 * the CSRF state. Rather than keep server-side session state (the API is
 * otherwise stateless and may run on more than one instance), we stash them in
 * a short-lived signed cookie that the callback consumes and clears.
 */

// User.Read is delegated and user-consentable — it needs no admin consent. It
// buys us the Graph /me lookup below, which is the only way to get a job title:
// no OIDC claim carries one. The calendar scopes only when Outlook is on
// (OUTLOOK_SYNC=false leaves them out, for an app registration without that consent).
const scopes = () => ["openid", "profile", "email", "User.Read", ...(graphTokensEnabled() ? CALENDAR_SCOPES : [])];

/** Graph is best-effort: a slow directory must never hold up a sign-in. */
const GRAPH_TIMEOUT_MS = 5000;

/** Holds the PKCE verifier + CSRF state between /microsoft and its callback. */
export const OIDC_TX_COOKIE = "lantern_roster_oidc_tx";
const TX_TTL_SECONDS = 10 * 60;

interface OidcTransaction {
  state: string;
  verifier: string;
  /** In-app path to land on after sign-in, e.g. "/bills/abc". */
  returnTo: string;
  /**
   * Whether the session cookie should outlive the browser — the sign-in
   * screen's "stay signed in on this phone".
   *
   * It travels in the transaction rather than in a cookie of its own because
   * the choice is made before the redirect to Microsoft and acted on after it
   * comes back, and the transaction is the only thing that survives the trip
   * with its integrity signed. Absent means yes, so a sign-in started by
   * anything that does not know about the box behaves as it always did.
   */
  stay?: boolean;
}

let client: ConfidentialClientApplication | null = null;

function getClient(): ConfidentialClientApplication {
  if (!ssoConfigured) {
    throw new Error(
      "Microsoft sign-in is not configured. Set MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET."
    );
  }
  client ??= new ConfidentialClientApplication({
    auth: {
      clientId: env.microsoft.clientId,
      clientSecret: env.microsoft.clientSecret,
      authority: `https://login.microsoftonline.com/${env.microsoft.tenantId}`,
    },
    system: {
      loggerOptions: {
        logLevel: isProd ? LogLevel.Error : LogLevel.Warning,
        piiLoggingEnabled: false,
        loggerCallback: (_level, message) => console.warn(`[msal] ${message}`),
      },
    },
  });
  return client;
}

const cryptoProvider = new CryptoProvider();

/**
 * Only same-site, in-app paths are accepted as a post-login destination —
 * an open redirect here would let a crafted link bounce a freshly
 * authenticated user off to an attacker's page.
 */
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

/**
 * Build the Entra authorization URL and the transaction cookie that pairs with it.
 *
 * `selectAccount` forces the account picker. It is off by default so that
 * somebody already signed into Microsoft 365 in this browser goes straight
 * through — the sign-in screen offers it explicitly for the handful of people
 * who hold more than one work account.
 *
 * ── Why a domain hint ───────────────────────────────────────────────────────
 * A personal Microsoft account can be registered against a work email address,
 * and then the two are indistinguishable at the sign-in box. Microsoft's
 * home-realm discovery sometimes resolves such an address to the *personal*
 * account — which is not in this tenant, so the tenant-pinned authority rejects
 * it with AADSTS50020 ("from identity provider 'live.com' does not exist in
 * tenant"). The person sees a hard failure on an account that is perfectly
 * healthy in the directory, and nothing about the message says which of their
 * two identities was actually used.
 *
 * `domain_hint` skips that discovery step and sends them straight to the work
 * account path, so the personal account never enters the picture. Only sent
 * when exactly one domain is configured — with several, or none (any tenant
 * account admitted), there is no single right answer and guessing one would
 * bounce legitimate people. Never sent alongside `select_account`: that is
 * somebody explicitly asking to choose, and a hint would undercut the ask.
 */
/**
 * The `prompt` / `domain_hint` half of the authorization request. Pure, so the
 * rule can be tested without a configured Entra tenant — see the note above
 * `beginSignIn` for why the hint exists at all.
 */
export function accountSelectionParams(
  selectAccount: boolean,
  allowedDomains: string[]
): { prompt?: string; domainHint?: string } {
  if (selectAccount) return { prompt: "select_account" };
  // Exactly one domain, or no hint: with several configured, or none at all
  // (any tenant account admitted), there is no single right answer and picking
  // one would bounce people who are legitimately on another.
  return allowedDomains.length === 1 ? { domainHint: allowedDomains[0] } : {};
}

export async function beginSignIn(
  returnTo: string,
  { selectAccount = false, stay = true }: { selectAccount?: boolean; stay?: boolean } = {}
): Promise<{ authUrl: string; tx: string }> {
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
  const state = crypto.randomBytes(16).toString("hex");

  const authUrl = await getClient().getAuthCodeUrl({
    scopes: scopes(),
    redirectUri: env.microsoft.redirectUri,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    state,
    ...accountSelectionParams(selectAccount, env.ssoAllowedDomains),
  });

  const tx = jwt.sign({ state, verifier, returnTo, stay } satisfies OidcTransaction, env.jwtSecret, {
    expiresIn: TX_TTL_SECONDS,
  });
  return { authUrl, tx };
}

export interface EntraIdentity {
  email: string;
  name: string;
  /** Entra object id — stable even if the person is renamed or re-addressed. */
  oid: string;
  tenantId: string;
  /** Job title from the directory. Null when Entra has none recorded. */
  jobTitle: string | null;
  /**
   * Which identity provider actually authenticated them. Absent for home-tenant
   * Microsoft accounts; "google.com" for Google Workspace guests federated into
   * Entra; the partner's issuer for SAML/OIDC federation.
   */
  idp: string | null;
  /**
   * Whether the Graph lookup actually succeeded. This separates "the directory
   * says this person has no title" from "we could not ask" — only the former
   * should be written through to the profile.
   */
  profileLoaded: boolean;
}

/** Read displayName/jobTitle from Microsoft Graph. Never throws — sign-in wins. */
async function loadDirectoryProfile(
  accessToken: string | undefined
): Promise<{ displayName?: string; jobTitle?: string | null } | null> {
  if (!accessToken) return null;
  try {
    const res = await fetch("https://graph.microsoft.com/v1.0/me?$select=displayName,jobTitle", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[entra] Graph /me returned ${res.status}; profile not refreshed.`);
      return null;
    }
    return (await res.json()) as { displayName?: string; jobTitle?: string | null };
  } catch (err) {
    console.warn("[entra] Graph /me failed; profile not refreshed:", err);
    return null;
  }
}

/**
 * Redeem the authorization code and return the verified identity.
 * MSAL validates the id_token signature, issuer, audience and expiry.
 */
export async function completeSignIn(
  code: string,
  state: string,
  txCookie: string | undefined
): Promise<{ identity: EntraIdentity; returnTo: string; stay: boolean; graph: { refreshToken: string; scopes: string[] } | null }> {
  if (!txCookie) throw new Error("Sign-in session expired. Please try again.");

  let tx: OidcTransaction;
  try {
    tx = jwt.verify(txCookie, env.jwtSecret) as OidcTransaction;
  } catch {
    throw new Error("Sign-in session expired. Please try again.");
  }

  // Constant-time compare: `state` is attacker-controllable in a CSRF attempt.
  const a = Buffer.from(tx.state);
  const b = Buffer.from(state ?? "");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("Sign-in verification failed. Please try again.");
  }

  const result = await getClient().acquireTokenByCode({
    code,
    scopes: scopes(),
    redirectUri: env.microsoft.redirectUri,
    codeVerifier: tx.verifier,
    state,
  });
  const refreshToken = await takeRefreshToken(result.account);

  const claims = (result.idTokenClaims ?? {}) as Record<string, unknown>;
  const tenantId = String(claims.tid ?? "");
  // Defence in depth: the single-tenant authority should already guarantee this.
  if (tenantId !== env.microsoft.tenantId) {
    throw new Error("This account is not part of the Lantern directory.");
  }

  // `email` first: for a B2B guest (e.g. a Google Workspace user) it is their
  // real address, while preferred_username can be a tenant-local alias.
  const email = String(
    claims.email ?? claims.preferred_username ?? claims.upn ?? result.account?.username ?? ""
  ).toLowerCase();
  if (!email) throw new Error("Microsoft did not return an email address for this account.");

  const profile = await loadDirectoryProfile(result.accessToken);

  return {
    identity: {
      email,
      // Graph's displayName is the authoritative spelling; the token claim is
      // the fallback when the directory could not be reached.
      name: String(profile?.displayName || claims.name || result.account?.name || email),
      oid: String(claims.oid ?? result.account?.homeAccountId ?? ""),
      tenantId,
      jobTitle: profile?.jobTitle?.trim() || null,
      profileLoaded: profile !== null,
      idp: typeof claims.idp === "string" ? claims.idp : null,
    },
    returnTo: safeReturnTo(tx.returnTo),
    // Absent means yes — see the note on OidcTransaction.
    stay: tx.stay !== false,
    graph: refreshToken && result.scopes.some((s) => /calendars\.readwrite/i.test(s)) ? { refreshToken, scopes: result.scopes } : null,
  };
}

/**
 * The refresh token MSAL just received for this account, then that account
 * taken out of MSAL's in-memory cache (the app keeps its own copy per person,
 * encrypted, and MSAL's cache would otherwise grow with every sign-in).
 * MSAL doesn't hand refresh tokens out directly; they're in its serialized
 * cache, in the shared MSAL cache format. Null when there's none (no
 * offline_access) or it can't be found: sign-in goes ahead without Outlook.
 */
async function takeRefreshToken(account: AccountInfo | null): Promise<string | null> {
  if (!account) return null;
  const cache = getClient().getTokenCache();
  try {
    const parsed = JSON.parse(cache.serialize()) as { RefreshToken?: Record<string, { home_account_id?: string; secret?: string }> };
    return Object.values(parsed.RefreshToken ?? {}).find((t) => t.home_account_id === account.homeAccountId)?.secret ?? null;
  } catch (err) {
    console.warn("[entra] couldn't read the refresh token from MSAL's cache:", err instanceof Error ? err.message : err);
    return null;
  } finally {
    await cache.removeAccount(account).catch(() => undefined);
  }
}

/**
 * Domain allowlist (see env.ssoAllowedDomains). Empty list = any tenant account.
 *
 * `guestDomains` are the admin-configured additions, for invited Entra B2B
 * guests who authenticate against this tenant but keep their home email domain.
 * They widen which *directory accounts* may use the app, never who may be in
 * the directory: the tenant check has already run by the time this is called,
 * so nobody reaches here without an admin having invited them.
 */
export function isAllowedDomain(email: string, guestDomains: string[] = []): boolean {
  if (env.ssoAllowedDomains.length === 0) return true;
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return env.ssoAllowedDomains.includes(domain) || guestDomains.includes(domain);
}

/**
 * Is this address on Lantern's own domain (SSO_ALLOWED_DOMAINS), as opposed
 * to an admitted partner domain? Fails closed: with no domains configured,
 * nobody counts as staff, so nobody is auto-approved.
 */
export function isStaffDomain(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return env.ssoAllowedDomains.length > 0 && env.ssoAllowedDomains.includes(domain);
}
