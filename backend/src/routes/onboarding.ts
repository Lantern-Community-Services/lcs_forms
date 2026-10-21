import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler, badRequest, unauthorized } from "../http.js";
import { ONBOARDING_COOKIE, verifyOnboarding } from "../auth/auth.js";
import { audit } from "../services/audit.js";
import { notifyQuietly } from "../services/notifications.js";

/**
 * A new person's first sign-in (/welcome): where they work and which sites
 * they want to see. It opens with the onboarding cookie routes/auth.ts sets,
 * not a session, and only while their account is still a request.
 *
 * The sites they choose are saved as unapproved UserSite rows; each site's
 * Site Managers (or an Admin) approve or decline them in People & roles
 * (routes/users.ts). Choosing again replaces what's still waiting.
 */
export const onboardingRouter = Router();

/** The "Main Office" choice on "Where do you work?" — not a site with a roster. */
export const MAIN_OFFICE_LOCATION = "main_office";

async function requester(req: Request) {
  const id = verifyOnboarding(req.cookies?.[ONBOARDING_COOKIE]);
  const user = id ? await prisma.user.findUnique({ where: { id }, include: { sites: { select: { siteId: true, approved: true } } } }) : null;
  if (!user || user.status !== "requested") throw unauthorized("Sign in again to continue.");
  return user;
}

export function parseLocations(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

onboardingRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const user = await requester(req);
    const sites = await prisma.site.findMany({ where: { active: true }, select: { id: true, name: true, siteType: true }, orderBy: { name: "asc" } });
    res.json({
      name: user.name,
      email: user.email,
      sites,
      locations: parseLocations(user.locations),
      siteIds: user.sites.map((s) => s.siteId),
      submitted: user.sites.length > 0,
    });
  })
);

onboardingRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const user = await requester(req);
    const body = z
      .object({
        locations: z.array(z.string()).min(1, "Choose where you work.").max(40),
        siteIds: z.array(z.string()).min(1, "Choose at least one site to see.").max(40),
      })
      .parse(req.body);
    const active = await prisma.site.findMany({ where: { active: true }, select: { id: true, name: true } });
    const known = new Set(active.map((s) => s.id));
    const locations = [...new Set(body.locations)];
    const siteIds = [...new Set(body.siteIds)];
    if (locations.some((l) => l !== MAIN_OFFICE_LOCATION && !known.has(l)) || siteIds.some((id) => !known.has(id))) {
      throw badRequest("One of those sites isn't available any more. Reload and choose again.");
    }
    const first = user.sites.length === 0;
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { locations: JSON.stringify(locations) } }),
      // Only what's still waiting is replaced: nothing here is approved yet,
      // since an approval makes the account active and closes this page.
      prisma.userSite.deleteMany({ where: { userId: user.id, approved: false } }),
      prisma.userSite.createMany({ data: siteIds.map((siteId) => ({ userId: user.id, siteId, approved: false })) }),
    ]);
    const names = active.filter((s) => siteIds.includes(s.id)).map((s) => s.name);
    await audit({
      actor: { id: user.id, name: user.name },
      action: "user.access_requested",
      summary: `${user.name} (${user.email}) ${first ? "asked" : "changed their request"} to see ${names.join(", ")}`,
    });
    // Admins see every site, so this reaches them and each chosen site's managers.
    notifyQuietly({
      to: { permissions: ["users.manage", "users.manageSite"], sites: siteIds },
      type: "people.request",
      title: `${user.name} is asking to see ${names.length === 1 ? names[0] : `${names.length} sites`}`,
      body: `${user.email}${user.title ? ` · ${user.title}` : ""} wants to see ${names.join(", ")}. Approve or decline it in People & roles.`,
      link: "/admin/people?tab=requests",
      sourceLabel: "People & roles",
    });
    res.json({ ok: true });
  })
);
