import type { BuiltForm, FormEntry } from "@prisma/client";
import { prisma } from "../prisma.js";
import { HttpError, badRequest, forbidden } from "../http.js";
import type { CurrentUser } from "../auth/middleware.js";
import { ENTRY_CREATED, type Recipient, type Route } from "../forms/routingSchema.js";
import { fieldError, isEmptyValue, signOffFieldIds, visibleFieldIds, type Field, type FormDoc, type Values } from "../forms/engine.js";
import { planRoutes } from "./routing.js";
import { notify, type TypeRule } from "./notifications.js";
import { ROLES } from "./permissions.js";

/**
 * Sign-off: a signature question signed after the entry is filed, by someone
 * else — a supervisor, a licensed reviewer (PlanStreet's forms have both). The
 * form marks the question `signOff: { by, fields?, whatToDo?, after?, backup? }`
 * (forms/engine.ts): whoever fills the form in never sees it; once the entry is
 * filed, the people `by` names (routing's kinds of people, at the entry's site)
 * are asked to sign it on the entry, and reminded every few days until they do.
 * `fields` are other questions the signer fills in as they sign (a license
 * number, the date). The signature is kept as the question's answer, so it
 * shows, prints and exports like any other; who signed and when is kept beside
 * it (FormEntry.signOffs). A question's own rule still decides whether an entry
 * needs it (the Psychosocial's licensed reviewer only signs some).
 *
 * Order: `after` names another sign-off that's signed first (the Program
 * Director's, then the Vice President's). Until that one is signed this one
 * can't be, and its people aren't asked: they're asked when the earlier one is
 * signed. An earlier one the entry doesn't need is passed over.
 *
 * Backup: `backup: { by, afterDays }` — once a sign-off has waited afterDays
 * from when it could first be signed, the backup people are asked (once) and
 * may sign it too. The note and the entry page say it was signed by a backup.
 *
 * Nobody signs off their own entry. Admins may sign any other one, in order.
 */

const DAY = 86_400_000;
/** Most entries reminded about per run. */
const BATCH = 100;
/** Remind the signers this many days after they're asked, and again as often, at most MAX_REMINDERS times. */
const REMIND_AFTER_DAYS = 3;
const MAX_REMINDERS = 3;

/** Sign-off notices: always in the app; each person chooses when they're emailed (Profile → Notifications). */
export const SIGN_OFF_RULE: TypeRule = { inApp: true, email: true, emailWhen: null, choice: "required" };
export const signOffTopicKey = (formId: string, which: "request" | "done") => `signoff:${formId}:${which}`;

const entryPath = (form: Pick<BuiltForm, "slug">, entryId: string) => `/f/${form.slug}/entries/${entryId}`;

export interface Signed {
  byId: string | null;
  byName: string;
  at: string;
  /** Signed by one of its backup people, not the people it's for. */
  backup?: boolean;
}

/**
 * One sign-off on an entry as it stands (FormEntry.signOffs holds one per
 * sign-off id): when it could first be signed, when its backup was asked, and
 * once it's signed, who signed it and when.
 */
export interface SignOffRecord extends Partial<Signed> {
  /** When it could first be signed: the entry was filed, or the one it comes after was signed. */
  since?: string;
  /** When its backup people were asked. */
  backupAskedAt?: string;
}

/** One sign-off as it stands on an entry, for the entry page. */
export interface SignOffView {
  id: string;
  label: string;
  state: "waiting" | "signed";
  signed: Signed | null;
  /** Who signs it, in words. */
  who: string;
  whatToDo: string | null;
  /** The questions the signer fills in as they sign. */
  fields: Field[];
  canSign: boolean;
  /** Why this person can't, when they otherwise would (they filed it). */
  cantSignWhy: string | null;
  /** The sign-off it waits for (its label) while that one isn't signed: nobody is asked to sign this one yet. */
  after: string | null;
  /** Its backup: who, after how many days, and whether they've been asked (they may sign it too then). */
  backup: { who: string; afterDays: number; asked: boolean } | null;
}

export function parseSignOffs(raw: string | null | undefined): Record<string, SignOffRecord> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, SignOffRecord>) : {};
  } catch {
    return {};
  }
}

