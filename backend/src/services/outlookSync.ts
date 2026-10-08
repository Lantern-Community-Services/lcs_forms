import crypto from "node:crypto";
import { prisma } from "../prisma.js";
import { appBaseUrl } from "../env.js";
import { roleFor } from "./permissions.js";
import { NoGraphToken, graphAccessTokenFor, graphTokensEnabled, useTokensForTests, withGraphToken } from "./graphTokens.js";
import { addDays, toGraphRecurrence, type Recurrence } from "../calendar/recurrence.js";

/**
 * The calendar in people's own Outlook.
 *
 * Everyone who asked for an event's sites in the calendar's "Add to my Outlook"
 * popup (User.calendarSyncEverySite, CalendarFollow) gets it in their own
 * calendar, in the way they chose there:
 *   - as an invite: they're an attendee of a meeting in the organizer's
 *     calendar, and Exchange emails them the invite;
 *   - or quietly: a copy is written straight into their own calendar
 *     (CalendarCopy), no email, with their reminder and free/busy choices.
 *
 * The app has no Outlook access of its own. Everything is written with one
 * person's own delegated Microsoft sign-in (Calendars.ReadWrite, kept by
 * services/graphTokens.ts), into that person's own calendar:
 *   - The organizer is whoever last changed the event when its meeting is first
 *     sent (or who made it). The meeting lives in their calendar and stays
 *     there; later changes are written with their sign-in.
 *   - A quiet copy is written with its owner's sign-in. Someone with no sign-in
 *     to use (never signed in with Microsoft, or signed out) is invited instead;
 *     a copy they already have stays, and catches up when they sign in again.
 *   - When a meeting's organizer has signed out, the next person to change the
 *     event sends a new one, and the old one is cancelled when the organizer
 *     signs in again (CalendarOutlookTrash).
 * Every item the app makes carries an open extension (EXTENSION), and nothing
 * without it is ever changed or deleted: the app only touches its own events.
 *
 * Invites and copies carry a link to the event here, and the Teams link,
 * nothing else: no description, no form contents. This app stays the place
 * events are made and changed; Outlook only hears about it (one way).
 *
 * Writes mark the event `outlookDirty`; a queue in this process sends it a few
 * seconds later (long enough for an Undo to cancel itself out), retries what
 * failed every few minutes, and re-checks every upcoming event's invite list a
 * few times a day, since people's sites change. One backend instance only: two
 * would send the same event twice.
 */

const GRAPH = "https://graph.microsoft.com/v1.0";
const TZ = "Eastern Standard Time";
/** The open extension on every event the app writes (Graph openTypeExtension). */
export const EXTENSION = "org.lanterncommunity.forms";
const EXTENSION_ID = `Microsoft.OutlookServices.OpenTypeExtension.${EXTENSION}`;
/** After a change, wait this long before sending, so quick edits and an Undo go as one. */
const SETTLE_MS = 15_000;
const RETRY_MS = 5 * 60_000;
const RECHECK_MS = 6 * 60 * 60_000;

export const outlookConfigured = () => graphTokensEnabled();

// ── Talking to Graph (swappable for scripts that test without a tenant) ───

let graphFetch: typeof fetch = (input, init) => fetch(input, init);
let forceConfigured = false;
/** Test scripts: a fake Graph, and who has a sign-in (a token, or null for none). */
export function useGraphForTests(f: typeof fetch, tokens: (userId: string) => Promise<string | null> = async () => "test-token") {
  graphFetch = f;
  useTokensForTests(tokens);
  forceConfigured = true;
}
const configured = () => forceConfigured || outlookConfigured();

