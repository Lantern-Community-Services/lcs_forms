import { prisma } from "../prisma.js";
import { addDays, day, listTasks, todayNY, ymd } from "./checklist.js";
import { caseLeadChoices } from "./clientProfile.js";
import { displayName } from "./roster.js";

/**
 * A case lead's caseload — PlanStreet's "My Activities": the residents whose
 * client information names them case lead (TenantProfile.caseLeadId), each with
 * where they live, whether they're away, their open checklist and when someone
 * last filed a Contact Form about them; their open checklist as one to-do list;
 * and, for a site's managers, the residents nobody leads yet. Case management
 * only: the routes (routes/caseload.ts) check the switch, the permission and the
 * sites. `siteIds` is always the viewer's: null for every site (an Admin).
 */

/** The basic form whose newest entry about a resident is their last contact. */
export const CONTACT_FORM = "contact-form";

/** Due in the next week counts as "this week", as in the daily checklist reminder. */
const WEEK_DAYS = 7;

const siteWhere = (siteIds: string[] | null) => (siteIds ? { siteId: { in: siteIds } } : {});

/** Which group a task is in on the to-do list. */
export type TaskWhen = "overdue" | "week" | "later";
export function taskWhen(dueOn: string, today = todayNY()): TaskWhen {
  if (dueOn < today) return "overdue";
  return dueOn <= addDays(today, WEEK_DAYS) ? "week" : "later";
}

export interface LastContact {
  at: string;
  entryId: string;
  formSlug: string;
  byName: string;
}

/**
 * The newest Contact Form entry about each resident. Entries that record their
 * resident (FormEntry.tenantId: code forms, and basic forms once they record it)
 * are matched on it; older basic-form entries keep the resident only in their
 * answers ({ "id": "<tenant id>", … }), so those are matched in the JSON.
 */
export async function lastContacts(tenantIds: string[]): Promise<Map<string, LastContact>> {
  const out = new Map<string, LastContact>();
  if (!tenantIds.length) return out;
  const form = await prisma.builtForm.findUnique({ where: { slug: CONTACT_FORM }, select: { id: true } });
  if (!form) return out;
  const keep = (tenantId: string, e: { id: string; occurredAt: Date; createdByName: string }) => {
    const had = out.get(tenantId);
    const at = e.occurredAt.toISOString();
    if (!had || had.at < at) out.set(tenantId, { at, entryId: e.id, formSlug: CONTACT_FORM, byName: e.createdByName });
  };
  // A caseload is tens of people; chunks keep the query's parameters well under SQL Server's limit.
  for (let i = 0; i < tenantIds.length; i += 200) {
    const ids = tenantIds.slice(i, i + 200);
    const [named, unnamed] = await Promise.all([
      prisma.formEntry.findMany({
        where: { formId: form.id, status: "active", tenantId: { in: ids } },
        select: { id: true, tenantId: true, occurredAt: true, createdByName: true },
      }),
      prisma.formEntry.findMany({
        where: { formId: form.id, status: "active", tenantId: null, OR: ids.map((id) => ({ data: { contains: `"id":"${id}"` } })) },
        select: { id: true, data: true, occurredAt: true, createdByName: true },
      }),
    ]);
    for (const e of named) keep(e.tenantId!, e);
    for (const e of unnamed) for (const id of ids) if (e.data.includes(`"id":"${id}"`)) keep(id, e);
  }
  return out;
}

