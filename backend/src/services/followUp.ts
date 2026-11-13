import { z } from "zod";
import type { BuiltForm, FormEntry } from "@prisma/client";
import { prisma } from "../prisma.js";
import { badRequest, forbidden } from "../http.js";
import type { CurrentUser } from "../auth/middleware.js";
import { ENTRY_CREATED, recipientSchema, type Route } from "../forms/routingSchema.js";
import { aboutValues, checkRoutes, planRoutes } from "./routing.js";
import type { Values } from "../forms/engine.js";
import { notify, type TypeRule } from "./notifications.js";
import { FOLLOW_UP_DONE_TEMPLATE, REMINDER_TEMPLATE, messageTags, messageWording, templateByKey } from "./emailTemplates.js";
import { audit, type Actor } from "./audit.js";
import { appBaseUrl } from "../env.js";
import { mailConfigured, sendLogged } from "./mailer.js";
import { brandedEmail, isInternalAddress } from "./emailTemplate.js";

/**
 * Follow-ups: a form's entries stay "open" until someone they're for marks
 * them done, with a note of what they did. Then whoever filed the entry is
 * told (in the app and by email), and until then the people who should do it
 * are reminded every few days. For HR's Onboarding, say: IT marks each
 * request done once the accounts exist, and HR hears so.
 *
 * Settings are saved per form (FormRecord "followup"/"settings"), outside the
 * form like its routing, and apply to entries saved after it's turned on.
 * Basic forms only for now: a code form runs its own steps in its own pages.
 * Admins can always mark an entry done or reopen it.
 */

export const COLLECTION = "followup";
const DOC = "settings";
const DAY = 86_400_000;
/** Most entries reminded about per form per run. */
const BATCH = 100;

/**
 * What the people it's for fill in when they mark it done (HR's Onboarding: the
 * new email address and username IT made). Kept on the entry, so they show in
 * its entries and exports. A "password" field is emailed once to whoever filed
 * the entry and never kept: not on the entry, the notification or the email log.
 */
export const DONE_FIELD_TYPES = ["text", "email", "textarea", "date", "password"] as const;
export type DoneFieldType = (typeof DONE_FIELD_TYPES)[number];
export const doneFieldSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "a done field's id is lower-case letters, digits and _, starting with a letter (e.g. work_email)"),
    label: z.string().trim().min(1).max(80),
    type: z.enum(DONE_FIELD_TYPES).default("text"),
    required: z.boolean().default(false),
    /** A line under the box. */
    help: z.string().trim().max(200).optional(),
    /**
     * What the box starts with, which they can change: {tags} from the entry's
     * answers, a name's parts as {field.first} / {field.last}. HR's Onboarding:
     * "{employee_name.first}.{employee_name.last}@lanterncommunity.org".
     */
    defaultValue: z.string().trim().max(300).optional(),
  })
  .strict();
export type DoneField = z.infer<typeof doneFieldSchema>;

/** One done field's answer, as kept on the entry. A password's value is never kept. */
export interface DoneValue {
  id: string;
  label: string;
  value: string | null;
  /** A password: emailed to whoever filed it, then dropped. */
  emailed?: boolean;
}

/**
 * One thing on a follow-up's checklist, ticked off on its own (HR's Separation:
 * "Laptop collected", "ETO account deactivated"), so everyone can see what's
 * been done, by whom and when. The label may hold the entry's answers as
 * {field_id} tags ("Delegate access given to {delegate_to}").
 */