class GraphError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Graph, as this person, on their own mailbox (/me). Throws NoGraphToken if they have no sign-in to use. */
async function graph<T = any>(userId: string, method: string, path: string, body?: unknown): Promise<T | null> {
  const token = await graphAccessTokenFor(userId);
  const res = await graphFetch(`${GRAPH}/me${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: `outlook.timezone="${TZ}"` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 204 || res.status === 202) return null;
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      message = JSON.parse(text)?.error?.message ?? message;
    } catch {}
    throw new GraphError(res.status, `Outlook answered ${res.status}: ${message}`);
  }
  return text ? (JSON.parse(text) as T) : null;
}

const item = (outlookId: string) => `/events/${encodeURIComponent(outlookId)}`;

/** The tag every event the app writes carries, added when it's made. */
const tagFor = (eventId: string) => ({
  extensions: [{ "@odata.type": "microsoft.graph.openTypeExtension", extensionName: EXTENSION, app: "Lantern Forms", calendarEventId: eventId }],
});

/**
 * Is this item in the person's calendar one the app made? "gone" when it isn't
 * there any more (deleted in Outlook). Anything without the app's extension is
 * "notOurs", and is left alone.
 */
async function ownership(userId: string, outlookId: string): Promise<"ours" | "gone" | "notOurs"> {
  try {
    const found = await graph<{ extensions?: { id: string }[] }>(
      userId,
      "GET",
      `${item(outlookId)}?$select=id&$expand=${encodeURIComponent(`extensions($filter=id eq '${EXTENSION_ID}')`)}`
    );
    return found?.extensions?.length ? "ours" : "notOurs";
  } catch (e) {
    if (e instanceof GraphError && e.status === 404) return "gone";
    throw e;
  }
}

// ── Who gets it, and how ─────────────────────────────────────────────────

/** Someone who asked for an event in Outlook, with how they want it to arrive. */
export interface Recipient {
  userId: string;
  name: string;
  email: string;
  emailTeams: boolean;
  emailOther: boolean;
  reminderMinutes: number | null;
  allDayFree: boolean;
}

/**
 * Everyone who asked for this event in Outlook and may still see it: an
 * every-site event goes to those who ticked "Events for every site"; a site
 * event to those who ticked one of its sites and are still at it.
 */
export async function recipientsFor(ev: { allSites: boolean; categoryId: string | null; sites: { siteId: string }[] }): Promise<Recipient[]> {
  const siteIds = ev.sites.map((s) => s.siteId);
  const people = await prisma.user.findMany({
    where: {
      status: "active",
      calendarSyncSetAt: { not: null },
      ...(ev.allSites ? { calendarSyncEverySite: true } : { calendarFollows: { some: { siteId: { in: siteIds } } } }),
      // Not a category they left out.
      ...(ev.categoryId ? { calendarMutes: { none: { categoryId: ev.categoryId } } } : { calendarSkipUncategorized: false }),
    },
    select: {
      id: true, name: true, email: true, roleKey: true, sites: { select: { siteId: true } },
      calendarEmailTeams: true, calendarEmailOther: true, calendarReminderMinutes: true, calendarAllDayFree: true,
    },
    orderBy: { email: "asc" },
  });
  return people
    .filter((p) => ev.allSites || roleFor(p.roleKey).allSites || p.sites.some((s) => siteIds.includes(s.siteId)))
    .map((p) => ({
      userId: p.id, name: p.name, email: p.email,
      emailTeams: p.calendarEmailTeams, emailOther: p.calendarEmailOther,
      reminderMinutes: p.calendarReminderMinutes, allDayFree: p.calendarAllDayFree,
    }));
}

async function nameOf(userId: string | null | undefined): Promise<string> {
  if (!userId) return "Nobody";
  return (await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? "Someone who's left";
}

// ── What Outlook is sent ─────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const at = (date: string, time: string | null) => ({ dateTime: `${date}T${time ?? "00:00"}:00`, timeZone: TZ });
const sha1 = (v: unknown) => crypto.createHash("sha1").update(JSON.stringify(v)).digest("hex");

type SyncRow = NonNullable<Awaited<ReturnType<typeof loadRow>>>;
function loadRow(id: string) {
  return prisma.calendarEvent.findUnique({
    where: { id },
    include: {
      exceptions: { orderBy: { originalDate: "asc" } },
      category: { select: { name: true } },
      sites: { select: { siteId: true } },
    },
  });
}

/**
 * The body of an invite or a copy: a link to the event in Lantern Forms (and
 * the Teams link on a copy). Nothing else: what it's about stays in the app,
 * behind sign-in.
 */
function bodyHtml(ev: { startDate: string }, joinUrl?: string | null) {
  const link = `${appBaseUrl}/calendar?view=day&date=${ev.startDate}`;
  return [
    joinUrl ? `<p><a href="${esc(joinUrl)}"><strong>Join the Teams meeting</strong></a></p>` : "",
    `<p><a href="${esc(link)}">Open it in Lantern Forms</a> for the details.</p>`,
    `<p style="color:#6b7280">From the Lantern Forms calendar. Changes made in Outlook aren't kept; change it in Lantern Forms.</p>`,
  ].join("");
}

