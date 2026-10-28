import { z } from "zod";
import type { EmailTemplate } from "@prisma/client";
import { prisma } from "../prisma.js";
import { badRequest, notFound } from "../http.js";
import { audit, type Actor } from "./audit.js";

/**
 * The organization's email templates (Admin → Notifications → Templates).
 *
 * A template is the wording of an email: its subject, heading, a line under
 * it, what to do, which built-in details to show and the button. Routes and
 * weekly reports pick one by key, or keep their own wording; follow-up
 * reminders and "done" emails use their presets; code forms send with one by
 * key. Changing a template changes every email that uses it.
 *
 * Presets ship with the site (PRESETS): they're made the first time templates
 * are read, can be edited and put back ("Back to preset") or hidden, and are
 * never deleted, so there's always a working default. Only Super Admins
 * (email.templates) make or change templates; Admins pick from them.
 *
 * System emails (kind "system") are the site's own: access requests, being let
 * in or given more sites, an entry a form couldn't save, the daily summary and
 * the follow-up emails. Each has its own tags (SYSTEM_TAGS); they can be
 * changed and put back, never made, copied, hidden or deleted.
 *
 * Templates are plain text with a few tags ({form}, {site}, …): no answers,
 * names or resident details can be put in one, so subjects stay safe. Answers
 * are still chosen on the route, and only ever go to Lantern addresses.
 */