/** Everyone a case lead leads, at the viewer's sites, with what's open for each. */
export async function caseloadResidents(leadId: string, siteIds: string[] | null) {
  const today = todayNY();
  const tenants = await prisma.tenant.findMany({
    where: { status: "active", profile: { is: { caseLeadId: leadId } }, ...siteWhere(siteIds) },
    select: {
      id: true, firstName: true, lastName: true, preferredName: true, unit: true, siteId: true, movedIn: true, moveInDate: true,
      awaySince: true, awayReason: true, highAcuity: true,
      site: { select: { id: true, code: true, name: true, siteType: true } },
      // Their stay now: the day they moved into the unit they live in.
      stays: { where: { endKind: null }, orderBy: { moveInDate: "desc" }, take: 1, select: { moveInDate: true } },
    },
  });
  const ids = tenants.map((t) => t.id);
  const [tasks, contacts] = await Promise.all([
    ids.length
      ? prisma.tenantTask.findMany({ where: { tenantId: { in: ids }, status: "open" }, select: { tenantId: true, label: true, dueOn: true }, orderBy: { dueOn: "asc" } })
      : [],
    lastContacts(ids),
  ]);
  const tasksBy = new Map<string, { label: string; dueOn: string }[]>();
  for (const t of tasks) tasksBy.set(t.tenantId, [...(tasksBy.get(t.tenantId) ?? []), { label: t.label, dueOn: ymd(t.dueOn) }]);

  return tenants
    .map((t) => {
      const open = tasksBy.get(t.id) ?? [];
      const overdue = open.filter((x) => x.dueOn < today);
      const next = open.find((x) => x.dueOn >= today) ?? null;
      const movedInOn = t.stays[0]?.moveInDate ?? (t.movedIn ? t.moveInDate : null);
      return {
        id: t.id,
        displayName: displayName(t),
        site: { id: t.site.id, code: t.site.code, name: t.site.name },
        unit: t.unit,
        movedIn: t.movedIn,
        movedInOn: movedInOn ? ymd(movedInOn) : null,
        away: t.awaySince ? { since: ymd(t.awaySince), reason: t.awayReason } : null,
        highAcuity: t.highAcuity,
        tasks: {
          open: open.length,
          overdue: overdue.length,
          /** The most overdue one, to say what's late. */
          oldestOverdue: overdue[0] ?? null,
          next,
        },
        lastContact: contacts.get(t.id) ?? null,
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export type CaseloadResident = Awaited<ReturnType<typeof caseloadResidents>>[number];

/** The sites a viewer sees (every roster site for an Admin), for lists that name them. */
export async function viewerSites(siteIds: string[] | null) {
  return prisma.site.findMany({
    where: { active: true, siteType: { not: "office" }, ...(siteIds ? { id: { in: siteIds } } : {}) },
    select: { id: true, code: true, name: true, siteType: true },
    orderBy: { name: "asc" },
  });
}

/**
 * The case lead's open checklist at the viewer's sites, each task marked
 * overdue, this week or later. Same reading as the Checklist tab's "Only mine":
 * people living here now, and the exit assessment of people who just left.
 */
export async function caseloadTasks(leadId: string, siteIds: string[] | null) {
  const today = todayNY();
  const sites = await viewerSites(siteIds);
  const items = sites.length ? await listTasks(sites.map((s) => s.id), { view: "open", caseLeadId: leadId }) : [];
  const names = new Map(sites.map((s) => [s.id, s.name]));
  return {
    today,
    // Every task here shares the case lead (the response's `lead`), so it isn't repeated on each.
    items: items.map((t) => ({ ...t, caseLead: null, siteName: names.get(t.siteId) ?? "", when: taskWhen(t.dueOn, today) })),
  };
}

/**
 * Who can be picked as a case lead at the viewer's sites (clientProfile's
 * caseLeadChoices for each), with how many residents each leads there now.
 */
export async function leadChoices(siteIds: string[] | null) {
  const sites = await viewerSites(siteIds);
  const lists = await Promise.all(sites.map((s) => caseLeadChoices(s.id)));
  const people = new Map<string, { id: string; name: string; title: string | null }>();
  for (const list of lists) for (const u of list) people.set(u.id, u);
  const counts = await prisma.tenantProfile.groupBy({
    by: ["caseLeadId"],
    where: { caseLeadId: { not: null }, tenant: { status: "active", ...siteWhere(siteIds) } },
    _count: { _all: true },
  });
  const countOf = new Map(counts.map((c) => [c.caseLeadId!, c._count._all]));
  return [...people.values()].map((u) => ({ ...u, residents: countOf.get(u.id) ?? 0 })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Residents at these supportive sites nobody is case lead for yet, and who can be
 * picked for each site. Supportive only: that's where caseloads and the checklist are.
 */
export async function unassigned(sites: { id: string; code: string; name: string; siteType: string }[]) {
  const supportive = sites.filter((s) => s.siteType === "supportive");
  if (!supportive.length) return [];
  const [tenants, leads] = await Promise.all([
    prisma.tenant.findMany({
      where: { status: "active", siteId: { in: supportive.map((s) => s.id) }, OR: [{ profile: { is: null } }, { profile: { is: { caseLeadId: null } } }] },
      select: { id: true, firstName: true, lastName: true, preferredName: true, unit: true, siteId: true, movedIn: true, moveInDate: true, awaySince: true },
    }),
    Promise.all(supportive.map((s) => caseLeadChoices(s.id))),
  ]);
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  return supportive.map((s, i) => ({
    id: s.id,
    code: s.code,
    name: s.name,
    leads: leads[i],
    residents: tenants
      .filter((t) => t.siteId === s.id)
      .map((t) => ({ id: t.id, displayName: displayName(t), unit: t.unit, movedIn: t.movedIn, movedInOn: t.movedIn && t.moveInDate ? ymd(t.moveInDate) : null, away: Boolean(t.awaySince) }))
      .sort((a, b) => collator.compare(a.unit ?? "~", b.unit ?? "~") || a.displayName.localeCompare(b.displayName)),
  }));
}

/** Totals for the screen's header: residents, overdue tasks, away, and no contact in 30 days. */
export function caseloadTotals(residents: CaseloadResident[], today = todayNY()) {
  const monthAgo = day(addDays(today, -30)).toISOString();
  return {
    residents: residents.length,
    overdue: residents.reduce((n, r) => n + r.tasks.overdue, 0),
    away: residents.filter((r) => r.away).length,
    noRecentContact: residents.filter((r) => !r.lastContact || r.lastContact.at < monthAgo).length,
  };
}
