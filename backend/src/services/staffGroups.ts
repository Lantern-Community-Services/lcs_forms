import { prisma } from "../prisma.js";
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
 * named people (FormAudience). No rows = everyone. Admins (forms.manage) always see every form. The check is
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
let loading: Promise<void> | null = null;
let loaded = false;

async function load() {
  const [rows, aud] = await Promise.all([
    prisma.staffGroup.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], include: { rules: { select: { contains: true } } } }),
    prisma.formAudience.findMany({ select: { formKey: true, groupId: true, userId: true, title: true } }),
  ]);
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

/** Whether this person may see and use the form. Admins always may. */
export function inAudience(user: Pick<CurrentUser, "userId" | "permissions" | "groupIds"> & { title?: string | null }, formKey: string): boolean {
  if (user.permissions.includes("forms.manage")) return true;
  const a = audiences.get(formKey);
  if (isEmpty(a)) return true;
  if (a!.userIds.has(user.userId)) return true;
  if (user.title && a!.titles.has(normTitle(user.title))) return true;
  return (user.groupIds ?? []).some((g) => a!.groupIds.has(g));
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

/** Moves a card's audience onto the built form it now opens (or back), so a relink keeps the limit. */
export async function moveAudience(from: string, to: string) {
  if (from === to) return;
  const n = await prisma.formAudience.updateMany({ where: { formKey: from }, data: { formKey: to } });
  if (n.count) await reloadAccess();
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
