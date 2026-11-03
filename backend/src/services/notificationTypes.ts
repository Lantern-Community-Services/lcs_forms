import type { BuiltForm } from "@prisma/client";
import { prisma } from "../prisma.js";
import { badRequest } from "../http.js";
import type { CurrentUser } from "../auth/middleware.js";
import { routeSchema, type Recipient, type Route } from "../forms/routingSchema.js";
import { canUseBuiltForm } from "./staffGroups.js";
import { LEGACY_ROLES, roleFor } from "./permissions.js";
import { audit, type Actor } from "./audit.js";
import { mailConfigured } from "./mailer.js";
import {
  DIGEST_HOUR, EMAIL_MODES, NOTIFICATION_TYPES, TYPE_CHOICES, EMAIL_WHEN, defaultRule, forgetSystemRules, formPrefKey, isNotificationType, readPref,
  readRuleChanges, resolveDelivery, systemRules,
  type EmailMode, type EmailWhen, type NotificationTypeKey, type Pref, type SystemRuleChanges, type TypeChoice, type TypeRule,
} from "./notifications.js";
import { manifestOf, routeRule, routeTopicKey } from "./routing.js";
import { COLLECTION as FOLLOW_UP, FOLLOW_UP_RULE, followUpSchema, followUpTopicKey } from "./followUp.js";

/**
 * Notification types, as people choose them and Admins set them up.
 *
 * Every notification goes out as a type (services/notifications.ts):
 *   - the site's own (NOTIFICATION_TYPES: access requests, your account…),
 *     whose defaults and how much people may change them an Admin sets in
 *     Admin → Notifications → Types (Setting "notificationTypes");
 *   - each route of each form ("route:<formId>:<routeId>"), set up on the
 *     route itself (forms/routingSchema.ts: label, email, emailDefault);
 *   - each form's follow-up reminders and "it's done" ("followup:<formId>:…").
 *   - A form's own "Messages" and "New entries" (ctx.notify.send, a builder
 *     form's older rules) stay as the form's kinds ("form:<formId>:<kind>").
 *
 * Profile → Notifications lists every type that could reach the person: one
 * whose people include them (by address, role at their sites, group, position),
 * one whose people are "whoever filed it" or a person a form names on a form
 * they can use, and any that has reached them or that they've set. For each:
 * in the app or not, and email now, in their daily summary, or not at all.
 */

type Viewer = Pick<CurrentUser, "userId" | "roleKey" | "permissions" | "groupIds" | "title" | "siteIds">;

export interface TypeRow {
  key: string;
  label: string;
  description: string | null;
  /** What they get now. */
  inApp: boolean;
  email: EmailWhen | null;
  /** What they'd get without a choice of their own for this type. */
  defaults: { inApp: boolean; email: EmailWhen | null };
  /** They've set this type themselves. */
  custom: boolean;
  /** Their own choice for it, if any, and what they follow without one (the form's, the kind's, else the type's defaults). */
  own: Pref | null;
  base: Pref;
  choice: TypeChoice;
  urgent: boolean;
  /** Notifications of this type they've had that are still kept. */
  sent: number;
}

export interface PrefsView {
  emailMode: EmailMode;
  mailConfigured: boolean;
  /** Their summary's hour (New York), and the site's. */
  digestHour: number;
  siteDigestHour: number;
  types: TypeRow[];
  forms: {
    id: string;
    title: string;
    kind: string;
    category: string | null;
    sent: number;
    rows: TypeRow[];
  }[];
}

/** The form kinds a form can still send outside its routes, as they're called on a form. */
const FORM_KINDS = { "forms.message": "Other messages from this form", "forms.entry": "New entries (older form rules)", "forms.problem": "Problems with your entries" } as const;
type FormKind = keyof typeof FORM_KINDS;

const KEY_RE = {
  form: /^form:([\w-]{1,64}):(forms\.message|forms\.entry|forms\.problem)$/,
  route: /^route:([\w-]{1,64}):([a-z0-9][a-z0-9_-]{0,63})$/i,
  followup: /^followup:([\w-]{1,64}):(reminder|done)$/,
};

// ── Who a type could reach ───────────────────────────────────────────────

interface Person {
  id: string;
  email: string;
  roleKey: string;
  allSites: boolean;
  siteCodes: string[];
  groupIds: string[];
  title: string;
}

/**
 * Whether a list of people (a route's, a follow-up's) could ever include this
 * person. People a form names, and whoever filed it, could be anyone who can
 * use the form.
 */