/** The signed ones among an entry's sign-offs: who signed each and when. */
function signedIn(rec: Record<string, SignOffRecord>): Record<string, Signed> {
  const out: Record<string, Signed> = {};
  for (const [id, r] of Object.entries(rec)) {
    if (r?.byName && r.at) out[id] = { byId: r.byId ?? null, byName: r.byName, at: r.at, ...(r.backup ? { backup: true } : {}) };
  }
  return out;
}

export const parseSigned = (raw: string | null | undefined): Record<string, Signed> => signedIn(parseSignOffs(raw));

export const hasSignOffs = (doc: Pick<FormDoc, "fields">) => doc.fields.some((f) => f.type === "signature" && f.signOff);

/** The sign-offs an entry needs: each one whose own rule (and its section's and page's) passes for the entry's answers. */
export function neededSignOffs(doc: Pick<FormDoc, "fields">, values: Values): Field[] {
  if (!hasSignOffs(doc)) return [];
  const vis = visibleFieldIds(doc, values, { includeAdminOnly: true, includeSignOff: true });
  return doc.fields.filter((f) => f.type === "signature" && f.signOff && vis.has(f.id));
}

/**
 * The sign-off this one waits for: the nearest one up its `after` chain that
 * the entry needs, while that one isn't signed. One the entry doesn't need (its
 * rule hides it) is passed over, so this one waits for the one before that, or
 * for nothing.
 */
function waitsFor(doc: Pick<FormDoc, "fields">, needed: Field[], signed: Record<string, Signed>, f: Field): Field | null {
  const seen = new Set([f.id]);
  for (let id = f.signOff?.after; id && !seen.has(id); id = doc.fields.find((x) => x.id === id)?.signOff?.after) {
    seen.add(id);
    const first = needed.find((x) => x.id === id);
    if (first) return signed[first.id] ? null : first;
  }
  return null;
}

/** The sign-offs that can be signed now: needed, not signed yet, and not waiting for another. */
export function signableSignOffs(doc: Pick<FormDoc, "fields">, values: Values, signed: Record<string, Signed>): Field[] {
  const needed = neededSignOffs(doc, values);
  return needed.filter((f) => !signed[f.id] && !waitsFor(doc, needed, signed, f));
}

/** When a sign-off that can be signed now first could be; an entry filed before this was kept counts from its filing. */
const sinceOf = (rec: Record<string, SignOffRecord>, f: Field, filedAt: Date) => (rec[f.id]?.since ? new Date(rec[f.id].since!) : filedAt);

/** When its backup is asked (and may sign): backup.afterDays after it could first be signed. */
const backupDue = (f: Field, since: Date) => new Date(since.getTime() + (f.signOff?.backup?.afterDays ?? 0) * DAY);

/** Whether a sign-off that can be signed now has waited long enough for its backup people to sign it too. */
const backupOpen = (f: Field, rec: Record<string, SignOffRecord>, filedAt: Date, now: Date) =>
  Boolean(f.signOff?.backup) && backupDue(f, sinceOf(rec, f, filedAt)) <= now;

/** When the reminder run next has a backup to ask on this entry (FormEntry.signOffBackupAt), or null. */
function nextBackupAt(doc: Pick<FormDoc, "fields">, values: Values, rec: Record<string, SignOffRecord>, filedAt: Date): Date | null {
  let next: Date | null = null;
  for (const f of signableSignOffs(doc, values, signedIn(rec))) {
    if (!f.signOff?.backup || rec[f.id]?.backupAskedAt) continue;
    const due = backupDue(f, sinceOf(rec, f, filedAt));
    if (!next || due < next) next = due;
  }
  return next;
}

const asRoute = (by: Recipient[]): Route => ({ id: "sign-off", name: "Sign-off", event: ENTRY_CREATED, enabled: true, to: by, email: "always", urgent: false });

async function siteOf(siteId: string | null) {
  return siteId ? prisma.site.findUnique({ where: { id: siteId }, select: { id: true, code: true, name: true } }) : null;
}

type SignEntry = Pick<FormEntry, "id" | "data" | "siteId" | "createdById">;

