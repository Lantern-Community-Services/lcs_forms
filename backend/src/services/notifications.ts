import type { Notification } from "@prisma/client";
import { prisma } from "../prisma.js";
import { appBaseUrl } from "../env.js";
import { linkOnlyHtml, mailConfigured, sendMail } from "./mailer.js";
import { PERMISSIONS, isRoleKey, permissionsFor, roleFor, type PermissionKey } from "./permissions.js";
import { partsOf, startOfDay, today } from "../apps/time.js";

/**
 * Notifications: one row per person (Notification), shown in the app — the
 * bell in the sidebar or dock, and /notifications — and emailed when the person
 * wants that kind by email.
 *
 * Everything that tells people something goes through notify():
 *   - the site's own events (an access request, an approved account, a queued
 *     entry another form couldn't save);
 *   - form builder rules of kind "notify" (forms/entries.ts);
 *   - code forms' ctx.notify.send (apps/notify.ts);
 *   - the MCP server's send_notification and POST /api/v1/notifications.
 *
 * What each person gets is theirs to choose on Profile → Notifications: per
 * kind (NOTIFICATION_TYPES), in the app and by email, plus a per-form switch
 * that can turn one form's off. Email comes as each one arrives, as one summary
 * a morning, or not at all (User.notifyEmailMode).
 *
 * Emails follow the site's link-only rule (services/mailer.ts): the subject is
 * the notification's title, then one line and a link. The body never leaves the
 * app. So a title must not carry resident details or answers; whoever writes
 * one (a form, server code, the MCP) is told so.
 *
 * Sent by a worker in this process (startNotificationMail), which claims each
 * row before sending, so two servers never email the same one twice.
 */

export interface NotificationType {
  label: string;
  description: string;
  /** Defaults for someone who hasn't chosen. */
  inApp: boolean;
  email: boolean;
  /** Shown on Profile only to people who can get it. */
  shownTo?: (p: PermissionKey[]) => boolean;
}

export const NOTIFICATION_TYPES = {
  "forms.message": {
    label: "Messages from forms",
    description: "What a form has to tell you: something waiting on your approval, a request that was answered, a reminder.",
    inApp: true,
    email: true,
  },
  "forms.entry": {
    label: "New form entries",
    description: "Someone filled in a form that sends you its new entries.",
    inApp: true,
    email: false,
  },
  "forms.problem": {
    label: "Problems with your entries",
    description: "Something a form tried to do for you didn't work, such as an entry it couldn't save in another form.",
    inApp: true,
    email: true,
  },
  "people.request": {
    label: "Access requests",
    description: "Someone signed in for the first time and is waiting to be let in.",
    inApp: true,
    email: true,
    shownTo: (p) => p.includes("users.manage"),
  },
  account: {
    label: "Your account",
    description: "Changes to your own access: approved, a new role, new sites.",
    inApp: true,
    email: true,
  },
  announcement: {
    label: "Announcements",
    description: "News from Lantern's admins, for everyone or for your role or site.",
    inApp: true,
    email: false,
  },
} satisfies Record<string, NotificationType>;

export type NotificationTypeKey = keyof typeof NOTIFICATION_TYPES;
export const isNotificationType = (k: unknown): k is NotificationTypeKey => typeof k === "string" && k in NOTIFICATION_TYPES;

export const EMAIL_MODES = ["instant", "daily", "off"] as const;
export type EmailMode = (typeof EMAIL_MODES)[number];

/** The New York hour the daily summary goes out at. */
export const DIGEST_HOUR = 7;
/** Notifications are kept this long, read or not. */
const KEEP_DAYS = 120;

/**
 * Who gets it. `users` are ids or email addresses of people with an account.
 * `roles` and `permissions` reach everyone holding one, and `sites` (ids or
 * codes) narrows those to people at one of the sites — people who work at every
 * site always count. `everyone` is every active person. People not active
 * (invited, waiting, deactivated) never get one.
 */
export interface Audience {
  users?: string[];
  roles?: string[];
  permissions?: string[];
  sites?: string[];
  everyone?: boolean;
}