function couldReach(to: Recipient[], routeSites: string[] | undefined, p: Person, canUse: boolean): boolean {
  const atRouteSites = !routeSites?.length || p.allSites || p.siteCodes.some((c) => routeSites.includes(c));
  const hasSite = p.allSites || p.siteCodes.length > 0;
  const siteFits = (siteOnly: boolean) => !siteOnly || (hasSite && atRouteSites);
  return to.some((t) => {
    switch (t.kind) {
      case "person":
        return t.email.toLowerCase() === p.email;
      case "role":
        return roleFor(LEGACY_ROLES[t.role] ?? t.role).key === p.roleKey && siteFits(t.siteOnly !== false);
      case "group":
        return p.groupIds.includes(t.group) && siteFits(Boolean(t.siteOnly));
      case "title":
        return Boolean(p.title) && t.title.trim().toLowerCase() === p.title && siteFits(Boolean(t.siteOnly));
      default:
        return canUse && atRouteSites;
    }
  });
}

/** Each form's routes (saved, else a code form's defaults) and follow-up, read for many forms at once. */
async function routingOf(forms: Pick<BuiltForm, "id" | "kind">[]) {
  const ids = forms.map((f) => f.id);
  const records = ids.length
    ? await prisma.formRecord.findMany({ where: { formId: { in: ids }, OR: [{ collection: "__routing", docId: "routes" }, { collection: FOLLOW_UP, docId: "settings" }] }, select: { formId: true, collection: true, data: true } })
    : [];
  const routes = new Map<string, Route[]>();
  const followUps = new Map<string, { doers: Recipient[]; tellSubmitter: boolean }>();
  for (const r of records) {
    let data: unknown;
    try {
      data = JSON.parse(r.data);
    } catch {
      continue;
    }
    if (r.collection === "__routing") {
      const list = ((data as { routes?: unknown[] }).routes ?? []).flatMap((x) => {
        const p = routeSchema.safeParse(x);
        return p.success ? [p.data] : [];
      });
      routes.set(r.formId, list);
    } else {
      const p = followUpSchema.safeParse(data);
      if (p.success && p.data.enabled) followUps.set(r.formId, { doers: p.data.doers, tellSubmitter: p.data.tellSubmitter });
    }
  }
  // A code form nobody has saved routing for uses its form.json defaults.
  const missing = forms.filter((f) => f.kind === "code" && !routes.has(f.id)).map((f) => f.id);
  if (missing.length) {
    for (const f of await prisma.builtForm.findMany({ where: { id: { in: missing } } })) {
      try {
        routes.set(f.id, manifestOf(f)?.routing?.defaults ?? []);
      } catch {
        routes.set(f.id, []);
      }
    }
  }
  return { routes, followUps };
}

const routeLabel = (r: Pick<Route, "label" | "name">) => r.label?.trim() || r.name;

// ── One person's settings ────────────────────────────────────────────────

const asMode = (m: string): EmailMode => ((EMAIL_MODES as readonly string[]).includes(m) ? (m as EmailMode) : "instant");