/** The people a list of recipients names for this entry (at its site), whoever filed it left out. */
async function peopleFor(form: BuiltForm, by: Recipient[], entry: SignEntry) {
  if (!by.length) return [];
  const values = JSON.parse(entry.data) as Values;
  const [plan] = await planRoutes(form, [asRoute(by)], {
    event: ENTRY_CREATED,
    title: form.title,
    site: await siteOf(entry.siteId),
    data: values,
    people: values,
    submitterId: entry.createdById,
    entryId: entry.id,
  });
  return (plan?.people ?? []).filter((p) => p.id !== entry.createdById);
}

/** The people who may sign this sign-off on this entry (at its site), whoever filed it left out. */
export const signersOf = (form: BuiltForm, field: Field, entry: SignEntry) => peopleFor(form, (field.signOff?.by ?? []) as Recipient[], entry);

/** Its backup people, who may sign it too once it has waited backup.afterDays. */
export const backupsOf = (form: BuiltForm, field: Field, entry: SignEntry) => peopleFor(form, (field.signOff?.backup?.by ?? []) as Recipient[], entry);

/**
 * Whether this person is asked to sign a sign-off the entry can be signed on
 * now (as one of its people, or as its backup once that's open), so they may
 * open it to sign. People of a sign-off still waiting for an earlier one aren't
 * asked yet.
 */
export async function isSignerOn(
  form: BuiltForm,
  doc: FormDoc,
  entry: SignEntry & Pick<FormEntry, "signOffs"> & Partial<Pick<FormEntry, "createdAt">>,
  userId: string,
  now = new Date()
): Promise<boolean> {
  const rec = parseSignOffs(entry.signOffs);
  for (const f of signableSignOffs(doc, JSON.parse(entry.data) as Values, signedIn(rec))) {
    if ((await signersOf(form, f, entry)).some((p) => p.id === userId)) return true;
    if (backupOpen(f, rec, entry.createdAt ?? now, now) && (await backupsOf(form, f, entry)).some((p) => p.id === userId)) return true;
  }
  return false;
}

const roleName = (key: string) => ROLES.find((r) => r.key === key)?.name ?? key.replace(/_/g, " ");
const plural = (s: string) => (/(s|ff)$/i.test(s) ? s : `${s}s`);