export interface NotifyInput {
  to: Audience;
  type: NotificationTypeKey;
  title: string;
  body?: string | null;
  /** A page of this site: "/apps/x/request?id=…", or a full URL on this site. */
  link?: string | null;
  source?: string;
  sourceLabel?: string | null;
  formId?: string | null;
  /** Leave these people out (e.g. whoever caused it). */
  exclude?: string[];
  /** Refuse past this many people (callers outside the site's own code set one). */
  maxRecipients?: number;
  /** Only people at this site (or at every site): a site-pinned API key. */
  onlySiteId?: string | null;
}

export interface NotifyResult {
  /** Notifications made (one a person). */
  sent: number;
  /** People it was for, before their own preferences. */
  recipients: number;
  /** How many will be emailed (now or in a summary). */
  emailed: number;
  /** People who have turned this kind (or this form) off entirely. */
  muted: number;
  /** Addresses or ids in `users` that aren't an active person here. */
  unknown?: string[];
}

/** A link stored as a path of this site, or an error a caller can show. */
export function sitePath(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") throw new Error("link must be a page of this site, like \"/apps/my-form/request?id=…\".");
  const v = raw.trim();
  if (v.startsWith(appBaseUrl + "/")) return v.slice(appBaseUrl.length);
  if (v.startsWith("/") && !v.startsWith("//")) return v.slice(0, 2000);
  throw new Error(`link must be a page of this site (a path like "/apps/my-form/…"), not "${v.slice(0, 80)}".`);
}

const clean = (s: string, max: number) => s.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);

/** Active people the audience names, with what they need for delivery. */
export async function resolveAudience(to: Audience) {
  const select = { id: true, email: true, roleKey: true, calendarEditor: true, globalAdmin: true, notifyEmailMode: true, sites: { select: { siteId: true } } } as const;
  type Person = { id: string; email: string; roleKey: string; calendarEditor: boolean; globalAdmin: boolean; notifyEmailMode: string; sites: { siteId: string }[] };
  const found = new Map<string, Person>();
  const unknown: string[] = [];

  const named = [...new Set((to.users ?? []).map((u) => String(u).trim()).filter(Boolean))];
  if (named.length) {
    const emails = named.filter((u) => u.includes("@")).map((u) => u.toLowerCase());
    const ids = named.filter((u) => !u.includes("@"));
    const rows: Person[] = await prisma.user.findMany({ where: { status: "active", OR: [{ id: { in: ids } }, { email: { in: emails } }] }, select });
    for (const r of rows) found.set(r.id, r);
    const hit = new Set(rows.flatMap((r) => [r.id, r.email.toLowerCase()]));
    unknown.push(...named.filter((u) => !hit.has(u.includes("@") ? u.toLowerCase() : u)));
  }

  const roles = (to.roles ?? []).filter(Boolean);
  const perms = (to.permissions ?? []).filter(Boolean);
  const badRole = roles.find((r) => !isRoleKey(r));
  if (badRole) throw new Error(`"${badRole}" isn't a role. Roles: admin, developer, main_office, site_admin, site_manager, site_staff.`);
  const badPerm = perms.find((p) => !(PERMISSIONS as readonly string[]).includes(p));
  if (badPerm) throw new Error(`"${badPerm}" isn't a permission.`);

  if (to.everyone || roles.length || perms.length) {
    let siteIds: string[] | null = null;
    if (to.sites?.length) {
      const want = to.sites.map((s) => String(s).trim()).filter(Boolean);
      const sites = await prisma.site.findMany({ where: { OR: [{ id: { in: want } }, { code: { in: want } }] }, select: { id: true, code: true } });
      const missing = want.filter((w) => !sites.some((s) => s.id === w || s.code === w));
      if (missing.length) throw new Error(`No site ${missing.map((m) => `"${m}"`).join(", ")}.`);
      siteIds = sites.map((s) => s.id);
    }
    const people: Person[] = await prisma.user.findMany({ where: { status: "active" }, select });
    for (const p of people) {
      const role = roleFor(p.roleKey);
      const granted = permissionsFor(role, p);
      const fits = to.everyone || roles.includes(role.key) || perms.some((x) => granted.includes(x as PermissionKey));
      if (!fits) continue;
      // Everyone-site roles count at every site; others need one of the sites (none assigned = none).
      if (siteIds && !role.allSites && !p.sites.some((s) => siteIds!.includes(s.siteId))) continue;
      found.set(p.id, p);
    }
  }
  return { people: [...found.values()], unknown };
}

type Choice = { inApp: boolean; email: boolean };

