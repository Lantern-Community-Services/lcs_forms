import { z } from "zod";
import { prisma } from "../prisma.js";
import { badRequest } from "../http.js";
import type { CurrentUser } from "../auth/middleware.js";

/**
 * Staff groups and who can see which form.
 *
 * A group is a team (HR, Finance, Case management…), separate from the role:
 * the role says what someone can do, the group which team they're on. Someone
 * is in a group when their job title (from Microsoft, at sign-in) contains
 * one of its rules, or an admin added them by hand; an admin can also take
 * them out (StaffGroupMember.include).
 *
 * A form can be limited to some groups, positions (exact job titles) and/or
 * named people (FormAudience). No rows = everyone. A catalog category can be
 * limited the same way (key category:<id>): then it, and every form on its
 * cards, is only for those people, on top of each form's own limit.
 *
 * A group can also be given forms (GroupForm). Once any of someone's groups
 * has forms, those are the only forms they see: forms open to everyone, or
 * limited some other way, stop showing for them unless the form also names
 * them. One person can then be given more forms, or have some hidden
 * (PersonForm), whatever their groups say. Someone whose groups have no forms
 * sees what each form's own limit allows, as before. Giving a form to a group
 * or a person is deliberate, so it passes the form's and its category's own
 * limits. Admins and Super Admins (forms.manage), and the see-everything
 * groups, ignore all of it and see every form.
 *
 * Who sees a form's entries (entryReach) is kept here too: each form's
 * "Who sees entries" (FormRecord "access"/"entries"), or, for a form saved
 * before that setting existed, its old reader roles (entriesRoles / form.json
 * entries.read) until an admin reviews it. Admins (forms.manage) always see every form. The check is
 * the same everywhere a form shows up or is used: the catalog and search, a
 * builder form's page and its entries, a code form and its server actions.
 *
 * The tables are small (a few dozen groups and rules, a row per limited
 * form), and the API runs as one instance, so all of it is held in memory and
 * reloaded after every change and once a minute. The first signed-in request
 * waits for the first load (accessReady): until it's in, nobody is answered,
 * rather than a limited form being shown to everyone for a moment.
 */

export interface GroupInfo {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  /** "Job title contains …", lower-cased; a leading ^ means "starts with". */
  rules: string[];
}

interface Audience {
  groupIds: Set<string>;
  userIds: Set<string>;
  /** Positions: job titles, trimmed and lower-cased. */
  titles: Set<string>;
}

/** A job title as it's compared: trimmed, any case. */
export const normTitle = (t: string | null | undefined) => (t ?? "").trim().toLowerCase();

let groups: GroupInfo[] = [];
let audiences = new Map<string, Audience>();
/** Built form id → the category of the catalog card that opens it. */
let formCategory = new Map<string, string>();
/** Built form id → its "Who sees entries"; none = the form's old reader roles still apply. */
let entryAccess = new Map<string, EntryAccess>();
/** Groups whose members see every form and every entry (the seeEverythingGroups setting; IT by default). */
let everythingGroups = new Set<string>();
/** Group id → the forms given to it (form keys). */
let groupForms = new Map<string, Set<string>>();
/** User id → form key → given (true) or hidden (false). */
let personForms = new Map<string, Map<string, boolean>>();
let loading: Promise<void> | null = null;
let loaded = false;

