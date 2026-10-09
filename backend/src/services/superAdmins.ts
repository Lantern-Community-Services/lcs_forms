import { prisma } from "../prisma.js";
import { env } from "../env.js";
import { audit } from "./audit.js";

/**
 * Super Admins come only from the SUPER_ADMINS setting. Nothing in the app or
 * the API makes, changes or removes one (routes/users.ts refuses), so this is
 * where the list takes effect, at every start-up:
 *   - a listed person with an account becomes an active Super Admin;
 *   - a Super Admin who's no longer listed goes back to a plain Admin, still
 *     active, so an Admin can then change or remove them as usual.
 * A listed address with no account yet gets one at its first Microsoft sign-in
 * (routes/auth.ts).
 *
 * An empty list changes nothing. A missing setting must never strip every
 * Super Admin and leave nobody able to manage the Admins.
 */
export async function syncSuperAdmins(): Promise<{ promoted: number; demoted: number } | null> {
  const listed = env.superAdmins;
  if (listed.length === 0) {
    console.warn("  Super Admins: SUPER_ADMINS is empty, so nobody was changed.");
    return null;
  }
  const actor = { id: null, name: "SUPER_ADMINS setting" };

  const toPromote = await prisma.user.findMany({
    where: { email: { in: listed }, NOT: { globalAdmin: true, roleKey: "admin", status: "active" } },
    select: { id: true, name: true, email: true },
  });
  for (const u of toPromote) {
    await prisma.user.update({ where: { id: u.id }, data: { roleKey: "admin", globalAdmin: true, status: "active" } });
    await audit({ actor, action: "user.super_admin", summary: `${u.name} (${u.email}) is a Super Admin (SUPER_ADMINS)` });
  }

  const toDemote = await prisma.user.findMany({
    where: { globalAdmin: true, email: { notIn: listed } },
    select: { id: true, name: true, email: true },
  });
  for (const u of toDemote) {
    await prisma.user.update({ where: { id: u.id }, data: { globalAdmin: false } });
    await audit({ actor, action: "user.super_admin_removed", summary: `${u.name} (${u.email}) is no longer a Super Admin (not in SUPER_ADMINS); still an Admin` });
  }

  return { promoted: toPromote.length, demoted: toDemote.length };
}
