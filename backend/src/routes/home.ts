import { Router, type Request } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../http.js";
import { requireAuth } from "../auth/middleware.js";
import { attentionHours } from "../services/settings.js";
import { cutoff, displayName } from "../services/roster.js";
import { sitesInScope, type ScopedSite } from "../services/siteScope.js";
import { dayKey, startOfDay } from "../services/hotFoods.js";
import { appHomeCards } from "../apps/home.js";

export const homeRouter = Router();
homeRouter.use(requireAuth);

/**
 * The Forms home dashboard: what needs the person's attention, what happened
 * recently, and a few counts. One round trip, and everything in it is limited
 * the same way the screen it links to is, so a card never leads to a 403:
 * roster items need roster.view and stay inside the person's sites, Hot Foods
 * overrides need entries.view, drafts belong to whoever started them.
 */

type Tone = "warn" | "info";

export interface AttentionItem {
  id: string;
  kind: "roster" | "hotfoods" | "draft";
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

async function hotFoodOverrides(sites: ScopedSite[]): Promise<AttentionItem[]> {
  if (!sites.length) return [];
  const where: Prisma.HotFoodEntryWhereInput = {
    siteId: { in: sites.map((s) => s.id) },
    voidedAt: null,
    overrideReason: { not: null },
    occurredAt: { gte: startOfDay(dayKey(new Date())) },
  };
  const [count, latest] = await Promise.all([
    prisma.hotFoodEntry.count({ where }),
    prisma.hotFoodEntry.findFirst({ where, orderBy: { occurredAt: "desc" }, select: { id: true, tenantName: true, overrideReason: true } }),
  ]);
  if (!count || !latest) return [];
  const reason = (latest.overrideReason ?? "").replace(/\s+/g, " ").slice(0, 120);
  return [{
    id: "hotfoods:overrides",
    kind: "hotfoods",
    tone: "warn",
    title: count === 1 ? "Hot Foods limit overridden today" : `${count} Hot Foods limits overridden today`,
    detail: count === 1 ? `${latest.tenantName}. Reason: ${reason}` : `Latest: ${latest.tenantName}. Reason: ${reason}`,
    action: count === 1 ? "View entry" : "View entries",
    href: count === 1 ? `/forms/hot-foods/entries/${latest.id}` : "/forms/hot-foods/entries",
  }];
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

async function recentActivity(req: Request, rosterSites: ScopedSite[] | null, hotFoodSites: ScopedSite[] | null): Promise<ActivityItem[]> {
  const me = req.user!.userId;
  const take = 15;
  const siteName = new Map([...(rosterSites ?? []), ...(hotFoodSites ?? [])].map((s) => [s.id, s.name]));
  const rosterIds = rosterSites?.map((s) => s.id) ?? [];

  const [audits, gfActivity, myEntries, hotFoods] = await Promise.all([
    rosterIds.length
      ? prisma.auditEvent.findMany({
          where: { siteId: { in: rosterIds }, action: { in: Object.keys(VERBS) } },
          orderBy: { createdAt: "desc" },
          take,
          select: { id: true, actorId: true, actorName: true, action: true, summary: true, tenantId: true, siteId: true, createdAt: true, tenant: { select: { firstName: true, lastName: true, preferredName: true } } },
        })
      : Promise.resolve([]),
    // Old-site (Gravity Forms) submissions that named a resident at these sites.
    rosterIds.length
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
      select: { id: true, createdAt: true, siteId: true, form: { select: { title: true, slug: true, kind: true } } },
    }),
    // Everyone's Hot Foods at your sites if you can read entries; otherwise just your own.
    prisma.hotFoodEntry.findMany({
      where: {
        voidedAt: null,
        ...(hotFoodSites ? { siteId: { in: hotFoodSites.map((s) => s.id) } } : { createdById: me }),
      },
      orderBy: { occurredAt: "desc" },
      take,
      select: { id: true, createdById: true, createdByName: true, tenantName: true, mealCount: true, siteId: true, occurredAt: true },
    }),
  ]);

  const site = (id: string | null | undefined) => (id ? siteName.get(id) ?? null : null);
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
      href: e.form.kind === "code" ? `/apps/${e.form.slug}` : `/f/${e.form.slug}`,
    })),
    ...hotFoods.map((h): ActivityItem => {
      const mine = h.createdById === me;
      return {
        id: `hotfood:${h.id}`,
        actorName: h.createdByName,
        mine,
        verb: `${mine ? "You" : h.createdByName.split(" ")[0]} recorded`,
        subject: `Hot Foods for ${h.tenantName}`,
        detail: [site(h.siteId), plural(h.mealCount, "meal")].filter(Boolean).join(" · "),
        at: h.occurredAt,
        href: hotFoodSites ? `/forms/hot-foods/entries/${h.id}` : "/forms/hot-foods",
      };
    }),
  ];
  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 20);
}

homeRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const me = req.user!.userId;
    const weekAgo = new Date(Date.now() - 7 * 86400_000);
    const rosterSites = has(req, "roster.view") ? await sitesInScope(req, undefined) : null;
    const hotFoodSites = has(req, "entries.view") ? rosterSites ?? (await sitesInScope(req, undefined)) : null;

    const [roster, overrides, drafts, activity, entriesWeek, hotFoodsWeek, residents] = await Promise.all([
      rosterSites ? rosterAttention(rosterSites) : Promise.resolve({ items: [], total: 0 }),
      hotFoodSites ? hotFoodOverrides(hotFoodSites) : Promise.resolve([]),
      myDrafts(req),
      recentActivity(req, rosterSites, hotFoodSites),
      prisma.formEntry.count({ where: { createdById: me, status: "active", source: { not: "preview" }, createdAt: { gte: weekAgo } } }),
      prisma.hotFoodEntry.count({ where: { createdById: me, voidedAt: null, createdAt: { gte: weekAgo } } }),
      rosterSites?.length ? prisma.tenant.count({ where: { siteId: { in: rosterSites.map((s) => s.id) }, status: "active" } }) : Promise.resolve(null),
    ]);

    const attention = [...roster.items, ...overrides, ...drafts];
    res.json({
      attention,
      activity,
      stats: {
        attention: attention.length,
        urgent: attention.filter((a) => a.tone === "warn").length,
        submissionsWeek: entriesWeek + hotFoodsWeek,
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
