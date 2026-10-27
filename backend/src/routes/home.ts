import { Router, type Request } from "express";
import { canUseBuiltForm, entryReach, groupFormKeys, personFormKeys } from "../services/staffGroups.js";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../http.js";
import { requireAuth } from "../auth/middleware.js";
import { attentionHours } from "../services/settings.js";
import { cutoff, displayName } from "../services/roster.js";
import { sitesInScope, type ScopedSite } from "../services/siteScope.js";
import { appHomeCards } from "../apps/home.js";

export const homeRouter = Router();
homeRouter.use(requireAuth);

/**
 * The Forms home dashboard: what needs the person's attention, what happened
 * recently, and a few counts. One round trip, and everything in it is limited
 * the same way the screen it links to is, so a card never leads to a 403:
 * roster items need roster.view and stay inside the person's sites, drafts
 * belong to whoever started them. Code forms add their own cards (apps/home.ts).
 * Which of these the screen shows is the person's choice (frontend
 * components/home/dashboard); this sends them all.
 */

type Tone = "warn" | "info";

export interface AttentionItem {
  id: string;
  kind: "roster" | "draft";
  tone: Tone;
  title: string;
  detail: string;
  action: string;
  href: string;
}

export interface ActivityItem {
  id: string;
  /** The person (or integration) who did it. */
  actorName: string;
  mine: boolean;
  /** "You submitted" / "Riley updated" — the verb phrase before `subject`. */
  verb: string;
  subject: string;
  detail: string | null;
  at: Date;
  href: string | null;
}

const has = (req: Request, p: string) => req.user!.permissions.includes(p as never);

