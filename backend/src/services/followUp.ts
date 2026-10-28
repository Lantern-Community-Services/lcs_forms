import { z } from "zod";
import type { BuiltForm, FormEntry } from "@prisma/client";
import { prisma } from "../prisma.js";
import { badRequest, forbidden } from "../http.js";
import type { CurrentUser } from "../auth/middleware.js";
import { ENTRY_CREATED, recipientSchema, type Route } from "../forms/routingSchema.js";
import { checkRoutes, planRoutes } from "./routing.js";
import { notify } from "./notifications.js";
import { FOLLOW_UP_DONE_TEMPLATE, REMINDER_TEMPLATE, messageTags, messageWording, templateByKey } from "./emailTemplates.js";
import { audit, type Actor } from "./audit.js";

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

const COLLECTION = "followup";
const DOC = "settings";
const DAY = 86_400_000;
/** Most entries reminded about per form per run. */
const BATCH = 100;

export const followUpSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Who it's for: they can mark it done, and are reminded. Same recipient kinds as a route. */
    doers: z.array(recipientSchema).max(50).default([]),
    /** Remind them this many days after it was filed, and again every as many days; null: never. */
    remindAfterDays: z.number().int().min(1).max(60).nullable().default(3),
    /** Stop after this many reminders. */
    maxReminders: z.number().int().min(1).max(10).default(3),
    /** Tell whoever filed it when it's done. */
    tellSubmitter: z.boolean().default(true),
    /** Shown in the reminder email: what's expected. */
    whatToDo: z.string().trim().max(500).optional(),
  })
  .strict();
export type FollowUpSettings = z.infer<typeof followUpSchema>;

const DEFAULTS: FollowUpSettings = { enabled: false, doers: [], remindAfterDays: 3, maxReminders: 3, tellSubmitter: true };

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
  if (p.data.doers.length) await checkRoutes(form, [asRoute(p.data)]);
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

/** Mark an entry done (with what was done), or open it again. Tells whoever filed it when it's done. */
export async function setFollowUp(form: BuiltForm, entry: FormEntry, actor: { userId: string | null; name: string }, input: { done: boolean; note?: string | null }) {
  if (!entry.followUp) throw badRequest("This entry isn't tracked for follow-up. Turn follow-up on for the form; it applies to entries saved after that.");
  const note = input.note?.trim().slice(0, 2000) || null;
  if (input.done && entry.followUp === "done") throw badRequest(`Already done, by ${entry.followUpDoneByName ?? "someone"}.`);
  if (!input.done && entry.followUp === "open") throw badRequest("It's already open.");

  const updated = await prisma.formEntry.update({
    where: { id: entry.id },
    data: input.done
      ? { followUp: "done", followUpDoneAt: new Date(), followUpDoneByName: actor.name.slice(0, 255), followUpNote: note }
      : { followUp: "open", followUpDoneAt: null, followUpDoneByName: null, followUpNote: null, followUpRemindedAt: null, followUpReminders: 0 },
  });
  await prisma.formEntryNote.create({
    data: {
      entryId: entry.id,
      kind: "system",
      authorName: "System",
      body: (input.done ? `Follow-up marked done by ${actor.name}${note ? `: ${note}` : "."}` : `Follow-up reopened by ${actor.name}${note ? `: ${note}` : "."}`).slice(0, 2000),
    },
  });

  const s = await loadFollowUp(form);
  if (input.done && s.tellSubmitter && entry.createdById && entry.createdById !== actor.userId) {
    const site = await siteOf(entry.siteId);
    // Worded by the "Follow-up done" template (Admin → Notifications → Templates).
    const fallback = `Done: ${form.title}${site ? ` at ${site.name}` : ""}`;
    const t = await templateByKey(FOLLOW_UP_DONE_TEMPLATE);
    const w = t ? messageWording(t, messageTags({ form: form.title, title: fallback, site: site?.name }), fallback) : null;
    await notify({
      to: { users: [entry.createdById] },
      type: "forms.entry",
      title: w?.subject ?? fallback,
      body: note ? `${actor.name}: ${note}` : `${actor.name} marked it done.`,
      link: entryPath(form, entry.id),
      source: `form:${form.slug}`,
      sourceLabel: form.title,
      formId: form.id,
      forceEmail: true,
      urgent: w?.urgent,
      email: {
        whatToDo: w?.whatToDo ?? null,
        heading: w?.heading,
        intro: w?.intro,
        buttonLabel: w?.buttonLabel,
        fields: [{ label: "Done by", value: actor.name }, ...(note ? [{ label: "What was done", value: note }] : [])],
      },
    }).catch((err) => console.error(`[follow-up] couldn't tell the submitter of ${entry.id}:`, err));
  }
  return updated;
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
        forceEmail: true,
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