/** Who signs, in words: "Site Managers at the entry's site or Ana Ruiz". */
export async function describeSigners(by: Recipient[]): Promise<string> {
  const groupIds = by.filter((r) => r.kind === "group").map((r) => (r as { group: string }).group);
  const groups = groupIds.length ? new Map((await prisma.staffGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true } })).map((g) => [g.id, g.name])) : new Map<string, string>();
  const parts = by.map((r) => {
    switch (r.kind) {
      case "role":
        return `${plural(roleName(r.role))}${r.siteOnly === false ? "" : " at the entry's site"}`;
      case "group":
        return `${groups.get(r.group) ?? "a staff group"}${r.siteOnly ? " at the entry's site" : ""}`;
      case "title":
        return `${plural(r.title)}${r.siteOnly ? " at the entry's site" : ""}`;
      case "person":
        return r.name || r.email;
      case "field":
        return "the person the form names";
      case "submitter":
        return "whoever filed it";
      case "sharer":
        return "whoever shared the link";
    }
  });
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}` : parts[0] ?? "nobody yet";
}

const isFormAdmin = (user: Pick<CurrentUser, "permissions"> | null | undefined) => Boolean(user?.permissions.includes("forms.manage"));

function cantSign(user: CurrentUser | null | undefined, entry: Pick<FormEntry, "createdById" | "status">): string | null {
  if (!user) return "Sign in to sign it.";
  if (entry.status !== "active") return "This entry is void.";
  if (entry.createdById && entry.createdById === user.userId) return "You filed this entry, so someone else signs it.";
  return null;
}

/**
 * How this person may sign a sign-off that can be signed now: as one of its
 * people, as its backup (once that's open), or as an Admin; null if they can't.
 */
async function signerKind(form: BuiltForm, f: Field, entry: SignEntry, user: CurrentUser, backupIsOpen: boolean): Promise<"signer" | "backup" | "admin" | null> {
  if ((await signersOf(form, f, entry)).some((p) => p.id === user.userId)) return "signer";
  if (backupIsOpen && (await backupsOf(form, f, entry)).some((p) => p.id === user.userId)) return "backup";
  return isFormAdmin(user) ? "admin" : null;
}

/** Each sign-off this entry needs, signed or not, and whether this person can sign it. */
export async function signOffView(form: BuiltForm, doc: FormDoc, entry: FormEntry, user: CurrentUser | null | undefined, now = new Date()): Promise<SignOffView[]> {
  const needed = neededSignOffs(doc, JSON.parse(entry.data) as Values);
  if (!needed.length) return [];
  const rec = parseSignOffs(entry.signOffs);
  const signed = signedIn(rec);
  const byId = new Map(doc.fields.map((f) => [f.id, f]));
  return Promise.all(
    needed.map(async (f) => {
      const done = signed[f.id] ?? null;
      const first = done ? null : waitsFor(doc, needed, signed, f);
      const why = done || first ? null : cantSign(user, entry);
      const open = !done && !first;
      const backupNow = open && backupOpen(f, rec, entry.createdAt, now);
      const allowed = open && !why && Boolean(await signerKind(form, f, entry, user!, backupNow));
      const backup = f.signOff!.backup;
      return {
        id: f.id,
        label: f.label || f.id,
        state: done ? "signed" : "waiting",
        signed: done,
        who: await describeSigners(f.signOff!.by as Recipient[]),
        whatToDo: f.signOff!.whatToDo ?? null,
        fields: (f.signOff!.fields ?? []).map((id) => byId.get(id)).filter((x): x is Field => Boolean(x)),
        canSign: allowed,
        // Only worth saying to someone who'd otherwise be asked.
        cantSignWhy: open && why && user && entry.createdById === user.userId ? why : null,
        after: first ? first.label || first.id : null,
        backup: backup ? { who: await describeSigners(backup.by as Recipient[]), afterDays: backup.afterDays, asked: backupNow || Boolean(rec[f.id]?.backupAskedAt) } : null,
      } satisfies SignOffView;
    })
  );
}

/** Ask the people each sign-off names to sign it. */
async function askToSign(form: BuiltForm, entry: FormEntry, fields: Field[], reminder: { n: number; days: number } | null) {
  const site = await siteOf(entry.siteId);
  for (const f of fields) {
    const people = await signersOf(form, f, entry);
    if (!people.length) {
      console.warn(`[sign-off] nobody can sign “${f.label}” on ${form.slug}/${entry.id}`);
      continue;
    }
    const at = site ? ` at ${site.name}` : "";
    await notify({
      to: { users: people.map((p) => p.id) },
      type: "forms.entry",
      title: reminder ? `Reminder: ${form.title}${at} still needs your signature` : `Sign-off needed: ${form.title}${at}`,
      body: reminder
        ? `Filed by ${entry.createdByName} ${reminder.days} day${reminder.days === 1 ? "" : "s"} ago. “${f.label}” isn't signed yet.`
        : `${entry.createdByName} filed it. “${f.label}” is waiting for your signature.`,
      link: entryPath(form, entry.id),
      source: `form:${form.slug}`,
      sourceLabel: form.title,
      formId: form.id,
      topic: { key: signOffTopicKey(form.id, "request"), rule: SIGN_OFF_RULE },
      email: {
        whatToDo: f.signOff?.whatToDo ?? "Open it, read it through, and sign it.",
        fields: [
          { label: "Filed by", value: entry.createdByName },
          { label: "To sign", value: f.label || f.id },
          ...(reminder ? [{ label: "Reminder", value: `${reminder.n} of ${MAX_REMINDERS}` }] : []),
        ],
      },
    }).catch((err) => console.error(`[sign-off] couldn't ask for “${f.label}” on ${entry.id}:`, err));
  }
}

