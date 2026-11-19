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
 * form marks the question `signOff: { by, fields?, whatToDo? }`
 * (forms/engine.ts): whoever fills the form in never sees it; once the entry is
 * filed, the people `by` names (routing's kinds of people, at the entry's site)
 * are asked to sign it on the entry, and reminded every few days until they do.
 * `fields` are other questions the signer fills in as they sign (a license
 * number, the date). The signature is kept as the question's answer, so it
 * shows, prints and exports like any other; who signed and when is kept beside
 * it (FormEntry.signOffs). A question's own rule still decides whether an entry
 * needs it (the Psychosocial's licensed reviewer only signs some).
 *
 * Nobody signs off their own entry. Admins may sign any other one.
 */

const DAY = 86_400_000;
/** Most entries reminded about per run. */
const BATCH = 100;
/** Remind the signers this many days after filing, and again as often, at most MAX_REMINDERS times. */
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
}

export function parseSigned(raw: string | null | undefined): Record<string, Signed> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Signed>) : {};
  } catch {
    return {};
  }
}

export const hasSignOffs = (doc: Pick<FormDoc, "fields">) => doc.fields.some((f) => f.type === "signature" && f.signOff);

/** The sign-offs an entry needs: each one whose own rule (and its section's and page's) passes for the entry's answers. */
export function neededSignOffs(doc: Pick<FormDoc, "fields">, values: Values): Field[] {
  if (!hasSignOffs(doc)) return [];
  const vis = visibleFieldIds(doc, values, { includeAdminOnly: true, includeSignOff: true });
  return doc.fields.filter((f) => f.type === "signature" && f.signOff && vis.has(f.id));
}

/** The ones still to sign. */
export function waitingSignOffs(doc: Pick<FormDoc, "fields">, entry: Pick<FormEntry, "data" | "signOffs">): Field[] {
  const signed = parseSigned(entry.signOffs);
  return neededSignOffs(doc, JSON.parse(entry.data) as Values).filter((f) => !signed[f.id]);
}

const asRoute = (by: Recipient[]): Route => ({ id: "sign-off", name: "Sign-off", event: ENTRY_CREATED, enabled: true, to: by, email: "always", urgent: false });

async function siteOf(siteId: string | null) {
  return siteId ? prisma.site.findUnique({ where: { id: siteId }, select: { id: true, code: true, name: true } }) : null;
}

