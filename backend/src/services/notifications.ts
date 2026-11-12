import type { Notification } from "@prisma/client";
import { peopleInGroupsOrPositions } from "./staffGroups.js";
import { prisma } from "../prisma.js";
import { appBaseUrl } from "../env.js";
import { mailConfigured, sendLogged } from "./mailer.js";
import { brandedEmail, isInternalAddress } from "./emailTemplate.js";
import { LEGACY_ROLES, PERMISSIONS, isRoleKey, permissionsFor, roleFor, type PermissionKey } from "./permissions.js";
import { partsOf, startOfDay, today } from "../apps/time.js";
import { messageWording, templateByKey } from "./emailTemplates.js";

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
 * Every notification is sent as a notification type: one of the site's own
 * (NOTIFICATION_TYPES, whose defaults Admins can change), a form's route
 * (services/routing.ts) or a form's follow-up. Each type has a rule (TypeRule):
 * what someone who hasn't chosen gets, and whether they may change it
 * (optional), only how (required: always in the app), or not at all (locked).
 * What each person chooses is on Profile → Notifications, type by type
 * (services/notificationTypes.ts): in the app or not, and email right away,
 * in their daily summary, or not at all. Their own default timing is
 * User.notifyEmailMode, the summary's hour User.notifyDigestHour.
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
export const EMAIL_WHEN = ["instant", "daily"] as const;
export type EmailWhen = (typeof EMAIL_WHEN)[number];
export const TYPE_CHOICES = ["optional", "required", "locked"] as const;
/**
 * How much a person may change a type: "optional" anything, turning it off
 * included; "required" how it reaches them, but it always shows in the app;
 * "locked" nothing (in the app and emailed as the rule says).
 */
export type TypeChoice = (typeof TYPE_CHOICES)[number];

/** What someone who hasn't chosen gets from a type, and how much they may change. */
export interface TypeRule {
  inApp: boolean;
  email: boolean;
  /** "daily": in their summary even when they get email as it comes. Null: their own default. */
  emailWhen: EmailWhen | null;
  choice: TypeChoice;
}

/** One person's choice for one type (NotificationPref). emailWhen null: their own default. */
export interface Pref {
  inApp: boolean;
  email: boolean;
  emailWhen: EmailWhen | null;
}

/** The New York hour the daily summary goes out at, unless someone picks another. */
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
  /** Staff groups (ids): everyone in them (services/staffGroups.ts). */
  groups?: string[];
  /** Positions: everyone with one of these exact job titles, any case. */
  titles?: string[];
  /** Keeps roles, groups and positions to people at these sites (everyone-site roles always count). */
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
  /**
   * The notification type it's sent as, when it's more particular than `type`:
   * a form's route or follow-up ("route:<formId>:<routeId>"), with its rule.
   * The person's choice for it comes first, then for the form, then for `type`.
   */
  topic?: { key: string; rule: TypeRule };
  /**
   * Needs attention now: always shown in the app (whatever they chose for this
   * kind), emailed at once even to people on a daily summary (unless they
   * turned its email off, or all email), and marked urgent in the bell, the list and the email.
   */
  urgent?: boolean;
  /**
   * What goes in the email besides the title and the button: what to do, and
   * chosen answers (services/routing.ts emailValues). The answers are kept only
   * for people with a Lantern address; never shown in the app.
   */
  email?: {
    whatToDo?: string | null;
    fields?: { label: string; value: string }[];
    /** From an email template (services/emailTemplates.ts): the heading, the line under it and the button. */
    heading?: string | null;
    intro?: string | null;
    buttonLabel?: string | null;
  };
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
  const select = { id: true, email: true, roleKey: true, calendarEditor: true, rosterEditor: true, globalAdmin: true, viewAsEnabled: true, notifyEmailMode: true, sites: { where: { approved: true }, select: { siteId: true } } } as const;
  type Person = { id: string; email: string; roleKey: string; calendarEditor: boolean; rosterEditor: boolean; globalAdmin: boolean; viewAsEnabled: boolean; notifyEmailMode: string; sites: { siteId: string }[] };
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

  // A retired role key (site_admin…) means the role it became: forms written before the change still reach people.
  const roles = [...new Set((to.roles ?? []).filter(Boolean).map((r) => LEGACY_ROLES[r] ?? r))];
  const perms = (to.permissions ?? []).filter(Boolean);
  const badRole = roles.find((r) => !isRoleKey(r));
  if (badRole) throw new Error(`"${badRole}" isn't a role. Roles: admin, developer, main_office, site_manager, site_staff, arete_staff.`);
  const badPerm = perms.find((p) => !(PERMISSIONS as readonly string[]).includes(p));
  if (badPerm) throw new Error(`"${badPerm}" isn't a permission.`);

  const members = await peopleInGroupsOrPositions((to.groups ?? []).filter(Boolean), (to.titles ?? []).filter(Boolean));

  if (to.everyone || roles.length || perms.length || members.size) {
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
      const fits = to.everyone || roles.includes(role.key) || perms.some((x) => granted.includes(x as PermissionKey)) || members.has(p.id);
      if (!fits) continue;
      // Everyone-site roles count at every site; others need one of the sites (none assigned = none).
      if (siteIds && !role.allSites && !p.sites.some((s) => siteIds!.includes(s.siteId))) continue;
      found.set(p.id, p);
    }
  }
  return { people: [...found.values()], unknown };
}

