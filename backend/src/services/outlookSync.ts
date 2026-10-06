import crypto from "node:crypto";
import { prisma } from "../prisma.js";
import { appBaseUrl, env } from "../env.js";
import { graphToken } from "./mailer.js";
import { roleFor } from "./permissions.js";
import { addDays, toGraphRecurrence, type Recurrence } from "../calendar/recurrence.js";

/**
 * The calendar in people's own Outlook.
 *
 * Every event is a meeting organized by the "Lantern Calendar" mailbox
 * (CALENDAR_ORGANIZER), with an invite to everyone who asked for that event's
 * sites in the calendar's "Add to my Outlook" popup (User.calendarSyncEverySite,
 * CalendarFollow). Outlook puts it in each of their calendars; a Teams link is
 * added when the event asks for one. This app stays the place events are made
 * and changed: Outlook only hears about it (one way).
 *
 * Writes mark the event `outlookDirty`; a queue in this process sends it a few
 * seconds later (long enough for an Undo to cancel itself out), retries what
 * failed every few minutes, and re-checks every upcoming event's invite list a
 * few times a day, since people's sites change.
 *
 * Needs, in Entra: the app's Calendars.ReadWrite *application* permission with
 * admin consent, fenced to the organizer mailbox in Exchange. See README
 * "Calendar in Outlook".
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

const mailbox = () => `/users/${encodeURIComponent(env.calendarOrganizer || "calendar@test")}`;

// ── Who gets the invite ──────────────────────────────────────────────────

/**
 * Everyone who asked for this event in Outlook and may still see it: an
 * every-site event goes to those who ticked "Events for every site"; a site
 * event to those who ticked one of its sites and are still at it.
 */
export async function attendeesFor(ev: { allSites: boolean; sites: { siteId: string }[] }) {
  const siteIds = ev.sites.map((s) => s.siteId);
  const people = await prisma.user.findMany({
    where: {
      status: "active",
      calendarSyncSetAt: { not: null },
      ...(ev.allSites ? { calendarSyncEverySite: true } : { calendarFollows: { some: { siteId: { in: siteIds } } } }),
    },
    select: { name: true, email: true, roleKey: true, sites: { select: { siteId: true } } },
    orderBy: { email: "asc" },
  });
  const organizer = env.calendarOrganizer.toLowerCase();
  return people
    .filter((p) => ev.allSites || roleFor(p.roleKey).allSites || p.sites.some((s) => siteIds.includes(s.siteId)))
    .filter((p) => p.email.toLowerCase() !== organizer)
    .map((p) => ({ name: p.name, email: p.email }));
}

// ── What Outlook is sent ─────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const at = (date: string, time: string | null) => ({ dateTime: `${date}T${time ?? "00:00"}:00`, timeZone: TZ });

type SyncRow = NonNullable<Awaited<ReturnType<typeof loadRow>>>;
function loadRow(id: string) {
  return prisma.calendarEvent.findUnique({
    where: { id },
    include: { sites: { include: { site: { select: { name: true } } } }, exceptions: { orderBy: { originalDate: "asc" } } },
  });
}

