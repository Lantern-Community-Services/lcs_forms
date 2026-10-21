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
 * A new person's pass to /welcome, where they choose where they work and which
 * sites they want to see. It isn't a session: it opens only the onboarding
 * routes (routes/onboarding.ts), for someone whose account is still a request.
 */
export const ONBOARDING_COOKIE = "lantern_onboarding";
const ONBOARDING_TTL = "2h";

export function signOnboarding(userId: string): string {
  return jwt.sign({ userId, purpose: "onboarding" }, env.jwtSecret, { expiresIn: ONBOARDING_TTL });
}

export function verifyOnboarding(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const p = jwt.verify(token, env.jwtSecret) as { userId?: string; purpose?: string };
    return p.purpose === "onboarding" && p.userId ? p.userId : null;
  } catch {
    return null;
  }
}