export const checkItemSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "a checklist item's id is lower-case letters, digits and _, starting with a letter (e.g. laptop)"),
    label: z.string().trim().min(1).max(160),
    /** A line under it. */
    help: z.string().trim().max(200).optional(),
    /** Only on entries whose answer to this field is one of these (choice values; for a multi-choice field, any of them). */
    when: z
      .object({
        field: z.string().trim().min(1).max(64),
        values: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CheckItem = z.infer<typeof checkItemSchema>;

/** A checklist item ticked off on an entry, as kept on it. */
export interface CheckTick {
  id: string;
  label: string;
  doneAt: string;
  doneByName: string;
  /** Taken off this entry's checklist (it doesn't apply to this person), rather than done. */
  removed?: boolean;
}

/** A checklist item as it stands on one entry: its label filled in, and whether it's been ticked or taken off. */
export interface CheckState {
  id: string;
  label: string;
  help?: string;
  done: { at: string; byName: string } | null;
  /** Taken off this entry's checklist: not needed for this person. */
  removed?: { at: string; byName: string } | null;
}

/** Still to do: neither ticked off nor taken off the list. */
export const isOpenItem = (c: CheckState) => !c.done && !c.removed;

export const followUpSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Who it's for: they can mark it done, and are reminded. Same recipient kinds as a route. */
    doers: z.array(recipientSchema).max(50).default([]),
    /** The things to tick off one by one. When the last is ticked, the entry is done (unless there are done fields to fill in). */
    checklist: z.array(checkItemSchema).max(25).default([]),
    /** Also told as each item is ticked off (when tellEachItem) and when it's all done, besides whoever filed it. */
    alsoTell: z.array(recipientSchema).max(50).default([]),
    /** Tell whoever filed it (when tellSubmitter) and alsoTell as each checklist item is ticked off, not only at the end. */
    tellEachItem: z.boolean().default(true),
    /** Remind them this many days after it was filed, and again every as many days; null: never. */
    remindAfterDays: z.number().int().min(1).max(60).nullable().default(3),
    /** Stop after this many reminders. */
    maxReminders: z.number().int().min(1).max(10).default(3),
    /** Tell whoever filed it when it's done. */
    tellSubmitter: z.boolean().default(true),
    /** Shown in the reminder email: what's expected. */
    whatToDo: z.string().trim().max(500).optional(),
    /** What they fill in when they mark it done. */
    doneFields: z.array(doneFieldSchema).max(15).default([]),
    /**
     * The email whoever filed it gets when it's done, in the doers' own words
     * (IT's "the account has been created…"). {tags}: a done field's id, any of
     * the entry's answers by field id, {done_by}, {filed_by}, {form}, {site}, {note}.
     */
    reply: z
      .object({
        subject: z.string().trim().max(200).optional(),
        message: z.string().trim().max(4000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type FollowUpSettings = z.infer<typeof followUpSchema>;

/**
 * A follow-up's two notification types, in people's settings: the reminders to
 * the people it's for, and "it's done" to whoever filed it. Both always show in
 * the app; each person chooses whether and when they're emailed.
 */
export const followUpTopicKey = (formId: string, which: "reminder" | "done") => `followup:${formId}:${which}`;
export const FOLLOW_UP_RULE: TypeRule = { inApp: true, email: true, emailWhen: null, choice: "required" };

const DEFAULTS: FollowUpSettings = { enabled: false, doers: [], checklist: [], alsoTell: [], tellEachItem: true, remindAfterDays: 3, maxReminders: 3, tellSubmitter: true, doneFields: [] };

export interface FollowUpView extends FollowUpSettings {
  /** Entries still open now. */
  open: number;
  updatedByName: string | null;
  updatedAt: string | null;
}

export async function loadFollowUp(form: BuiltForm): Promise<FollowUpSettings & { updatedByName: string | null; updatedAt: string | null }> {
  const row = await prisma.formRecord.findUnique({ where: { formId_collection_docId: { formId: form.id, collection: COLLECTION, docId: DOC } } });
  const parsed = row ? followUpSchema.safeParse(JSON.parse(row.data)) : null;
  return { ...(parsed?.success ? parsed.data : DEFAULTS), updatedByName: row?.updatedByName ?? null, updatedAt: row?.updatedAt.toISOString() ?? null };
}

export async function followUpView(form: BuiltForm): Promise<FollowUpView> {
  const [s, open] = await Promise.all([loadFollowUp(form), prisma.formEntry.count({ where: { formId: form.id, status: "active", followUp: "open" } })]);
  return { ...s, open };
}

/** The doers as a route, so routing's checks and planning apply. */
const asRoute = (s: Pick<FollowUpSettings, "doers">): Route => ({ id: "follow-up", name: "Follow-up", event: ENTRY_CREATED, enabled: true, to: s.doers, email: "always", urgent: false });

export async function saveFollowUp(form: BuiltForm, input: unknown, actor: Actor): Promise<FollowUpView> {
  if (form.kind === "code") throw badRequest("Follow-ups are for forms made in Form builder for now; a code form runs its own steps in its pages.");
  const p = followUpSchema.safeParse(input);
  if (!p.success) throw badRequest(p.error.issues.map((i) => `${i.path.join(".") || "follow-up"}: ${i.message}`).join("; "));
  if (p.data.enabled && !p.data.doers.length) throw badRequest("Say who the follow-up is for: they mark entries done and get the reminders.");
  const ids = p.data.doneFields.map((f) => f.id);
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice) throw badRequest(`Two done fields are called "${twice}": give each its own id.`);
  if (p.data.doneFields.some((f) => f.type === "password") && !p.data.tellSubmitter) {
    throw badRequest("A password field is emailed to whoever filed the entry and never kept, so turn on telling them when it's done.");
  }
  const items = p.data.checklist.map((c) => c.id);
  const itemTwice = items.find((id, i) => items.indexOf(id) !== i);
  if (itemTwice) throw badRequest(`Two checklist items are called "${itemTwice}": give each its own id.`);
  if (p.data.doers.length) await checkRoutes(form, [asRoute(p.data)]);
  if (p.data.alsoTell.length) await checkRoutes(form, [{ ...asRoute({ doers: p.data.alsoTell }), id: "follow-up-tell", name: "Follow-up: also told" }]);
  await prisma.formRecord.upsert({
    where: { formId_collection_docId: { formId: form.id, collection: COLLECTION, docId: DOC } },
    create: { formId: form.id, collection: COLLECTION, docId: DOC, data: JSON.stringify(p.data), updatedByName: actor.name.slice(0, 255) },
    update: { data: JSON.stringify(p.data), updatedByName: actor.name.slice(0, 255) },
  });
  await audit({ actor, action: "forms.follow_up_changed", summary: `${p.data.enabled ? "Turned on" : "Turned off"} follow-up for “${form.title}”` }).catch(() => undefined);
  return followUpView(form);
}

/** A new entry starts open when the form tracks follow-ups. Never throws: saving the entry matters more. */
export async function openFollowUp(form: BuiltForm, entryId: string) {
  try {
    if (form.kind === "code") return;
    const s = await loadFollowUp(form);
    if (s.enabled) await prisma.formEntry.update({ where: { id: entryId }, data: { followUp: "open" } });
  } catch (err) {
    console.error(`[follow-up] couldn't open ${form.slug}/${entryId}:`, err);
  }
}

async function siteOf(siteId: string | null) {
  return siteId ? prisma.site.findUnique({ where: { id: siteId }, select: { id: true, code: true, name: true } }) : null;
}

/** The people an entry's follow-up is for (at its site). */
async function doersOf(form: BuiltForm, s: FollowUpSettings, entry: Pick<FormEntry, "siteId">) {
  if (!s.doers.length) return [];
  const [plan] = await planRoutes(form, [asRoute(s)], { event: ENTRY_CREATED, title: form.title, site: await siteOf(entry.siteId) });
  return plan?.people ?? [];
}

/** The people also told about an entry's follow-up (at its site), besides whoever filed it. */
async function alsoTellOf(form: BuiltForm, s: FollowUpSettings, entry: Pick<FormEntry, "siteId">) {
  return (await alsoTellPlan(form, s, entry)).people;
}

/** Everyone also told: account holders (told in the app and by email), and addresses with no account (emailed only). */
async function alsoTellPlan(form: BuiltForm, s: FollowUpSettings, entry: Pick<FormEntry, "siteId">) {
  if (!s.alsoTell.length) return { people: [] as { id: string; name: string; email: string }[], emails: [] as string[], trusted: [] as string[] };
  const [plan] = await planRoutes(form, [asRoute({ doers: s.alsoTell })], { event: ENTRY_CREATED, title: form.title, site: await siteOf(entry.siteId) });
  // trusted: outside addresses marked details: true (a partner helpdesk), sent what was done, like a route's answers.
  return { people: plan?.people ?? [], emails: plan?.emails ?? [], trusted: plan?.trusted ?? [] };
}

/** The checklist items ticked off on an entry, or none. */
export function parseChecks(raw: string | null | undefined): CheckTick[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is CheckTick => Boolean(x && typeof x === "object" && typeof (x as CheckTick).id === "string" && typeof (x as CheckTick).doneAt === "string")) : [];
  } catch {
    return [];
  }
}

/** Whether an entry's answer is one of these values (any of them, for a multi-choice answer). */
function answerIsOneOf(raw: unknown, values: string[]): boolean {
  const want = new Set(values.map((v) => v.toLowerCase()));
  const one = (x: unknown): boolean => {
    if (x == null) return false;
    if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") return want.has(String(x).toLowerCase());
    if (typeof x === "object" && "value" in (x as object)) return one((x as { value: unknown }).value);
    return false;
  };
  return Array.isArray(raw) ? raw.some(one) : one(raw);
}

/**
 * The checklist as it stands on one entry: the items its answers call for
 * (their {tags} filled in from those answers), each ticked or not. A ticked
 * item that's since been taken off the checklist still shows, so nothing done goes missing.
 */
export function checklistFor(s: Pick<FollowUpSettings, "checklist">, entry: Pick<FormEntry, "data" | "followUpChecks">): CheckState[] {
  const ticks = parseChecks(entry.followUpChecks);
  if (!s.checklist.length && !ticks.length) return [];
  const answers = JSON.parse(entry.data) as Record<string, unknown>;
  const tags = answerTags(answers);
  const out: CheckState[] = [];
  for (const c of s.checklist) {
    const tick = ticks.find((t) => t.id === c.id);
    if (c.when && !answerIsOneOf(answers[c.when.field], c.when.values) && !tick) continue;
    const label = fillReply(c.label, tags).replace(/\s+/g, " ").trim() || c.label;
    out.push({ id: c.id, label, help: c.help, ...stateOf(tick) });
  }
  for (const t of ticks) if (!out.some((c) => c.id === t.id)) out.push({ id: t.id, label: t.label, ...stateOf(t) });
  return out;
}

const stateOf = (t: CheckTick | undefined): Pick<CheckState, "done" | "removed"> =>
  !t ? { done: null } : t.removed ? { done: null, removed: { at: t.doneAt, byName: t.doneByName } } : { done: { at: t.doneAt, byName: t.doneByName } };

/** How many of an entry's checklist items are ticked, of how many; nothing when it has no checklist. */
export function checklistCount(s: Pick<FollowUpSettings, "checklist">, entry: Pick<FormEntry, "data" | "followUpChecks">): { checked?: number; checkTotal?: number } {
  const c = checklistFor(s, entry).filter((x) => !x.removed);
  return c.length ? { checked: c.filter((x) => x.done).length, checkTotal: c.length } : {};
}

export const tickedText = (c: CheckState) =>
  c.done ? `Done by ${c.done.byName}, ${stampOf(c.done.at)}` : c.removed ? `Not needed (taken off by ${c.removed.byName})` : "Not done";
/** A time as people at Lantern read it. */
function stampOf(iso: string) {
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Whether the entry's follow-up is this person's to do (Admins' override left out): for their Records. */
export async function isFollowUpDoer(form: BuiltForm, userId: string, entry: Pick<FormEntry, "siteId">, settings?: FollowUpSettings): Promise<boolean> {
  const s = settings ?? (await loadFollowUp(form));
  return (await doersOf(form, s, entry)).some((p) => p.id === userId);
}

/** Whether this person may mark the entry done (or reopen it): Admins, and the people it's for. */
export async function canFollowUp(form: BuiltForm, user: CurrentUser | null | undefined, entry: Pick<FormEntry, "siteId" | "followUp">): Promise<boolean> {
  if (!user || !entry.followUp) return false;
  if (user.permissions.includes("forms.manage")) return true;
  const s = await loadFollowUp(form);
  return (await doersOf(form, s, entry)).some((p) => p.id === user.userId);
}

const entryPath = (form: BuiltForm, entryId: string) => `/f/${form.slug}/entries/${entryId}`;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LEN: Record<DoneFieldType, number> = { text: 300, email: 320, textarea: 2000, date: 10, password: 200 };

/** The done fields' answers, checked against the settings: what's kept, and the passwords to email once. */
export function readDoneValues(fields: DoneField[], input: Record<string, unknown> | undefined) {
  const errors: string[] = [];
  const kept: DoneValue[] = [];
  const secrets = new Map<string, string>();
  const known = new Set(fields.map((f) => f.id));
  const stray = Object.keys(input ?? {}).filter((k) => !known.has(k));
  if (stray.length) errors.push(`This follow-up has no done field ${stray.map((k) => `"${k}"`).join(", ")}.`);
  for (const f of fields) {
    const raw = input?.[f.id];
    const v = typeof raw === "string" ? (f.type === "textarea" ? raw.trim() : raw.replace(/\s+/g, " ").trim()) : raw == null ? "" : String(raw).trim();
    if (!v) {
      if (f.required) errors.push(`Fill in ${f.label}.`);
      continue;
    }
    if (v.length > MAX_LEN[f.type]) errors.push(`${f.label} is too long (at most ${MAX_LEN[f.type]} characters).`);
    else if (f.type === "email" && !EMAIL_RE.test(v)) errors.push(`${f.label} isn't an email address.`);
    else if (f.type === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v)))) errors.push(`${f.label} isn't a date (YYYY-MM-DD).`);
    if (f.type === "password") {
      secrets.set(f.id, v);
      kept.push({ id: f.id, label: f.label, value: null, emailed: true });
    } else {
      kept.push({ id: f.id, label: f.label, value: f.type === "email" ? v.toLowerCase() : v });
    }
  }
  return { errors, kept, secrets };
}

/** The done fields' answers kept on an entry, or none. */
export function parseDoneValues(raw: string | null | undefined): DoneValue[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is DoneValue => Boolean(x && typeof x === "object" && typeof (x as DoneValue).id === "string" && typeof (x as DoneValue).label === "string")) : [];
  } catch {
    return [];
  }
}