function bodyHtml(ev: { description: string | null; allSites: boolean; startDate: string }, siteNames: string[]) {
  const link = `${appBaseUrl}/calendar?view=day&date=${ev.startDate}`;
  return [
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

/** Bring one event's Outlook meeting in line with it. Throws on a Graph failure (the event stays dirty). */
export async function syncEvent(id: string): Promise<void> {
  const ev = await loadRow(id);
  if (!ev) return;
  let recurrence = null;
  if (ev.recurrence) {
    const mapped = toGraphRecurrence(ev.startDate, JSON.parse(ev.recurrence) as Recurrence);
    if (!mapped.ok) {
      // Can't go to Outlook as it is: take back any meeting sent before, and say why.
      if (ev.outlookEventId) await cancelMeeting(ev.outlookEventId);
      await done(id, { outlookEventId: null, outlookHash: null, outlookError: `Not in Outlook: ${mapped.reason}` });
      return;
    }
    recurrence = mapped.value;
  }

  const attendees = await attendeesFor(ev);
  if (attendees.length === 0 && !ev.outlookEventId) {
    await done(id, { outlookError: null, outlookHash: null });
    return;
  }

  const siteNames = ev.sites.map((s) => s.site.name).sort();
  const meeting = {
    subject: ev.title,
    ...timesOf(ev),
    location: { displayName: ev.location ?? "" },
    recurrence,
    attendees: attendees.map((a) => ({ type: "required", emailAddress: { address: a.email, name: a.name } })),
    // Hundreds of yes/no replies to the Lantern Calendar mailbox help nobody.
    responseRequested: false,
    allowNewTimeProposals: false,
    ...(ev.teamsMeeting ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
  };
  const body = { contentType: "HTML", content: bodyHtml(ev, siteNames) };
  const exceptions = ev.exceptions.map((x) => ({ d: x.originalDate, c: x.cancelled, t: x.title, l: x.location, s: [x.allDay, x.startDate, x.startTime, x.endDate, x.endTime] }));
  const hash = crypto.createHash("sha1").update(JSON.stringify({ meeting, body, exceptions })).digest("hex");
  // Unchanged: nothing to send. One still missing the Teams link it asked for is
  // sent again, but only once the organizer can host Teams meetings; before
  // that, a re-send would only mail attendees a pointless "updated" notice.
  if (ev.outlookEventId && hash === ev.outlookHash) {
    const retryTeams = ev.teamsMeeting && !ev.teamsJoinUrl;
    if (!retryTeams) {
      await done(id, { outlookError: null });
      return;
    }
    if (!(await teamsAvailable())) {
      await done(id, { outlookError: TEAMS_MISSING });
      return;
    }
  }

  let outlookId = ev.outlookEventId;
  let joinUrl = ev.teamsJoinUrl;
  type Created = { id: string; onlineMeeting?: { joinUrl?: string } | null };
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
  if (recurrence) await applyExceptions(outlookId!, ev);
  if (ev.teamsMeeting && !joinUrl) {
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

/** Single days changed or cancelled here, on their Outlook occurrence. */
async function applyExceptions(outlookId: string, ev: SyncRow) {
  for (const x of ev.exceptions) {
    const window = `startDateTime=${addDays(x.originalDate, -1)}T00:00:00&endDateTime=${addDays(x.originalDate, 2)}T00:00:00`;
    const list = await graph<{ value: { id: string; originalStart?: string }[] }>("GET", `${mailbox()}/events/${outlookId}/instances?${window}`);
    const instance = list?.value.find((i) => i.originalStart && nyDay(i.originalStart) === x.originalDate);
    if (!instance) continue; // already cancelled, or not in Outlook's series
    if (x.cancelled) {
      await cancelMeeting(instance.id);
      continue;
    }
    const moved = x.startDate && x.endDate;
    await graph("PATCH", `${mailbox()}/events/${instance.id}`, {
      ...(x.title !== null ? { subject: x.title } : {}),
      ...(x.location !== null ? { location: { displayName: x.location } } : {}),
      ...(moved ? timesOf({ allDay: Boolean(x.allDay), startDate: x.startDate!, startTime: x.startTime, endDate: x.endDate!, endTime: x.endTime }) : {}),
    });
  }
}

const nyFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const nyDay = (iso: string) => nyFormat.format(new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`));

/** Call off a meeting (or one occurrence): attendees get a cancellation. One with nobody invited is just deleted. */
async function cancelMeeting(outlookId: string) {
  try {
    await graph("POST", `${mailbox()}/events/${outlookId}/cancel`, { comment: "Removed from the Lantern Forms calendar." });
  } catch (e) {
    if (e instanceof GraphError && e.status === 404) return;
    if (e instanceof GraphError && e.status === 400) {
      try {
        await graph("DELETE", `${mailbox()}/events/${outlookId}`);
      } catch (d) {
        if (!(d instanceof GraphError && d.status === 404)) throw d;
      }
      return;
    }
    throw e;
  }
}

// ── The queue ────────────────────────────────────────────────────────────

/** An event was saved: send it to Outlook shortly. Called by services/calendar.ts. */
export async function noteCalendarChange(ids: string[]) {
  if (ids.length) await prisma.calendarEvent.updateMany({ where: { id: { in: ids } }, data: { outlookDirty: true } });
  kick();
}

/** An event with an Outlook meeting is about to be deleted here: cancel the meeting later. */
export async function queueOutlookCancel(ev: { outlookEventId: string | null; title: string }) {
  if (ev.outlookEventId) await prisma.calendarOutlookTrash.create({ data: { outlookEventId: ev.outlookEventId, title: ev.title } });
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
        await cancelMeeting(t.outlookEventId);
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
