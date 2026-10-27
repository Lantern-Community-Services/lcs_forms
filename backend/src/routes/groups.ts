import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler, notFound } from "../http.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { actorOf, audit } from "../services/audit.js";
import { permissionsFor, roleFor } from "../services/permissions.js";
import {
  allGroups,
  canSeeFormKey,
  effectiveGroups,
  groupFormKeys,
  groupsForTitle,
  keyForCard,
  knownTitles,
  limitedToGroupForms,
  personFormKeys,
  reloadAccess,
  seesEverything,
  setGroupForms,
  setPersonForms,
} from "../services/staffGroups.js";

/**
 * Staff groups (People & roles → Groups): the teams forms can be limited to.
 * Admins only (users.manage). Someone is in a group when their job title
 * matches one of its rules, or an admin added them; an admin can also take
 * them out. A group can be given forms: then its members see only their
 * groups' forms, and one person can be given more or have some hidden. See
 * services/staffGroups.ts.
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
        return { ...g, members, removed, forms: groupFormKeys(g.id) };
      })
    );
  })
);

/** Every job title in use (the positions a form can be limited to), with how many people hold it. */
groupsRouter.get(
  "/titles",
  requirePermission("users.manage", "forms.manage"),
  asyncHandler(async (_req, res) => res.json(await knownTitles()))
);

/** Every form on the catalog, by the key a group or person is given it with (keyForCard). */
async function catalogForms() {
  const [cards, built] = await Promise.all([
    prisma.formLink.findMany({
      select: { id: true, title: true, active: true, roles: true, categoryId: true, category: { select: { name: true } } },
      orderBy: [{ category: { sortOrder: "asc" } }, { sortOrder: "asc" }],
    }),
    prisma.builtForm.findMany({ where: { catalogLinkId: { not: null } }, select: { id: true, catalogLinkId: true } }),
  ]);
  const byCard = new Map(built.map((b) => [b.catalogLinkId!, b.id]));
  return cards.map((c) => ({
    key: keyForCard(c.id, byCard.get(c.id)),
    title: c.title,
    category: c.category.name,
    categoryId: c.categoryId,
    roles: c.roles ? c.roles.split(",").filter(Boolean) : [],
    active: c.active,
  }));
}

/** Every form on the catalog, for the pickers. */
groupsRouter.get(
  "/forms",
  requirePermission("users.manage"),
  asyncHandler(async (_req, res) => {
    res.json((await catalogForms()).map(({ key, title, category, active }) => ({ key, title, category, active })));
  })
);

const formKeys = z.array(z.string().trim().min(1).max(100)).max(500);

/** Replaces the forms given to a group. Any forms at all: its members then see only their groups' forms. */
groupsRouter.put(
  "/:id/forms",
  requirePermission("users.manage"),
  asyncHandler(async (req, res) => {
    const { keys } = z.object({ keys: formKeys }).parse(req.body);
    const g = await prisma.staffGroup.findUnique({ where: { id: req.params.id } });
    if (!g) throw notFound();
    const before = groupFormKeys(g.id);
    await setGroupForms(g.id, keys);
    await audit({
      actor: actorOf(req),
      action: "groups.forms_changed",
      summary: `Gave staff group “${g.name}” ${keys.length} form${keys.length === 1 ? "" : "s"}`,
      changes: { forms: [before, keys] },
    });
    res.json({ forms: groupFormKeys(g.id) });
  })
);

/** One person's forms: what their groups give them, and their own additions and hidden forms. */
groupsRouter.get(
  "/person/:userId/forms",
  requirePermission("users.manage"),
  asyncHandler(async (req, res) => {
    const u = await prisma.user.findUnique({
      where: { id: req.params.userId },
      select: { id: true, title: true, roleKey: true, calendarEditor: true, rosterEditor: true, globalAdmin: true, groupOverrides: { select: { groupId: true, include: true } } },
    });
    if (!u) throw notFound();
    const groupIds = effectiveGroups(u.title, u.groupOverrides);
    const role = roleFor(u.roleKey);
    const viewer = { userId: u.id, permissions: permissionsFor(role, u), groupIds, title: u.title };
    const own = personFormKeys(u.id);
    const added = new Set(own.added);
    const hidden = new Set(own.hidden);
    res.json({
      /** Admins and the see-everything groups see every form, whatever is given or hidden. */
      seesAll: viewer.permissions.includes("forms.manage") || seesEverything(viewer),
      /** Their groups have forms, so those are all they see (plus their own changes). */
      limited: limitedToGroupForms(groupIds),
      groupIds,
      forms: (await catalogForms()).map((f) => {
        const roleOk = !f.roles.length || f.roles.includes(role.key) || viewer.permissions.includes("forms.manage");
        return {
          key: f.key,
          title: f.title,
          category: f.category,
          active: f.active,
          /** A form for other roles: giving it doesn't show it. */
          roleOk,
          /** Seen through their groups and the form's own limits, before their own changes. */
          fromGroups: canSeeFormKey(viewer, f.key, f.categoryId, { ignoreOwn: true }),
          /** Their own change: given (true), hidden (false), or none. */
          own: added.has(f.key) ? true : hidden.has(f.key) ? false : null,
          groups: groupIds.filter((g) => groupFormKeys(g).includes(f.key)),
        };
      }),
    });
  })
);

/** Replaces one person's own changes: forms given to them, and forms hidden from them. */
groupsRouter.put(
  "/person/:userId/forms",
  requirePermission("users.manage"),
  asyncHandler(async (req, res) => {
    const body = z.object({ added: formKeys, hidden: formKeys }).parse(req.body);
    const u = await prisma.user.findUnique({ where: { id: req.params.userId }, select: { id: true, name: true } });
    if (!u) throw notFound();
    const before = personFormKeys(u.id);
    await setPersonForms(u.id, body.added, body.hidden);
    const after = personFormKeys(u.id);
    await audit({
      actor: actorOf(req),
      action: "groups.person_forms_changed",
      summary: `Changed ${u.name}'s own forms: ${after.added.length} given, ${after.hidden.length} hidden`,
      changes: { added: [before.added, after.added], hidden: [before.hidden, after.hidden] },
    });
    res.json(after);
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
