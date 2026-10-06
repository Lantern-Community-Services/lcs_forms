import crypto from "node:crypto";
import { prisma } from "../prisma.js";
import { appBaseUrl, env } from "../env.js";
import { graphToken } from "./mailer.js";
import { roleFor } from "./permissions.js";
import { addDays, toGraphRecurrence, type Recurrence } from "../calendar/recurrence.js";

/**
 * The calendar in people's own Outlook.
 *
 * Everyone who asked for an event's sites in the calendar's "Add to my Outlook"
 * popup (User.calendarSyncEverySite, CalendarFollow) gets it in their own
 * calendar, in the way they chose there:
 *   - as an invite: they're an attendee of a meeting organized by the "Lantern
 *     Calendar" mailbox (CALENDAR_ORGANIZER), which emails them;
 *   - or quietly: a copy is written straight into their calendar (CalendarCopy),
 *     no email, with their reminder and free/busy choices.
 * By default Teams meetings come as invites and everything else quietly. A
 * Teams event always has the organizer's meeting, since that's where the Teams
 * link comes from; quiet copies carry the link. This app stays the place
 * events are made and changed: Outlook only hears about it (one way).
 *
 * Writes mark the event `outlookDirty`; a queue in this process sends it a few
 * seconds later (long enough for an Undo to cancel itself out), retries what
 * failed every few minutes, and re-checks every upcoming event's invite list a
 * few times a day, since people's sites change.
 *
 * Needs Calendars.ReadWrite for the app in Exchange (RBAC for Applications),
 * on the organizer and the staff mailboxes: backend/scripts/setup-outlook-calendar.ps1.
 * See README "Calendar in Outlook".
 */

const GRAPH = "https://graph.microsoft.com/v1.0";
const TZ = "Eastern Standard Time";
/** After a change, wait this long before sending, so quick edits and an Undo go as one. */
const SETTLE_MS = 15_000;
const RETRY_MS = 5 * 60_000;
const RECHECK_MS = 6 * 60 * 60_000;

export const outlookConfigured = () =>
  Boolean(env.calendarOrganizer && env.microsoft.tenantId && env.microsoft.clientId && env.microsoft.clientSecret);

// ── Talking to Graph (swappable for scripts that test without a tenant) ───

let graphFetch: typeof fetch = (input, init) => fetch(input, init);
let tokenFor: () => Promise<string> = graphToken;
let forceConfigured = false;
export function useGraphForTests(f: typeof fetch, token = async () => "test-token") {
  graphFetch = f;
  tokenFor = token;
  forceConfigured = true;
}
const configured = () => forceConfigured || outlookConfigured();

class GraphError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function graph<T = any>(method: string, path: string, body?: unknown): Promise<T | null> {
  const res = await graphFetch(`${GRAPH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await tokenFor()}`, "Content-Type": "application/json", Prefer: `outlook.timezone="${TZ}"` },
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

const userPath = (email: string) => `/users/${encodeURIComponent(email)}`;
const mailbox = () => userPath(env.calendarOrganizer || "calendar@test");

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
  const organizer = env.calendarOrganizer.toLowerCase();
  return people
    .filter((p) => ev.allSites || roleFor(p.roleKey).allSites || p.sites.some((s) => siteIds.includes(s.siteId)))
    .filter((p) => p.email.toLowerCase() !== organizer)
    .map((p) => ({
      userId: p.id, name: p.name, email: p.email,
      emailTeams: p.calendarEmailTeams, emailOther: p.calendarEmailOther,
      reminderMinutes: p.calendarReminderMinutes, allDayFree: p.calendarAllDayFree,
    }));
}

// ── What Outlook is sent ─────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const at = (date: string, time: string | null) => ({ dateTime: `${date}T${time ?? "00:00"}:00`, timeZone: TZ });
const sha1 = (v: unknown) => crypto.createHash("sha1").update(JSON.stringify(v)).digest("hex");

type SyncRow = NonNullable<Awaited<ReturnType<typeof loadRow>>>;
function loadRow(id: string) {
  return prisma.calendarEvent.findUnique({
    where: { id },
    include: {
      sites: { include: { site: { select: { name: true } } } },
      exceptions: { orderBy: { originalDate: "asc" } },
      category: { select: { name: true, colorSlot: true } },
    },
  });
}