/** The preference key for one kind of notification from one form. */
export const formPrefKey = (formId: string, type: string) => `form:${formId}:${type}`;

// ── Type rules ───────────────────────────────────────────────────────────

/** An Admin's changes to the site's own types (Admin → Notifications → Types), kept in Setting "notificationTypes". */
export type SystemRuleChanges = Partial<Record<NotificationTypeKey, Partial<TypeRule>>>;

const baseRule = (k: NotificationTypeKey): TypeRule => ({ inApp: NOTIFICATION_TYPES[k].inApp, email: NOTIFICATION_TYPES[k].email, emailWhen: null, choice: "optional" });

/** Read leniently: anything that doesn't fit is ignored, so a bad row never stops a notification. */
export function readRuleChanges(raw: string): SystemRuleChanges {
  const out: SystemRuleChanges = {};
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isNotificationType(k) || !v || typeof v !== "object") continue;
    const c = v as Record<string, unknown>;
    const r: Partial<TypeRule> = {};
    if (typeof c.inApp === "boolean") r.inApp = c.inApp;
    if (typeof c.email === "boolean") r.email = c.email;
    if (c.emailWhen === null || (EMAIL_WHEN as readonly unknown[]).includes(c.emailWhen)) r.emailWhen = c.emailWhen as EmailWhen | null;
    if ((TYPE_CHOICES as readonly unknown[]).includes(c.choice)) r.choice = c.choice as TypeChoice;
    out[k] = r;
  }
  return out;
}

let rulesCache: { at: number; rules: Record<NotificationTypeKey, TypeRule> } | null = null;

/** Every site type's rule: its own defaults with an Admin's changes. Cached briefly. */
export async function systemRules(): Promise<Record<NotificationTypeKey, TypeRule>> {
  if (rulesCache && Date.now() - rulesCache.at < 30_000) return rulesCache.rules;
  const changes = readRuleChanges((await prisma.setting.findUnique({ where: { key: "notificationTypes" } }))?.value ?? "");
  const rules = {} as Record<NotificationTypeKey, TypeRule>;
  for (const k of Object.keys(NOTIFICATION_TYPES) as NotificationTypeKey[]) rules[k] = { ...baseRule(k), ...changes[k] };
  rulesCache = { at: Date.now(), rules };
  return rules;
}

export function forgetSystemRules() {
  rulesCache = null;
}

export const defaultRule = baseRule;

/**
 * How one notification reaches one person: in the app or not, and its email
 * now, in the summary or not at all.
 *
 * `own` is their choice for this very type; `inherited` their choices it falls
 * back to (the form's, then the kind's), first found wins; else the rule's
 * defaults. A required type always shows in the app; a locked one goes as the
 * rule says. Email timing is theirs when they set one for the type; otherwise
 * their default (`mode`), which "off" stops, and a rule's "daily" holds back.
 * Urgent: always in the app, and emailed now unless they turned this type's
 * email off or never get email.
 */