async function load() {
  const [rows, aud, linked, cards, access, everything, given, personal] = await Promise.all([
    prisma.staffGroup.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], include: { rules: { select: { contains: true } } } }),
    prisma.formAudience.findMany({ select: { formKey: true, groupId: true, userId: true, title: true } }),
    prisma.builtForm.findMany({ where: { catalogLinkId: { not: null } }, select: { id: true, catalogLinkId: true } }),
    prisma.formLink.findMany({ select: { id: true, categoryId: true } }),
    prisma.formRecord.findMany({ where: { collection: ACCESS_COLLECTION, docId: ACCESS_DOC }, select: { formId: true, data: true } }),
    prisma.setting.findUnique({ where: { key: "seeEverythingGroups" } }),
    prisma.groupForm.findMany({ select: { groupId: true, formKey: true } }),
    prisma.personForm.findMany({ select: { userId: true, formKey: true, include: true } }),
  ]);
  const nextGroupForms = new Map<string, Set<string>>();
  for (const g of given) nextGroupForms.set(g.groupId, (nextGroupForms.get(g.groupId) ?? new Set<string>()).add(g.formKey));
  groupForms = nextGroupForms;
  const nextPersonForms = new Map<string, Map<string, boolean>>();
  for (const p of personal) nextPersonForms.set(p.userId, (nextPersonForms.get(p.userId) ?? new Map<string, boolean>()).set(p.formKey, p.include));
  personForms = nextPersonForms;
  entryAccess = new Map(
    access.flatMap((a) => {
      const p = entryAccessSchema.safeParse(JSON.parse(a.data));
      return p.success ? [[a.formId, p.data] as [string, EntryAccess]] : [];
    })
  );
  const cardCategory = new Map(cards.map((c) => [c.id, c.categoryId]));
  formCategory = new Map(linked.flatMap((f) => (cardCategory.has(f.catalogLinkId!) ? [[f.id, cardCategory.get(f.catalogLinkId!)!] as [string, string]] : [])));
  groups = rows.map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    sortOrder: g.sortOrder,
    rules: g.rules.map((r) => r.contains.trim().toLowerCase()).filter(Boolean),
  }));
  const next = new Map<string, Audience>();
  for (const a of aud) {
    const entry = next.get(a.formKey) ?? { groupIds: new Set<string>(), userIds: new Set<string>(), titles: new Set<string>() };
    if (a.groupId) entry.groupIds.add(a.groupId);
    if (a.userId) entry.userIds.add(a.userId);
    if (a.title) entry.titles.add(normTitle(a.title));
    next.set(a.formKey, entry);
  }
  audiences = next;
  const wanted = (everything?.value ?? "@IT").split(",").map((x) => x.trim()).filter(Boolean);
  everythingGroups = new Set(
    groups.filter((g) => wanted.includes(g.id) || (wanted.includes("@IT") && g.name.trim().toLowerCase() === "it")).map((g) => g.id)
  );
  for (const a of aud) if (a.title) titleCase.set(normTitle(a.title), a.title);
  loaded = true;
}