/** An entry answer as plain words, for a reply's {tags}. */
function answerText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(answerText).filter(Boolean).join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.name === "string") return o.name;
    if (typeof o.label === "string") return o.label;
    return Object.values(o).map(answerText).filter(Boolean).join(" ");
  }
  return "";
}

/** Fill a reply's {tags}. Unknown tags are left out. */
export function fillReply(template: string, tags: Record<string, string>) {
  return template.replace(/\{([a-z][a-z0-9_]{0,39}(?:\.[a-z][a-z0-9_]{0,19})?)\}/gi, (_, k: string) => tags[k] ?? tags[k.toLowerCase()] ?? "");
}

/** An entry's answers as {tags}: each answer in words, and each part of one made of parts ({employee_name.first}). */
export function answerTags(answers: Record<string, unknown>): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(answers)) {
    tags[k] = answerText(v);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [part, pv] of Object.entries(v as Record<string, unknown>)) if (/^[a-z][a-z0-9_]{0,19}$/i.test(part)) tags[`${k}.${part}`] = answerText(pv);
    }
  }
  return tags;
}

/**
 * A follow-up's done fields for one entry, each with what it starts as
 * (prefill), worked out from its defaultValue and the entry's answers. An
 * email is made lower-case with no spaces ("Mary Ann" → maryann).
 */