export async function prefsFor(viewer: Viewer): Promise<PrefsView> {
  const { userId } = viewer;
  const [user, prefRows, sentRows, forms, rules, sites] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, notifyEmailMode: true, notifyDigestHour: true } }),
    prisma.notificationPref.findMany({ where: { userId } }),
    prisma.notification.groupBy({ by: ["formId", "type", "topic"], where: { userId }, _count: { _all: true } }),
    prisma.builtForm.findMany({ where: { status: { not: "archived" }, liveSchema: { not: null } }, select: { id: true, title: true, kind: true, catalogLinkId: true } }),
    systemRules(),
    prisma.site.findMany({ select: { id: true, code: true } }),
  ]);
  const mode = asMode(user.notifyEmailMode);
  const prefs = new Map<string, Pref>(prefRows.map((r) => [r.key, readPref(r)]));
  const sentOf = (pred: (r: (typeof sentRows)[number]) => boolean) => sentRows.filter(pred).reduce((n, r) => n + r._count._all, 0);
  const role = roleFor(viewer.roleKey);
  const person: Person = {
    id: userId,
    email: user.email.toLowerCase(),
    roleKey: role.key,
    allSites: role.allSites || viewer.siteIds === null,
    siteCodes: (viewer.siteIds ?? []).map((id) => sites.find((s) => s.id === id)?.code).filter((c): c is string => Boolean(c)),
    groupIds: viewer.groupIds,
    title: (viewer.title ?? "").trim().toLowerCase(),
  };

  const row = (key: string, label: string, description: string | null, rule: TypeRule, inherited: string[], extra: { urgent?: boolean; sent: number }): TypeRow => {
    const own = prefs.get(key);
    const up = inherited.map((k) => prefs.get(k));
    const now = resolveDelivery({ rule, own, inherited: up, mode });
    const def = resolveDelivery({ rule, inherited: up, mode });
    const base = up.find(Boolean) ?? { inApp: rule.inApp, email: rule.email, emailWhen: null };
    return {
      key, label, description,
      inApp: now.inApp, email: now.email, defaults: { inApp: def.inApp, email: def.email },
      custom: Boolean(own), own: own ?? null, base,
      choice: rule.choice, urgent: Boolean(extra.urgent), sent: extra.sent,
    };
  };

  const types = (Object.keys(NOTIFICATION_TYPES) as NotificationTypeKey[])
    .filter((k) => {
      const t = NOTIFICATION_TYPES[k] as { shownTo?: (p: typeof viewer.permissions) => boolean };
      return !t.shownTo || t.shownTo(viewer.permissions);
    })
    .map((k) => row(k, NOTIFICATION_TYPES[k].label, NOTIFICATION_TYPES[k].description, rules[k], [], { sent: sentOf((r) => r.type === k && !r.formId) }));

  const cards = await prisma.formLink.findMany({
    where: { id: { in: forms.map((f) => f.catalogLinkId).filter((x): x is string => Boolean(x)) } },
    select: { id: true, active: true, roles: true, category: { select: { name: true } } },
  });
  const cardBy = new Map(cards.map((c) => [c.id, c]));
  const { routes, followUps } = await routingOf(forms);

  const out: PrefsView["forms"] = [];
  for (const f of forms) {
    const card = f.catalogLinkId ? cardBy.get(f.catalogLinkId) : undefined;
    const canUse = canUseBuiltForm(viewer, f.id);
    const onTheirScreen = Boolean(card?.active && (!card.roles || card.roles.split(",").includes(viewer.roleKey)) && canUse);
    const has = (key: string) => prefs.has(key);
    const rows: TypeRow[] = [];
    const formKind = (k: FormKind) => formPrefKey(f.id, k);

    for (const r of routes.get(f.id) ?? []) {
      const key = routeTopicKey(f.id, r.id);
      const sent = sentOf((x) => x.topic === key);
      if (!(r.enabled && couldReach(r.to, r.sites, person, canUse)) && !sent && !has(key)) continue;
      rows.push(row(key, routeLabel(r), r.description ?? null, routeRule(r), [formKind("forms.message"), "forms.message"], { urgent: r.urgent, sent }));
    }
    const fu = followUps.get(f.id);
    for (const which of ["reminder", "done"] as const) {
      const key = followUpTopicKey(f.id, which);
      const sent = sentOf((x) => x.topic === key);
      const could = fu && (which === "reminder" ? couldReach(fu.doers, undefined, person, canUse) : fu.tellSubmitter && canUse);
      if (!could && !sent && !has(key)) continue;
      rows.push(
        row(
          key,
          which === "reminder" ? "Follow-up reminders" : "Your entry was followed up",
          which === "reminder" ? "An entry you're to follow up is still open." : "Someone marked an entry you filed as done.",
          FOLLOW_UP_RULE,
          [formKind("forms.entry"), "forms.entry"],
          { sent }
        )
      );
    }
    // What the form sends outside routing: a code form's own messages (ctx.notify.send), and any kind it has sent or they've set.
    for (const k of Object.keys(FORM_KINDS) as FormKind[]) {
      const key = formKind(k);
      const sent = sentOf((x) => x.formId === f.id && x.type === k && !x.topic);
      if (!(k === "forms.message" && f.kind === "code" && onTheirScreen) && !sent && !has(key)) continue;
      rows.push(row(key, FORM_KINDS[k], null, { ...rules[k], choice: "optional" }, [k], { sent }));
    }
    if (!rows.length) continue;
    out.push({ id: f.id, title: f.title, kind: f.kind, category: card?.category.name ?? null, sent: rows.reduce((n, r) => n + r.sent, 0), rows });
  }
  // The ones that have notified them first, then by name.
  out.sort((a, b) => Number(b.sent > 0) - Number(a.sent > 0) || a.title.localeCompare(b.title));

  return {
    emailMode: mode,
    mailConfigured: mailConfigured(),
    digestHour: user.notifyDigestHour ?? DIGEST_HOUR,
    siteDigestHour: DIGEST_HOUR,
    types,
    forms: out,
  };
}