export function resolveDelivery(o: { rule: TypeRule; own?: Pref; inherited?: (Pref | undefined)[]; mode: EmailMode; urgent?: boolean }): { inApp: boolean; email: EmailWhen | null } {
  const { rule, own, mode } = o;
  const urgent = Boolean(o.urgent);
  if (rule.choice === "locked") {
    return { inApp: rule.inApp || urgent, email: rule.email || urgent ? (urgent ? "instant" : rule.emailWhen ?? "instant") : null };
  }
  const chosen = own ?? o.inherited?.find(Boolean);
  const pick: Pref = chosen ?? { inApp: rule.inApp, email: rule.email, emailWhen: null };
  const inApp = pick.inApp || rule.choice === "required" || urgent;
  const emailOn = urgent ? (own ? own.email : true) : pick.email;
  if (!emailOn) return { inApp, email: null };
  const when: EmailWhen | null = chosen?.emailWhen ?? (mode === "off" ? null : rule.emailWhen === "daily" ? "daily" : mode);
  return { inApp, email: when && urgent ? "instant" : when };
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

  // Their choice for this type, then for this form's kind, then for the kind.
  const formKey = input.formId ? formPrefKey(input.formId, input.type) : null;
  const chain = [input.topic?.key, formKey, input.type].filter((k): k is string => Boolean(k));
  const rule = input.topic?.rule ?? (await systemRules())[input.type];
  const prefRows = await prisma.notificationPref.findMany({ where: { userId: { in: people.map((p) => p.id) }, key: { in: chain } } });
  const prefsBy = new Map<string, Map<string, Pref>>();
  for (const r of prefRows) {
    if (!prefsBy.has(r.userId)) prefsBy.set(r.userId, new Map());
    prefsBy.get(r.userId)!.set(r.key, readPref(r));
  }

  const mail = mailConfigured();
  let muted = 0;
  let emailed = 0;
  const rows = [];
  for (const p of people) {
    const mine = prefsBy.get(p.id) ?? new Map<string, Pref>();
    const [own, ...inherited] = chain.map((k) => mine.get(k));
    const mode = (EMAIL_MODES as readonly string[]).includes(p.notifyEmailMode) ? (p.notifyEmailMode as EmailMode) : "instant";
    const urgent = Boolean(input.urgent);
    const d = resolveDelivery({ rule, own, inherited, mode, urgent });
    const inApp = d.inApp;
    if (!inApp && !d.email) {
      muted++;
      continue;
    }
    const emailStatus = !d.email ? "none" : !mail ? "skipped" : d.email === "daily" ? "digest" : "pending";
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
      topic: input.topic?.key ?? null,
      inApp,
      urgent,
      emailStatus,
      emailError: emailStatus === "skipped" ? "Email isn't set up on this server (MAIL_FROM)." : null,
      emailDetail: emailDetailFor(input.email, p.email),
    });
  }
  // SQL Server takes at most 2,100 parameters a statement: ~15 columns, so 130 rows a go.
  for (let i = 0; i < rows.length; i += 130) await prisma.notification.createMany({ data: rows.slice(i, i + 130) });
  if (emailed) kick();
  return { sent: rows.length, recipients: people.length, emailed, muted, ...(unknown.length ? { unknown } : {}) };
}

/** The email parts kept on one person's notification: answers only for a Lantern address. */
function emailDetailFor(email: NotifyInput["email"], address: string): string | null {
  if (!email) return null;
  const fields = isInternalAddress(address) ? (email.fields ?? []).slice(0, 20) : [];
  const whatToDo = email.whatToDo?.trim() || null;
  const heading = email.heading?.trim() || null;
  const intro = email.intro?.trim() || null;
  const buttonLabel = email.buttonLabel?.trim() || null;
  if (!whatToDo && !fields.length && !heading && !intro && !buttonLabel) return null;
  return JSON.stringify({ whatToDo, fields, ...(heading ? { heading } : {}), ...(intro ? { intro } : {}), ...(buttonLabel ? { buttonLabel } : {}) });
}