export function doneFieldsFor(s: Pick<FollowUpSettings, "doneFields">, entry: Pick<FormEntry, "data">): (DoneField & { prefill?: string })[] {
  if (!s.doneFields.some((f) => f.defaultValue)) return s.doneFields;
  const tags = answerTags(JSON.parse(entry.data) as Record<string, unknown>);
  return s.doneFields.map((f) => {
    if (!f.defaultValue) return f;
    let v = fillReply(f.defaultValue, tags).trim();
    if (f.type === "email") v = v.toLowerCase().replace(/\s+/g, "").replace(/^\.+|\.(?=@)/g, "");
    return v ? { ...f, prefill: v.slice(0, MAX_LEN[f.type]) } : f;
  });
}

/** How the system note written when an entry is marked done starts: an entry with one was done before. */
const DONE_NOTE = "Follow-up marked done by";

/** Whether this entry's follow-up has been marked done before (and then opened again). */
export async function wasDoneBefore(entryId: string) {
  return (await prisma.formEntryNote.count({ where: { entryId, kind: "system", body: { startsWith: DONE_NOTE } } })) > 0;
}

/**
 * Mark an entry done (with what was done and its done fields), or open it again.
 * Tells whoever filed it when it's done. When the follow-up has a reply, or a
 * password was filled in, that's an email of its own to them, sent before
 * anything is saved: if it can't go, nothing changes and they can try again,
 * and the password is never written anywhere.
 *
 * Marked done again after being opened again, nobody is told a second time
 * unless tellAgain (a corrected username or a new password): then it goes out
 * as it did the first time. Quietly, a password isn't asked for or sent.
 */
