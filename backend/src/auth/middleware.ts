import type { NextFunction, Request, Response } from "express";
import { AUTH_COOKIE, verifySession, type SessionPayload } from "./auth.js";
import { prisma } from "../prisma.js";
import { forbidden, unauthorized } from "../http.js";
import { permissionsFor, roleFor, type PermissionKey } from "../services/permissions.js";
import { looksLikeApiKey, resolveApiKey, type ApiScope, type ResolvedKey } from "../services/apiKeys.js";

/** The signed-in person, with what their role currently grants. */
export interface CurrentUser extends SessionPayload {
  roleKey: string;
  roleName: string;
  permissions: PermissionKey[];
  /**
   * Null = every site (admins). Otherwise exactly the sites this person is
   * assigned to — possibly none, in which case they see no rosters at all.
   */
  siteIds: string[] | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: CurrentUser;
      apiKey?: ResolvedKey;
    }
  }
}

/**
 * Populate req.user from the session cookie, or req.apiKey from a key.
 *
 * The cookie proves who you are; role, status and site access are re-read from
 * the database on every request, so a change in Admin → People applies on the
 * person's next tap rather than when their week-long session expires.
 */
/** An active person as the request would see them (role, permissions, sites), or null. Also used for work queued on their behalf. */
export async function currentUserById(id: string): Promise<CurrentUser | null> {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, status: true, roleKey: true, calendarEditor: true, sites: { select: { siteId: true } } },
  });
  if (!user || user.status !== "active") return null;
  const role = roleFor(user.roleKey);
  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    roleKey: role.key,
    roleName: role.name,
    permissions: permissionsFor(role, user),
    siteIds: role.allSites ? null : user.sites.map((s) => s.siteId),
  } as CurrentUser;
}

export async function loadUser(req: Request, _res: Response, next: NextFunction) {
  try {
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const headerKey = req.headers["x-api-key"];
    const presented = looksLikeApiKey(bearer) ? bearer : looksLikeApiKey(headerKey) ? headerKey : null;
    if (presented) {
      const key = await resolveApiKey(presented);
      if (key) req.apiKey = key;
      return next();
    }

    const token = req.cookies?.[AUTH_COOKIE];
    if (!token) return next();
    const payload = verifySession(token);
    if (!payload) return next();

    const user = await currentUserById(payload.userId);
    if (user) req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  next();
}

/** Any one of the listed permissions. */
export function requirePermission(...permissions: PermissionKey[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (permissions.some((p) => req.user!.permissions.includes(p))) return next();
    next(forbidden());
  };
}

export function requireApiScope(scope: ApiScope) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.apiKey) return next(unauthorized("A valid API key is required (Authorization: Bearer lrk_…)."));
    if (!req.apiKey.scopes.includes(scope)) return next(forbidden(`This API key lacks the ${scope} scope.`));
    next();
  };
}

/** Can the signed-in person see / act on this site? */
export function canAccessSite(req: Request, siteId: string): boolean {
  const ids = req.user?.siteIds;
  return ids === null || ids === undefined ? Boolean(req.user) : ids.includes(siteId);
}

/** Prisma filter limiting a query to the caller's sites. */
export function siteScopeWhere(req: Request): { siteId?: { in: string[] } } {
  const ids = req.user?.siteIds;
  return ids ? { siteId: { in: ids } } : {};
}