export const TEMPLATE_KINDS = ["message", "report", "system"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/** Built-in details a template can show above the route's own answers (services/routing.ts BUILT_IN_EMAIL_FIELDS). */
export const TEMPLATE_DETAILS = ["_site", "_date", "_by", "_followup"] as const;

/** The tags each kind fills in, with what they become. */
export const TEMPLATE_TAGS: Record<TemplateKind, { tag: string; means: string }[]> = {
  message: [
    { tag: "{form}", means: "The form's title" },
    { tag: "{title}", means: "What happened, e.g. “New entry: Employee Separation”" },
    { tag: "{site}", means: "The site's name, or nothing" },
    { tag: "{at_site}", means: "“ at <site>” when there is one, else nothing" },
    { tag: "{for_site}", means: "“ for <site>” when there is one, else nothing" },
    { tag: "{event}", means: "The event, e.g. “A new entry”" },
    { tag: "{date}", means: "Today, e.g. “Oct 27, 2026”" },
  ],
  report: [
    { tag: "{form}", means: "The form's title" },
    { tag: "{report}", means: "The report's name" },
    { tag: "{site}", means: "The site, or “All Sites”" },
    { tag: "{count}", means: "How many entries in the past week" },
    { tag: "{date}", means: "Today, e.g. “10/27/2026”" },
  ],
  // Each system email has its own (SYSTEM_TAGS).
  system: [],
};

const SITE_TAGS = [
  { tag: "{form}", means: "The form's title" },
  { tag: "{site}", means: "The site's name, or nothing" },
  { tag: "{at_site}", means: "“ at <site>” when there is one, else nothing" },
  { tag: "{for_site}", means: "“ for <site>” when there is one, else nothing" },
  { tag: "{date}", means: "Today, e.g. “Oct 27, 2026”" },
];
const ACCESS_TAGS = [
  { tag: "{by}", means: "Who did it, e.g. “Morgan Site Manager”" },
  { tag: "{a_role}", means: "Their role with “a” or “an”, e.g. “a Site Manager”" },
  { tag: "{role}", means: "Their role, e.g. “Site Manager”" },
  { tag: "{where}", means: "Where they work now, e.g. “Clover Hall and Main Office”" },
];

/** The tags each system email fills in. */
export const SYSTEM_TAGS: Record<string, { tag: string; means: string }[]> = {
  "access-request": [
    { tag: "{person}", means: "Who's asking" },
    { tag: "{email}", means: "Their email address" },
    { tag: "{position}", means: "Their position, or nothing" },
    { tag: "{sites}", means: "The site they asked for, or “3 sites”" },
    { tag: "{all_sites}", means: "Every site they asked for, by name" },
  ],
  "access-granted": ACCESS_TAGS,
  "access-changed": ACCESS_TAGS,
  "sites-added": [...ACCESS_TAGS, { tag: "{sites}", means: "The sites just approved, by name" }],
  "entry-problem": [
    { tag: "{source}", means: "The form that tried to save it, in quotes, or “A form”" },
    { tag: "{target}", means: "The form it tried to save into" },
  ],
  "daily-summary": [
    { tag: "{count}", means: "How many, e.g. “3”" },
    { tag: "{notifications}", means: "e.g. “3 new notifications”" },
    { tag: "{unread}", means: "e.g. “3 notifications”" },
  ],
  "follow-up-done": SITE_TAGS,
  reminder: SITE_TAGS,
};

/** The tags a template may use: its kind's, or its own for a system email. */
export function tagsFor(kind: TemplateKind, key?: string | null) {
  return kind === "system" ? SYSTEM_TAGS[key ?? ""] ?? [] : TEMPLATE_TAGS[kind];
}

/** The key the routes editor starts a new route on. */
export const DEFAULT_MESSAGE_TEMPLATE = "new-entry";
export const DEFAULT_REPORT_TEMPLATE = "weekly-report";
/** Presets the site's own follow-up emails use (services/followUp.ts). */
export const FOLLOW_UP_DONE_TEMPLATE = "follow-up-done";
export const REMINDER_TEMPLATE = "reminder";

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

export const templateInput = z
  .object({
    name: z.string().trim().min(1, "Give the template a name.").max(120),
    description: text(300),
    kind: z.enum(TEMPLATE_KINDS).default("message"),
    subject: text(200),
    heading: text(200),
    intro: text(500),
    whatToDo: text(500),
    details: z.array(z.enum(TEMPLATE_DETAILS)).max(4).default([]),
    buttonLabel: text(60),
    urgent: z.boolean().default(false),
  })
  .strict();
export type TemplateInput = z.infer<typeof templateInput>;

/** The starter set. Keys are what routes, reports and code forms name them by. */
export const PRESETS: (TemplateInput & { key: string })[] = [
  {
    key: "new-entry",
    name: "New entry",
    description: "The everyday email: someone filled in the form. New routes start on this one.",
    kind: "message",
    subject: "{title}{at_site}",
    heading: "{title}",
    intro: "There's a new entry in “{form}”{for_site}.",
    whatToDo: "Open the entry and check it.",
    details: ["_site", "_date", "_by"],
    buttonLabel: "Open it in Lantern Forms",
    urgent: false,
  },
  {
    key: "urgent",
    name: "Urgent",
    description: "Incidents and anything that can't wait. Always urgent: red in the bell, emailed straight away.",
    kind: "message",
    subject: "{title}{at_site}",
    heading: "{title}",
    intro: "This came in on “{form}”{for_site} and needs attention now.",
    whatToDo: "Open it now and act on it today.",
    details: ["_site", "_date", "_by"],
    buttonLabel: "Open it now",
    urgent: true,
  },
  {
    key: "request",
    name: "Request to act on",
    description: "HR and IT requests: something to do, then mark it done with what was done.",
    kind: "message",
    subject: "Action needed: {title}{at_site}",
    heading: "{title}",
    intro: "A request came in on “{form}”{for_site}.",
    whatToDo: "Do what it asks, then open it and mark it done with what you did.",
    details: ["_site", "_date", "_by", "_followup"],
    buttonLabel: "Open the request",
    urgent: false,
  },
  {
    key: FOLLOW_UP_DONE_TEMPLATE,
    name: "Follow-up done",
    description: "Tells whoever filed an entry that it's been taken care of, when a follow-up is marked done.",
    kind: "system",
    subject: "Done: {form}{at_site}",
    heading: "Done: {form}{at_site}",
    intro: "What you filed on “{form}” has been taken care of.",
    whatToDo: null,
    details: [],
    buttonLabel: "See what was done",
    urgent: false,
  },
  {
    key: REMINDER_TEMPLATE,
    name: "Follow-up reminder",
    description: "Reminds the people a follow-up is for that it's still open.",
    kind: "system",
    subject: "Reminder: {form}{at_site} is still open",
    heading: "Reminder: {form}{at_site} is still open",
    intro: "This hasn't been marked done yet.",
    whatToDo: "Do what it asks, then open it and mark it done.",
    details: [],
    buttonLabel: "Open it in Lantern Forms",
    urgent: false,
  },
  {
    key: DEFAULT_REPORT_TEMPLATE,
    name: "Weekly report",
    description: "The weekly summary: a count, a table of the answers chosen on the report, and a button to the entries.",
    kind: "report",
    subject: "{report} - {site} - {date}",
    heading: "{report}: {site}",
    intro: null,
    whatToDo: null,
    details: [],
    buttonLabel: "Open the entries",
    urgent: false,
  },
  {
    key: "access-request",
    name: "Someone asks to see sites",
    description: "To the people who approve access (Admins, and the managers of the sites asked for).",
    kind: "system",
    subject: "{person} is asking to see {sites}",
    heading: "{person} is asking to see {sites}",
    intro: "{person} ({email}) asked to see {all_sites} in Lantern Forms.",
    whatToDo: "Approve or decline it in People & roles.",
    details: [],
    buttonLabel: "Open the request",
    urgent: false,
  },
  {
    key: "access-granted",
    name: "You can now sign in",
    description: "To someone who's just been let in.",
    kind: "system",
    subject: "You can now sign in to Lantern Forms",
    heading: "You can now sign in to Lantern Forms",
    intro: "{by} let you in. You're {a_role}, at {where}.",
    whatToDo: null,
    details: [],
    buttonLabel: "Open Lantern Forms",
    urgent: false,
  },
  {
    key: "access-changed",
    name: "Your access changed",
    description: "To someone whose role or sites were changed.",
    kind: "system",
    subject: "Your access in Lantern Forms changed",
    heading: "Your access in Lantern Forms changed",
    intro: "{by} changed your access. You're {a_role}, at {where}.",
    whatToDo: null,
    details: [],
    buttonLabel: "Open Lantern Forms",
    urgent: false,
  },
  {
    key: "sites-added",
    name: "More sites approved",
    description: "To someone already in who was given the sites they asked for.",
    kind: "system",
    subject: "You've been given more sites in Lantern Forms",
    heading: "You've been given more sites in Lantern Forms",
    intro: "{by} approved {sites}. You're {a_role}, at {where}.",
    whatToDo: null,
    details: [],
    buttonLabel: "Open Lantern Forms",
    urgent: false,
  },
  {
    key: "entry-problem",
    name: "An entry couldn't be saved",
    description: "To whoever caused it, when one form couldn't save an entry into another.",
    kind: "system",
    subject: "{source} couldn't save an entry in “{target}”",
    heading: "{source} couldn't save an entry in “{target}”",
    intro: "The entry wasn't saved. Open the form to see what went wrong and send it again.",
    whatToDo: null,
    details: [],
    buttonLabel: "Open the form",
    urgent: false,
  },
  {
    key: "daily-summary",
    name: "Daily summary",
    description: "Each morning, to people who chose a daily summary: how many notifications they haven't read.",
    kind: "system",
    subject: "{notifications} in Lantern Forms",
    heading: "You have {unread} you haven't read yet.",
    intro: null,
    whatToDo: null,
    details: [],
    buttonLabel: "Open them in Lantern Forms",
    urgent: false,
  },
];
export const SYSTEM_KEYS = PRESETS.filter((p) => p.kind === "system").map((p) => p.key);
const PRESET_ORDER = new Map(PRESETS.map((p, i) => [p.key, i]));

// ── Reading (cached: every routed event reads them) ──────────────────────

let cache: { at: number; byKey: Map<string, EmailTemplate> } | null = null;
let presetsMade = false;
const TTL = 60_000;

const rowData = (t: TemplateInput) => ({
  name: t.name,
  description: t.description,
  kind: t.kind,
  subject: t.subject,
  heading: t.heading,
  intro: t.intro,
  whatToDo: t.whatToDo,
  details: t.details.length ? t.details.join(",") : null,
  buttonLabel: t.buttonLabel,
  urgent: t.urgent,
});

/** Make any preset that isn't there yet (a new one in a later release, or the first time). */
async function ensurePresets() {
  if (presetsMade) return;
  const rows = await prisma.emailTemplate.findMany({ where: { key: { in: PRESETS.map((p) => p.key) } }, select: { key: true, kind: true, revision: true } });
  const have = new Set(rows.map((r) => r.key));
  for (const r of rows) {
    const p = PRESETS.find((x) => x.key === r.key)!;
    // Nobody has changed it (revision 1): it follows the site's wording for it. A changed one keeps its own.
    if (r.revision === 1) await prisma.emailTemplate.update({ where: { key: r.key }, data: { ...rowData(p), ...(p.kind === "system" ? { hidden: false } : {}) } });
    else if (r.kind !== p.kind) await prisma.emailTemplate.update({ where: { key: r.key }, data: { kind: p.kind, ...(p.kind === "system" ? { hidden: false } : {}) } });
  }
  for (const p of PRESETS.filter((x) => !have.has(x.key))) {
    await prisma.emailTemplate
      .create({ data: { key: p.key, preset: p.key, ...rowData(p), createdByName: "Lantern Forms", updatedByName: "Lantern Forms" } })
      .catch(() => undefined); // another server made it first
  }
  presetsMade = true;
}

async function byKey(): Promise<Map<string, EmailTemplate>> {
  if (cache && Date.now() - cache.at < TTL) return cache.byKey;
  await ensurePresets();
  const rows = await prisma.emailTemplate.findMany();
  cache = { at: Date.now(), byKey: new Map(rows.map((r) => [r.key, r])) };
  return cache.byKey;
}
const forget = () => (cache = null);

/** A template by key, hidden or not (what already uses a hidden one keeps working). */
export async function templateByKey(key: string | null | undefined): Promise<EmailTemplate | null> {
  if (!key) return null;
  return (await byKey()).get(key) ?? null;
}

export async function listTemplates(): Promise<EmailTemplate[]> {
  const rows = [...(await byKey()).values()];
  return rows.sort((a, b) => (PRESET_ORDER.get(a.key) ?? 99) - (PRESET_ORDER.get(b.key) ?? 99) || a.name.localeCompare(b.name));
}

export async function getTemplate(idOrKey: string): Promise<EmailTemplate> {
  await ensurePresets();
  const row = await prisma.emailTemplate.findFirst({ where: { OR: [{ id: idOrKey }, { key: idOrKey }] } });
  if (!row) throw notFound("No such email template.");
  return row;
}

/** A template as the screens and the MCP see it. */
export function templateView(t: EmailTemplate) {
  return {
    id: t.id,
    key: t.key,
    name: t.name,
    description: t.description,
    kind: t.kind as TemplateKind,
    subject: t.subject,
    heading: t.heading,
    intro: t.intro,
    whatToDo: t.whatToDo,
    details: t.details ? t.details.split(",").filter(Boolean) : [],
    buttonLabel: t.buttonLabel,
    urgent: t.urgent,
    preset: Boolean(t.preset),
    /** A preset that's been changed from what the site ships. */
    changed: t.preset ? !samePreset(t) : false,
    hidden: t.hidden,
    revision: t.revision,
    createdByName: t.createdByName,
    updatedByName: t.updatedByName,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}
export type TemplateView = ReturnType<typeof templateView>;

function samePreset(t: EmailTemplate) {
  const p = PRESETS.find((x) => x.key === t.preset);
  if (!p) return true;
  const a = rowData(p);
  return (Object.keys(a) as (keyof typeof a)[]).every((k) => (a[k] ?? null) === (t[k] ?? null));
}

// ── Filling in ───────────────────────────────────────────────────────────

/** Tags that aren't in the kind's list, so a typo ({sit}) is caught when it's saved. */
function unknownTags(value: string | null, kind: TemplateKind, key?: string | null) {
  if (!value) return [];
  const ok = new Set(tagsFor(kind, key).map((t) => t.tag));
  return [...value.matchAll(/\{[^{}]*\}/g)].map((m) => m[0]).filter((t) => !ok.has(t));
}

/** Throws with what's wrong, in words. */
export function checkTemplate(t: TemplateInput, key?: string | null) {
  const bad = (["subject", "heading", "intro", "whatToDo", "buttonLabel"] as const).flatMap((k) => unknownTags(t[k], t.kind, key).map((tag) => `${tag} in ${k === "whatToDo" ? "What to do" : k}`));
  if (bad.length) {
    const what = t.kind === "system" ? "this email" : `a ${t.kind} template`;
    throw badRequest(`These tags don't exist for ${what}: ${bad.join(", ")}. You can use ${tagsFor(t.kind, key).map((x) => x.tag).join(" ") || "none"}.`);
  }
  if (t.kind !== "message" && t.details.length) throw badRequest("Only a message template shows details of its own.");
  if (t.kind === "system" && !t.subject) throw badRequest("The site's own emails need a subject.");
}

/** Fill a template's tags. Anything not given becomes nothing; spaces are tidied. */
export function fillTags(value: string | null | undefined, tags: Record<string, string>, opts: { line?: boolean; max?: number } = {}) {
  if (!value) return null;
  let out = value.replace(/\{([a-z_]+)\}/g, (all, k: string) => (k in tags ? tags[k] : all));
  if (opts.line) out = out.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").replace(/\s+([-–—:·,])\s*$/, "");
  out = out.replace(/[ \t]{2,}/g, " ").trim();
  return out ? out.slice(0, opts.max ?? 500) : null;
}

/** The tags for one event: what a message template fills in. */
export function messageTags(p: { form: string; title: string; site?: string | null; event?: string | null; date?: Date }) {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(p.date ?? new Date());
  const site = p.site ?? "";
  return { form: p.form, title: p.title, site, at_site: site ? ` at ${site}` : "", for_site: site ? ` for ${site}` : "", event: p.event ?? "", date: day };
}

export interface Wording {
  subject: string;
  heading: string;
  intro: string | null;
  whatToDo: string | null;
  buttonLabel: string | null;
  urgent: boolean;
  /** Built-in details to show before the route's chosen answers. */
  details: string[];
}

/** A message template filled in for one event. */
export function messageWording(t: Pick<EmailTemplate, "subject" | "heading" | "intro" | "whatToDo" | "buttonLabel" | "urgent" | "details">, tags: Record<string, string>, fallbackTitle: string): Wording {
  const subject = fillTags(t.subject, tags, { line: true, max: 200 }) ?? fallbackTitle.slice(0, 200);
  return {
    subject,
    heading: fillTags(t.heading, tags, { line: true, max: 200 }) ?? subject,
    intro: fillTags(t.intro, tags),
    whatToDo: fillTags(t.whatToDo, tags),
    buttonLabel: fillTags(t.buttonLabel, tags, { line: true, max: 60 }),
    urgent: t.urgent,
    details: t.details ? t.details.split(",").filter(Boolean) : [],
  };
}

// ── Changing (Super Admins) ──────────────────────────────────────────────

/** A key from a name, not taken yet: "HR request" → "hr-request". */
async function newKey(name: string) {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "template";
  const taken = new Set((await prisma.emailTemplate.findMany({ where: { key: { startsWith: base } }, select: { key: true } })).map((r) => r.key));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

export async function createTemplate(input: unknown, actor: Actor, opts: { key?: string } = {}) {
  const t = parse(input);
  if (t.kind === "system") throw badRequest("The site's own emails come with the site: change one of them instead of making a new one.");
  checkTemplate(t);
  let key = opts.key?.trim().toLowerCase();
  if (key) {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(key)) throw badRequest("A key is lowercase letters, numbers and dashes, e.g. hr-request.");
    if (await prisma.emailTemplate.findUnique({ where: { key } })) throw badRequest(`There's already a template with the key "${key}".`);
  } else key = await newKey(t.name);
  const row = await prisma.emailTemplate.create({ data: { key, ...rowData(t), createdByName: actor.name.slice(0, 255), updatedByName: actor.name.slice(0, 255) } });
  forget();
  await audit({ actor, action: "email.template_created", summary: `Made the email template “${row.name}” (${row.key})` }).catch(() => undefined);
  return row;
}

export async function copyTemplate(idOrKey: string, actor: Actor, name?: string) {
  const from = templateView(await getTemplate(idOrKey));
  if (from.kind === "system") throw badRequest(`“${from.name}” is one of the site's own emails and can't be copied.`);
  const { id: _id, key: _key, preset: _p, changed: _c, hidden: _h, revision: _r, createdByName: _cb, updatedByName: _ub, createdAt: _ca, updatedAt: _ua, ...copy } = from;
  return createTemplate({ ...copy, details: copy.details, name: (name?.trim() || `${from.name} (copy)`).slice(0, 120) }, actor);
}

export async function updateTemplate(idOrKey: string, input: unknown, actor: Actor, revision?: number) {
  const before = await getTemplate(idOrKey);
  if (revision !== undefined && revision !== before.revision) throw badRequest(`Someone changed “${before.name}” since you opened it. Load it again and redo your change.`);
  // A change that doesn't say its kind keeps the template's.
  const t = parse(input && typeof input === "object" && !("kind" in input) ? { ...input, kind: before.kind } : input);
  if (t.kind !== before.kind) throw badRequest("A template's kind can't change: make a new one.");
  checkTemplate(t, before.key);
  const row = await prisma.emailTemplate.update({ where: { id: before.id }, data: { ...rowData(t), revision: { increment: 1 }, updatedByName: actor.name.slice(0, 255) } });
  forget();
  const changed = (Object.keys(rowData(t)) as (keyof ReturnType<typeof rowData>)[]).filter((k) => (before[k] ?? null) !== (row[k] ?? null));
  await audit({
    actor,
    action: "email.template_updated",
    summary: `Changed the email template “${row.name}”${changed.length ? `: ${changed.join(", ")}` : ""}`,
    changes: Object.fromEntries(changed.map((k) => [k, [before[k], row[k]]])),
  }).catch(() => undefined);
  return row;
}

/** A preset back to what the site ships. */
export async function resetTemplate(idOrKey: string, actor: Actor) {
  const before = await getTemplate(idOrKey);
  const p = PRESETS.find((x) => x.key === before.preset);
  if (!p) throw badRequest(`“${before.name}” isn't a preset, so there's nothing to go back to.`);
  const row = await prisma.emailTemplate.update({ where: { id: before.id }, data: { ...rowData(p), revision: { increment: 1 }, updatedByName: actor.name.slice(0, 255) } });
  forget();
  await audit({ actor, action: "email.template_reset", summary: `Put the email template “${row.name}” back to its preset` }).catch(() => undefined);
  return row;
}

export async function setTemplateHidden(idOrKey: string, hidden: boolean, actor: Actor) {
  const before = await getTemplate(idOrKey);
  if (before.kind === "system") throw badRequest(`“${before.name}” is one of the site's own emails, so it's always sent. Change its wording instead.`);
  if (hidden && (before.key === DEFAULT_MESSAGE_TEMPLATE || before.key === DEFAULT_REPORT_TEMPLATE)) {
    throw badRequest(`“${before.name}” is what new ${before.kind === "report" ? "reports" : "routes"} start on, so it can't be hidden.`);
  }
  const row = await prisma.emailTemplate.update({ where: { id: before.id }, data: { hidden, updatedByName: actor.name.slice(0, 255) } });
  forget();
  await audit({ actor, action: hidden ? "email.template_hidden" : "email.template_shown", summary: `${hidden ? "Hid" : "Showed again"} the email template “${row.name}”` }).catch(() => undefined);
  return row;
}

/** Delete one nothing uses. Presets are never deleted (hide them instead). */
export async function deleteTemplate(idOrKey: string, actor: Actor, usedBy: number) {
  const before = await getTemplate(idOrKey);
  if (before.preset) throw badRequest(`“${before.name}” is a preset: hide it instead.`);
  if (usedBy) throw badRequest(`“${before.name}” is used by ${usedBy} route${usedBy === 1 ? "" : "s"} or report${usedBy === 1 ? "" : "s"}. Move them to another template first, or hide it.`);
  await prisma.emailTemplate.delete({ where: { id: before.id } });
  forget();
  await audit({ actor, action: "email.template_deleted", summary: `Deleted the email template “${before.name}” (${before.key})` }).catch(() => undefined);
}

function parse(input: unknown): TemplateInput {
  const p = templateInput.safeParse(input);
  if (!p.success) throw badRequest(p.error.issues.map((i) => `${i.path.join(".") || "template"}: ${i.message}`).join("; "));
  return p.data;
}

/** Throws unless every key names a template of this kind (when a route or report is saved). */
export async function checkTemplateKeys(keys: (string | undefined)[], kind: TemplateKind, where: string) {
  for (const key of keys.filter(Boolean) as string[]) {
    const t = await templateByKey(key);
    if (!t) throw badRequest(`${where}: there's no email template "${key}". See Admin → Notifications → Templates (MCP list_email_templates).`);
    if (t.kind !== kind) throw badRequest(`${where}: “${t.name}” is a ${t.kind} template; this needs a ${kind} template.`);
  }
}

/**
 * One of the site's own emails, worded by its system template: the in-app
 * title and the email's parts for notify(). Falls back to `fallback` (what the
 * site always said) if the template can't be read.
 */
export async function systemEmail(key: string, tags: Record<string, string>, fallback: string) {
  const t = await templateByKey(key).catch(() => null);
  if (!t) return { title: fallback, urgent: false, email: undefined };
  const w = messageWording(t, tags, fallback);
  return { title: w.subject, urgent: w.urgent, email: { heading: w.heading, intro: w.intro, whatToDo: w.whatToDo, buttonLabel: w.buttonLabel } };
}

/** "a Site Manager", "an Admin". */
export const withArticle = (role: string) => `${/^[aeiou]/i.test(role) ? "an" : "a"} ${role}`;