export async function setFollowUp(
  form: BuiltForm,
  entry: FormEntry,
  actor: { userId: string | null; name: string },
  input: { done: boolean; note?: string | null; values?: Record<string, unknown>; tellAgain?: boolean }
) {
  if (!entry.followUp) throw badRequest("This entry isn't tracked for follow-up. Turn follow-up on for the form; it applies to entries saved after that.");
  const note = input.note?.trim().slice(0, 2000) || null;
  if (input.done && entry.followUp === "done") throw badRequest(`Already done, by ${entry.followUpDoneByName ?? "someone"}.`);
  if (!input.done && entry.followUp === "open") throw badRequest("It's already open.");

  const s = await loadFollowUp(form);
  const checklist = checklistFor(s, entry);
  if (input.done) {
    const left = checklist.filter(isOpenItem);
    if (left.length) throw badRequest(`Tick ${left.length === 1 ? "this" : "these"} off first: ${left.map((c) => c.label).join("; ")}.`);
  }
  // Done again, and not to be told again: no emails, so no password either.
  const quiet = input.done && !input.tellAgain && (await wasDoneBefore(entry.id));
  const passwordIds = new Set(s.doneFields.filter((f) => f.type === "password").map((f) => f.id));
  const askFor = quiet ? s.doneFields.filter((f) => !passwordIds.has(f.id)) : s.doneFields;
  const values = quiet && input.values ? Object.fromEntries(Object.entries(input.values).filter(([k]) => !passwordIds.has(k))) : input.values;
  // Each item with who did it and when, in the "it's done" emails.
  const checkFields = checklist.map((c) => ({ label: c.label, value: tickedText(c) }));
  const done = input.done ? readDoneValues(askFor, values) : { errors: [] as string[], kept: [] as DoneValue[], secrets: new Map<string, string>() };
  if (done.errors.length) throw badRequest(done.errors.join(" "));

  // Whoever filed it, when they're someone to tell.
  const tell = Boolean(input.done && !quiet && s.tellSubmitter && entry.createdById && entry.createdById !== actor.userId);
  const filer = tell ? await prisma.user.findUnique({ where: { id: entry.createdById! }, select: { id: true, email: true, status: true } }) : null;
  const reachable = Boolean(filer && filer.status === "active" && isInternalAddress(filer.email));
  const site = input.done ? await siteOf(entry.siteId) : null;

  if (done.secrets.size) {
    if (!filer || filer.status !== "active") {
      throw badRequest("There's nobody to email the password to: whoever filed this can't be told (they filed it through a link, no longer have access, or it's you). Leave the password blank and give it to them another way.");
    }
    if (!isInternalAddress(filer.email)) throw badRequest("A password is only emailed to a Lantern address, and whoever filed this doesn't have one. Leave it blank and give it to them another way.");
    if (!mailConfigured()) throw badRequest("Email isn't set up on this server, so the password can't be sent. Leave it blank and give it to them another way.");
  }

  // The reply's {tags}: the entry's answers, what was filled in, and who did it. Never a password.
  const base: Record<string, string> = {};
  if (input.done) {
    const answers = JSON.parse(entry.data) as Record<string, unknown>;
    Object.assign(base, answerTags(answers));
    Object.assign(base, { done_by: actor.name, filed_by: entry.createdByName, form: form.title, site: site?.name ?? "", note: note ?? "" });
    for (const v of done.kept) if (v.value) base[v.id] = v.value;
  }
  const replySubject = (s.reply?.subject ? fillReply(s.reply.subject, base) : "").replace(/\s+/g, " ").trim().slice(0, 200) || `Done: ${form.title}${site ? ` at ${site.name}` : ""}`;
  // The people also told get the same words, unless they'd carry a password (then they get the usual notice).
  const passwordTags = s.doneFields.filter((f) => f.type === "password").map((f) => `{${f.id}}`);
  const shareReply = Boolean(s.reply?.message && !passwordTags.some((t) => `${s.reply?.subject ?? ""} ${s.reply?.message ?? ""}`.includes(t)));

  let replied = false;
  if (filer && reachable && (s.reply?.message || done.secrets.size)) {
    // A password goes in the message, never the subject (subjects are logged).
    const withSecrets: Record<string, string> = { ...base, ...Object.fromEntries(done.secrets) };
    const subject = replySubject;
    const message = s.reply?.message ? fillReply(s.reply.message, withSecrets) : null;
    // Without a message of their own, the done fields are listed (a password too, in this email only).
    const fields = [
      ...(message
        ? []
        : [
            ...done.kept.map((v) => ({ label: v.label, value: v.emailed ? done.secrets.get(v.id) ?? "" : v.value ?? "" })),
            ...(note ? [{ label: "Note", value: note }] : []),
          ]),
      ...checkFields,
    ];
    try {
      await sendLogged({
        to: [filer.email],
        subject,
        kind: "notification",
        formId: form.id,
        withAnswers: true,
        html: brandedEmail({
          kicker: form.title,
          heading: subject,
          intro: message ? null : `${actor.name} marked it done.`,
          message,
          fields,
          button: { label: "Open it in Lantern Forms", url: `${appBaseUrl}${entryPath(form, entry.id)}` },
          note: done.secrets.size ? "The password is only in this email: Lantern Forms doesn't keep it." : null,
        }),
      });
      replied = true;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (done.secrets.size) throw badRequest(`Couldn't email the password to ${entry.createdByName} (${why}). Nothing was saved, so try again.`);
      console.error(`[follow-up] reply for ${entry.id} failed, telling them the usual way instead:`, why);
    }
  }

  const updated = await prisma.formEntry.update({
    where: { id: entry.id },
    data: input.done
      ? { followUp: "done", followUpDoneAt: new Date(), followUpDoneByName: actor.name.slice(0, 255), followUpNote: note, followUpValues: done.kept.length ? JSON.stringify(done.kept) : null }
      : { followUp: "open", followUpDoneAt: null, followUpDoneByName: null, followUpNote: null, followUpValues: null, followUpRemindedAt: null, followUpReminders: 0 },
  });
  const emailedLabels = done.kept.filter((v) => v.emailed).map((v) => v.label);
  await prisma.formEntryNote.create({
    data: {
      entryId: entry.id,
      kind: "system",
      authorName: "System",
      body: (input.done
        ? `${DONE_NOTE} ${actor.name}${note ? `: ${note}` : "."}${emailedLabels.length ? ` ${emailedLabels.join(", ")} emailed to ${entry.createdByName} and not kept.` : ""}${quiet ? " Done again: nobody was emailed this time." : ""}`
        : `Follow-up reopened by ${actor.name}${note ? `: ${note}` : "."}`
      ).slice(0, 2000),
    },
  });

  // Worded by the "Follow-up done" template (Admin → Notifications → Templates).
  const fallback = `Done: ${form.title}${site ? ` at ${site.name}` : ""}`;
  const w =
    input.done && !quiet && (tell || s.alsoTell.length)
      ? await templateByKey(FOLLOW_UP_DONE_TEMPLATE).then((t) => (t ? messageWording(t, messageTags({ form: form.title, title: fallback, site: site?.name }), fallback) : null))
      : null;
  const doneFields = [
    { label: "Done by", value: actor.name },
    ...(note ? [{ label: "What was done", value: note }] : []),
    ...done.kept.filter((v) => v.value).map((v) => ({ label: v.label, value: v.value! })),
    ...checkFields,
  ];
  if (tell) {
    await notify({
      to: { users: [entry.createdById!] },
      type: "forms.entry",
      title: w?.subject ?? fallback,
      body: note ? `${actor.name}: ${note}` : `${actor.name} marked it done.`,
      link: entryPath(form, entry.id),
      source: `form:${form.slug}`,
      sourceLabel: form.title,
      formId: form.id,
      // Their reply was already emailed: this one is the bell only.
      topic: { key: followUpTopicKey(form.id, "done"), rule: replied ? { inApp: true, email: false, emailWhen: null, choice: "locked" } : FOLLOW_UP_RULE },
      urgent: replied ? false : w?.urgent,
      email: replied
        ? undefined
        : {
            whatToDo: w?.whatToDo ?? null,
            heading: w?.heading,
            intro: w?.intro,
            buttonLabel: w?.buttonLabel,
            fields: doneFields,
          },
    }).catch((err) => console.error(`[follow-up] couldn't tell the submitter of ${entry.id}:`, err));
  }
  if (input.done && !quiet && s.alsoTell.length) {
    // The people also told (HR and IT on a Separation), besides whoever filed it and whoever did it.
    const plan = await alsoTellPlan(form, s, entry);
    const others = plan.people.filter((p) => p.id !== actor.userId && !(tell && p.id === entry.createdById));
    const message = shareReply ? fillReply(s.reply!.message!, base) : null;
    const link = { label: "Open it in Lantern Forms", url: `${appBaseUrl}${entryPath(form, entry.id)}` };
    // Which person it's about (the new hire), so a helpdesk ticket made from it can be matched.
    const about = aboutValues(form, JSON.parse(entry.data) as Values);
    // In the doers' own words ("Termination processed: …"), to Lantern addresses only: they carry answers.
    // Addresses with no account (HR's shared inbox) get it either way, as nobody else would tell them.
    const sendTo = [...(message ? others.map((p) => p.email) : []), ...plan.emails].filter((a, i, all) => all.indexOf(a) === i);
    for (const to of sendTo) {
      const inside = isInternalAddress(to);
      // A trusted outside address (PTSI) gets what was done (the new username), but never the
      // doers' reply: it carries the temporary password, which only goes to Lantern addresses.
      const trusted = !inside && plan.trusted.includes(to);
      await sendLogged({
        to: [to],
        subject: message && inside ? replySubject : w?.subject ?? fallback,
        kind: "notification",
        formId: form.id,
        withAnswers: inside || trusted,
        html: brandedEmail({
          kicker: form.title,
          heading: message && inside ? replySubject : w?.heading ?? w?.subject ?? fallback,
          intro: message && inside ? null : `${actor.name} marked it done.`,
          message: inside ? message : null,
          fields: inside || trusted ? [...about, { label: "Filed by", value: entry.createdByName }, ...doneFields] : [],
          button: link,
        }),
      }).catch((err) => console.error(`[follow-up] couldn't email ${to} about ${entry.id}:`, err));
    }
    if (others.length && message) {
      // Their email has gone: this one is the bell only.
      await notify({
        to: { users: others.map((p) => p.id) },
        type: "forms.entry",
        title: replySubject,
        body: `Filed by ${entry.createdByName}. ${actor.name} marked it done.`,
        link: entryPath(form, entry.id),
        source: `form:${form.slug}`,
        sourceLabel: form.title,
        formId: form.id,
        topic: { key: followUpTopicKey(form.id, "done"), rule: { inApp: true, email: false, emailWhen: null, choice: "locked" } },
      }).catch((err) => console.error(`[follow-up] couldn't tell the people also told about ${entry.id}:`, err));
    } else if (others.length) {
      await notify({
        to: { users: others.map((p) => p.id) },
        type: "forms.entry",
        title: w?.subject ?? fallback,
        body: `Filed by ${entry.createdByName}. ${note ? `${actor.name}: ${note}` : `${actor.name} marked it done.`}`,
        link: entryPath(form, entry.id),
        source: `form:${form.slug}`,
        sourceLabel: form.title,
        formId: form.id,
        topic: { key: followUpTopicKey(form.id, "done"), rule: FOLLOW_UP_RULE },
        urgent: w?.urgent,
        email: { whatToDo: w?.whatToDo ?? null, heading: w?.heading, intro: w?.intro, buttonLabel: w?.buttonLabel, fields: [...about, { label: "Filed by", value: entry.createdByName }, ...doneFields] },
      }).catch((err) => console.error(`[follow-up] couldn't tell the people also told about ${entry.id}:`, err));
    }
  }
  return updated;
}