/** Ask each sign-off's backup people to sign it too: it has waited its backup's days. */
async function askBackups(form: BuiltForm, entry: FormEntry, fields: Field[], rec: Record<string, SignOffRecord>, now: Date) {
  const site = await siteOf(entry.siteId);
  for (const f of fields) {
    const people = await backupsOf(form, f, entry);
    if (!people.length) {
      console.warn(`[sign-off] no backup can sign “${f.label}” on ${form.slug}/${entry.id}`);
      continue;
    }
    const who = await describeSigners(f.signOff!.by as Recipient[]);
    const days = Math.max(1, Math.floor((now.getTime() - sinceOf(rec, f, entry.createdAt).getTime()) / DAY));
    await notify({
      to: { users: people.map((p) => p.id) },
      type: "forms.entry",
      title: `Sign-off needed: ${form.title}${site ? ` at ${site.name}` : ""}`,
      body: `“${f.label}” has waited ${days} day${days === 1 ? "" : "s"} for ${who}. You're their backup, so you can sign it too.`,
      link: entryPath(form, entry.id),
      source: `form:${form.slug}`,
      sourceLabel: form.title,
      formId: form.id,
      topic: { key: signOffTopicKey(form.id, "request"), rule: SIGN_OFF_RULE },
      email: {
        whatToDo: f.signOff?.whatToDo ?? "Open it, read it through, and sign it.",
        fields: [
          { label: "Filed by", value: entry.createdByName },
          { label: "To sign", value: f.label || f.id },
          { label: "Waiting for", value: who },
        ],
      },
    }).catch((err) => console.error(`[sign-off] couldn't ask the backup for “${f.label}” on ${entry.id}:`, err));
  }
}

/**
 * A new entry: when it needs any sign-off, it waits for them, and the people of
 * each one that can be signed now are asked (the rest wait for the one before
 * them). Never throws: saving the entry matters more.
 */
export async function openSignOffs(form: BuiltForm, doc: FormDoc, entry: FormEntry) {
  try {
    if (form.kind === "code" || !hasSignOffs(doc)) return;
    const values = JSON.parse(entry.data) as Values;
    if (!neededSignOffs(doc, values).length) return;
    const first = signableSignOffs(doc, values, {});
    const rec: Record<string, SignOffRecord> = Object.fromEntries(first.map((f) => [f.id, { since: entry.createdAt.toISOString() }]));
    const waiting = await prisma.formEntry.update({
      where: { id: entry.id },
      data: { signOff: "waiting", signOffs: JSON.stringify(rec), signOffBackupAt: nextBackupAt(doc, values, rec, entry.createdAt) },
    });
    // Asked after the response: working out who signs shouldn't hold up filing.
    void askToSign(form, waiting, first, null).catch((err) => console.error(`[sign-off] couldn't ask about ${entry.id}:`, err));
  } catch (err) {
    console.error(`[sign-off] couldn't open ${form.slug}/${entry.id}:`, err);
  }
}

/**
 * Sign one sign-off on an entry: the signature, and the answers to the
 * questions its signer fills in. The ones that were waiting for it can be
 * signed now, and their people are asked. When it was the last one, whoever
 * filed the entry is told it's signed off.
 */