/** The preference key for one kind of notification from one form. */
export const formPrefKey = (formId: string, type: string) => `form:${formId}:${type}`;

/**
 * What a person gets: their choice for this kind from this form if they made
 * one, else their choice for the kind, else the kind's default.
 */
function choose(type: NotificationTypeKey, prefs: Map<string, Choice>, formId: string | null | undefined): Choice {
  const def = NOTIFICATION_TYPES[type];
  const own = prefs.get(type) ?? { inApp: def.inApp, email: def.email };
  return (formId ? prefs.get(formPrefKey(formId, type)) : undefined) ?? own;
}

/** Tell people something. Returns once the rows are written; emails go after. */
export async function notify(input: NotifyInput): Promise<NotifyResult> {
  const title = clean(input.title ?? "", 200);
  if (!title) throw new Error("A notification needs a title.");
  if (!isNotificationType(input.type)) throw new Error(`Unknown notification type "${input.type}".`);
  const body = typeof input.body === "string" && input.body.trim() ? input.body.trim().slice(0, 4000) : null;
  const link = sitePath(input.link);

  const { people: all, unknown } = await resolveAudience(input.to);
  const exclude = new Set(input.exclude ?? []);
  const atSite = (p: (typeof all)[number]) => !input.onlySiteId || roleFor(p.roleKey).allSites || p.sites.some((s) => s.siteId === input.onlySiteId);
  const people = all.filter((p) => !exclude.has(p.id) && atSite(p));
  if (input.maxRecipients && people.length > input.maxRecipients) {
    throw new Error(`That would notify ${people.length} people; the most at once is ${input.maxRecipients}. Narrow it with roles or sites.`);
  }
  if (!people.length) return { sent: 0, recipients: 0, emailed: 0, muted: 0, ...(unknown.length ? { unknown } : {}) };

  const keys = [input.type, ...(input.formId ? [formPrefKey(input.formId, input.type)] : [])];
  const prefRows = await prisma.notificationPref.findMany({ where: { userId: { in: people.map((p) => p.id) }, key: { in: keys } } });
  const prefsBy = new Map<string, Map<string, Choice>>();
  for (const r of prefRows) {
    if (!prefsBy.has(r.userId)) prefsBy.set(r.userId, new Map());
    prefsBy.get(r.userId)!.set(r.key, { inApp: r.inApp, email: r.email });
  }

  const mail = mailConfigured();
  let muted = 0;
  let emailed = 0;
  const rows = [];
  for (const p of people) {
    const c = choose(input.type, prefsBy.get(p.id) ?? new Map(), input.formId);
    const mode = (EMAIL_MODES as readonly string[]).includes(p.notifyEmailMode) ? (p.notifyEmailMode as EmailMode) : "instant";
    const wantsEmail = c.email && mode !== "off";
    if (!c.inApp && !wantsEmail) {
      muted++;
      continue;
    }
    const emailStatus = !wantsEmail ? "none" : !mail ? "skipped" : mode === "daily" ? "digest" : "pending";
    if (emailStatus === "pending" || emailStatus === "digest") emailed++;
    rows.push({
      userId: p.id,
      type: input.type,
      title,
      body,
      link,
      source: clean(input.source ?? "system", 255) || "system",
      sourceLabel: input.sourceLabel ? clean(input.sourceLabel, 255) : null,
      formId: input.formId ?? null,
      inApp: c.inApp,
      emailStatus,
      emailError: emailStatus === "skipped" ? "Email isn't set up on this server (MAIL_FROM)." : null,
    });
  }
  // SQL Server takes at most 2,100 parameters a statement: ~13 columns, so 150 rows a go.
  for (let i = 0; i < rows.length; i += 150) await prisma.notification.createMany({ data: rows.slice(i, i + 150) });
  if (emailed) kick();
  return { sent: rows.length, recipients: people.length, emailed, muted, ...(unknown.length ? { unknown } : {}) };
}

/** notify(), but never throws: for the site's own events, where a failed notification mustn't fail the request. */
export function notifyQuietly(input: NotifyInput) {
  void notify(input).catch((err) => console.error(`[notifications] ${input.type} “${input.title}” failed:`, err));
}

// ── Preferences ──────────────────────────────────────────────────────────

