import jwt from "jsonwebtoken";
import { env } from "../env.js";

/**
 * Session tokens. Identity itself comes from Microsoft Entra ID (see
 * auth/entra.ts) — this module only mints and reads the app's own session
 * cookie once that sign-in has succeeded. There are no local passwords.
 */

/**
 * What the session cookie carries. Deliberately just identity: the role and its
 * permissions are read from the database per request (see auth/middleware.ts),
 * so retuning a role takes effect immediately instead of lingering in a token.
 */
export interface SessionPayload {
  userId: string;
  name: string;
  email: string;
}

const TOKEN_TTL = "7d";
export const AUTH_COOKIE = "lantern_roster_session";

export function signSession(payload: SessionPayload): string {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: TOKEN_TTL });
}

export function verifySession(token: string): SessionPayload | null {
  try {
    return jwt.verify(token, env.jwtSecret) as SessionPayload;
  } catch {
    return null;
  }
}

/**
 * A new person's pass to /welcome, where they ask for access. It isn't a
 * session: it opens only the onboarding routes (routes/onboarding.ts). Before
 * they ask it carries who Microsoft says they are (`newcomer`), since there's
 * no account yet; once they've asked, it names their request (`userId`).
 */
export const ONBOARDING_COOKIE = "lantern_onboarding";
const ONBOARDING_TTL = "2h";

export interface Newcomer {
  name: string;
  email: string;
  entraObjectId: string | null;
  identityProvider: string;
  title?: string | null;
}

export type OnboardingPass = { userId: string } | { newcomer: Newcomer };

export function signOnboarding(pass: OnboardingPass): string {
  return jwt.sign({ ...pass, purpose: "onboarding" }, env.jwtSecret, { expiresIn: ONBOARDING_TTL });
}

export function verifyOnboarding(token: string | undefined): OnboardingPass | null {
  if (!token) return null;
  try {
    const p = jwt.verify(token, env.jwtSecret) as { userId?: string; newcomer?: Newcomer; purpose?: string };
    if (p.purpose !== "onboarding") return null;
    if (p.userId) return { userId: p.userId };
    if (p.newcomer?.email) return { newcomer: p.newcomer };
    return null;
  } catch {
    return null;
  }
}

/**
 * Someone with View as seeing the site as another person (routes/auth.ts
 * /view-as), read only or, with `act`, acting as them. It rides beside the
 * session cookie and names both people, so it does nothing for anyone but who
 * started it, and nothing once they can't any more (auth/middleware.ts checks
 * again on every request).
 */
export const VIEW_AS_COOKIE = "lantern_view_as";
export const VIEW_AS_TTL_MS = 8 * 60 * 60 * 1000;

export interface ViewAsPass {
  /** Who's really signed in. */
  by: string;
  /** Who they're seeing the site as. */
  as: string;
  /** Acting as them: changes go through in their name (IT support). Otherwise read only. */
  act?: boolean;
}

export function signViewAs(pass: ViewAsPass): string {
  return jwt.sign({ ...pass, purpose: "view_as" }, env.jwtSecret, { expiresIn: VIEW_AS_TTL_MS / 1000 });
}

export function verifyViewAs(token: string | undefined): ViewAsPass | null {
  if (!token) return null;
  try {
    const p = jwt.verify(token, env.jwtSecret) as Partial<ViewAsPass> & { purpose?: string };
    return p.purpose === "view_as" && p.by && p.as ? { by: p.by, as: p.as, act: p.act === true } : null;
  } catch {
    return null;
  }
}
