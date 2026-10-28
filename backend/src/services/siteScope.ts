import type { Request } from "express";
import { prisma } from "../prisma.js";
import { forbidden, notFound } from "../http.js";
import { canAccessSite } from "../auth/middleware.js";
import { notOffice } from "./officeSites.js";

const SELECT = { id: true, code: true, name: true, siteType: true, attentionHours: true } as const;
export type ScopedSite = { id: string; code: string; name: string; siteType: string; attentionHours: number | null };

/**
 * The sites a request is about.
 *
 * `?site=` takes one code or a comma-separated list (`amber-hall,rockaway-terrace`);
 * ids are accepted too. Absent or empty means "all my sites", which is every
 * active site for an admin and exactly the assigned sites for everyone else.
 * Asking for a site you aren't assigned to is a 403, not a silent drop, so a
 * stale bookmark says what's wrong.
 */
export async function sitesInScope(req: Request, raw: unknown): Promise<ScopedSite[]> {
  const allowed = req.user?.siteIds ?? null;
  const asked =
    typeof raw === "string"
      ? raw.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

  if (asked.length === 0) {
    // Office sites (the Main Office) have no roster.
    return prisma.site.findMany({
      where: { active: true, ...(allowed ? { id: { in: allowed } } : {}), ...notOffice },
      select: SELECT,
      orderBy: { name: "asc" },
    });
  }

  const found = await prisma.site.findMany({
    where: { OR: [{ code: { in: asked } }, { id: { in: asked } }] },
    select: SELECT,
    orderBy: { name: "asc" },
  });
  if (found.length === 0) throw notFound("Site not found.");
  if (allowed && found.some((s) => !allowed.includes(s.id))) throw forbidden("You aren't assigned to one of those sites.");
  return found;
}

/** Resolve a single `?site=` (code or id) and enforce access. Undefined = not given. */
export async function resolveSite(req: Request, raw: unknown): Promise<ScopedSite | undefined> {
  if (typeof raw !== "string" || !raw) return undefined;
  const site = await prisma.site.findFirst({ where: { OR: [{ code: raw }, { id: raw }] }, select: SELECT });
  if (!site) throw notFound("Site not found.");
  if (!canAccessSite(req, site.id)) throw forbidden("You don't have access to that site.");
  return site;
}