/** The kinds a form can send, and what they're called on a form's own settings. */
export const FORM_KINDS = { "forms.message": "Messages", "forms.entry": "New entries", "forms.problem": "Problems with your entries" } as const;
type FormKind = keyof typeof FORM_KINDS;
const FORM_PREF_RE = /^form:[\w-]{1,64}:(forms\.message|forms\.entry|forms\.problem)$/;

export interface PrefsView {
  emailMode: EmailMode;
  mailConfigured: boolean;
  digestHour: number;
  types: { key: NotificationTypeKey; label: string; description: string; inApp: boolean; email: boolean; defaults: Choice }[];
  /**
   * Forms this person can open, or that have notified them, each with the kinds
   * it sends. A kind follows the person's choice for it (custom: false) until
   * they set it for this form.
   */
  forms: {
    id: string;
    title: string;
    kind: string;
    category: string | null;
    /** Notifications it has sent them that are still kept. */
    sent: number;
    kinds: { key: FormKind; label: string; inApp: boolean; email: boolean; custom: boolean }[];
  }[];
}

export async function prefsFor(person: { userId: string; roleKey: string; permissions: PermissionKey[] }): Promise<PrefsView> {
  const { userId, permissions } = person;
  const [user, rows, sentBy, forms] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { notifyEmailMode: true } }),
    prisma.notificationPref.findMany({ where: { userId } }),
    prisma.notification.groupBy({ by: ["formId", "type"], where: { userId, formId: { not: null } }, _count: { _all: true } }),
    prisma.builtForm.findMany({ where: { status: { not: "archived" }, liveSchema: { not: null } }, select: { id: true, title: true, kind: true, catalogLinkId: true } }),
  ]);
  const by = new Map(rows.map((r) => [r.key, r]));
  const cards = await prisma.formLink.findMany({
    where: { id: { in: forms.map((f) => f.catalogLinkId).filter((x): x is string => Boolean(x)) } },
    select: { id: true, active: true, roles: true, category: { select: { name: true } } },
  });
  const cardBy = new Map(cards.map((c) => [c.id, c]));
  const seesEverything = permissions.includes("forms.manage");

  const allTypes = (Object.entries(NOTIFICATION_TYPES) as [NotificationTypeKey, NotificationType][]).map(([key, t]) => {
    const r = by.get(key);
    return { key, shownTo: t.shownTo, label: t.label, description: t.description, inApp: r?.inApp ?? t.inApp, email: r?.email ?? t.email, defaults: { inApp: t.inApp, email: t.email } };
  });
  const typeChoice = new Map(allTypes.map((t) => [t.key, { inApp: t.inApp, email: t.email }]));

  const out: PrefsView["forms"] = [];
  for (const f of forms) {
    const card = f.catalogLinkId ? cardBy.get(f.catalogLinkId) : undefined;
    const sentKinds = sentBy.filter((x) => x.formId === f.id);
    const sent = sentKinds.reduce((n, x) => n + x._count._all, 0);
    const customised = rows.some((r) => r.key.startsWith(`form:${f.id}:`));
    // The forms on their own Forms screen, plus any that have reached them or that they've set.
    const onTheirScreen = Boolean(card?.active && (!card.roles || card.roles.split(",").includes(person.roleKey)));
    if (!seesEverything && !onTheirScreen && !sent && !customised) continue;
    // A basic form sends new entries; a code form, messages and new entries.
    // Anything else it has actually sent them, or they've set, is listed too.
    const natural: FormKind[] = f.kind === "code" ? ["forms.message", "forms.entry"] : ["forms.entry"];
    const kinds = (Object.keys(FORM_KINDS) as FormKind[]).filter(
      (k) => natural.includes(k) || sentKinds.some((x) => x.type === k) || by.has(formPrefKey(f.id, k))
    );
    out.push({
      id: f.id,
      title: f.title,
      kind: f.kind,
      category: card?.category.name ?? null,
      sent,
      kinds: kinds.map((k) => {
        const r = by.get(formPrefKey(f.id, k));
        const base = typeChoice.get(k)!;
        return { key: k, label: FORM_KINDS[k], inApp: r?.inApp ?? base.inApp, email: r?.email ?? base.email, custom: Boolean(r) };
      }),
    });
  }
  // The ones that have notified them first, then by name.
  out.sort((a, b) => Number(b.sent > 0) - Number(a.sent > 0) || a.title.localeCompare(b.title));

  return {
    emailMode: (EMAIL_MODES as readonly string[]).includes(user.notifyEmailMode) ? (user.notifyEmailMode as EmailMode) : "instant",
    mailConfigured: mailConfigured(),
    digestHour: DIGEST_HOUR,
    types: allTypes.filter((t) => !t.shownTo || t.shownTo(permissions)).map(({ shownTo: _s, ...t }) => t),
    forms: out,
  };
}