/** The parts saved by emailDetailFor, or none. */
type EmailDetail = { whatToDo: string | null; fields: { label: string; value: string }[]; heading?: string | null; intro?: string | null; buttonLabel?: string | null };
function readEmailDetail(raw: string | null): EmailDetail {
  if (!raw) return { whatToDo: null, fields: [] };
  try {
    const d = JSON.parse(raw) as Partial<EmailDetail>;
    return { whatToDo: d.whatToDo ?? null, fields: Array.isArray(d.fields) ? d.fields : [], heading: d.heading ?? null, intro: d.intro ?? null, buttonLabel: d.buttonLabel ?? null };
  } catch {
    return { whatToDo: null, fields: [] };
  }
}

/** One notification's email, in the branded layout. Also used for previews. */
export function notificationEmail(n: { title: string; sourceLabel: string | null; urgent: boolean; emailDetail: string | null }, url: string) {
  const d = readEmailDetail(n.emailDetail);
  return {
    subject: n.urgent ? `Urgent: ${n.title}` : n.title,
    withAnswers: d.fields.length > 0,
    html: brandedEmail({
      kicker: n.sourceLabel ?? "Lantern Forms",
      heading: d.heading || n.title,
      intro: d.intro || `You have ${n.urgent ? "an urgent" : "a new"} notification${n.sourceLabel ? ` from “${n.sourceLabel}”` : ""}.`,
      whatToDo: d.whatToDo,
      fields: d.fields,
      button: { label: d.buttonLabel || "Open it in Lantern Forms", url },
      note: d.fields.length ? "The rest is in Lantern Forms." : "The details aren't in this email. Sign in to see them.",
      urgent: n.urgent,
    }),
  };
}

/** notify(), but never throws: for the site's own events, where a failed notification mustn't fail the request. */
export function notifyQuietly(input: NotifyInput) {
  void notify(input).catch((err) => console.error(`[notifications] ${input.type} “${input.title}” failed:`, err));
}

/** A NotificationPref row as a Pref. */
export function readPref(r: { inApp: boolean; email: boolean; emailWhen: string | null }): Pref {
  return { inApp: r.inApp, email: r.email, emailWhen: (EMAIL_WHEN as readonly string[]).includes(r.emailWhen ?? "") ? (r.emailWhen as EmailWhen) : null };
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
    urgent: n.urgent,
    /** The notification type it was sent as (its settings), or its kind. */
    topic: n.topic ?? n.type,
    read: Boolean(n.readAt),
    createdAt: n.createdAt.toISOString(),
  };
}

export const unreadCount = (userId: string) => prisma.notification.count({ where: { userId, inApp: true, readAt: null } });
export const urgentUnreadCount = (userId: string) => prisma.notification.count({ where: { userId, inApp: true, readAt: null, urgent: true } });

// ── Email ────────────────────────────────────────────────────────────────

const TICK_MS = 30_000;
/** Tries for one email; an urgent one (an incident) gets more before it's given up on. */
const MAX_TRIES = 5;
const MAX_TRIES_URGENT = 7;
/**
 * How long a failed email waits before its next try, by how many it's had.
 * Spread out so a few busy minutes at Microsoft don't use them all up: three
 * tries 30 seconds apart lost an urgent incident email on 2026-11-12.
 */
