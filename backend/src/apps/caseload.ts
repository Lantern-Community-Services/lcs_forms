import type { BuiltForm, FormEntry, Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import type { CurrentUser } from "../auth/middleware.js";
import { caseManagementEnabled } from "../services/settings.js";
import { displayName } from "../services/roster.js";
import { SCHEDULE, todayNY, ymd } from "../services/checklist.js";
import { lastContacts } from "../services/caseload.js";
import { listApplicants } from "../services/applicants.js";
import { isSignerOn, parseSigned, signableSignOffs, type SignerCache } from "../services/signOff.js";
import { readDoc } from "../forms/service.js";
import type { FormDoc, Values } from "../forms/engine.js";

/**
 * Case management for code forms (ctx.caseload.*): what the Caseload screen,
 * the Checklist tab and Applicants show, read only, so a form can be a case
 * manager's dashboard (the dev site's Case Management board). Each call is what
 * its screen allows: on only while case management is on (Admin → Settings), as
 * a signed-in person (never a share-link guest), at their own supportive sites.
 *
 * - residents: everyone living at the sites (and people who just left, while
 *   their exit assessment is open), with case lead, move-in, away, open
 *   checklist and last Contact Form. Like Caseload: client information
 *   (clients.view) or roster management (roster.archive).
 * - leads: who leads someone there, for a "Case lead" filter. Same people.
 * - applicants: the open pipeline. Like Applicants: roster.edit or clients.view.
 * - signOffs: entries waiting for this person's signature (they're asked, or
 *   are its backup now). Anyone signed in; only what they'd be asked to sign.
 */

/** Most residents one call returns: about twice every supportive site Lantern has (tested to fit a code form at this size). */
const RESIDENT_CAP = 2500;
/** Most waiting entries looked at for one person's sign-offs (oldest first). */
const SIGN_OFF_SCAN = 400;

const has = (u: CurrentUser, p: string) => u.permissions.includes(p as never);

class CaseloadError extends Error {
  userError = true;
}

async function requireCaseManagement(user: CurrentUser | null, what: string): Promise<CurrentUser> {
  if (!user) throw new CaseloadError(`${what} needs a signed-in person.`);
  if (!(await caseManagementEnabled())) throw new CaseloadError(`${what} is part of case management, which is turned off (Admin → Settings).`);
  return user;
}

function requireCaseload(user: CurrentUser) {
  if (!has(user, "roster.view") || (!has(user, "clients.view") && !has(user, "roster.archive"))) {
    throw new CaseloadError("The caseload is for people with client information or who manage a site's roster.");
  }
}

/**
 * The supportive sites asked for (codes or ids; all of the person's when none),
 * limited to their own. Supportive only: that's where caseloads, the checklist
 * and applicants are.
 */
async function sitesFor(user: CurrentUser, wanted: unknown) {
  const list = Array.isArray(wanted) ? wanted.map(String).filter(Boolean).slice(0, 200) : typeof wanted === "string" && wanted ? [wanted] : [];
  const rows = await prisma.site.findMany({
    where: {
      active: true,
      siteType: "supportive",
      ...(user.siteIds ? { id: { in: user.siteIds } } : {}),
      ...(list.length ? { OR: [{ id: { in: list } }, { code: { in: list } }] } : {}),
    },
    select: { id: true, code: true, name: true },
    orderBy: { name: "asc" },
  });
  return rows;
}

/** "me", a staff id, or anything else (everyone). */
function leadFilter(user: CurrentUser, lead: unknown): string | null {
  if (lead === "me") return user.userId;
  if (typeof lead === "string" && lead && lead !== "all" && lead !== "everyone") return lead;
  return null;
}

const FORMS_BY_KEY = new Map(SCHEDULE.map((s) => [s.key, s.forms]));

export async function caseloadResidents(user0: CurrentUser | null, args: { sites?: unknown; lead?: unknown }) {
  const user = await requireCaseManagement(user0, "The caseload");
  requireCaseload(user);
  const today = todayNY();
  const sites = await sitesFor(user, args?.sites);
  if (!sites.length) return { today, sites: [], residents: [], taskForms: {}, truncated: false };
  const siteIds = sites.map((s) => s.id);
  const leadId = leadFilter(user, args?.lead);
  const byLead: Prisma.TenantWhereInput = leadId ? { profile: { is: { caseLeadId: leadId } } } : {};

  const tenantSelect = {
    id: true, firstName: true, lastName: true, preferredName: true, unit: true, siteId: true, status: true, movedIn: true,
    moveInDate: true, moveOutDate: true, awaySince: true, awayReason: true, highAcuity: true,
    profile: { select: { caseLeadId: true } },
    // Their stay now: the day they moved into the unit they live in.
    stays: { where: { endKind: null }, orderBy: { moveInDate: "desc" }, take: 1, select: { moveInDate: true } },
  } satisfies Prisma.TenantSelect;

  const [living, tasks] = await Promise.all([
    prisma.tenant.findMany({ where: { siteId: { in: siteIds }, status: "active", movedIn: true, ...byLead }, select: tenantSelect, take: RESIDENT_CAP + 1 }),
    // Open checklist, the Checklist tab's way: people living here now, and the exit paperwork of people who just left.
    prisma.tenantTask.findMany({
      where: {
        siteId: { in: siteIds },
        status: "open",
        OR: [{ tenant: { status: "active", movedIn: true } }, { key: "hmis_project_exit" }],
        ...(leadId ? { tenant: { profile: { is: { caseLeadId: leadId } } } } : {}),
      },
      select: { id: true, tenantId: true, key: true, label: true, dueOn: true },
      orderBy: { dueOn: "asc" },
      take: 20_000,
    }),
  ]);
  const truncated = living.length > RESIDENT_CAP;
  const people = living.slice(0, RESIDENT_CAP);
  const seen = new Set(people.map((t) => t.id));
  // People who've left but still owe their exit assessment.
  const leftIds = [...new Set(tasks.map((t) => t.tenantId).filter((id) => !seen.has(id)))];
  const left = leftIds.length ? await prisma.tenant.findMany({ where: { id: { in: leftIds } }, select: tenantSelect }) : [];
  const everyone = [...people, ...left];

  const ids = everyone.map((t) => t.id);
  const leadIds = [...new Set(everyone.map((t) => t.profile?.caseLeadId).filter((x): x is string => Boolean(x)))];
  const [contacts, leads] = await Promise.all([
    lastContacts(ids),
    leadIds.length ? prisma.user.findMany({ where: { id: { in: leadIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ]);
  const leadName = new Map(leads.map((l) => [l.id, l.name]));
  // Lean, since an Admin's is every supportive site (thousands of tasks): which forms do each kind of task is
  // said once (taskForms), and each resident's site is its code (sites has the names).
  const tasksBy = new Map<string, { key: string; label: string; dueOn: string }[]>();
  const taskForms: Record<string, string[]> = {};
  for (const t of tasks) {
    const list = tasksBy.get(t.tenantId) ?? [];
    list.push({ key: t.key, label: t.label, dueOn: ymd(t.dueOn) });
    tasksBy.set(t.tenantId, list);
    taskForms[t.key] ??= FORMS_BY_KEY.get(t.key) ?? [];
  }
  const codeOf = new Map(sites.map((s) => [s.id, s.code]));

  const residents = everyone.map((t) => {
    const living = t.status === "active" && t.movedIn;
    const movedInOn = t.stays[0]?.moveInDate ?? (t.movedIn ? t.moveInDate : null);
    const lead = t.profile?.caseLeadId ?? null;
    const c = contacts.get(t.id);
    return {
      id: t.id,
      name: displayName(t),
      unit: t.unit,
      site: codeOf.get(t.siteId) ?? "",
      caseLead: lead ? { id: lead, name: leadName.get(lead) ?? "" } : null,
      movedInOn: movedInOn ? ymd(movedInOn) : null,
      /** They've left; only their exit assessment keeps them here. */
      movedOutOn: living ? null : t.moveOutDate ? ymd(t.moveOutDate) : null,
      living,
      away: t.awaySince ? { since: ymd(t.awaySince), reason: t.awayReason } : null,
      highAcuity: t.highAcuity,
      tasks: tasksBy.get(t.id) ?? [],
      lastContact: c ? { at: c.at, byName: c.byName, entryId: c.entryId } : null,
    };
  });
  residents.sort((a, b) => a.name.localeCompare(b.name));
  return { today, sites, residents, taskForms, truncated };
}

/** Who leads someone at these sites now, with how many: the choices for a "Case lead" filter. */
export async function caseloadLeads(user0: CurrentUser | null, args: { sites?: unknown }) {
  const user = await requireCaseManagement(user0, "The caseload");
  requireCaseload(user);
  const sites = await sitesFor(user, args?.sites);
  if (!sites.length) return [];
  const counts = await prisma.tenantProfile.groupBy({
    by: ["caseLeadId"],
    where: { caseLeadId: { not: null }, tenant: { status: "active", movedIn: true, siteId: { in: sites.map((s) => s.id) } } },
    _count: { _all: true },
  });
  const ids = counts.map((c) => c.caseLeadId!);
  const people = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, title: true, status: true } }) : [];
  const countOf = new Map(counts.map((c) => [c.caseLeadId!, c._count._all]));
  return people
    .map((u) => ({ id: u.id, name: u.name, title: u.title, active: u.status === "active", residents: countOf.get(u.id) ?? 0, me: u.id === user.userId }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The open applicant pipeline at these sites, as the Applicants page lists it (no history). */
export async function caseloadApplicants(user0: CurrentUser | null, args: { sites?: unknown }) {
  const user = await requireCaseManagement(user0, "The applicant list");
  if (!has(user, "roster.edit") && !has(user, "clients.view")) throw new CaseloadError("Applicants are for people with client information or who edit the roster.");
  const sites = await sitesFor(user, args?.sites);
  const { items, truncated } = await listApplicants(sites, { status: "open" });
  const codeOf = new Map(sites.map((s) => [s.id, s.code]));
  return {
    truncated,
    items: items.map((a) => ({
      id: a.id,
      name: a.displayName,
      site: { id: a.siteId, code: codeOf.get(a.siteId) ?? "", name: a.siteName ?? "" },
      program: a.program,
      stage: a.stage,
      stageLabel: a.stageLabel,
      stageDate: a.stageDate,
      daysInStage: a.daysInStage,
      viewingDate: a.viewingDate,
      referralDate: a.referralDate,
      /** Accepted and waiting to move in: the resident they became. */
      residentId: a.resident?.id ?? null,
    })),
  };
}

/**
 * Entries waiting for this person's signature: sign-offs they're asked to sign
 * now (or, once it has waited long enough, are the backup for). Not every one an
 * Admin could sign: only what they'd be asked to. Oldest first.
 */
export async function caseloadSignOffs(user0: CurrentUser | null) {
  const user = await requireCaseManagement(user0, "The sign-off list");
  const rows = await prisma.formEntry.findMany({
    where: {
      signOff: "waiting",
      status: "active",
      source: { not: "preview" },
      NOT: { createdById: user.userId },
      ...(user.siteIds ? { OR: [{ siteId: null }, { siteId: { in: user.siteIds } }] } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: SIGN_OFF_SCAN,
  });
  if (!rows.length) return [];
  const forms = await prisma.builtForm.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.formId))] } } });
  const formOf = new Map<string, { form: BuiltForm; doc: FormDoc }>(forms.map((f) => [f.id, { form: f, doc: readDoc(f.liveSchema ?? f.draftSchema) }]));
  const now = new Date();
  // Who each sign-off names is worked out once per form and site, not once per entry.
  const cache: SignerCache = new Map();
  const mine: FormEntry[] = [];
  for (const e of rows) {
    const f = formOf.get(e.formId);
    if (f && (await isSignerOn(f.form, f.doc, e, user.userId, now, cache))) mine.push(e);
  }
  const tenantIds = [...new Set(mine.map((e) => e.tenantId).filter((x): x is string => Boolean(x)))];
  const siteIds = [...new Set(mine.map((e) => e.siteId).filter((x): x is string => Boolean(x)))];
  const [tenants, sites] = await Promise.all([
    tenantIds.length ? prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, firstName: true, lastName: true, preferredName: true, unit: true } }) : Promise.resolve([]),
    siteIds.length ? prisma.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, code: true, name: true } }) : Promise.resolve([]),
  ]);
  const tenantOf = new Map(tenants.map((t) => [t.id, t]));
  const siteOf = new Map(sites.map((s) => [s.id, s]));
  return mine.map((e) => {
    const { form, doc } = formOf.get(e.formId)!;
    const t = e.tenantId ? tenantOf.get(e.tenantId) : undefined;
    const waiting = signableSignOffs(doc, JSON.parse(e.data) as Values, parseSigned(e.signOffs));
    return {
      entryId: e.id,
      form: { slug: form.slug, title: form.title },
      /** What to sign: the sign-off questions open now. */
      signOffs: waiting.map((f) => f.label || f.id),
      filedAt: e.createdAt.toISOString(),
      filedByName: e.createdByName,
      resident: t ? { id: t.id, name: displayName(t), unit: t.unit } : null,
      site: e.siteId ? siteOf.get(e.siteId) ?? null : null,
      /** The entry page, where the Sign-off panel is. */
      link: `/f/${form.slug}/entries/${e.id}`,
    };
  });
}