/**
 * Change preferences. `prefs` sets a kind ("forms.entry") or one kind from one
 * form ("form:<id>:forms.entry"); `reset` takes keys back to following the kind
 * (a form's) or the kind's default (a kind's).
 */
export async function savePrefs(userId: string, change: { emailMode?: EmailMode; prefs?: { key: string; inApp: boolean; email: boolean }[]; reset?: string[] }) {
  for (const key of [...(change.prefs ?? []).map((p) => p.key), ...(change.reset ?? [])]) {
    if (!isNotificationType(key) && !FORM_PREF_RE.test(key)) throw new Error(`Unknown notification setting "${key}".`);
  }
  await prisma.$transaction(async (tx) => {
    if (change.emailMode) {
      const before = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { notifyEmailMode: true } });
      await tx.user.update({ where: { id: userId }, data: { notifyEmailMode: change.emailMode } });
      // Leaving the daily summary: what was waiting for it isn't emailed after all,
      // and going to it, what's waiting to go now waits for the morning.
      if (before.notifyEmailMode === "daily" && change.emailMode !== "daily") {
        await tx.notification.updateMany({ where: { userId, emailStatus: "digest" }, data: { emailStatus: "skipped", emailError: "They stopped the daily summary." } });
      }
      if (change.emailMode === "daily") await tx.notification.updateMany({ where: { userId, emailStatus: "pending" }, data: { emailStatus: "digest" } });
      if (change.emailMode === "off") await tx.notification.updateMany({ where: { userId, emailStatus: "pending" }, data: { emailStatus: "skipped", emailError: "They turned email off." } });
    }
    if (change.reset?.length) await tx.notificationPref.deleteMany({ where: { userId, key: { in: change.reset } } });
    for (const p of change.prefs ?? []) {
      await tx.notificationPref.upsert({
        where: { userId_key: { userId, key: p.key } },
        create: { userId, key: p.key, inApp: p.inApp, email: p.email },
        update: { inApp: p.inApp, email: p.email },
      });
    }
  });
}

// ── The inbox ────────────────────────────────────────────────────────────

export function shapeNotification(n: Notification) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link,
    source: n.source,
    sourceLabel: n.sourceLabel,
    read: Boolean(n.readAt),
    createdAt: n.createdAt.toISOString(),
  };
}

export const unreadCount = (userId: string) => prisma.notification.count({ where: { userId, inApp: true, readAt: null } });

// ── Email ────────────────────────────────────────────────────────────────

const TICK_MS = 30_000;
const MAX_TRIES = 3;
let timer: NodeJS.Timeout | null = null;
let running = false;
let lastCleanup = 0;

/** Where an email's link goes: the notification itself, which marks it read and opens its page. */
const openUrl = (id: string) => `${appBaseUrl}/notifications/${id}`;