/**
 * Tick one checklist item off on an entry, or untick it. Whoever filed it and
 * the people also told hear as each one is ticked (when tellEachItem). Ticking
 * the last one marks the entry done, unless the doers have done fields to fill in.
 * An item that doesn't apply to this person (no laptop to collect) can be
 * taken off this entry's list instead (removed), and put back (removed: false).
 */
export async function setFollowUpItem(
  form: BuiltForm,
  entry: FormEntry,
  actor: { userId: string | null; name: string },
  input: { item: string; done?: boolean; removed?: boolean }
) {
  if (!entry.followUp) throw badRequest("This entry isn't tracked for follow-up. Turn follow-up on for the form; it applies to entries saved after that.");
  if (entry.followUp === "done") throw badRequest("It's already done. Open it again to change the checklist.");
  if ((input.done === undefined) === (input.removed === undefined)) throw badRequest("Say either done (tick it off or untick it) or removed (take it off this entry's list or put it back).");
  const s = await loadFollowUp(form);
  const item = checklistFor(s, entry).find((c) => c.id === input.item);
  if (!item) throw badRequest(`This entry's checklist has no item "${input.item}".`);
  const ticking = input.done !== undefined;
  if (ticking) {
    if (item.removed) throw badRequest("It's been taken off this entry's list. Put it back first.");
    if (input.done && item.done) throw badRequest(`Already ticked off, by ${item.done.byName}.`);
    if (!input.done && !item.done) throw badRequest("It isn't ticked off.");
  } else {
    if (item.done) throw badRequest("It's ticked off. Untick it first.");
    if (input.removed && item.removed) throw badRequest(`Already taken off, by ${item.removed.byName}.`);
    if (!input.removed && !item.removed) throw badRequest("It's on the list.");
  }
  const adding = ticking ? input.done! : input.removed!;

  const ticks = parseChecks(entry.followUpChecks).filter((t) => t.id !== item.id);
  if (adding) ticks.push({ id: item.id, label: item.label, doneAt: new Date().toISOString(), doneByName: actor.name.slice(0, 255), ...(ticking ? {} : { removed: true }) });
  const followUpChecks = ticks.length ? JSON.stringify(ticks) : null;
  // Only if nobody else changed the checklist meanwhile, so two people ticking at once don't undo each other.
  const saved = await prisma.formEntry.updateMany({ where: { id: entry.id, followUp: "open", followUpChecks: entry.followUpChecks }, data: { followUpChecks } });
  if (!saved.count) throw badRequest("Someone else just changed this checklist. Reload the page and try again.");
  const what = ticking ? (adding ? "Ticked off" : "Unticked") : adding ? "Taken off the list (not needed)" : "Put back on the list";
  await prisma.formEntryNote.create({
    data: { entryId: entry.id, kind: "system", authorName: "System", body: `${what}: ${item.label} (${actor.name})`.slice(0, 2000) },
  });

  const now = { ...entry, followUpChecks };
  const after = checklistFor(s, now);
  const left = after.filter(isOpenItem);
  // The last one ticked or taken off (with at least one done): it's done, and everyone hears that instead.
  if (adding && !left.length && after.some((c) => c.done) && !s.doneFields.some((f) => f.required || f.type === "password")) {
    return setFollowUp(form, now, actor, { done: true });
  }

  if (ticking && input.done && s.tellEachItem) {
    const filer = s.tellSubmitter && entry.createdById && entry.createdById !== actor.userId ? entry.createdById : null;
    const others = (await alsoTellOf(form, s, entry)).map((p) => p.id).filter((id) => id !== actor.userId);
    const users = [...new Set([...(filer ? [filer] : []), ...others])];
    if (users.length) {
      const site = await siteOf(entry.siteId);
      const counted = after.filter((c) => !c.removed);
      const progress = `${counted.length - left.length} of ${counted.length} done`;
      await notify({
        to: { users },
        type: "forms.entry",
        title: `Done: ${item.label}`.slice(0, 200),
        body: `${form.title}${site ? ` at ${site.name}` : ""}, filed by ${entry.createdByName}. ${actor.name} ticked it off (${progress}).`,
        link: entryPath(form, entry.id),
        source: `form:${form.slug}`,
        sourceLabel: form.title,
        formId: form.id,
        topic: { key: followUpTopicKey(form.id, "done"), rule: FOLLOW_UP_RULE },
        email: {
          heading: `Done: ${item.label}`.slice(0, 200),
          intro: `${actor.name} ticked this off on ${form.title}, filed by ${entry.createdByName}.`,
          fields: [{ label: "Checklist", value: progress }, ...after.map((c) => ({ label: c.label, value: tickedText(c) }))],
        },
      }).catch((err) => console.error(`[follow-up] couldn't tell anyone about ${item.id} on ${entry.id}:`, err));
    }
  }
  return prisma.formEntry.findUniqueOrThrow({ where: { id: entry.id } });
}