/** Waits for the first load (or starts it again after a failure). */
export function accessReady(): Promise<void> {
  if (loaded) return Promise.resolve();
  loading ??= load().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

/** After any change to groups, rules, overrides or audiences. */
export async function reloadAccess() {
  await load();
}

/** Keeps the copy fresh if a change ever arrives some other way. */
export function startAccessRefresh() {
  setInterval(() => void load().catch((err) => console.error("[groups] could not reload form access:", err)), 60_000).unref();
}

export const allGroups = () => groups;

/** The groups a job title puts someone in. */
export function groupsForTitle(title: string | null | undefined): string[] {
  const t = (title ?? "").toLowerCase();
  if (!t) return [];
  return groups.filter((g) => g.rules.some((r) => (r.startsWith("^") ? t.startsWith(r.slice(1)) : t.includes(r)))).map((g) => g.id);
}

/**
 * Active people in any of these groups or holding any of these positions
 * (exact job titles, any case): their user ids. Membership is worked out the
 * same way as for form access, overrides included.
 */
export async function peopleInGroupsOrPositions(groupIds: string[], titles: string[]): Promise<Set<string>> {
  const wantGroups = new Set(groupIds);
  const wantTitles = new Set(titles.map(normTitle).filter(Boolean));
  if (!wantGroups.size && !wantTitles.size) return new Set();
  const rows = await prisma.user.findMany({
    where: { status: "active", OR: [{ title: { not: null } }, { groupOverrides: { some: {} } }] },
    select: { id: true, title: true, groupOverrides: { select: { groupId: true, include: true } } },
  });
  const ids = new Set<string>();
  for (const u of rows) {
    if (wantTitles.has(normTitle(u.title)) || effectiveGroups(u.title, u.groupOverrides).some((g) => wantGroups.has(g))) ids.add(u.id);
  }
  return ids;
}

/** Title rules, then an admin's additions and removals. */
export function effectiveGroups(title: string | null | undefined, overrides: { groupId: string; include: boolean }[]): string[] {
  const set = new Set(groupsForTitle(title));
  for (const o of overrides) {
    if (o.include) set.add(o.groupId);
    else set.delete(o.groupId);
  }
  // Only groups that still exist, in their order.
  return groups.filter((g) => set.has(g.id)).map((g) => g.id);
}

// ── Form audiences ───────────────────────────────────────────────────────

export const builtFormKey = (formId: string) => `form:${formId}`;
export const cardKey = (cardId: string) => `card:${cardId}`;
export const categoryKey = (categoryId: string) => `category:${categoryId}`;

/** A catalog card's audience lives on the form it opens when that's built here, else on the card. */
export const keyForCard = (cardId: string, builtFormId: string | null | undefined) => (builtFormId ? builtFormKey(builtFormId) : cardKey(cardId));

/** Positions are given back as stored (their case), for the editor. */
const titleCase = new Map<string, string>();

export function audienceOf(formKey: string): { groupIds: string[]; userIds: string[]; titles: string[] } {
  const a = audiences.get(formKey);
  return { groupIds: a ? [...a.groupIds] : [], userIds: a ? [...a.userIds] : [], titles: a ? [...a.titles].map((t) => titleCase.get(t) ?? t) : [] };
}

const isEmpty = (a: Audience | undefined) => !a || (!a.groupIds.size && !a.userIds.size && !a.titles.size);

export const isLimited = (formKey: string) => !isEmpty(audiences.get(formKey));

/** In a group that sees every form and every entry (IT by default): treated like an Admin for seeing them. */
export function seesEverything(user: Pick<CurrentUser, "groupIds">): boolean {
  return (user.groupIds ?? []).some((g) => everythingGroups.has(g));
}

/** The groups that see every form and every entry, for Admin → Settings. */
export const everythingGroupIds = () => [...everythingGroups];

/** Whether this person may see and use the form. Admins, and the groups that see everything, always may. */
export function inAudience(user: Pick<CurrentUser, "userId" | "permissions" | "groupIds"> & { title?: string | null }, formKey: string): boolean {
  if (user.permissions.includes("forms.manage") || seesEverything(user)) return true;
  const a = audiences.get(formKey);
  if (isEmpty(a)) return true;
  if (a!.userIds.has(user.userId)) return true;
  if (user.title && a!.titles.has(normTitle(user.title))) return true;
  return (user.groupIds ?? []).some((g) => a!.groupIds.has(g));
}

// ── Forms given to groups and people ─────────────────────────────────────

/** The forms given to a group (form keys). */
export const groupFormKeys = (groupId: string) => [...(groupForms.get(groupId) ?? [])];

/** One person's own changes: forms given to them, and forms hidden from them. */
export function personFormKeys(userId: string): { added: string[]; hidden: string[] } {
  const m = [...(personForms.get(userId) ?? new Map<string, boolean>())];
  return { added: m.filter(([, v]) => v).map(([k]) => k), hidden: m.filter(([, v]) => !v).map(([k]) => k) };
}

/** Whether someone in these groups sees only their groups' forms (one of the groups has some). */
export const limitedToGroupForms = (groupIds: string[]) => groupIds.some((g) => (groupForms.get(g)?.size ?? 0) > 0);

/**
 * What giving forms to groups and people says about this form for this
 * person: true (given), false (hidden, or not among their groups' forms), or
 * null when it says nothing and the form's own limits decide.
 */
function givenVerdict(user: Pick<CurrentUser, "userId" | "groupIds">, formKey: string, ignoreOwn = false): boolean | null {
  const own = ignoreOwn ? undefined : personForms.get(user.userId)?.get(formKey);
  if (own !== undefined) return own;
  const mine = user.groupIds ?? [];
  if (!limitedToGroupForms(mine)) return null;
  // A form that names them still shows: someone chose them for it.
  return mine.some((g) => groupForms.get(g)?.has(formKey)) || Boolean(audiences.get(formKey)?.userIds.has(user.userId));
}

type FormViewer = Parameters<typeof inAudience>[0];

/**
 * Whether this person sees a catalog form (key form:… or card:…) in this
 * category: what was given to their groups and to them, else the form's and
 * the category's own limits. Admins and the see-everything groups always do.
 * ignoreOwn leaves out the person's own changes: what their groups alone give them.
 */
export function canSeeFormKey(user: FormViewer, formKey: string, categoryId: string | null | undefined, opts: { ignoreOwn?: boolean } = {}): boolean {
  if (user.permissions.includes("forms.manage") || seesEverything(user)) return true;
  const given = givenVerdict(user, formKey, opts.ignoreOwn);
  if (given !== null) return given;
  return inAudience(user, formKey) && (!categoryId || inAudience(user, categoryKey(categoryId)));
}

/**
 * Whether this person may open and use a form built here: as canSeeFormKey,
 * with the category of the catalog card that opens it.
 */
export function canUseBuiltForm(user: FormViewer, formId: string): boolean {
  return canSeeFormKey(user, builtFormKey(formId), formCategory.get(formId));
}

/** Replaces the forms given to a group. */
export async function setGroupForms(groupId: string, formKeys: string[]) {
  await prisma.$transaction([
    prisma.groupForm.deleteMany({ where: { groupId } }),
    ...[...new Set(formKeys)].map((formKey) => prisma.groupForm.create({ data: { groupId, formKey } })),
  ]);
  await reloadAccess();
}

/** A form gone for good: nobody is given it, or has it hidden, any more. */
export async function forgetGivenForm(formKey: string) {
  const [g, p] = await Promise.all([prisma.groupForm.deleteMany({ where: { formKey } }), prisma.personForm.deleteMany({ where: { formKey } })]);
  if (g.count || p.count) await reloadAccess();
}

/** Replaces one person's own changes: forms given to them, and forms hidden from them (given wins a clash). */
export async function setPersonForms(userId: string, added: string[], hidden: string[]) {
  const give = new Set(added);
  const hide = [...new Set(hidden)].filter((k) => !give.has(k));
  await prisma.$transaction([
    prisma.personForm.deleteMany({ where: { userId } }),
    ...[...give].map((formKey) => prisma.personForm.create({ data: { userId, formKey, include: true } })),
    ...hide.map((formKey) => prisma.personForm.create({ data: { userId, formKey, include: false } })),
  ]);
  await reloadAccess();
}

/** A built form limited by itself or by its category, so never public. */
export function isBuiltFormLimited(formId: string): boolean {
  const category = formCategory.get(formId);
  return isLimited(builtFormKey(formId)) || (category ? isLimited(categoryKey(category)) : false);
}

// ── Who sees a form's entries ────────────────────────────────────────────

const ACCESS_COLLECTION = "access";
const ACCESS_DOC = "entries";

export const entryAccessSchema = z
  .object({
    /** What everyone who can open the form sees: only their own entries, their sites' entries, or every entry. */
    mode: z.enum(["own", "site", "everyone"]).default("own"),
    /** These people see every entry, whatever the mode. */
    seeAll: z
      .object({
        groupIds: z.array(z.string().max(64)).max(50).default([]),
        titles: z.array(z.string().trim().min(1).max(255)).max(100).default([]),
        userIds: z.array(z.string().max(64)).max(500).default([]),
        roles: z.array(z.string().max(64)).max(10).default([]),
      })
      .strict()
      .default({}),
    /** People a route, rule or follow-up tells about an entry can open that entry. */
    notified: z.boolean().default(true),
  })
  .strict();
export type EntryAccess = z.infer<typeof entryAccessSchema>;

/** What a new form starts with: everyone sees only their own; the people it notifies can open those. */
export const NEW_FORM_ENTRY_ACCESS: EntryAccess = { mode: "own", seeAll: { groupIds: [], titles: [], userIds: [], roles: [] }, notified: true };

/** A form's "Who sees entries", or null while its old reader roles still apply. */
export const entryAccessOf = (formId: string): EntryAccess | null => entryAccess.get(formId) ?? null;

type Viewer = Pick<CurrentUser, "userId" | "permissions" | "groupIds" | "roleKey"> & { title?: string | null };

/**
 * How much of a form's entries this person sees: "all" (still only their own
 * sites' if they work at some), "site" (their sites', and their own), or
 * "own" (their own, and any they were told about). Admins see all.
 * `legacyReaders` are the form's old reader roles, used until it's reviewed.
 */
export function entryReach(formId: string, legacyReaders: string[], user: Viewer): "all" | "site" | "own" {
  if (user.permissions.includes("forms.manage") || seesEverything(user)) return "all";
  const s = entryAccess.get(formId);
  if (!s) return legacyReaders.includes(user.roleKey) ? "all" : "own";
  const a = s.seeAll;
  if (
    a.userIds.includes(user.userId) ||
    a.roles.includes(user.roleKey) ||
    (user.title && a.titles.some((t) => normTitle(t) === normTitle(user.title))) ||
    (user.groupIds ?? []).some((g) => a.groupIds.includes(g))
  ) {
    return "all";
  }
  return s.mode === "everyone" ? "all" : s.mode === "site" ? "site" : "own";
}

/** Whether people a form notifies about an entry may open it (the default, and always for an unreviewed form). */
export const notifiedCanOpen = (formId: string) => entryAccess.get(formId)?.notified ?? true;

/** Set a form's "Who sees entries". */
export async function setEntryAccess(formId: string, input: unknown, by: string): Promise<EntryAccess> {
  const p = entryAccessSchema.safeParse(input);
  if (!p.success) throw badRequest(p.error.issues.map((i) => `${i.path.join(".") || "access"}: ${i.message}`).join("; "));
  const bad = p.data.seeAll.groupIds.filter((g) => !groups.some((x) => x.id === g));
  if (bad.length) throw badRequest(`No staff group ${bad.map((b) => `"${b}"`).join(", ")}. Reload and try again.`);
  await prisma.formRecord.upsert({
    where: { formId_collection_docId: { formId, collection: ACCESS_COLLECTION, docId: ACCESS_DOC } },
    create: { formId, collection: ACCESS_COLLECTION, docId: ACCESS_DOC, data: JSON.stringify(p.data), updatedByName: by.slice(0, 255) },
    update: { data: JSON.stringify(p.data), updatedByName: by.slice(0, 255) },
  });
  await reloadAccess();
  return p.data;
}

/** Replaces a form's audience. Empty lists = everyone. */
export async function setAudience(formKey: string, groupIds: string[], userIds: string[], titles: string[] = []) {
  const uniqueTitles = [...new Map(titles.map((t) => t.trim()).filter(Boolean).map((t) => [normTitle(t), t])).values()];
  await prisma.$transaction([
    prisma.formAudience.deleteMany({ where: { formKey } }),
    ...[...new Set(groupIds)].map((groupId) => prisma.formAudience.create({ data: { formKey, groupId } })),
    ...[...new Set(userIds)].map((userId) => prisma.formAudience.create({ data: { formKey, userId } })),
    ...uniqueTitles.map((title) => prisma.formAudience.create({ data: { formKey, title } })),
  ]);
  await reloadAccess();
}

/** Every job title in use, with how many people have it: the positions a form can be limited to. */
export interface KnownTitle {
  title: string;
  /** Active or invited people with this exact title (any case). */
  people: number;
  /** The groups its title rules put it in. */
  groupIds: string[];
  /** One of LANTERN_POSITIONS, so it can be picked before anyone holds it. */
  listed: boolean;
}

/** Every position a form can be limited to: Lantern's list, plus any other title someone has. */
export async function knownTitles(): Promise<KnownTitle[]> {
  const rows = await prisma.user.groupBy({ by: ["title"], where: { status: { in: ["active", "invited"] }, title: { not: null } }, _count: { _all: true } });
  const byKey = new Map<string, KnownTitle>();
  for (const title of LANTERN_POSITIONS) byKey.set(title.toLowerCase(), { title, people: 0, groupIds: groupsForTitle(title), listed: true });
  for (const r of rows) {
    const title = r.title?.trim();
    if (!title) continue;
    const had = byKey.get(title.toLowerCase());
    if (had) had.people += r._count._all;
    else byKey.set(title.toLowerCase(), { title, people: r._count._all, groupIds: groupsForTitle(title), listed: false });
  }
  return [...byKey.values()].sort((x, y) => x.title.localeCompare(y.title));
}

/** Moves a card's audience, and who it's given to, onto the built form it now opens (or back), so a relink keeps them. */
export async function moveAudience(from: string, to: string) {
  if (from === to) return;
  const [n, g, p] = await Promise.all([
    prisma.formAudience.updateMany({ where: { formKey: from }, data: { formKey: to } }),
    prisma.groupForm.updateMany({ where: { formKey: from }, data: { formKey: to } }),
    prisma.personForm.updateMany({ where: { formKey: from }, data: { formKey: to } }),
  ]);
  if (n.count || g.count || p.count) await reloadAccess();
}

// ── Lantern's positions ──────────────────────────────────────────────────

/**
 * The job titles at Lantern, as HR lists them (some are cut short the same
 * way). Offered when limiting a form to positions even before anyone signs in
 * with one; a position matches a person's title exactly, in any case.
 */
export const LANTERN_POSITIONS: string[] = [
  "Accounts Payable Specialist",
  "Administrative Assistant",
  "Adult Development Specialist",
  "Assistant Director of Community Health",
  "Assistant Director of Housing Stability",
  "Assistant Director of Resident Learning & Res",
  "Assistant Program Director",
  "Assistant Vice President of Quality Improveme",
  "Benefits Specialist",
  "Bilingual Case Manager",
  "Case Manager",
  "Case Manager (CSAC) - Prospero Hall",
  "Chief Financial & Administrative Officer",
  "Contract Supervisor",
  "Contracts and Budget Specialist",
  "Controller - Main Office",
  "Deputy Chief Program Officer",
  "Director of Information Technology",
  "Director of Nutrition and Food Programs",
  "Director of Peer Programming",
  "Director of Program O",
  "Director of Social Se",
  "Director of Special Projects",
  "Director of Training & Learning",
  "Employee Relations Manager",
  "Employment and Entitl",
  "Executive Assistant",
  "Executive Director",
  "Family Specialist",
  "Financial Analyst",
  "Grant Analyst",
  "Harm Reduction Specialist",
  "Housing Specialist",
  "Housing Stability Manager",
  "Housing Stability Specialist",
  "Housing Transition Manager",
  "Human Resources Assistant",
  "IT Support Analyst",
  "Nutritionist",
  "Onboarding Specialist",
  "Operations & Logistics Coordinator",
  "Operations and Procur",
  "Operations Manager",
  "Procurement Analyst",
  "Procurement Data Analyst",
  "Procurement Manager",
  "Program Associate",
  "Program Director",
  "Program Manager",
  "Program Manager - Harm Reduction",
  "Program Manager of Community Initiatives",
  "Quality Improvement & Data Systems Manager",
  "Recreation Specialist",
  "Residential Aide",
  "Residential Aide Cleaner and Maintenance",
  "Security Operations Manager",
  "Security Operations S",
  "Senior Case Manager",
  "Senior Program Director",
  "Senior Vice President of Operations",
  "Senior Vice President of Procurement",
  "Senior Vice President of Shelter Operations",
  "Senior Vice President of Shelter Services",
  "Shelter Compliance Manager",
  "Shift Supervisor",
  "Social Worker",
  "Staff Accountant Exempt",
  "Supportive Housing Co",
  "Team Leader",
  "Training & Learning Coordinator",
  "Transportation & Logi",
  "Van Driver",
  "Vice President of Behavioral Health",
  "Vice President of Compliance & Data Strategy",
  "Vice President of Housing Stability",
  "Vice President of Human Resources",
  "Vice President of Supportive Housing",
  "VP of Communications & Fundraising",
];

// ── The starting groups ──────────────────────────────────────────────────

/**
 * The groups a new database starts with, matched to Lantern's job titles
 * (October 2026). Rules are "title contains" (or "starts with", written with a
 * leading ^, where a word turns up in other titles: "^operations manager" isn't
 * the Security Operations Manager), so a title cut short in the directory
 * ("Director of Program O") still matches. Admins change all of it
 * in People & roles → Groups.
 */
export const STARTING_GROUPS: { name: string; description: string; rules: string[] }[] = [
  { name: "HR", description: "Human resources, employee relations and onboarding.", rules: ["human resources", "employee relations", "onboarding"] },
  {
    name: "Finance",
    description: "Accounting, budgets, grants and contracts.",
    rules: ["financial", "accounts payable", "accountant", "controller", "grant analyst", "contracts and budget", "contract supervisor"],
  },
  { name: "Procurement", description: "Purchasing and vendors.", rules: ["procurement", "^operations and procur"] },
  { name: "IT", description: "Information technology and support.", rules: ["information technology", "^it support"] },
  {
    name: "Operations & Transport",
    description: "Operations, logistics and transportation.",
    rules: ["vice president of operations", "^operations manager", "^operations & logistics", "transportation", "van driver"],
  },
  { name: "Security", description: "Security operations.", rules: ["security operations"] },
  {
    name: "Leadership",
    description: "Executive and senior leadership.",
    rules: ["executive director", "executive assistant", "chief", "senior vice president", "vice president", "vp of"],
  },
  { name: "Quality & Compliance", description: "Quality improvement, compliance and data.", rules: ["quality improv", "compliance"] },
  {
    name: "Shelter programs",
    description: "Shelter operations and residential staff.",
    rules: ["shelter operations", "shelter services", "shift supervisor", "team leader", "residential aide"],
  },
  {
    name: "Housing",
    description: "Supportive housing and housing stability.",
    rules: ["supportive housing", "housing specialist", "housing stability", "housing transition"],
  },
  {
    name: "Case management",
    description: "Case managers, social workers and resident services.",
    rules: ["case manager", "social worker", "social se", "family specialist", "employment and entitl", "benefits specialist", "adult development"],
  },
  {
    name: "Program leadership",
    description: "Program directors and managers.",
    rules: ["program director", "program manager", "program associate", "director of program o", "special projects", "deputy chief program officer"],
  },
  {
    name: "Health & wellness",
    description: "Behavioral and community health, harm reduction, peer programs, nutrition and recreation.",
    rules: ["behavioral health", "community health", "harm reduction", "peer programming", "nutrition", "recreation", "resident learning"],
  },
  { name: "Training", description: "Training and learning.", rules: ["training & learning", "training and learning"] },
];

/** Writes the starting groups once, on an empty table. Never touches groups an admin has made. */
export async function ensureStartingGroups(): Promise<number> {
  if ((await prisma.staffGroup.count()) > 0) return 0;
  let i = 0;
  for (const g of STARTING_GROUPS) {
    await prisma.staffGroup.create({
      data: { name: g.name, description: g.description, sortOrder: i++, rules: { create: g.rules.map((contains) => ({ contains })) } },
    });
  }
  await reloadAccess();
  return STARTING_GROUPS.length;
}
