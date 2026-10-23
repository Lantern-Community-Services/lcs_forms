import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler, notFound } from "../http.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { actorOf, audit } from "../services/audit.js";
import { allGroups, effectiveGroups, groupsForTitle, reloadAccess } from "../services/staffGroups.js";

/**
 * Staff groups (People & roles → Groups): the teams forms can be limited to.
 * Admins only (users.manage). Someone is in a group when their job title
 * matches one of its rules, or an admin added them; an admin can also take
 * them out. See services/staffGroups.ts.
 */
export const groupsRouter = Router();
groupsRouter.use(requireAuth);

const rulesSchema = z.array(z.string().trim().min(2).max(120)).max(40);
const groupBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z
    .string()
    .trim()
    .max(255)
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null)),
  rules: rulesSchema.optional(),
});

/** Every group with its rules, and who is in it (and why), for the editor. Also used by form editors to pick groups. */
groupsRouter.get(
  "/",
  requirePermission("users.manage", "forms.manage"),
  asyncHandler(async (_req, res) => {
    const people = await prisma.user.findMany({
      where: { status: { in: ["active", "invited"] } },
      select: { id: true, name: true, email: true, title: true, groupOverrides: { select: { groupId: true, include: true } } },
      orderBy: { name: "asc" },
    });
    res.json(
      allGroups().map((g) => {
        const members: { id: string; name: string; email: string; title: string | null; via: "title" | "added" }[] = [];
        const removed: { id: string; name: string; email: string; title: string | null }[] = [];
        for (const p of people) {
          const byTitle = groupsForTitle(p.title).includes(g.id);
          const o = p.groupOverrides.find((x) => x.groupId === g.id);
          const person = { id: p.id, name: p.name, email: p.email, title: p.title };
          if (o?.include === false) {
            if (byTitle) removed.push(person);
          } else if (o?.include === true) members.push({ ...person, via: byTitle ? "title" : "added" });
          else if (byTitle) members.push({ ...person, via: "title" });
        }
        return { ...g, members, removed };
      })
    );
  })
);

groupsRouter.post(
  "/",
  requirePermission("users.manage"),
  asyncHandler(async (req, res) => {
    const body = groupBody.parse(req.body);
    const last = await prisma.staffGroup.aggregate({ _max: { sortOrder: true } });
    const row = await prisma.staffGroup.create({
      data: {
        name: body.name,
        description: body.description ?? null,
        sortOrder: (last._max.sortOrder ?? -1) + 1,
        rules: { create: [...new Set(body.rules ?? [])].map((contains) => ({ contains })) },
      },
    });
    await reloadAccess();
    await audit({ actor: actorOf(req), action: "groups.created", summary: `Added staff group “${row.name}”`, changes: { rules: body.rules ?? [] } });
    res.status(201).json(row);
  })
);

groupsRouter.patch(
  "/:id",
  requirePermission("users.manage"),
  asyncHandler(async (req, res) => {
    const body = groupBody.partial().parse(req.body);
    const before = await prisma.staffGroup.findUnique({ where: { id: req.params.id }, include: { rules: true } });
    if (!before) throw notFound();
    await prisma.$transaction([
      prisma.staffGroup.update({ where: { id: before.id }, data: { name: body.name, description: body.description } }),
      ...(body.rules
        ? [
            prisma.staffGroupRule.deleteMany({ where: { groupId: before.id } }),
            ...[...new Set(body.rules)].map((contains) => prisma.staffGroupRule.create({ data: { groupId: before.id, contains } })),
          ]
        : []),
    ]);
    await reloadAccess();
    await audit({
      actor: actorOf(req),
      action: "groups.updated",
      summary: `Updated staff group “${body.name ?? before.name}”`,
      changes: body.rules ? { rules: [before.rules.map((r) => r.contains), body.rules] } : undefined,
    });
    res.json({ ok: true });
  })
);

groupsRouter.delete(
  "/:id",
  requirePermission("users.manage"),
  asyncHandler(async (req, res) => {
    const g = await prisma.staffGroup.findUnique({ where: { id: req.params.id } });
    if (!g) throw notFound();
    // Forms limited to it lose it (cascade); a form left with nobody becomes open to everyone, so say so.
    const limited = await prisma.formAudience.count({ where: { groupId: g.id } });
    await prisma.staffGroup.delete({ where: { id: g.id } });
    await reloadAccess();
    await audit({ actor: actorOf(req), action: "groups.deleted", summary: `Deleted staff group “${g.name}”${limited ? ` (it was on ${limited} form${limited === 1 ? "" : "s"})` : ""}` });
    res.json({ ok: true, forms: limited });
  })
);

/** Groups in the order given. */
groupsRouter.post(
  "/reorder",
  requirePermission("users.manage"),
  asyncHandler(async (req, res) => {
    const { ids } = z.object({ ids: z.array(z.string()).min(1) }).parse(req.body);
    await prisma.$transaction(ids.map((id, i) => prisma.staffGroup.update({ where: { id }, data: { sortOrder: i } })));
    await reloadAccess();
    res.json({ ok: true });
  })
);

/**
 * One person's place in one group, by hand: include true adds them, false
 * takes them out even though their job title matches, null goes back to
 * whatever their title says.
 */
groupsRouter.put(
  "/:id/people/:userId",
  requirePermission("users.manage"),
  asyncHandler(async (req, res) => {
    const { include } = z.object({ include: z.boolean().nullable() }).parse(req.body);
    const [g, u] = await Promise.all([
      prisma.staffGroup.findUnique({ where: { id: req.params.id } }),
      prisma.user.findUnique({ where: { id: req.params.userId }, select: { id: true, name: true, title: true } }),
    ]);
    if (!g || !u) throw notFound();
    const key = { userId: u.id, groupId: g.id };
    if (include === null) await prisma.staffGroupMember.deleteMany({ where: key });
    else await prisma.staffGroupMember.upsert({ where: { userId_groupId: key }, create: { ...key, include }, update: { include } });
    await reloadAccess();
    const after = await prisma.staffGroupMember.findMany({ where: { userId: u.id }, select: { groupId: true, include: true } });
    const inIt = effectiveGroups(u.title, after).includes(g.id);
    await audit({
      actor: actorOf(req),
      action: "groups.member_changed",
      summary: `${include === true ? "Added" : include === false ? "Took" : "Reset"} ${u.name} ${include === true ? "to" : include === false ? "out of" : "in"} staff group “${g.name}”`,
    });
    res.json({ inGroup: inIt });
  })
);