export async function signEntry(
  form: BuiltForm,
  doc: FormDoc,
  entry: FormEntry,
  user: CurrentUser,
  input: { field: string; signature: string; values?: Record<string, unknown> }
): Promise<FormEntry> {
  const field = doc.fields.find((f) => f.id === input.field && f.type === "signature" && f.signOff);
  if (!field) throw badRequest("That isn't a signature this form asks for after filing.");
  const values = JSON.parse(entry.data) as Values;
  const needed = neededSignOffs(doc, values);
  if (!needed.some((f) => f.id === field.id)) throw badRequest("This entry doesn't need that signature.");
  const rec = parseSignOffs(entry.signOffs);
  const signed = signedIn(rec);
  if (signed[field.id]) throw badRequest(`Already signed by ${signed[field.id].byName}.`);
  const first = waitsFor(doc, needed, signed, field);
  if (first) throw badRequest(`This is signed after “${first.label || first.id}”, which isn't signed yet.`);
  const why = cantSign(user, entry);
  if (why) throw forbidden(why);
  const now = new Date();
  const backupNow = backupOpen(field, rec, entry.createdAt, now);
  const as = await signerKind(form, field, entry, user, backupNow);
  if (!as) {
    const who = await describeSigners(field.signOff!.by as Recipient[]);
    const backup = backupNow ? await describeSigners(field.signOff!.backup!.by as Recipient[]) : null;
    throw forbidden(`Only ${who}${backup ? ` (or their backup, ${backup})` : ""} can sign this.`);
  }

  // The signature and the signer's own questions, judged like answers when filing.
  const next: Values = { ...values, [field.id]: input.signature };
  const own = new Set(field.signOff!.fields ?? []);
  for (const id of own) {
    const v = input.values?.[id];
    next[id] = typeof v === "string" ? v.trim() : v;
    if (isEmptyValue(next[id])) delete next[id];
  }
  const errors: Record<string, string> = {};
  const sigError = fieldError({ ...field, required: true }, input.signature);
  if (sigError) errors[field.id] = sigError;
  const vis = visibleFieldIds(doc, next, { includeAdminOnly: true, includeSignOff: true });
  for (const id of own) {
    const f = doc.fields.find((x) => x.id === id);
    if (!f || !vis.has(id)) {
      delete next[id];
      continue;
    }
    const e = fieldError(f, next[id]);
    if (e) errors[id] = e;
  }
  if (Object.keys(errors).length) throw new HttpError(422, "Some answers need fixing.", { errors });

  const nowRec: Record<string, SignOffRecord> = {
    ...rec,
    [field.id]: { ...rec[field.id], byId: user.userId, byName: user.name, at: now.toISOString(), ...(as === "backup" ? { backup: true } : {}) },
  };
  const nowSigned = signedIn(nowRec);
  // The ones that were waiting for this one (or that the signer's answers now call for) can be signed from now.
  const before = new Set(signableSignOffs(doc, values, signed).map((f) => f.id));
  const opened = signableSignOffs(doc, next, nowSigned).filter((f) => !before.has(f.id));
  for (const f of opened) nowRec[f.id] = { ...nowRec[f.id], since: now.toISOString() };
  const left = neededSignOffs(doc, next).filter((f) => !nowSigned[f.id]);
  // Only if nobody signed it in the meantime.
  const saved = await prisma.formEntry.updateMany({
    where: { id: entry.id, status: "active", signOffs: entry.signOffs },
    data: {
      data: JSON.stringify(next),
      signOffs: JSON.stringify(nowRec),
      signOff: left.length ? "waiting" : "done",
      signOffBackupAt: left.length ? nextBackupAt(doc, next, nowRec, entry.createdAt) : null,
      // The people asked now get their reminders on the usual cadence, counted from now.
      ...(opened.length ? { signOffReminders: 0, signOffRemindedAt: now } : {}),
    },
  });
  if (!saved.count) throw new HttpError(409, "Someone else signed this entry just now. Open it again to see what changed.");

  const extras = [...own]
    .filter((id) => !isEmptyValue(next[id]))
    .map((id) => `${doc.fields.find((f) => f.id === id)?.label ?? id}: ${String(next[id])}`);
  await prisma.formEntryNote.create({
    data: {
      entryId: entry.id,
      kind: "system",
      authorName: "System",
      body: `Signed off: “${field.label || field.id}”, by ${user.name}${as === "backup" ? ", as a backup" : ""}${extras.length ? ` (${extras.join("; ")})` : ""}.`.slice(0, 2000),
    },
  });
  const updated = (await prisma.formEntry.findUnique({ where: { id: entry.id } }))!;

  if (opened.length) await askToSign(form, updated, opened, null);
  if (!left.length && entry.createdById && entry.createdById !== user.userId) {
    const site = await siteOf(entry.siteId);
    await notify({
      to: { users: [entry.createdById] },
      type: "forms.entry",
      title: `Signed off: ${form.title}${site ? ` at ${site.name}` : ""}`,
      body: `${user.name} signed “${field.label || field.id}”. Nothing else is waiting.`,
      link: entryPath(form, entry.id),
      source: `form:${form.slug}`,
      sourceLabel: form.title,
      formId: form.id,
      topic: { key: signOffTopicKey(form.id, "done"), rule: SIGN_OFF_RULE },
      email: { fields: [{ label: "Signed by", value: user.name }, { label: "Signature", value: field.label || field.id }] },
    }).catch((err) => console.error(`[sign-off] couldn't tell the filer of ${entry.id}:`, err));
  }
  return updated;
}

/** An Admin's edit keeps the sign-offs as they were: they change only by signing. */
export function keepSignOffAnswers(doc: Pick<FormDoc, "fields">, before: Values, after: Values) {
  for (const id of signOffFieldIds(doc)) {
    if (before[id] === undefined) delete after[id];
    else after[id] = before[id];
  }
}