function timesOf(w: { allDay: boolean; startDate: string; startTime: string | null; endDate: string; endTime: string | null }) {
  return w.allDay
    ? { isAllDay: true, start: at(w.startDate, null), end: at(addDays(w.endDate, 1), null) }
    : { isAllDay: false, start: at(w.startDate, w.startTime), end: at(w.endDate, w.endTime) };
}

// ── Sending one event ────────────────────────────────────────────────────

const done = (id: string, data: Record<string, unknown>) =>
  prisma.calendarEvent.update({ where: { id }, data: { outlookDirty: false, outlookSyncedAt: new Date(), ...data } });

const saveCopy = (eventId: string, userId: string, data: { mailbox: string; outlookEventId?: string | null; hash?: string | null; fallbackInvite?: boolean; error?: string | null }) =>
  prisma.calendarCopy.upsert({ where: { eventId_userId: { eventId, userId } }, create: { eventId, userId, ...data }, update: data });

/** For later, with its owner's sign-in: cancel a meeting, or delete a quiet copy. */
const toTrash = (ownerId: string, meeting: boolean, outlookEventId: string, title: string) =>
  prisma.calendarOutlookTrash.create({ data: { ownerId, meeting, outlookEventId, title } });

/** A mailbox that isn't in this organization (a partner account): Graph has nowhere to write. */
const noMailbox = (e: unknown) => e instanceof GraphError && (e.status === 404 || /MailboxNotEnabled|InvalidUser|not found/i.test(e.message));

/**
 * Bring one event in line with Outlook. People who want it as an invite are
 * attendees of the organizer's meeting (Exchange sends them the email);
 * everyone else gets a quiet copy written into their own calendar (no email).
 * A Teams event always has the meeting, even with no invitees, because the
 * Teams link comes from it; the quiet copies carry that link.
 * Throws on a Graph failure (the event stays dirty and is tried again).
 */