/** The rule a settings key answers to, or an error naming what's wrong. */
async function ruleOfKey(key: string): Promise<TypeRule> {
  if (isNotificationType(key)) return (await systemRules())[key];
  if (KEY_RE.form.test(key) || KEY_RE.followup.test(key)) return key.startsWith("followup:") ? FOLLOW_UP_RULE : { ...defaultRule("forms.message"), choice: "optional" };
  const m = KEY_RE.route.exec(key);
  if (m) {
    const form = await prisma.builtForm.findUnique({ where: { id: m[1] }, select: { id: true, kind: true } });
    const route = form ? (await routingOf([form])).routes.get(form.id)?.find((r) => r.id === m[2]) : undefined;
    if (!route) throw new Error("That form no longer has that notification.");
    return routeRule(route);
  }
  throw new Error(`Unknown notification setting "${key}".`);
}

export interface PrefChange {
  emailMode?: EmailMode;
  /** The New York hour of their summary; null: the site's. */
  digestHour?: number | null;
  prefs?: { key: string; inApp: boolean; email: boolean; emailWhen?: EmailWhen | null }[];
  /** Back to the type's default (and, for a form's kinds, to following the kind). */
  reset?: string[];
}

/**
 * Change someone's settings. A locked type can't be set; a required one is
 * always in the app, so its in-app choice is kept on.
 */
export async function savePrefs(userId: string, change: PrefChange) {
  const prefs: { key: string; inApp: boolean; email: boolean; emailWhen: EmailWhen | null }[] = [];
  for (const p of change.prefs ?? []) {
    const rule = await ruleOfKey(p.key);
    if (rule.choice === "locked") throw new Error("An Admin has set that notification for everyone; it can't be changed.");
    prefs.push({ key: p.key, inApp: rule.choice === "required" ? true : p.inApp, email: p.email, emailWhen: p.email ? p.emailWhen ?? null : null });
  }
  for (const key of change.reset ?? []) await ruleOfKey(key).catch((err: Error) => {
    // A setting for a route that's gone may still be cleared.
    if (!/no longer has/.test(err.message)) throw err;
  });
  await prisma.$transaction(async (tx) => {
    if (change.emailMode) {
      await tx.user.update({ where: { id: userId }, data: { notifyEmailMode: change.emailMode } });
      // Going to the summary, what's waiting to go now waits for it; turning email off, it's not sent.
      // Leaving the summary, what's waiting for it still goes in it (some types may be set to it anyway).
      if (change.emailMode === "daily") await tx.notification.updateMany({ where: { userId, emailStatus: "pending" }, data: { emailStatus: "digest" } });
      if (change.emailMode === "off") await tx.notification.updateMany({ where: { userId, emailStatus: "pending" }, data: { emailStatus: "skipped", emailError: "They turned email off." } });
    }
    if (change.digestHour !== undefined) await tx.user.update({ where: { id: userId }, data: { notifyDigestHour: change.digestHour } });
    if (change.reset?.length) await tx.notificationPref.deleteMany({ where: { userId, key: { in: change.reset } } });
    for (const p of prefs) {
      const data = { inApp: p.inApp, email: p.email, emailWhen: p.emailWhen };
      await tx.notificationPref.upsert({ where: { userId_key: { userId, key: p.key } }, create: { userId, key: p.key, ...data }, update: data });
    }
  });
}

// ── Admin → Notifications → Types ────────────────────────────────────────

export interface TypesOverview {
  system: {
    key: NotificationTypeKey;
    label: string;
    description: string;
    rule: TypeRule;
    /** The site's own default, for "Back to the default". */
    base: TypeRule;
    changed: boolean;
    /** People who've set it themselves. */
    customised: number;
  }[];
  forms: {
    id: string;
    slug: string;
    title: string;
    kind: string;
    types: {
      key: string;
      label: string;
      routeName: string | null;
      description: string | null;
      enabled: boolean;
      urgent: boolean;
      choice: TypeChoice;
      emailDefault: "own" | "daily" | "off";
      customised: number;
    }[];
  }[];
}