// ── Reminders and backups ────────────────────────────────────────────────

/**
 * Remind the signers of entries still waiting, every REMIND_AFTER_DAYS, up to
 * MAX_REMINDERS times; and ask the backup people of any sign-off that has
 * waited its backup's days.
 */
export async function runSignOffReminders(now = new Date()): Promise<number> {
  return (await remind(now)) + (await escalate(now));
}

async function remind(now: Date): Promise<number> {
  const due = new Date(now.getTime() - REMIND_AFTER_DAYS * DAY);
  const entries = await prisma.formEntry.findMany({
    where: {
      status: "active",
      signOff: "waiting",
      createdAt: { lte: due },
      signOffReminders: { lt: MAX_REMINDERS },
      OR: [{ signOffRemindedAt: null }, { signOffRemindedAt: { lte: due } }],
    },
    orderBy: { createdAt: "asc" },
    take: BATCH,
  });
  if (!entries.length) return 0;
  const { docForEntry } = await import("../forms/entries.js");
  let sent = 0;
  for (const e of entries) {
    // Claimed first, so an overlapping run doesn't remind twice.
    const claimed = await prisma.formEntry.updateMany({ where: { id: e.id, signOffReminders: e.signOffReminders }, data: { signOffRemindedAt: now, signOffReminders: { increment: 1 } } });
    if (!claimed.count) continue;
    const form = await prisma.builtForm.findUnique({ where: { id: e.formId } });
    if (!form || form.status === "archived") continue;
    // Only the ones that can be signed now: one waiting for an earlier one hasn't been asked yet.
    const waiting = signableSignOffs(await docForEntry(form, e.formVersion), JSON.parse(e.data) as Values, parseSigned(e.signOffs));
    if (!waiting.length) continue;
    const days = Math.max(1, Math.floor((now.getTime() - e.createdAt.getTime()) / DAY));
    await askToSign(form, e, waiting, { n: e.signOffReminders + 1, days });
    sent++;
  }
  return sent;
}

/** Ask the backups whose time has come (FormEntry.signOffBackupAt), each sign-off's once. */
async function escalate(now: Date): Promise<number> {
  const entries = await prisma.formEntry.findMany({
    where: { status: "active", signOff: "waiting", signOffBackupAt: { lte: now } },
    orderBy: { signOffBackupAt: "asc" },
    take: BATCH,
  });
  if (!entries.length) return 0;
  const { docForEntry } = await import("../forms/entries.js");
  let sent = 0;
  for (const e of entries) {
    const form = await prisma.builtForm.findUnique({ where: { id: e.formId } });
    if (!form || form.status === "archived") {
      await prisma.formEntry.updateMany({ where: { id: e.id }, data: { signOffBackupAt: null } });
      continue;
    }
    const doc = await docForEntry(form, e.formVersion);
    const values = JSON.parse(e.data) as Values;
    const rec = parseSignOffs(e.signOffs);
    const due = signableSignOffs(doc, values, signedIn(rec)).filter((f) => f.signOff?.backup && !rec[f.id]?.backupAskedAt && backupOpen(f, rec, e.createdAt, now));
    for (const f of due) rec[f.id] = { ...rec[f.id], backupAskedAt: now.toISOString() };
    // Claimed first, and only if nobody signed it meanwhile, so an overlapping run doesn't ask twice.
    const claimed = await prisma.formEntry.updateMany({
      where: { id: e.id, signOffs: e.signOffs },
      data: { signOffs: JSON.stringify(rec), signOffBackupAt: nextBackupAt(doc, values, rec, e.createdAt) },
    });
    if (!claimed.count || !due.length) continue;
    await askBackups(form, e, due, rec, now);
    sent++;
  }
  return sent;
}

let timer: NodeJS.Timeout | null = null;

export function startSignOffReminders() {
  if (timer) return;
  const tick = () => void runSignOffReminders().catch((err) => console.error("[sign-off] reminders failed:", err));
  timer = setInterval(tick, 15 * 60_000);
  timer.unref();
  setTimeout(tick, 90_000).unref();
}