const RETRY_AFTER_MS = [0, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
const retryWait = (tries: number) => RETRY_AFTER_MS[Math.min(tries, RETRY_AFTER_MS.length - 1)];

/** Pending emails whose wait since their last try is over (a new one has had no tries). */
function dueNow(now = Date.now()) {
  return RETRY_AFTER_MS.map((wait, tries) =>
    tries === 0
      ? { emailTries: 0 }
      : tries === RETRY_AFTER_MS.length - 1
        ? { emailTries: { gte: tries }, updatedAt: { lt: new Date(now - wait) } }
        : { emailTries: tries, updatedAt: { lt: new Date(now - wait) } }
  );
}
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
    const mail = notificationEmail(n, openUrl(n.id));
    await sendLogged({ to: [n.user.email], subject: mail.subject, html: mail.html, kind: "notification", formId: n.formId, withAnswers: mail.withAnswers });
    await prisma.notification.update({ where: { id: n.id }, data: { emailStatus: "sent", emailedAt: new Date(), emailError: null } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const final = (err as { final?: boolean }).final || n.emailTries + 1 >= (n.urgent ? MAX_TRIES_URGENT : MAX_TRIES);
    console.error(`[notifications] email ${n.id} to ${n.user.email} failed${final ? "" : ` (will retry in ${Math.round(retryWait(n.emailTries + 1) / 60_000)} min)`}:`, message);
    await prisma.notification.update({ where: { id: n.id }, data: { emailStatus: final ? (mailConfigured() ? "failed" : "skipped") : "pending", emailError: message.slice(0, 2000) } });
  }
}

/** Most notifications listed in one summary; the rest are counted. */
const DIGEST_LIST = 25;

/**
 * The daily summary, for everyone with notifications waiting for it, at the
 * hour each chose (User.notifyDigestHour, else DIGEST_HOUR). It lists what
 * they haven't read: each one's form and title (titles never carry answers or
 * resident details, so they may go in an email), with a link to the list.
 */
async function sendDigests() {
  const now = new Date();
  const hour = partsOf(now.toISOString()).hour;
  const midnight = startOfDay(today()).getTime();
  const waiting = await prisma.notification.groupBy({ by: ["userId"], where: { emailStatus: "digest", createdAt: { lt: now } } });
  for (const { userId } of waiting) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, status: true, notifyDigestAt: true, notifyDigestHour: true } });
    if (!user) continue;
    const at = user.notifyDigestHour ?? DIGEST_HOUR;
    if (hour < at) continue;
    const dueAfter = new Date(midnight + at * 3_600_000);
    if (user.notifyDigestAt && user.notifyDigestAt >= dueAfter) continue;
    // Claim the day's summary for this person; a second server finds it taken.
    const claimed = await prisma.user.updateMany({
      where: { id: userId, OR: [{ notifyDigestAt: null }, { notifyDigestAt: { lt: dueAfter } }] },
      data: { notifyDigestAt: now },
    });
    if (!claimed.count) continue;
    const rows = await prisma.notification.findMany({
      where: { userId, emailStatus: "digest", createdAt: { lt: now } },
      select: { id: true, readAt: true, title: true, sourceLabel: true, urgent: true },
      orderBy: { createdAt: "desc" },
    });
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
      // Worded by the "Daily summary" email (Admin → Notifications → System emails).
      const s = n === 1 ? "" : "s";
      const t = await templateByKey("daily-summary").catch(() => null);
      const tags = { count: String(n), notifications: `${n} new notification${s}`, unread: `${n} notification${s}` };
      const w = t ? messageWording(t, tags, `${n} new notification${s} in Lantern Forms`) : null;
      const shown = [...unread].sort((a, b) => Number(b.urgent) - Number(a.urgent)).slice(0, DIGEST_LIST);
      await sendLogged({
        to: [user.email],
        subject: w?.subject ?? `${n} new notification${s} in Lantern Forms`,
        html: brandedEmail({
          kicker: "Your daily summary",
          heading: w?.heading ?? `You have ${n} notification${s} you haven't read yet.`,
          intro: w?.intro,
          whatToDo: w?.whatToDo,
          table: {
            columns: ["From", "Notification"],
            rows: shown.map((r) => [r.sourceLabel ?? "Lantern Forms", r.urgent ? `Urgent: ${r.title}` : r.title]),
            more: n - shown.length,
          },
          button: { label: w?.buttonLabel || "Open them in Lantern Forms", url: `${appBaseUrl}/notifications` },
          note: "The details aren't in this email. Sign in to see them. Change what comes in this summary on your Profile.",
          urgent: shown.some((r) => r.urgent),
        }),
        kind: "digest",
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
        where: { emailStatus: "pending", OR: dueNow(), ...(tried.length ? { id: { notIn: tried } } : {}) },
        // Urgent ones first (an incident shouldn't wait behind a busy minute), then oldest first.
        orderBy: [{ urgent: "desc" }, { createdAt: "asc" }],
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