export async function syncEvent(id: string): Promise<void> {
  const ev = await loadRow(id);
  if (!ev) return;
  const copies = await prisma.calendarCopy.findMany({ where: { eventId: id } });

  let recurrence = null;
  if (ev.recurrence) {
    const mapped = toGraphRecurrence(ev.startDate, JSON.parse(ev.recurrence) as Recurrence);
    if (!mapped.ok) {
      // Can't go to Outlook as it is: take back anything sent before, and say why.
      if (ev.outlookEventId && ev.outlookOrganizerId) await toTrash(ev.outlookOrganizerId, true, ev.outlookEventId, ev.title);
      for (const c of copies) if (c.outlookEventId) await toTrash(c.userId, false, c.outlookEventId, ev.title);
      await prisma.calendarCopy.deleteMany({ where: { eventId: id } });
      await done(id, { outlookEventId: null, outlookOrganizerId: null, teamsJoinUrl: null, outlookHash: null, outlookError: `Not in Outlook: ${mapped.reason}` });
      kick(1_000);
      return;
    }
    recurrence = mapped.value;
  }

  // Waiting on approval: nobody gets it yet, which also takes back anything sent before.
  const people = ev.pending ? [] : await recipientsFor(ev);
  // Who could send it: the last person to change it, then whoever made it.
  const senders = [ev.updatedById, ev.createdById].filter((x): x is string => Boolean(x));
  const holders = await withGraphToken([...people.map((p) => p.userId), ...senders, ...(ev.outlookOrganizerId ? [ev.outlookOrganizerId] : [])]);

  // The organizer: whoever's calendar already holds the meeting.
  let outlookId = ev.outlookEventId;
  let joinUrl = ev.teamsJoinUrl;
  let organizerId = outlookId ? ev.outlookOrganizerId : null;
  let stuck = false;
  if (outlookId && (!organizerId || !holders.has(organizerId))) {
    // They've signed out (or left): their meeting can't be reached. The next
    // sender takes over with a new one; theirs is cancelled when they're back.
    const next = senders.find((s) => s !== organizerId && holders.has(s));
    if (next) {
      if (organizerId) await toTrash(organizerId, true, outlookId, ev.title);
      outlookId = null;
      joinUrl = null;
      organizerId = next;
      await prisma.calendarEvent.update({ where: { id }, data: { outlookEventId: null, outlookOrganizerId: null, teamsJoinUrl: null, outlookHash: null } });
    } else {
      stuck = true;
    }
  }
  if (!outlookId) organizerId = senders.find((s) => holders.has(s)) ?? null;

  const fallback = new Set(copies.filter((c) => c.fallbackInvite).map((c) => c.userId));
  const hasCopy = new Set(copies.filter((c) => c.outlookEventId).map((c) => c.userId));
  const prefersQuiet = (p: Recipient) => !fallback.has(p.userId) && !(ev.teamsMeeting ? p.emailTeams : p.emailOther);
  // A quiet copy needs its owner's own sign-in. Without one they're invited,
  // unless they already have a copy: it stays, so nobody gets the event twice.
  const others = people.filter((p) => p.userId !== organizerId);
  const quiet = others.filter((p) => prefersQuiet(p) && (holders.has(p.userId) || hasCopy.has(p.userId)));
  const invitees = others.filter((p) => !quiet.includes(p));
  const me = organizerId ? people.find((p) => p.userId === organizerId) : undefined;
  const needMeeting = invitees.length > 0 || (ev.teamsMeeting && (quiet.length > 0 || Boolean(me)));
  // The organizer's own calendar holds the meeting when there is one; otherwise they get a quiet copy like anyone else.
  if (me && !needMeeting) quiet.push(me);

  const meeting = {
    subject: ev.title,
    ...timesOf(ev),
    location: { displayName: ev.location ?? "" },
    recurrence,
    attendees: invitees.map((a) => ({ type: "required", emailAddress: { address: a.email, name: a.name } })),
    // Hundreds of yes/no replies in the organizer's inbox help nobody.
    responseRequested: false,
    allowNewTimeProposals: false,
    showAs: ev.allDay ? "free" : "busy",
    ...(ev.teamsMeeting ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
  };
  const body = { contentType: "HTML", content: bodyHtml(ev) };
  const exceptions = ev.exceptions.map((x) => ({ d: x.originalDate, c: x.cancelled, t: x.title, l: x.location, s: [x.allDay, x.startDate, x.startTime, x.endDate, x.endTime] }));
  // Whether each quiet person can be written to is in it, so a copy waiting on
  // its owner's sign-in catches up once they're back.
  const quietKey = quiet.map((p) => [p.userId, p.email, p.reminderMinutes, p.allDayFree, holders.has(p.userId)]);
  // Two fingerprints, kept as "meeting|everything": every re-send of the meeting
  // emails its invitees an "updated" notice, so it's re-sent only when the
  // meeting itself changed, not when a quiet copy did.
  // The Teams link isn't in either: it comes back from Outlook, it isn't sent.
  const meetingHash = needMeeting ? sha1({ organizerId, meeting, body, exceptions }) : "none";
  const hash = `${meetingHash}|${sha1({ meetingHash, quietKey, fallback: [...fallback], category: ev.category?.name, exceptions, body })}`;
  const [sentMeetingHash] = (ev.outlookHash ?? "").split("|");

  // Unchanged: nothing to send. One still missing the Teams link it asked for is
  // sent again, but only once the organizer can host Teams meetings; before
  // that, a re-send would only mail attendees a pointless "updated" notice.
  if (!stuck && hash === ev.outlookHash && (outlookId || !needMeeting)) {
    const retryTeams = needMeeting && ev.teamsMeeting && !joinUrl;
    if (!retryTeams) {
      await done(id, { outlookError: null });
      return;
    }
    if (!(await teamsAvailable(organizerId!))) {
      await done(id, { outlookError: await teamsMissing(organizerId) });
      return;
    }
  }

  // 1. The meeting, for invitees (and for the Teams link).
  const problems: string[] = [];
  type Created = { id: string; onlineMeeting?: { joinUrl?: string } | null };
  const retryTeams = ev.teamsMeeting && !joinUrl;
  if (needMeeting && stuck) {
    problems.push(`It was sent from ${await nameOf(organizerId)}'s Outlook, and they've signed out of Lantern Forms, so changes can't reach it. They can sign in again, or anyone who can edit the event can save it to send it from their own Outlook.`);
  } else if (needMeeting && !organizerId) {
    const who = senders.length ? await nameOf(senders[0]) : "Whoever changes it next";
    problems.push(`Not sent: invites go out from the Outlook of the person who changed the event, and ${who} hasn't signed in to Lantern Forms with Microsoft (or has signed out).`);
  } else if (needMeeting && outlookId && meetingHash === sentMeetingHash && !retryTeams) {
    // The meeting is as sent: leave it (and its invitees' inboxes) alone.
  } else if (needMeeting) {
    const sender = organizerId!;
    const create = async () => {
      const made = await graph<Created>(sender, "POST", "/events", { ...meeting, body, ...tagFor(id) });
      return { id: made!.id, joinUrl: made!.onlineMeeting?.joinUrl ?? null };
    };
    if (outlookId && (await ownership(sender, outlookId)) !== "ours") outlookId = null; // deleted in Outlook: send it afresh
    if (!outlookId) {
      ({ id: outlookId, joinUrl } = await create());
    } else {
      try {
        // A Teams meeting's body holds its join details, which a new body would wipe out.
        const updated = await graph<Created>(sender, "PATCH", item(outlookId), joinUrl || ev.teamsMeeting ? meeting : { ...meeting, body });
        joinUrl = updated?.onlineMeeting?.joinUrl ?? joinUrl;
      } catch (e) {
        if (!(e instanceof GraphError && e.status === 404)) throw e;
        ({ id: outlookId, joinUrl } = await create());
      }
    }
    // Save the id before the day-by-day changes, so a failure there can't send a second meeting.
    await prisma.calendarEvent.update({ where: { id }, data: { outlookEventId: outlookId, outlookOrganizerId: sender, teamsJoinUrl: joinUrl } });
    if (recurrence) await applyExceptions(sender, outlookId!, ev, true);
  } else if (outlookId) {
    // Nobody wants the invite any more: call the meeting off (later, if the organizer has signed out).
    if (!stuck && organizerId) await cancelMeeting(organizerId, outlookId);
    else if (organizerId) await toTrash(organizerId, true, outlookId, ev.title);
    outlookId = null;
    joinUrl = null;
    await prisma.calendarEvent.update({ where: { id }, data: { outlookEventId: null, outlookOrganizerId: null, teamsJoinUrl: null } });
  }

  // 2. Quiet copies, straight into each person's own calendar, with their own sign-in.
  let newFallback = false;
  let waiting = 0;
  for (const p of quiet) {
    const row = copies.find((c) => c.userId === p.userId);
    if (!holders.has(p.userId)) {
      // They've signed out: their copy stays as it is until they sign in again.
      waiting++;
      if (row && !row.error) await saveCopy(id, p.userId, { mailbox: row.mailbox, error: "Waiting for them to sign in to Lantern Forms again." });
      continue;
    }
    const copy = {
      subject: ev.title,
      ...timesOf(ev),
      location: { displayName: ev.location ?? "" },
      recurrence,
      body: { contentType: "HTML", content: bodyHtml(ev, joinUrl) },
      isReminderOn: p.reminderMinutes !== null,
      reminderMinutesBeforeStart: p.reminderMinutes ?? 0,
      showAs: ev.allDay && p.allDayFree ? "free" : "busy",
      // The category's name. Its color would need access to their Outlook
      // settings, which the app doesn't ask for: Outlook colors it if they
      // have a category of that name.
      categories: ev.category ? [ev.category.name] : [],
    };
    const copyHash = sha1({ copy, exceptions });
    if (row?.outlookEventId && row.hash === copyHash && !row.error) continue;
    try {
      let copyId = row?.outlookEventId ?? null;
      if (copyId && (await ownership(p.userId, copyId)) !== "ours") copyId = null; // they deleted their copy: write it again
      if (copyId) {
        try {
          await graph(p.userId, "PATCH", item(copyId), copy);
        } catch (e) {
          if (!(e instanceof GraphError && e.status === 404)) throw e;
          copyId = null;
        }
      }
      if (!copyId) copyId = (await graph<{ id: string }>(p.userId, "POST", "/events", { ...copy, ...tagFor(id) }))!.id;
      await saveCopy(id, p.userId, { mailbox: p.email, outlookEventId: copyId, hash: null, error: null, fallbackInvite: false });
      if (recurrence) await applyExceptions(p.userId, copyId, ev, false);
      await saveCopy(id, p.userId, { mailbox: p.email, hash: copyHash });
    } catch (e) {
      if (e instanceof NoGraphToken) {
        // Microsoft stopped honouring their sign-in just now: like signed out.
        waiting++;
        continue;
      }
      if (!row?.outlookEventId && noMailbox(e)) {
        // No mailbox here to write into (a partner account): they get the invite instead.
        await saveCopy(id, p.userId, { mailbox: p.email, outlookEventId: null, fallbackInvite: true, error: "No mailbox in this organization; sent as an invite." });
        newFallback = true;
        continue;
      }
      const message = e instanceof Error ? e.message : String(e);
      problems.push(`${p.email}: ${message}`);
      await saveCopy(id, p.userId, { mailbox: p.email, error: message });
    }
  }

  // 3. Quiet copies nobody should have any more (stopped following, now invited, left).
  const quietIds = new Set(quiet.map((p) => p.userId));
  const peopleIds = new Set(people.map((p) => p.userId));
  for (const c of copies) {
    if (quietIds.has(c.userId)) continue;
    if (c.fallbackInvite && peopleIds.has(c.userId)) continue; // keeps the "invite instead" note
    if (c.outlookEventId) {
      if (holders.has(c.userId)) await deleteItem(c.userId, c.outlookEventId);
      else await toTrash(c.userId, false, c.outlookEventId, ev.title);
    }
    await prisma.calendarCopy.delete({ where: { id: c.id } });
  }

  if (newFallback) {
    // Someone turned out to have no mailbox here: go round again so they're invited.
    await prisma.calendarEvent.update({ where: { id }, data: { outlookDirty: true, outlookHash: null } });
    kick(1_000);
    return;
  }
  if (problems.length) {
    await done(id, { outlookError: problems.length === 1 ? problems[0] : `${problems.length} problems. First: ${problems[0]}`, outlookHash: null });
    return;
  }
  if (needMeeting && ev.teamsMeeting && !joinUrl) {
    // Exchange takes the request and quietly leaves the Teams link off when the
    // organizer can't host Teams meetings. Say so, and leave no hash, so the next
    // re-check (or "send now") asks again once Teams works for that account.
    await done(id, { outlookError: await teamsMissing(organizerId), outlookHash: null });
    return;
  }
  // Copies waiting on someone's sign-in aren't a fault; the hash notes who could be written to.
  await done(id, { outlookError: null, outlookHash: hash });
  if (waiting) console.log(`[outlook] event ${id}: ${waiting} quiet ${waiting === 1 ? "copy waits" : "copies wait"} for their owner to sign in again.`);
}

async function teamsMissing(organizerId: string | null) {
  return `In Outlook, but without a Teams link: ${await nameOf(organizerId)}, whose Outlook sent it, can't host Teams meetings (Teams not in their license, or the Outlook add-in is off in their Teams meeting policy). It's tried again automatically.`;
}

const teamsChecks = new Map<string, { at: number; ok: boolean }>();
/** Can this organizer host Teams meetings now? Asked at most every 10 minutes per person. */
async function teamsAvailable(userId: string): Promise<boolean> {
  const check = teamsChecks.get(userId);
  if (check && Date.now() - check.at < 10 * 60_000) return check.ok;
  const ok = ((await meetingProvidersFor(userId)) ?? []).includes("teamsForBusiness");
  teamsChecks.set(userId, { at: Date.now(), ok });
  return ok;
}

/** Whether someone's calendar can host Teams meetings at all, as Exchange sees it. */
export async function meetingProvidersFor(userId: string): Promise<string[] | null> {
  if (!configured()) return null;
  const cal = await graph<{ allowedOnlineMeetingProviders?: string[] }>(userId, "GET", "/calendar?$select=allowedOnlineMeetingProviders");
  return cal?.allowedOnlineMeetingProviders ?? [];
}

/** Single days changed or cancelled here, on their Outlook occurrence (in the meeting, or a quiet copy). */
async function applyExceptions(userId: string, outlookId: string, ev: SyncRow, isMeeting: boolean) {
  for (const x of ev.exceptions) {
    const window = `startDateTime=${addDays(x.originalDate, -1)}T00:00:00&endDateTime=${addDays(x.originalDate, 2)}T00:00:00`;
    // Occurrences of a series the app made (the series was checked as the app's own just before).
    const list = await graph<{ value: { id: string; originalStart?: string }[] }>(userId, "GET", `${item(outlookId)}/instances?${window}`);
    const instance = list?.value.find((i) => i.originalStart && nyDay(i.originalStart) === x.originalDate);
    if (!instance) continue; // already cancelled, or not in Outlook's series
    if (x.cancelled) {
      if (isMeeting) await cancelMeeting(userId, instance.id, true);
      else await deleteItem(userId, instance.id, true);
      continue;
    }
    const moved = x.startDate && x.endDate;
    await graph(userId, "PATCH", item(instance.id), {
      ...(x.title !== null ? { subject: x.title } : {}),
      ...(x.location !== null ? { location: { displayName: x.location } } : {}),
      ...(moved ? timesOf({ allDay: Boolean(x.allDay), startDate: x.startDate!, startTime: x.startTime, endDate: x.endDate!, endTime: x.endTime }) : {}),
    });
  }
}

const nyFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const nyDay = (iso: string) => nyFormat.format(new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`));

/**
 * Call off a meeting (or one occurrence of the app's own series): attendees get
 * a cancellation. One with nobody invited is just deleted. Only ever one the
 * app made; one that's gone already is fine.
 */
async function cancelMeeting(userId: string, outlookId: string, occurrenceOfOurs = false) {
  if (!occurrenceOfOurs && (await ownership(userId, outlookId)) !== "ours") return;
  try {
    await graph(userId, "POST", `${item(outlookId)}/cancel`, { comment: "Removed from the Lantern Forms calendar." });
  } catch (e) {
    if (e instanceof GraphError && e.status === 404) return;
    if (e instanceof GraphError && e.status === 400) return deleteItem(userId, outlookId, true);
    throw e;
  }
}

/** Delete an item from someone's own calendar (a quiet copy, or one of its days). Only the app's own; already gone is fine. */
async function deleteItem(userId: string, outlookId: string, checked = false) {
  if (!checked && (await ownership(userId, outlookId)) !== "ours") return;
  try {
    await graph(userId, "DELETE", item(outlookId));
  } catch (e) {
    if (!(e instanceof GraphError && e.status === 404)) throw e;
  }
}

// ── The queue ────────────────────────────────────────────────────────────

/** An event was saved: send it to Outlook shortly. Called by services/calendar.ts. */
export async function noteCalendarChange(ids: string[]) {
  if (ids.length) await prisma.calendarEvent.updateMany({ where: { id: { in: ids } }, data: { outlookDirty: true } });
  kick();
}

/** An event is about to be deleted here: cancel its meeting and remove the quiet copies, later, with their owners' sign-ins. */
export async function queueOutlookCancel(ev: { id: string; outlookEventId: string | null; outlookOrganizerId: string | null; title: string }) {
  if (ev.outlookEventId && ev.outlookOrganizerId) await toTrash(ev.outlookOrganizerId, true, ev.outlookEventId, ev.title);
  const copies = await prisma.calendarCopy.findMany({ where: { eventId: ev.id, outlookEventId: { not: null } } });
  if (copies.length) await prisma.calendarOutlookTrash.createMany({ data: copies.map((c) => ({ ownerId: c.userId, meeting: false, outlookEventId: c.outlookEventId!, title: ev.title })) });
  kick();
}

/** Who wants what changed (the popup, a person's sites): every upcoming event's invite list is checked again. */
export async function markUpcomingDirty() {
  const yesterday = addDays(new Date().toISOString().slice(0, 10), -1);
  await prisma.calendarEvent.updateMany({ where: { OR: [{ lastDate: null }, { lastDate: { gte: yesterday } }] }, data: { outlookDirty: true } });
  kick();
}

/**
 * Someone signed in with Microsoft and the app has a sign-in for them it didn't
 * have before: what was waiting on them (their copies, meetings sent from their
 * Outlook, cancellations) can go now.
 */
export async function noteGraphTokenArrived(userId: string, isNew: boolean) {
  if (!configured()) return;
  if (isNew) await markUpcomingDirty();
  else kick();
  void userId;
}

let timer: NodeJS.Timeout | null = null;
let running: Promise<void> | null = null;

function kick(delay = SETTLE_MS) {
  if (!configured()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runQueue();
  }, delay);
}

/** Send everything waiting, one at a time. Safe to call while it's already going. */
export async function runQueue(): Promise<{ sent: number; failed: number; waiting: number }> {
  if (!configured()) return { sent: 0, failed: 0, waiting: 0 };
  while (running) await running;
  let sent = 0;
  let failed = 0;
  let waiting = 0;
  running = (async () => {
    const trash = await prisma.calendarOutlookTrash.findMany({ orderBy: { createdAt: "asc" } });
    const owners = await withGraphToken(trash.map((t) => t.ownerId));
    for (const t of trash) {
      if (!owners.has(t.ownerId)) {
        // Only its owner's own sign-in can remove it.
        waiting++;
        if (!t.error) await prisma.calendarOutlookTrash.update({ where: { id: t.id }, data: { error: `Waiting for ${await nameOf(t.ownerId)} to sign in to Lantern Forms again.` } });
        continue;
      }
      try {
        if (t.meeting) await cancelMeeting(t.ownerId, t.outlookEventId);
        else await deleteItem(t.ownerId, t.outlookEventId);
        await prisma.calendarOutlookTrash.delete({ where: { id: t.id } });
      } catch (e) {
        failed++;
        await prisma.calendarOutlookTrash.update({ where: { id: t.id }, data: { error: e instanceof Error ? e.message : String(e) } });
      }
    }
    const dirty = await prisma.calendarEvent.findMany({ where: { outlookDirty: true }, select: { id: true }, orderBy: { updatedAt: "asc" } });
    for (const { id } of dirty) {
      try {
        await syncEvent(id);
        sent++;
      } catch (e) {
        failed++;
        const message = e instanceof NoGraphToken ? `${await nameOf(e.userId)} ${e.message}. It's tried again.` : e instanceof Error ? e.message : String(e);
        console.error(`[outlook] event ${id}: ${message}`);
        await prisma.calendarEvent.update({ where: { id }, data: { outlookError: message } }).catch(() => {});
      }
    }
  })();
  try {
    await running;
  } finally {
    running = null;
  }
  return { sent, failed, waiting };
}

/** On boot: send what's waiting, retry failures every few minutes, re-check invite lists a few times a day. */
export function startOutlookSync() {
  if (!outlookConfigured()) return false;
  kick(5_000);
  setInterval(() => void runQueue(), RETRY_MS).unref();
  setInterval(() => void markUpcomingDirty(), RECHECK_MS).unref();
  return true;
}