/** Throws unless this person may mark the entry done or reopen it. */
export async function requireFollowUp(form: BuiltForm, user: CurrentUser | null | undefined, entry: FormEntry) {
  if (!(await canFollowUp(form, user, entry))) throw forbidden("Only the people this follow-up is for (and Admins) can mark it done.");
}

// ── Reminders ────────────────────────────────────────────────────────────

/** Remind the people an open entry is for, every remindAfterDays, up to maxReminders times. */
export async function runFollowUpReminders(now = new Date()): Promise<number> {
  const rows = await prisma.formRecord.findMany({ where: { collection: COLLECTION, docId: DOC }, select: { formId: true } });
  let sent = 0;
  const reminder = rows.length ? await templateByKey(REMINDER_TEMPLATE) : null;
  for (const { formId } of rows) {
    const form = await prisma.builtForm.findUnique({ where: { id: formId } });
    if (!form || form.status === "archived") continue;
    const s = await loadFollowUp(form);
    if (!s.enabled || !s.remindAfterDays || !s.doers.length) continue;
    const due = new Date(now.getTime() - s.remindAfterDays * DAY);
    const entries = await prisma.formEntry.findMany({
      where: {
        formId: form.id,
        status: "active",
        followUp: "open",
        createdAt: { lte: due },
        followUpReminders: { lt: s.maxReminders },
        OR: [{ followUpRemindedAt: null }, { followUpRemindedAt: { lte: due } }],
      },
      orderBy: { createdAt: "asc" },
      take: BATCH,
    });
    for (const e of entries) {
      // Claimed first, so an overlapping run doesn't remind twice.
      const claimed = await prisma.formEntry.updateMany({
        where: { id: e.id, followUpReminders: e.followUpReminders },
        data: { followUpRemindedAt: now, followUpReminders: { increment: 1 } },
      });
      if (!claimed.count) continue;
      const people = await doersOf(form, s, e);
      if (!people.length) continue;
      const days = Math.max(1, Math.floor((now.getTime() - e.createdAt.getTime()) / DAY));
      const site = await siteOf(e.siteId);
      const left = checklistFor(s, e).filter(isOpenItem);
      // Worded by the "Reminder" template; the follow-up's own What to do comes first.
      const fallback = `Reminder: ${form.title}${site ? ` at ${site.name}` : ""} is still open`;
      const w = reminder ? messageWording(reminder, messageTags({ form: form.title, title: fallback, site: site?.name }), fallback) : null;
      await notify({
        to: { users: people.map((p) => p.id) },
        type: "forms.entry",
        title: w?.subject ?? fallback,
        body: `Filed by ${e.createdByName} ${days} day${days === 1 ? "" : "s"} ago and not marked done yet.`,
        link: entryPath(form, e.id),
        source: `form:${form.slug}`,
        sourceLabel: form.title,
        formId: form.id,
        topic: { key: followUpTopicKey(form.id, "reminder"), rule: FOLLOW_UP_RULE },
        urgent: w?.urgent,
        email: {
          heading: w?.heading,
          intro: w?.intro,
          buttonLabel: w?.buttonLabel,
          whatToDo: s.whatToDo ?? w?.whatToDo ?? "Do what it asks, then open it and mark it done.",
          fields: [
            { label: "Filed by", value: e.createdByName },
            { label: "Open for", value: `${days} day${days === 1 ? "" : "s"}` },
            { label: "Reminder", value: `${e.followUpReminders + 1} of ${s.maxReminders}` },
            ...(left.length ? [{ label: "Still to do", value: left.map((c) => c.label).join("\n") }] : []),
          ],
        },
      }).catch((err) => console.error(`[follow-up] reminder for ${e.id} failed:`, err));
      sent++;
    }
  }
  return sent;
}

let timer: NodeJS.Timeout | null = null;

export function startFollowUpReminders() {
  if (timer) return;
  const tick = () => void runFollowUpReminders().catch((err) => console.error("[follow-up] reminders failed:", err));
  timer = setInterval(tick, 15 * 60_000);
  timer.unref();
  setTimeout(tick, 60_000).unref();
}
