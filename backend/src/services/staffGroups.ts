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
 * A form can be limited to some groups and/or named people (FormAudience). No
 * rows = everyone. Admins (forms.manage) always see every form. The check is
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
}

let groups: GroupInfo[] = [];
let audiences = new Map<string, Audience>();
let loading: Promise<void> | null = null;
let loaded = false;

async function load() {
  const [rows, aud] = await Promise.all([
    prisma.staffGroup.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], include: { rules: { select: { contains: true } } } }),
    prisma.formAudience.findMany({ select: { formKey: true, groupId: true, userId: true } }),
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
    const entry = next.get(a.formKey) ?? { groupIds: new Set<string>(), userIds: new Set<string>() };
    if (a.groupId) entry.groupIds.add(a.groupId);
    if (a.userId) entry.userIds.add(a.userId);
    next.set(a.formKey, entry);
  }
  audiences = next;
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

export function audienceOf(formKey: string): { groupIds: string[]; userIds: string[] } {
  const a = audiences.get(formKey);
  return { groupIds: a ? [...a.groupIds] : [], userIds: a ? [...a.userIds] : [] };
}

export const isLimited = (formKey: string) => {
  const a = audiences.get(formKey);
  return Boolean(a && (a.groupIds.size || a.userIds.size));
};

/** Whether this person may see and use the form. Admins always may. */
export function inAudience(user: Pick<CurrentUser, "userId" | "permissions" | "groupIds">, formKey: string): boolean {
  if (user.permissions.includes("forms.manage")) return true;
  const a = audiences.get(formKey);
  if (!a || (!a.groupIds.size && !a.userIds.size)) return true;
  if (a.userIds.has(user.userId)) return true;
  return (user.groupIds ?? []).some((g) => a.groupIds.has(g));
}

/** Replaces a form's audience. Empty lists = everyone. */
export async function setAudience(formKey: string, groupIds: string[], userIds: string[]) {
  await prisma.$transaction([
    prisma.formAudience.deleteMany({ where: { formKey } }),
    ...[...new Set(groupIds)].map((groupId) => prisma.formAudience.create({ data: { formKey, groupId } })),
    ...[...new Set(userIds)].map((userId) => prisma.formAudience.create({ data: { formKey, userId } })),
  ]);
  await reloadAccess();
}

/** Moves a card's audience onto the built form it now opens (or back), so a relink keeps the limit. */
export async function moveAudience(from: string, to: string) {
  if (from === to) return;
  const n = await prisma.formAudience.updateMany({ where: { formKey: from }, data: { formKey: to } });
  if (n.count) await reloadAccess();
}

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