export async function typesOverview(): Promise<TypesOverview> {
  const [rules, raw, counts, forms] = await Promise.all([
    systemRules(),
    prisma.setting.findUnique({ where: { key: "notificationTypes" } }),
    prisma.notificationPref.groupBy({ by: ["key"], _count: { _all: true } }),
    prisma.builtForm.findMany({ where: { status: { not: "archived" } }, select: { id: true, slug: true, title: true, kind: true }, orderBy: { title: "asc" } }),
  ]);
  const changes = readRuleChanges(raw?.value ?? "");
  const count = new Map(counts.map((c) => [c.key, c._count._all]));
  const { routes, followUps } = await routingOf(forms);
  return {
    system: (Object.keys(NOTIFICATION_TYPES) as NotificationTypeKey[]).map((k) => ({
      key: k,
      label: NOTIFICATION_TYPES[k].label,
      description: NOTIFICATION_TYPES[k].description,
      rule: rules[k],
      base: defaultRule(k),
      changed: Boolean(changes[k] && Object.keys(changes[k]!).length),
      customised: count.get(k) ?? 0,
    })),
    forms: forms
      .map((f) => {
        const types: TypesOverview["forms"][number]["types"] = (routes.get(f.id) ?? []).map((r) => {
          const rule = routeRule(r);
          return {
            key: routeTopicKey(f.id, r.id),
            label: routeLabel(r),
            routeName: r.name,
            description: r.description ?? null,
            enabled: r.enabled,
            urgent: r.urgent,
            choice: rule.choice,
            emailDefault: !rule.email ? ("off" as const) : rule.emailWhen === "daily" && rule.choice !== "locked" ? ("daily" as const) : ("own" as const),
            customised: count.get(routeTopicKey(f.id, r.id)) ?? 0,
          };
        });
        if (followUps.has(f.id)) {
          for (const which of ["reminder", "done"] as const) {
            const key = followUpTopicKey(f.id, which);
            types.push({
              key,
              label: which === "reminder" ? "Follow-up reminders" : "Your entry was followed up",
              routeName: null,
              description: null,
              enabled: which === "reminder" || followUps.get(f.id)!.tellSubmitter,
              urgent: false,
              choice: FOLLOW_UP_RULE.choice,
              emailDefault: "own",
              customised: count.get(key) ?? 0,
            });
          }
        }
        return { id: f.id, slug: f.slug, title: f.title, kind: f.kind, types };
      })
      .filter((f) => f.types.length),
  };
}

/** Change the site's own types' rules. Null for a type puts it back to the site's default. */
export async function saveSystemRules(input: Record<string, Partial<TypeRule> | null>, actor: Actor) {
  const raw = await prisma.setting.findUnique({ where: { key: "notificationTypes" } });
  const next: SystemRuleChanges = readRuleChanges(raw?.value ?? "");
  const changed: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (!isNotificationType(k)) throw badRequest(`"${k}" isn't one of the site's notification types. Types: ${Object.keys(NOTIFICATION_TYPES).join(", ")}.`);
    if (v === null) delete next[k];
    else {
      if (v.choice !== undefined && !(TYPE_CHOICES as readonly string[]).includes(v.choice)) throw badRequest(`choice is one of ${TYPE_CHOICES.join(", ")}.`);
      if (v.emailWhen != null && !(EMAIL_WHEN as readonly string[]).includes(v.emailWhen)) throw badRequest(`emailWhen is one of ${EMAIL_WHEN.join(", ")}, or null.`);
      const r: Partial<TypeRule> = { ...next[k] };
      if (typeof v.inApp === "boolean") r.inApp = v.inApp;
      if (typeof v.email === "boolean") r.email = v.email;
      if (v.emailWhen !== undefined) r.emailWhen = v.emailWhen;
      if (v.choice) r.choice = v.choice;
      // A type someone can't see in the app and isn't emailed reaches nobody.
      const full = { ...defaultRule(k), ...r };
      if (!full.inApp && !full.email) throw badRequest(`“${NOTIFICATION_TYPES[k].label}” would reach nobody: leave it in the app or by email.`);
      next[k] = r;
    }
    changed.push(NOTIFICATION_TYPES[k].label);
  }
  await prisma.setting.upsert({ where: { key: "notificationTypes" }, create: { key: "notificationTypes", value: JSON.stringify(next) }, update: { value: JSON.stringify(next) } });
  forgetSystemRules();
  await audit({ actor, action: "notifications.types_saved", summary: `Changed how ${changed.join(", ")} reach${changed.length === 1 ? "es" : ""} people` });
  return typesOverview();
}
