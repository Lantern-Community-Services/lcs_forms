import { Router, type Request } from "express";
import { prisma } from "../prisma.js";
import { asyncHandler, unauthorized } from "../http.js";
import { ONBOARDING_COOKIE, verifyOnboarding } from "../auth/auth.js";
import { setOnboardingCookie } from "./auth.js";
import { DEFAULT_ROLE_KEY } from "../services/permissions.js";
import { randomAvatarColor } from "../services/avatars.js";
import { audit } from "../services/audit.js";
import { notifyQuietly } from "../services/notifications.js";
import { systemEmail } from "../services/emailTemplates.js";

/**
 * A first sign-in by someone nobody made an account for (/welcome). It opens
 * with the onboarding cookie routes/auth.ts sets, not a session. All they do
 * here is ask for access: that makes their account, as a request, and an
 * Admin approves it in People & roles → Requests, choosing their role and
 * sites (routes/users.ts). Site Managers don't see or approve requests.
 */
export const onboardingRouter = Router();

/** The "Main Office" choice the old "Where do you work?" question offered; still read on older requests. */
export const MAIN_OFFICE_LOCATION = "main_office";

/** Who's on /welcome: a newcomer who hasn't asked yet, or the request they made. */
async function visitor(req: Request) {
  const pass = verifyOnboarding(req.cookies?.[ONBOARDING_COOKIE]);
  if (!pass) throw unauthorized("Sign in again to continue.");
  if ("newcomer" in pass) {
    // Asked already, from another tab or device: that request is theirs.
    const existing = await prisma.user.findUnique({ where: { email: pass.newcomer.email } });
    if (!existing) return { newcomer: pass.newcomer, user: null };
    if (existing.status !== "requested") throw unauthorized("Sign in again to continue.");
    return { newcomer: null, user: existing };
  }
  const user = await prisma.user.findUnique({ where: { id: pass.userId } });
  if (!user || user.status !== "requested") throw unauthorized("Sign in again to continue.");
  return { newcomer: null, user };
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
    const { newcomer, user } = await visitor(req);
    const who = user ?? newcomer!;
    res.json({ name: who.name, email: who.email, submitted: Boolean(user) });
  })
);

onboardingRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { newcomer, user } = await visitor(req);
    // Asking twice changes nothing.
    if (user) return res.json({ ok: true });
    const requester = await prisma.user.create({
      data: { ...newcomer!, avatarColor: randomAvatarColor(), roleKey: DEFAULT_ROLE_KEY, status: "requested" },
    });
    // From here on the cookie names the request, so signing in again finds it.
    setOnboardingCookie(res, { userId: requester.id });
    await audit({
      actor: { id: requester.id, name: requester.name },
      action: "user.access_requested",
      summary: `${requester.name} (${requester.email}) asked for access to Lantern Forms`,
    });
    // Only Admins let people in, so this reaches them.
    // Worded by the "Someone asks for access" email (Admin → Notifications → System emails).
    const mail = await systemEmail(
      "access-request",
      { person: requester.name, email: requester.email, position: requester.title ?? "" },
      `${requester.name} is asking for access`
    );
    notifyQuietly({
      to: { permissions: ["users.manage"] },
      type: "people.request",
      title: mail.title,
      urgent: mail.urgent,
      email: mail.email,
      body: `${requester.email}${requester.title ? ` · ${requester.title}` : ""} signed in for the first time and asked for access. Approve it in People & roles, with their role and sites.`,
      link: "/admin/people?tab=requests",
      sourceLabel: "People & roles",
    });
    res.json({ ok: true });
  })
);