function bodyHtml(ev: { description: string | null; allSites: boolean; startDate: string }, siteNames: string[], joinUrl?: string | null) {
  const link = `${appBaseUrl}/calendar?view=day&date=${ev.startDate}`;
  return [
    joinUrl ? `<p><a href="${esc(joinUrl)}"><strong>Join the Teams meeting</strong></a></p>` : "",
    ev.description ? `<p>${esc(ev.description).replace(/\n/g, "<br>")}</p>` : "",
    `<p style="color:#6b7280">For ${ev.allSites ? "every site" : esc(siteNames.join(", "))}. From the Lantern Forms calendar: <a href="${link}">open it there</a>. Changes made in Outlook aren't kept; change it in Lantern Forms.</p>`,
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

/** A mailbox that isn't in this organization (a partner account): Graph has nowhere to write. */
const noMailbox = (e: unknown) => e instanceof GraphError && (e.status === 404 || /MailboxNotEnabled|InvalidUser|not found/i.test(e.message));

/**
 * Bring one event in line with Outlook. People who want it as an invite are
 * attendees of Lantern Calendar's meeting (which sends them an email); everyone
 * else gets a quiet copy written straight into their own calendar (no email).
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
      if (ev.outlookEventId) await cancelMeeting(mailbox(), ev.outlookEventId);
      for (const c of copies) if (c.outlookEventId) await deleteItem(c.mailbox, c.outlookEventId);
      await prisma.calendarCopy.deleteMany({ where: { eventId: id } });
      await done(id, { outlookEventId: null, teamsJoinUrl: null, outlookHash: null, outlookError: `Not in Outlook: ${mapped.reason}` });
      return;
    }
    recurrence = mapped.value;
  }

  const people = await recipientsFor(ev);
  const fallback = new Set(copies.filter((c) => c.fallbackInvite).map((c) => c.userId));
  const wantsInvite = (p: Recipient) => fallback.has(p.userId) || (ev.teamsMeeting ? p.emailTeams : p.emailOther);
  const invitees = people.filter(wantsInvite);
  const quiet = people.filter((p) => !wantsInvite(p));
  const needMeeting = invitees.length > 0 || (ev.teamsMeeting && quiet.length > 0);

  const siteNames = ev.sites.map((s) => s.site.name).sort();
  const meeting = {
    subject: ev.title,
    ...timesOf(ev),
    location: { displayName: ev.location ?? "" },
    recurrence,
    attendees: invitees.map((a) => ({ type: "required", emailAddress: { address: a.email, name: a.name } })),
    // Hundreds of yes/no replies to the Lantern Calendar mailbox help nobody.
    responseRequested: false,
    allowNewTimeProposals: false,
    showAs: ev.allDay ? "free" : "busy",
    ...(ev.teamsMeeting ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
  };
  const body = { contentType: "HTML", content: bodyHtml(ev, siteNames) };
  const exceptions = ev.exceptions.map((x) => ({ d: x.originalDate, c: x.cancelled, t: x.title, l: x.location, s: [x.allDay, x.startDate, x.startTime, x.endDate, x.endTime] }));
  const quietKey = quiet.map((p) => [p.userId, p.email, p.reminderMinutes, p.allDayFree]);
  // Two fingerprints, kept as "meeting|everything": every re-send of the meeting
  // emails its invitees an "updated" notice, so it's re-sent only when the
  // meeting itself changed, not when a quiet copy or a category color did.
  // The Teams link isn't in either: it comes back from Outlook, it isn't sent.
  const meetingHash = needMeeting ? sha1({ meeting, body, exceptions }) : "none";
  const hash = `${meetingHash}|${sha1({ meetingHash, quietKey, fallback: [...fallback], category: ev.category, exceptions, body })}`;
  const [sentMeetingHash] = (ev.outlookHash ?? "").split("|");

  // Unchanged: nothing to send. One still missing the Teams link it asked for is
  // sent again, but only once the organizer can host Teams meetings; before
  // that, a re-send would only mail attendees a pointless "updated" notice.
  if (hash === ev.outlookHash && (ev.outlookEventId || !needMeeting)) {
    const retryTeams = needMeeting && ev.teamsMeeting && !ev.teamsJoinUrl;
    if (!retryTeams) {
      await done(id, { outlookError: null });
      return;
    }
    if (!(await teamsAvailable())) {
      await done(id, { outlookError: TEAMS_MISSING });
      return;
    }
  }

  // 1. The meeting, for invitees (and for the Teams link).
  let outlookId = ev.outlookEventId;
  let joinUrl = ev.teamsJoinUrl;
  type Created = { id: string; onlineMeeting?: { joinUrl?: string } | null };
  const retryTeams = ev.teamsMeeting && !ev.teamsJoinUrl;
  if (needMeeting && outlookId && meetingHash === sentMeetingHash && !retryTeams) {
    // The meeting is as sent: leave it (and its invitees' inboxes) alone.
  } else if (needMeeting) {
    const create = async () => {
      const made = await graph<Created>("POST", `${mailbox()}/events`, { ...meeting, body });
      return { id: made!.id, joinUrl: made!.onlineMeeting?.joinUrl ?? null };
    };
    if (!outlookId) {
      ({ id: outlookId, joinUrl } = await create());
    } else {
      try {
        // A Teams meeting's body holds its join details, which a new body would wipe out.
        const updated = await graph<Created>("PATCH", `${mailbox()}/events/${outlookId}`, ev.teamsJoinUrl || ev.teamsMeeting ? meeting : { ...meeting, body });
        joinUrl = updated?.onlineMeeting?.joinUrl ?? joinUrl;
      } catch (e) {
        // Deleted in Outlook by someone: send it afresh.
        if (!(e instanceof GraphError && e.status === 404)) throw e;
        ({ id: outlookId, joinUrl } = await create());
      }
    }
    // Save the id before the day-by-day changes, so a failure there can't send a second meeting.
    await prisma.calendarEvent.update({ where: { id }, data: { outlookEventId: outlookId, teamsJoinUrl: joinUrl } });
    if (recurrence) await applyExceptions(mailbox(), outlookId!, ev, true);
  } else if (outlookId) {
    // Nobody wants the invite any more: call the meeting off.
    await cancelMeeting(mailbox(), outlookId);
    outlookId = null;
    joinUrl = null;
    await prisma.calendarEvent.update({ where: { id }, data: { outlookEventId: null, teamsJoinUrl: null } });
  }

  // 2. Quiet copies, straight into each person's calendar.
  const problems: string[] = [];
  let newFallback = false;
  for (const p of quiet) {
    const row = copies.find((c) => c.userId === p.userId);
    const copy = {
      subject: ev.title,
      ...timesOf(ev),
      location: { displayName: ev.location ?? "" },
      recurrence,
      body: { contentType: "HTML", content: bodyHtml(ev, siteNames, joinUrl) },
      isReminderOn: p.reminderMinutes !== null,
      reminderMinutesBeforeStart: p.reminderMinutes ?? 0,
      showAs: ev.allDay && p.allDayFree ? "free" : "busy",
      // The event's category, with its color, in their own Outlook (set up for them; see ensureCategory).
      categories: ev.category ? [ev.category.name] : [],
    };
    const copyHash = sha1({ copy, exceptions, color: ev.category?.colorSlot });
    if (row?.outlookEventId && row.mailbox === p.email && row.hash === copyHash) continue;
    try {
      // Their address changed: the old copy goes, a new one is written.
      if (row?.outlookEventId && row.mailbox !== p.email) await deleteItem(row.mailbox, row.outlookEventId).catch(() => {});
      let copyId = row?.mailbox === p.email ? row.outlookEventId : null;
      if (copyId) {
        try {
          await graph("PATCH", `${userPath(p.email)}/events/${copyId}`, copy);
        } catch (e) {
          if (!(e instanceof GraphError && e.status === 404)) throw e;
          copyId = null; // they deleted their copy: write it again
        }
      }
      if (ev.category) await ensureCategory(p.email, ev.category.name, ev.category.colorSlot);
      if (!copyId) copyId = (await graph<{ id: string }>("POST", `${userPath(p.email)}/events`, copy))!.id;
      await saveCopy(id, p.userId, { mailbox: p.email, outlookEventId: copyId, hash: null, error: null, fallbackInvite: false });
      if (recurrence) await applyExceptions(userPath(p.email), copyId, ev, false);
      await saveCopy(id, p.userId, { mailbox: p.email, hash: copyHash });
    } catch (e) {
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
    if (c.outlookEventId) await deleteItem(c.mailbox, c.outlookEventId);
    await prisma.calendarCopy.delete({ where: { id: c.id } });
  }

  if (newFallback) {
    // Someone turned out to have no mailbox here: go round again so they're invited.
    await prisma.calendarEvent.update({ where: { id }, data: { outlookDirty: true, outlookHash: null } });
    kick(1_000);
    return;
  }
  if (problems.length) {
    const access = problems.some((m) => /\b403\b/.test(m))
      ? " The app may not have access to staff calendars yet: run backend/scripts/setup-outlook-calendar.ps1 again."
      : "";
    await done(id, { outlookError: `Couldn't add it to ${problems.length} ${problems.length === 1 ? "person's" : "people's"} calendars.${access} First: ${problems[0]}`, outlookHash: null });
    return;
  }
  if (needMeeting && ev.teamsMeeting && !joinUrl) {
    // Exchange takes the request and quietly leaves the Teams link off when the
    // organizer can't host Teams meetings. Say so, and leave no hash, so the next
    // re-check (or "send now") asks again once Teams works for that account.
    await done(id, { outlookError: TEAMS_MISSING, outlookHash: null });
    return;
  }
  await done(id, { outlookError: null, outlookHash: hash });
}

export const TEAMS_MISSING =
  "In Outlook, but without a Teams link: the Lantern Calendar account can't host Teams meetings yet (Teams not in its license, still being set up, or the Outlook add-in is off in its Teams meeting policy). It's tried again automatically.";

let teamsCheck: { at: number; ok: boolean } | null = null;
/** Can the organizer host Teams meetings now? Asked at most every 10 minutes. */
async function teamsAvailable(): Promise<boolean> {
  if (teamsCheck && Date.now() - teamsCheck.at < 10 * 60_000) return teamsCheck.ok;
  const ok = ((await organizerMeetingProviders()) ?? []).includes("teamsForBusiness");
  teamsCheck = { at: Date.now(), ok };
  return ok;
}

/** Whether the organizer mailbox can host Teams meetings at all, as Exchange sees it. */
export async function organizerMeetingProviders(): Promise<string[] | null> {
  if (!configured()) return null;
  const cal = await graph<{ allowedOnlineMeetingProviders?: string[] }>("GET", `${mailbox()}/calendar?$select=allowedOnlineMeetingProviders`);
  return cal?.allowedOnlineMeetingProviders ?? [];
}

// ── Outlook categories ───────────────────────────────────────────────────

/**
 * The calendar's eight colors (index.css --viz-1…8) as Outlook's nearest
 * preset colors: blue, orange, green, amber, pink, dark green, purple, red.
 */
const OUTLOOK_COLORS = ["preset7", "preset1", "preset5", "preset3", "preset9", "preset4", "preset8", "preset0"];

/** Per mailbox: its Outlook categories (name → id and color), read at most hourly. */
const masterCache = new Map<string, { at: number; byName: Map<string, { id: string; color: string }> | null }>();

/**
 * Make sure someone's Outlook has this category, in the calendar's color, so
 * their copy shows up colored with nothing set up on their end. Needs the
 * app's MailboxSettings.ReadWrite in Exchange; without it the copy still gets
 * the category's name, just without a color, and nothing fails.
 */
async function ensureCategory(email: string, name: string, colorSlot: number) {
  const color = OUTLOOK_COLORS[colorSlot] ?? "preset12";
  const key = email.toLowerCase();
  let entry = masterCache.get(key);
  if (!entry || Date.now() - entry.at > 60 * 60_000) {
    try {
      const list = await graph<{ value: { id: string; displayName: string; color: string }[] }>("GET", `${userPath(email)}/outlook/masterCategories`);
      entry = { at: Date.now(), byName: new Map((list?.value ?? []).map((c) => [c.displayName.toLowerCase(), { id: c.id, color: c.color }])) };
    } catch {
      entry = { at: Date.now(), byName: null }; // no access yet: try again in an hour
    }
    masterCache.set(key, entry);
  }
  if (!entry.byName) return;
  const have = entry.byName.get(name.toLowerCase());
  try {
    if (!have) {
      const made = await graph<{ id: string }>("POST", `${userPath(email)}/outlook/masterCategories`, { displayName: name, color });
      entry.byName.set(name.toLowerCase(), { id: made?.id ?? "", color });
    } else if (have.color !== color && have.id) {
      // Recolored here: follow it.
      await graph("PATCH", `${userPath(email)}/outlook/masterCategories/${have.id}`, { color });
      have.color = color;
    }
  } catch (e) {
    if (e instanceof GraphError && e.status === 409) entry.at = 0; // made meanwhile: re-read next time
    else console.error(`[outlook] category "${name}" for ${email}: ${e instanceof Error ? e.message : e}`);
  }
}

/** Single days changed or cancelled here, on their Outlook occurrence (in the meeting, or a quiet copy). */
async function applyExceptions(base: string, outlookId: string, ev: SyncRow, isMeeting: boolean) {
  for (const x of ev.exceptions) {
    const window = `startDateTime=${addDays(x.originalDate, -1)}T00:00:00&endDateTime=${addDays(x.originalDate, 2)}T00:00:00`;
    const list = await graph<{ value: { id: string; originalStart?: string }[] }>("GET", `${base}/events/${outlookId}/instances?${window}`);
    const instance = list?.value.find((i) => i.originalStart && nyDay(i.originalStart) === x.originalDate);
    if (!instance) continue; // already cancelled, or not in Outlook's series
    if (x.cancelled) {
      if (isMeeting) await cancelMeeting(base, instance.id);
      else await deleteItem(null, instance.id, base);
      continue;
    }
    const moved = x.startDate && x.endDate;
    await graph("PATCH", `${base}/events/${instance.id}`, {
      ...(x.title !== null ? { subject: x.title } : {}),
      ...(x.location !== null ? { location: { displayName: x.location } } : {}),
      ...(moved ? timesOf({ allDay: Boolean(x.allDay), startDate: x.startDate!, startTime: x.startTime, endDate: x.endDate!, endTime: x.endTime }) : {}),
    });
  }
}

const nyFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const nyDay = (iso: string) => nyFormat.format(new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`));

/** Call off a meeting (or one occurrence): attendees get a cancellation. One with nobody invited is just deleted. */
async function cancelMeeting(base: string, outlookId: string) {
  try {
    await graph("POST", `${base}/events/${outlookId}/cancel`, { comment: "Removed from the Lantern Forms calendar." });
  } catch (e) {
    if (e instanceof GraphError && e.status === 404) return;
    if (e instanceof GraphError && e.status === 400) return deleteItem(null, outlookId, base);
    throw e;
  }
}

/** Delete an item from someone's calendar (a quiet copy, or one of its days). Already gone is fine. */
async function deleteItem(email: string | null, outlookId: string, base = userPath(email ?? "")) {
  try {
    await graph("DELETE", `${base}/events/${outlookId}`);
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

/** An event is about to be deleted here: cancel its meeting and remove the quiet copies, later. */
export async function queueOutlookCancel(ev: { id: string; outlookEventId: string | null; title: string }) {
  if (ev.outlookEventId) await prisma.calendarOutlookTrash.create({ data: { outlookEventId: ev.outlookEventId, title: ev.title } });
  const copies = await prisma.calendarCopy.findMany({ where: { eventId: ev.id, outlookEventId: { not: null } } });
  if (copies.length) await prisma.calendarOutlookTrash.createMany({ data: copies.map((c) => ({ mailbox: c.mailbox, outlookEventId: c.outlookEventId!, title: ev.title })) });
  kick();
}

/** Who wants what changed (the popup, a person's sites): every upcoming event's invite list is checked again. */
export async function markUpcomingDirty() {
  const yesterday = addDays(new Date().toISOString().slice(0, 10), -1);
  await prisma.calendarEvent.updateMany({ where: { OR: [{ lastDate: null }, { lastDate: { gte: yesterday } }] }, data: { outlookDirty: true } });
  kick();
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
export async function runQueue(): Promise<{ sent: number; failed: number }> {
  if (!configured()) return { sent: 0, failed: 0 };
  while (running) await running;
  let sent = 0;
  let failed = 0;
  running = (async () => {
    for (const t of await prisma.calendarOutlookTrash.findMany({ orderBy: { createdAt: "asc" } })) {
      try {
        if (t.mailbox) await deleteItem(t.mailbox, t.outlookEventId);
        else await cancelMeeting(mailbox(), t.outlookEventId);
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
        const message = e instanceof Error ? e.message : String(e);
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
  return { sent, failed };
}

/** On boot: send what's waiting, retry failures every few minutes, re-check invite lists a few times a day. */
export function startOutlookSync() {
  if (!outlookConfigured()) return false;
  kick(5_000);
  setInterval(() => void runQueue(), RETRY_MS).unref();
  setInterval(() => void markUpcomingDirty(), RECHECK_MS).unref();
  return true;
}