function quietFor(hours: number) {
  return hours >= 48 && hours % 24 === 0 ? `${hours / 24} days` : `${hours} hours`;
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

async function rosterAttention(sites: ScopedSite[]): Promise<{ items: AttentionItem[]; total: number }> {
  if (!sites.length) return { items: [], total: 0 };
  const orgHours = await attentionHours();
  const rows = await prisma.$queryRaw<{ siteId: string; cnt: bigint | number }[]>`
    SELECT siteId, COUNT(*) as cnt FROM Tenant
    WHERE status = 'active' AND (${Prisma.join(
      sites.map((s) => Prisma.sql`(siteId = ${s.id} AND attentionClockAt < ${cutoff(s.attentionHours ?? orgHours)})`),
      " OR "
    )})
    GROUP BY siteId`;
  const byId = new Map(rows.map((r) => [r.siteId, Number(r.cnt)]));
  const due = sites
    .map((s) => ({ s, n: byId.get(s.id) ?? 0 }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  // An admin covers every site; past a few, one line for the rest keeps the list readable.
  const SHOWN = 3;
  const rest = due.length > SHOWN + 1 ? due.slice(SHOWN) : [];
  const items = (rest.length ? due.slice(0, SHOWN) : due)
    .map(({ s, n }): AttentionItem => ({
      id: `roster:${s.id}`,
      kind: "roster",
      tone: "warn",
      title: `${plural(n, "resident")} at ${s.name} ${n === 1 ? "needs" : "need"} a check-in`,
      detail: `No form activity in ${quietFor(s.attentionHours ?? orgHours)}. Keep or archive each one.`,
      action: "Review",
      href: `/roster/review?site=${encodeURIComponent(s.code)}`,
    }));
  if (rest.length) {
    const people = rest.reduce((sum, x) => sum + x.n, 0);
    items.push({
      id: "roster:rest",
      kind: "roster",
      tone: "warn",
      title: `${plural(rest.length, "more site")} with residents to check in`,
      detail: `${plural(people, "resident")} across ${rest.slice(0, 2).map((x) => x.s.name).join(", ")}${rest.length > 2 ? " and others" : ""}.`,
      action: "Review all",
      href: "/roster/review",
    });
  }
  return { items, total: items.length };
}

async function myDrafts(req: Request): Promise<AttentionItem[]> {
  if (!has(req, "forms.manage") && !has(req, "apps.develop")) return [];
  const drafts = await prisma.builtForm.findMany({
    where: { status: "draft", createdById: req.user!.userId },
    orderBy: { updatedAt: "desc" },
    take: 3,
    select: { id: true, kind: true, title: true, updatedAt: true },
  });
  return drafts.map((d): AttentionItem => ({
    id: `draft:${d.id}`,
    kind: "draft",
    tone: "info",
    title: `${d.title} is still a draft`,
    detail: `Last edited ${d.updatedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}. Staff can't see it until it's published.`,
    action: "Continue",
    href: d.kind === "code" ? `/admin/apps/${d.id}` : `/admin/builder/${d.id}`,
  }));
}

const VERBS: Record<string, string> = {
  "tenant.created": "added",
  "tenant.updated": "updated",
  "tenant.archived": "archived",
  "tenant.restored": "restored",
  "tenant.kept": "checked in",
};

/**
 * How much of what happened a person's Recent activity shows, by role:
 * - "sites": Site Managers (and Admins, whose sites are all of them) see
 *   everything at their sites: every form entry, roster change and old-site
 *   submission, whoever made it;
 * - "assigned": Main Office Staff see entries at their sites too, but only on
 *   the forms given to their groups or to them (People & roles → Groups);
 * - "own": everyone else (Site Staff, Developers) sees only what they did.
 * Everyone always sees their own.
 */
type ActivityReach = "sites" | "assigned" | "own";

function activityReach(req: Request): ActivityReach {
  const role = req.user!.roleKey;
  if (role === "admin" || role === "site_manager") return "sites";
  if (role === "main_office") return "assigned";
  return "own";
}

/** The built forms given to this person's groups or to them directly (keys form:…; cards that open a built form use that key too). */
function assignedBuiltFormIds(req: Request): string[] {
  const keys = new Set([...req.user!.groupIds.flatMap(groupFormKeys), ...personFormKeys(req.user!.userId).added]);
  return [...keys].filter((k) => k.startsWith("form:")).map((k) => k.slice("form:".length));
}

async function recentActivity(req: Request, rosterSites: ScopedSite[] | null): Promise<ActivityItem[]> {
  const me = req.user!.userId;
  const take = 15;
  const reach = activityReach(req);
  // Null: every site (an Admin).
  const mySites = req.user!.siteIds;
  const siteWhere = mySites ? { siteId: { in: mySites } } : { siteId: { not: null } };
  const rosterIds = rosterSites?.map((s) => s.id) ?? [];
  const assigned = reach === "assigned" ? assignedBuiltFormIds(req) : [];

  const entrySelect = { id: true, createdAt: true, siteId: true, createdById: true, createdByName: true, form: { select: { id: true, title: true, slug: true, kind: true } } } as const;
  const [audits, gfActivity, myEntries, theirEntries] = await Promise.all([
    // Roster changes: all of them at your sites, or only your own.
    rosterIds.length && reach !== "assigned"
      ? prisma.auditEvent.findMany({
          where: { siteId: { in: rosterIds }, action: { in: Object.keys(VERBS) }, ...(reach === "own" ? { actorId: me } : {}) },
          orderBy: { createdAt: "desc" },
          take,
          select: { id: true, actorId: true, actorName: true, action: true, summary: true, tenantId: true, siteId: true, createdAt: true, tenant: { select: { firstName: true, lastName: true, preferredName: true } } },
        })
      : Promise.resolve([]),
    // Old-site (Gravity Forms) submissions that named a resident at these sites. Nobody's "own", so only for "sites".
    rosterIds.length && reach === "sites"
      ? prisma.tenantActivity.findMany({
          where: { source: "gravity_forms", tenant: { siteId: { in: rosterIds } } },
          orderBy: { occurredAt: "desc" },
          take,
          select: { id: true, label: true, recordedBy: true, occurredAt: true, tenantId: true, tenant: { select: { firstName: true, lastName: true, preferredName: true, siteId: true } } },
        })
      : Promise.resolve([]),
    prisma.formEntry.findMany({
      where: { createdById: me, status: "active", source: { not: "preview" } },
      orderBy: { createdAt: "desc" },
      take,
      select: entrySelect,
    }),
    // Other people's entries at your sites: any form, or only the ones given to you.
    reach === "sites" || (reach === "assigned" && assigned.length && mySites?.length)
      ? prisma.formEntry.findMany({
          where: {
            ...siteWhere,
            status: "active",
            source: { not: "preview" },
            OR: [{ createdById: null }, { createdById: { not: me } }],
            ...(reach === "assigned" ? { formId: { in: assigned } } : {}),
          },
          orderBy: { createdAt: "desc" },
          take,
          select: entrySelect,
        })
      : Promise.resolve([]),
  ]);

  // Site names for every row, not only the roster's sites (an entry's site may be any of yours).
  const siteIds = new Set<string>([...rosterIds, ...[...myEntries, ...theirEntries].map((e) => e.siteId).filter((s): s is string => Boolean(s))]);
  const siteRows = siteIds.size ? await prisma.site.findMany({ where: { id: { in: [...siteIds] } }, select: { id: true, name: true } }) : [];
  const siteName = new Map(siteRows.map((s) => [s.id, s.name]));
  const site = (id: string | null | undefined) => (id ? siteName.get(id) ?? null : null);
  const formHref = (f: { slug: string; kind: string }) => (f.kind === "code" ? `/apps/${f.slug}` : `/f/${f.slug}`);

  const items: ActivityItem[] = [
    ...audits.map((a): ActivityItem => {
      const mine = a.actorId === me;
      return {
        id: `audit:${a.id}`,
        actorName: a.actorName,
        mine,
        verb: `${mine ? "You" : a.actorName.split(" ")[0]} ${VERBS[a.action] ?? "changed"}`,
        subject: a.tenant ? displayName(a.tenant) : a.summary,
        detail: [site(a.siteId), "Roster"].filter(Boolean).join(" · "),
        at: a.createdAt,
        href: a.tenantId ? `/tenants/${a.tenantId}` : null,
      };
    }),
    ...gfActivity.map((g): ActivityItem => ({
      id: `gf:${g.id}`,
      actorName: g.recordedBy ?? "Old forms site",
      mine: false,
      verb: `${g.recordedBy?.split(" ")[0] ?? "Someone"} submitted`,
      subject: (g.label ?? "a form").replace(/\s*\(form \d+\)$/, ""),
      detail: [`About ${displayName(g.tenant)}`, site(g.tenant.siteId), "old forms site"].filter(Boolean).join(" · "),
      at: g.occurredAt,
      href: `/tenants/${g.tenantId}`,
    })),
    ...myEntries.map((e): ActivityItem => ({
      id: `entry:${e.id}`,
      actorName: req.user!.name,
      mine: true,
      verb: "You submitted",
      subject: e.form.title,
      detail: site(e.siteId),
      at: e.createdAt,
      href: formHref(e.form),
    })),
    // Someone else's entry: listed only on a form this person can see, and
    // linked only where its entries are open to them, so a row never leads to a 403.
    ...theirEntries
      .filter((e) => canUseBuiltForm(req.user!, e.form.id))
      .map((e): ActivityItem => {
        // A code form opens on its own pages (anyone who can see the form may); a built form's entry needs its entries open to them.
        const opens = e.form.kind === "code" || entryReach(e.form.id, [], req.user!) !== "own";
        return {
          id: `entry:${e.id}`,
          actorName: e.createdByName,
          mine: false,
          verb: `${e.createdByName.split(" ")[0] || "Someone"} submitted`,
          subject: e.form.title,
          detail: site(e.siteId),
          at: e.createdAt,
          href: opens ? (e.form.kind === "code" ? formHref(e.form) : `/f/${e.form.slug}/entries/${e.id}`) : null,
        };
      }),
  ];
  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 20);
}

export interface RecentForm {
  id: string;
  title: string;
  href: string;
  lastAt: Date;
  /** Entries among the person's last 60. */
  uses: number;
}

/** The forms this person submitted most recently, newest first: the "Recently used" widget. */
async function recentForms(req: Request): Promise<RecentForm[]> {
  const entries = await prisma.formEntry.findMany({
    where: { createdById: req.user!.userId, status: "active", source: { not: "preview" } },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: { createdAt: true, form: { select: { id: true, title: true, slug: true, kind: true, status: true } } },
  });
  const byForm = new Map<string, RecentForm>();
  for (const e of entries) {
    // A form since unpublished, or since limited to other people, would only lead to an error page.
    if (e.form.status !== "published" || !canUseBuiltForm(req.user!, e.form.id)) continue;
    const seen = byForm.get(e.form.id);
    if (seen) seen.uses++;
    else byForm.set(e.form.id, { id: e.form.id, title: e.form.title, href: e.form.kind === "code" ? `/apps/${e.form.slug}` : `/f/${e.form.slug}`, lastAt: e.createdAt, uses: 1 });
  }
  return [...byForm.values()].slice(0, 6);
}

/**
 * The forms the Shortcuts widget suggests, as catalog card ids, best first:
 * those given to the person's groups or to them (their group), then the ones
 * people in their role have used most at their sites lately (their role and
 * location), then what anyone uses there, so someone in a role nobody has
 * used yet still gets their sites' forms. The screen keeps only those it lists in the person's catalog, so
 * nothing here can show a form they can't open.
 */
async function shortcutForms(req: Request): Promise<string[]> {
  const SHOWN = 8;
  const user = req.user!;
  const since = new Date(Date.now() - 30 * 86400_000);
  const given = [...new Set([...user.groupIds.flatMap(groupFormKeys), ...personFormKeys(user.userId).added])];
  const siteFilter = user.siteIds === null ? Prisma.empty : user.siteIds.length ? Prisma.sql`AND e.siteId IN (${Prisma.join(user.siteIds)})` : null;
  const [cards, popular] = await Promise.all([
    prisma.builtForm.findMany({ where: { catalogLinkId: { not: null }, status: "published" }, select: { id: true, catalogLinkId: true } }),
    // Someone with no sites yet has no "location" to go on.
    siteFilter
      ? prisma.$queryRaw<{ formId: string }[]>`
          SELECT TOP 20 e.formId FROM FormEntry e
          LEFT JOIN [User] u ON u.id = e.createdById
          WHERE e.status = 'active' AND e.source <> 'preview' AND e.createdAt >= ${since} ${siteFilter}
          GROUP BY e.formId
          ORDER BY SUM(CASE WHEN u.roleKey = ${user.roleKey} THEN 1 ELSE 0 END) DESC, COUNT(*) DESC`
      : Promise.resolve([]),
  ]);
  const cardOf = new Map(cards.map((c) => [c.id, c.catalogLinkId!]));
  const ids = [
    ...given.map((k) => (k.startsWith("form:") ? cardOf.get(k.slice("form:".length)) : k.startsWith("card:") ? k.slice("card:".length) : undefined)),
    ...popular.filter((p) => canUseBuiltForm(user, p.formId)).map((p) => cardOf.get(p.formId)),
  ].filter((id): id is string => Boolean(id));
  return [...new Set(ids)].slice(0, SHOWN);
}

homeRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const me = req.user!.userId;
    const weekAgo = new Date(Date.now() - 7 * 86400_000);
    const rosterSites = has(req, "roster.view") ? await sitesInScope(req, undefined) : null;

    const [roster, drafts, activity, recent, shortcuts, entriesWeek, residents] = await Promise.all([
      rosterSites ? rosterAttention(rosterSites) : Promise.resolve({ items: [], total: 0 }),
      myDrafts(req),
      recentActivity(req, rosterSites),
      recentForms(req),
      shortcutForms(req),
      prisma.formEntry.count({ where: { createdById: me, status: "active", source: { not: "preview" }, createdAt: { gte: weekAgo } } }),
      rosterSites?.length ? prisma.tenant.count({ where: { siteId: { in: rosterSites.map((s) => s.id) }, status: "active" } }) : Promise.resolve(null),
    ]);

    const attention = [...roster.items, ...drafts];
    res.json({
      attention,
      activity,
      recentForms: recent,
      shortcutForms: shortcuts,
      // For the Shortcuts widget's per-site roster links.
      rosterSites: rosterSites ? rosterSites.map((s) => ({ code: s.code, name: s.name })) : null,
      stats: {
        attention: attention.length,
        urgent: attention.filter((a) => a.tone === "warn").length,
        submissionsWeek: entriesWeek,
        residents,
        sites: rosterSites ? rosterSites.map((s) => s.name) : null,
      },
    });
  })
);

/**
 * Cards from code forms (form.json "home"): their own attention items and stat
 * tiles. A separate request, so a slow form never holds up the rest of the home screen.
 */
homeRouter.get(
  "/apps",
  asyncHandler(async (req, res) => {
    res.json(await appHomeCards(req.user!));
  })
);