async function sendOne(n: Notification & { user: { email: string; status: string } }) {
  // Claimed first, so another server (or an overlapping run) leaves it alone.
  const claimed = await prisma.notification.updateMany({ where: { id: n.id, emailStatus: "pending" }, data: { emailStatus: "sending", emailTries: { increment: 1 } } });
  if (!claimed.count) return;
  if (n.user.status !== "active") {
    await prisma.notification.update({ where: { id: n.id }, data: { emailStatus: "skipped", emailError: "They no longer have access." } });
    return;
  }
  try {
    if (!mailConfigured()) throw Object.assign(new Error("Email isn't set up on this server (MAIL_FROM)."), { final: true });
    const from = n.sourceLabel ? ` from “${n.sourceLabel}”` : "";
    await sendMail({ to: [n.user.email], subject: n.title, html: linkOnlyHtml(`You have a new notification${from} in Lantern Forms.`, openUrl(n.id)) });
    await prisma.notification.update({ where: { id: n.id }, data: { emailStatus: "sent", emailedAt: new Date(), emailError: null } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const final = (err as { final?: boolean }).final || n.emailTries + 1 >= MAX_TRIES;
    console.error(`[notifications] email ${n.id} to ${n.user.email} failed${final ? "" : " (will retry)"}:`, message);
    await prisma.notification.update({ where: { id: n.id }, data: { emailStatus: final ? (mailConfigured() ? "failed" : "skipped") : "pending", emailError: message.slice(0, 2000) } });
  }
}

/** The morning summary for everyone on "daily" whose summary is due. */
async function sendDigests() {
  const now = new Date();
  if (partsOf(now.toISOString()).hour < DIGEST_HOUR) return;
  const dueAfter = new Date(startOfDay(today()).getTime() + DIGEST_HOUR * 3_600_000);
  const waiting = await prisma.notification.groupBy({ by: ["userId"], where: { emailStatus: "digest", createdAt: { lt: now } } });
  for (const { userId } of waiting) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, status: true, notifyDigestAt: true } });
    if (!user) continue;
    if (user.notifyDigestAt && user.notifyDigestAt >= dueAfter) continue;
    // Claim the day's summary for this person; a second server finds it taken.
    const claimed = await prisma.user.updateMany({
      where: { id: userId, OR: [{ notifyDigestAt: null }, { notifyDigestAt: { lt: dueAfter } }] },
      data: { notifyDigestAt: now },
    });
    if (!claimed.count) continue;
    const rows = await prisma.notification.findMany({ where: { userId, emailStatus: "digest", createdAt: { lt: now } }, select: { id: true, readAt: true } });
    const unread = rows.filter((r) => !r.readAt);
    const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
    // Already read in the app: nothing to tell them.
    if (rows.length > unread.length) {
      await prisma.notification.updateMany({ where: { id: { in: ids(rows.filter((r) => r.readAt)) } }, data: { emailStatus: "skipped", emailError: "Read before the daily summary." } });
    }
    if (!unread.length) continue;
    try {
      if (user.status !== "active") throw new Error("They no longer have access.");
      if (!mailConfigured()) throw new Error("Email isn't set up on this server (MAIL_FROM).");
      const n = unread.length;
      await sendMail({
        to: [user.email],
        subject: `${n} new notification${n === 1 ? "" : "s"} in Lantern Forms`,
        html: linkOnlyHtml(`You have ${n} notification${n === 1 ? "" : "s"} you haven't read yet in Lantern Forms.`, `${appBaseUrl}/notifications`),
      });
      await prisma.notification.updateMany({ where: { id: { in: ids(unread) } }, data: { emailStatus: "sent", emailedAt: now } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[notifications] daily summary to ${user.email} failed:`, message);
      await prisma.notification.updateMany({ where: { id: { in: ids(unread) } }, data: { emailStatus: "failed", emailError: message.slice(0, 2000) } });
    }
  }
}

export async function runNotificationMail(): Promise<number> {
  if (running) return 0;
  running = true;
  // A failure that will be retried stays pending; it waits for the next run rather than going again at once.
  const tried: string[] = [];
  try {
    while (tried.length < 500) {
      const batch = await prisma.notification.findMany({
        where: { emailStatus: "pending", ...(tried.length ? { id: { notIn: tried } } : {}) },
        orderBy: { createdAt: "asc" },
        take: 20,
        include: { user: { select: { email: true, status: true } } },
      });
      if (!batch.length) break;
      for (const row of batch) {
        await sendOne(row);
        tried.push(row.id);
      }
    }
    await sendDigests();
    if (Date.now() - lastCleanup > 6 * 3_600_000) {
      lastCleanup = Date.now();
      const { count } = await prisma.notification.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - KEEP_DAYS * 86_400_000) } } });
      if (count) console.log(`[notifications] removed ${count} older than ${KEEP_DAYS} days.`);
    }
  } finally {
    running = false;
  }
  return tried.length;
}

function kick(delay = 500) {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void runNotificationMail().catch((err) => console.error("[notifications] run failed:", err));
  }, delay);
  timer.unref?.();
}

export function startNotificationMail() {
  // A send cut short by a stopped server goes again (at most a duplicate, never a loss).
  void prisma.notification
    .updateMany({ where: { emailStatus: "sending", updatedAt: { lt: new Date(Date.now() - 5 * 60_000) } }, data: { emailStatus: "pending" } })
    .then(() => kick(5_000))
    .catch((err) => console.error("[notifications] start failed:", err));
  setInterval(() => kick(0), TICK_MS).unref();
}