/** The people who may sign this sign-off on this entry (at its site), whoever filed it left out. */
export async function signersOf(form: BuiltForm, field: Field, entry: Pick<FormEntry, "id" | "data" | "siteId" | "createdById">) {
  if (!field.signOff?.by.length) return [];
  const values = JSON.parse(entry.data) as Values;
  const [plan] = await planRoutes(form, [asRoute(field.signOff.by as Recipient[])], {
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

/** Whether this person is asked to sign any sign-off the entry still needs, so they may open it to sign. */
export async function isSignerOn(form: BuiltForm, doc: FormDoc, entry: Pick<FormEntry, "id" | "data" | "siteId" | "createdById" | "signOffs">, userId: string): Promise<boolean> {
  for (const f of waitingSignOffs(doc, entry)) if ((await signersOf(form, f, entry)).some((p) => p.id === userId)) return true;
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

/** Each sign-off this entry needs, signed or not, and whether this person can sign it. */
export async function signOffView(form: BuiltForm, doc: FormDoc, entry: FormEntry, user: CurrentUser | null | undefined): Promise<SignOffView[]> {
  const needed = neededSignOffs(doc, JSON.parse(entry.data) as Values);
  if (!needed.length) return [];
  const signed = parseSigned(entry.signOffs);
  const byId = new Map(doc.fields.map((f) => [f.id, f]));
  return Promise.all(
    needed.map(async (f) => {
      const done = signed[f.id] ?? null;
      const why = done ? null : cantSign(user, entry);
      const allowed = !done && !why && (isFormAdmin(user) || (await signersOf(form, f, entry)).some((p) => p.id === user!.userId));
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
        cantSignWhy: !done && why && user && entry.createdById === user.userId ? why : null,
      } satisfies SignOffView;
    })
  );
}

/** Ask the people each needed sign-off names to sign it. */
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

/**
 * A new entry: when it needs any sign-off, it waits for them and the signers
 * are asked. Never throws: saving the entry matters more.
 */
export async function openSignOffs(form: BuiltForm, doc: FormDoc, entry: FormEntry) {
  try {
    if (form.kind === "code" || !hasSignOffs(doc)) return;
    const needed = neededSignOffs(doc, JSON.parse(entry.data) as Values);
    if (!needed.length) return;
    const waiting = await prisma.formEntry.update({ where: { id: entry.id }, data: { signOff: "waiting" } });
    // Asked after the response: working out who signs shouldn't hold up filing.
    void askToSign(form, waiting, needed, null).catch((err) => console.error(`[sign-off] couldn't ask about ${entry.id}:`, err));
  } catch (err) {
    console.error(`[sign-off] couldn't open ${form.slug}/${entry.id}:`, err);
  }
}

/**
 * Sign one sign-off on an entry: the signature, and the answers to the
 * questions its signer fills in. When it was the last one, whoever filed the
 * entry is told it's signed off.
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
  if (!neededSignOffs(doc, values).some((f) => f.id === field.id)) throw badRequest("This entry doesn't need that signature.");
  const signed = parseSigned(entry.signOffs);
  if (signed[field.id]) throw badRequest(`Already signed by ${signed[field.id].byName}.`);
  const why = cantSign(user, entry);
  if (why) throw forbidden(why);
  if (!isFormAdmin(user) && !(await signersOf(form, field, entry)).some((p) => p.id === user.userId)) {
    throw forbidden(`Only ${await describeSigners(field.signOff!.by as Recipient[])} can sign this.`);
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

  const nowSigned: Record<string, Signed> = { ...signed, [field.id]: { byId: user.userId, byName: user.name, at: new Date().toISOString() } };
  const left = neededSignOffs(doc, next).filter((f) => !nowSigned[f.id]);
  // Only if nobody signed it in the meantime.
  const saved = await prisma.formEntry.updateMany({
    where: { id: entry.id, status: "active", signOffs: entry.signOffs },
    data: { data: JSON.stringify(next), signOffs: JSON.stringify(nowSigned), signOff: left.length ? "waiting" : "done" },
  });
  if (!saved.count) throw new HttpError(409, "Someone else signed this entry just now. Open it again to see what changed.");

  const extras = [...own]
    .filter((id) => !isEmptyValue(next[id]))
    .map((id) => `${doc.fields.find((f) => f.id === id)?.label ?? id}: ${String(next[id])}`);
  await prisma.formEntryNote.create({
    data: { entryId: entry.id, kind: "system", authorName: "System", body: `Signed off: “${field.label || field.id}”, by ${user.name}${extras.length ? ` (${extras.join("; ")})` : ""}.`.slice(0, 2000) },
  });

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
  return (await prisma.formEntry.findUnique({ where: { id: entry.id } }))!;
}

/** An Admin's edit keeps the sign-offs as they were: they change only by signing. */
export function keepSignOffAnswers(doc: Pick<FormDoc, "fields">, before: Values, after: Values) {
  for (const id of signOffFieldIds(doc)) {
    if (before[id] === undefined) delete after[id];
    else after[id] = before[id];
  }
}

// ── Reminders ────────────────────────────────────────────────────────────

/** Remind the signers of entries still waiting, every REMIND_AFTER_DAYS, up to MAX_REMINDERS times. */
export async function runSignOffReminders(now = new Date()): Promise<number> {
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
    const waiting = waitingSignOffs(await docForEntry(form, e.formVersion), e);
    if (!waiting.length) continue;
    const days = Math.max(1, Math.floor((now.getTime() - e.createdAt.getTime()) / DAY));
    await askToSign(form, e, waiting, { n: e.signOffReminders + 1, days });
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
