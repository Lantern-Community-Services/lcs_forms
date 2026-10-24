import crypto from "node:crypto";
import type { BuiltForm } from "@prisma/client";
import { prisma } from "../prisma.js";
import { appBaseUrl } from "../env.js";
import { badRequest, notFound } from "../http.js";
import { conditionPasses, isInputField, type FormDoc, type Values } from "../forms/engine.js";
import { ENTRY_CREATED, routeSchema, type Recipient, type Route, type RoutingEvent } from "../forms/routingSchema.js";
import { readManifest, type Files, type Manifest } from "../apps/project.js";
import { audit, type Actor } from "./audit.js";
import { linkOnlyHtml, mailConfigured, sendMail } from "./mailer.js";
import { notify, resolveAudience, sitePath } from "./notifications.js";
import { isRoleKey, ROLES } from "./permissions.js";

/**
 * Notification routing: for each form, who's told about what. Admins edit it in
 * Admin → Notification routing (routes/routing.ts) or through the MCP
 * (forms/routingTools.ts), without touching the form itself.
 *
 * A form has events. Every form has "entry.created" (an entry was saved); a
 * code form declares its own in form.json "routing" and fires them from server
 * code with ctx.notify.route (e.g. "review.requested" when an assessment needs
 * a supervisor). Each route answers one event: optionally only at some sites,
 * only when the event's values match, and tells a list of people (see
 * forms/routingSchema.ts for the kinds).
 *
 * Delivery follows the site's rules. Account holders get a notification in the
 * app (services/notifications.ts), emailed too: always, unless the route says to
 * follow their own settings. Anyone else gets a link-only email (subject, a
 * line, a link; never answers or resident details). Nobody is told twice about
 * one event, however many routes name them.
 *
 * Stored in FormRecord's private collections ("__routing" holds the routes,
 * "__routing_log" what was sent), so routing needs no table of its own. Until
 * someone saves a form's routing it uses the form's defaults (form.json
 * "routing.defaults"; none for a basic form).
 */

const COLLECTION = "__routing";
const DOC = "routes";
const LOG = "__routing_log";
const LOG_KEEP = 500;
/** People one event may reach across all its routes. */
const MAX_PER_EVENT = 300;
/** Notifications and emails one form may send in an hour through routing. */
const PER_FORM_HOURLY = 1000;
const sentLastHour = new Map<string, number[]>();

export interface RoutingDoc {
  routes: Route[];
  revision: number;
  updatedByName: string | null;
  updatedAt: string | null;
  /** True when nothing has been saved: the routes are the form's defaults. */
  usingDefaults: boolean;
}

type Site = { id: string; code: string; name: string };

// ── What a form can route ────────────────────────────────────────────────

/** A code form's manifest: published if it has been, else the draft. */
export function manifestOf(form: BuiltForm): Manifest | null {
  if (form.kind !== "code") return null;
  const text = form.liveSchema ?? form.draftSchema;
  if (!text) return null;
  return readManifest((JSON.parse(text) as { files: Files }).files).manifest;
}

/** A code form's manifest, when the caller has it (a loaded app); else read from the form. */
type Known = Manifest | null | undefined;
const known = (form: BuiltForm, m: Known) => (m === undefined ? manifestOf(form) : m);

function basicDoc(form: BuiltForm): FormDoc {
  return JSON.parse(form.liveSchema ?? form.draftSchema) as FormDoc;
}

/**
 * The events a form's routes can answer, with the values they can test and the
 * people they name. entry.created comes first; a code form may describe it more
 * fully by declaring it too.
 */
export function eventsOf(form: BuiltForm, manifest?: Known): RoutingEvent[] {
  if (form.kind === "code") {
    const declared = known(form, manifest)?.routing?.events ?? [];
    const own = declared.find((e) => e.id === ENTRY_CREATED);
    return [
      own ?? { id: ENTRY_CREATED, label: "A new entry", description: "Someone saved an entry. Rules can test the entry's top-level values by name." },
      ...declared.filter((e) => e.id !== ENTRY_CREATED),
    ];
  }
  const doc = basicDoc(form);
  const inputs = doc.fields.filter((f) => isInputField(f));
  return [
    {
      id: ENTRY_CREATED,
      label: "A new entry",
      description: "Someone filled in the form.",
      fields: inputs
        .filter((f) => !["file", "signature", "repeater", "code"].includes(f.type))
        .slice(0, 40)
        .map((f) => ({ id: f.id, label: (f.label || f.id).slice(0, 80), ...(f.choices?.length ? { choices: f.choices.slice(0, 100).map((c) => c.value.slice(0, 120)) } : {}) })),
      people: inputs.filter((f) => f.type === "email").slice(0, 20).map((f) => ({ id: f.id, label: (f.label || f.id).slice(0, 80) })),
    },
  ];
}

function defaultsOf(form: BuiltForm, manifest?: Known): Route[] {
  return known(form, manifest)?.routing?.defaults ?? [];
}

export async function loadRouting(form: BuiltForm, manifest?: Known): Promise<RoutingDoc> {
  const row = await prisma.formRecord.findUnique({ where: { formId_collection_docId: { formId: form.id, collection: COLLECTION, docId: DOC } } });
  if (!row) return { routes: defaultsOf(form, manifest), revision: 0, updatedByName: null, updatedAt: null, usingDefaults: true };
  const saved = JSON.parse(row.data) as { routes?: unknown[]; revision?: number };
  // Anything that no longer parses (a schema change) is dropped rather than breaking delivery.
  const routes = (saved.routes ?? []).flatMap((r) => {
    const p = routeSchema.safeParse(r);
    return p.success ? [p.data] : [];
  });
  return { routes, revision: saved.revision ?? 1, updatedByName: row.updatedByName, updatedAt: row.updatedAt.toISOString(), usingDefaults: false };
}

/** The form a caller named, for routing: either kind, not archived. */
export async function routingForm(idOrSlug: string): Promise<BuiltForm> {
  const form = await prisma.builtForm.findFirst({ where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] } });
  if (!form) throw notFound(`No form "${idOrSlug}".`);
  return form;
}

// ── Saving ───────────────────────────────────────────────────────────────

/** Check routes against the form and the site: known events, roles, sites and people fields. */
export async function checkRoutes(form: BuiltForm, input: unknown[]): Promise<Route[]> {
  const events = eventsOf(form);
  const siteCodes = new Set((await prisma.site.findMany({ select: { code: true } })).map((s) => s.code));
  const ids = new Set<string>();
  return input.map((raw, i) => {
    const parsed = routeSchema.safeParse(raw);
    if (!parsed.success) {
      throw badRequest(`Route ${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join(".") || "route"}: ${x.message}`).join("; ")}`);
    }
    const r = parsed.data;
    const where = `Route “${r.name}”`;
    if (ids.has(r.id)) throw badRequest(`${where}: another route already has the id "${r.id}".`);
    ids.add(r.id);
    const ev = events.find((e) => e.id === r.event);
    if (!ev) throw badRequest(`${where}: this form has no event "${r.event}". Events: ${events.map((e) => e.id).join(", ")}.`);
    const badSite = [...(r.sites ?? []), ...r.to.flatMap((t) => (t.kind === "person" ? t.sites ?? [] : []))].find((s) => !siteCodes.has(s));
    if (badSite) throw badRequest(`${where}: no site with the code "${badSite}".`);
    for (const t of r.to) {
      if (t.kind === "role" && !isRoleKey(t.role)) throw badRequest(`${where}: "${t.role}" isn't a role. Roles: ${ROLES.map((x) => x.key).join(", ")}.`);
      // A code form's events are described by its author; an undeclared field may still be passed, so only basic forms are strict.
      if (t.kind === "field" && form.kind === "basic" && !(ev.people ?? []).some((p) => p.id === t.field)) {
        throw badRequest(`${where}: "${t.field}" isn't an email field on this form.${ev.people?.length ? ` Email fields: ${ev.people.map((p) => p.id).join(", ")}.` : ""}`);
      }
    }
    return r;
  });
}

export async function saveRouting(form: BuiltForm, routesIn: unknown[], actor: Actor, revision?: number): Promise<RoutingDoc> {
  const routes = await checkRoutes(form, routesIn);
  const now = await loadRouting(form);
  if (revision !== undefined && revision !== now.revision) {
    throw badRequest(`Someone else changed this form's routing${now.updatedByName ? ` (${now.updatedByName})` : ""} since you opened it. Reload to see their changes.`);
  }
  const data = JSON.stringify({ routes, revision: now.revision + 1 });
  await prisma.formRecord.upsert({
    where: { formId_collection_docId: { formId: form.id, collection: COLLECTION, docId: DOC } },
    create: { formId: form.id, collection: COLLECTION, docId: DOC, data, updatedByName: actor.name },
    update: { data, updatedByName: actor.name },
  });
  await audit({ actor, action: "forms.routing_saved", summary: `Changed who's told about “${form.title}” (${routes.length} route${routes.length === 1 ? "" : "s"})` });
  return loadRouting(form);
}

/** Forget the saved routing: the form's defaults apply again. */
export async function resetRouting(form: BuiltForm, actor: Actor): Promise<RoutingDoc> {
  await prisma.formRecord.deleteMany({ where: { formId: form.id, collection: COLLECTION, docId: DOC } });
  await audit({ actor, action: "forms.routing_reset", summary: `Put “${form.title}”'s routing back to the form's defaults` });
  return loadRouting(form);
}

/** A new route id that isn't taken. */
export function newRouteId(taken: string[], name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "route";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

// ── Sending ──────────────────────────────────────────────────────────────

export interface RouteInput {
  event: string;
  /** The default title and email subject. One line, no resident details. */
  title: string;
  /** Shown in the app only. */
  body?: string | null;
  /** A page of this site the notification and email open. */
  link?: string | null;
  site?: Site | null;
  /** Values routes test (`when`). */
  data?: Values;
  /** People the event names, by field: an address, a user id, or a list of them. */
  people?: Record<string, unknown>;
  submitterId?: string | null;
  entryId?: string | null;
}

export interface RoutePlan {
  routeId: string;
  routeName: string;
  /** Account holders, told in the app (and by email). */
  people: { id: string; name: string; email: string }[];
  /** Addresses with no account here: a link-only email. */
  emails: string[];
  /** Why someone on the route wasn't reached (no site, no address given…). */
  notes: string[];
}

export interface RouteOutcome {
  event: string;
  routes: RoutePlan[];
  /** Account holders notified, and addresses emailed. */
  told: number;
  emailed: number;
  preview?: boolean;
  reason?: string;
}

/** The addresses or user ids a value holds: "a@b.org", ["id1", …], { email }, { id }. */
function addressesIn(v: unknown): string[] {
  if (v == null || v === "") return [];
  if (Array.isArray(v)) return v.flatMap(addressesIn);
  if (typeof v === "object") {
    const o = v as { email?: unknown; id?: unknown; userId?: unknown };
    return addressesIn(o.email ?? o.userId ?? o.id);
  }
  return String(v).split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

function render(tpl: string, form: BuiltForm, input: RouteInput, label: string) {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(new Date());
  const tags: Record<string, string> = { form: form.title, site: input.site?.name ?? "", event: label, title: input.title, date: day };
  return tpl.replace(/\{(form|site|event|title|date)\}/g, (_, k: string) => tags[k]).replace(/\s{2,}/g, " ").replace(/\s+([-–—:·,])\s*$/, "").trim().slice(0, 200);
}

/** Who each matching route reaches, nobody twice. Nothing is sent. */
export async function planRoutes(form: BuiltForm, routes: Route[], input: RouteInput): Promise<RoutePlan[]> {
  const told = new Set<string>();
  const plans: RoutePlan[] = [];
  const values: Values = { ...(input.data ?? {}), site: input.site?.code ?? "" };
  for (const r of routes) {
    if (!r.enabled || r.event !== input.event) continue;
    if (r.sites?.length && !(input.site && r.sites.includes(input.site.code))) continue;
    if (r.when?.rules.length && !conditionPasses({ action: "show", match: r.when.match, rules: r.when.rules }, values)) continue;

    const plan: RoutePlan = { routeId: r.id, routeName: r.name, people: [], emails: [], notes: [] };
    const named: string[] = [];
    const roleGroups: { roles: string[]; sites?: string[] }[] = [];
    for (const t of r.to as Recipient[]) {
      if (t.kind === "person") {
        if (t.sites?.length && !(input.site && t.sites.includes(input.site.code))) continue;
        named.push(t.email);
      } else if (t.kind === "field") {
        const found = addressesIn(input.people?.[t.field] ?? input.data?.[t.field]);
        if (!found.length) plan.notes.push(`Nobody in “${t.field}”.`);
        named.push(...found);
      } else if (t.kind === "submitter") {
        if (input.submitterId) named.push(input.submitterId);
        else plan.notes.push("Nobody filed it (no signed-in person).");
      } else if (t.siteOnly === false) {
        roleGroups.push({ roles: [t.role] });
      } else if (input.site) {
        roleGroups.push({ roles: [t.role], sites: [input.site.id] });
      } else {
        plan.notes.push(`${ROLES.find((x) => x.key === t.role)?.name ?? t.role} at the site: this event has no site.`);
      }
    }

    const found = new Map<string, { id: string; email: string }>();
    if (named.length) {
      const { people, unknown } = await resolveAudience({ users: named });
      for (const p of people) found.set(p.id, p);
      // An id of someone not active yet (invited, waiting): their address still gets the link-only email.
      const ids = unknown.filter((u) => !u.includes("@"));
      const byId = new Map(ids.length ? (await prisma.user.findMany({ where: { id: { in: ids }, status: { not: "deactivated" } }, select: { id: true, email: true } })).map((u) => [u.id, u.email]) : []);
      for (const u of unknown.map((x) => byId.get(x) ?? x)) {
        if (!u.includes("@")) plan.notes.push(`No active person with the id ${u}.`);
        else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u) && !told.has(u.toLowerCase())) {
          told.add(u.toLowerCase());
          plan.emails.push(u.toLowerCase());
        }
      }
    }
    for (const g of roleGroups) for (const p of (await resolveAudience(g)).people) found.set(p.id, p);
    const fresh = [...found.values()].filter((p) => !told.has(p.id) && !told.has(p.email.toLowerCase()));
    const names = new Map((await prisma.user.findMany({ where: { id: { in: fresh.map((p) => p.id) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    for (const p of fresh) {
      told.add(p.id);
      told.add(p.email.toLowerCase());
      plan.people.push({ id: p.id, name: names.get(p.id) || p.email, email: p.email });
    }
    plans.push(plan);
  }
  const total = plans.reduce((n, p) => n + p.people.length + p.emails.length, 0);
  if (total > MAX_PER_EVENT) throw badRequest(`This would tell ${total} people about one event; the most is ${MAX_PER_EVENT}. Narrow the routes with sites or roles.`);
  return plans;
}

async function writeLog(formId: string, entry: Record<string, unknown>) {
  const docId = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  await prisma.formRecord.create({ data: { formId, collection: LOG, docId, data: JSON.stringify({ at: new Date().toISOString(), ...entry }), updatedByName: String(entry.actor ?? "System").slice(0, 255) } });
  const old = await prisma.formRecord.findMany({ where: { formId, collection: LOG }, orderBy: { createdAt: "desc" }, skip: LOG_KEEP, take: 200, select: { id: true } });
  if (old.length) await prisma.formRecord.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
}

/** What routing has sent for a form, newest first. */
export async function routingLog(formId: string, opts: { limit?: number; entryId?: string } = {}) {
  const rows = await prisma.formRecord.findMany({ where: { formId, collection: LOG }, orderBy: { createdAt: "desc" }, take: Math.min(opts.limit ?? 50, 200) * (opts.entryId ? 4 : 1) });
  const items = rows.map((r) => ({ id: r.docId, ...(JSON.parse(r.data) as Record<string, unknown>) }) as { id: string; entryId?: string | null } & Record<string, unknown>);
  return (opts.entryId ? items.filter((i) => i.entryId === opts.entryId) : items).slice(0, opts.limit ?? 50);
}

/**
 * Route one event: work out who each matching route reaches and tell them.
 * `preview` (a code form's draft) tells only `previewUserId`, titled "Preview: …",
 * and says who the published form would have told. `dryRun` sends nothing.
 */
export async function routeEvent(
  form: BuiltForm,
  input: RouteInput,
  opts: { actor: Actor; manifest?: Known; preview?: boolean; previewUserId?: string | null; dryRun?: boolean; routes?: Route[]; onlyRoute?: string }
): Promise<RouteOutcome> {
  const events = eventsOf(form, opts.manifest);
  const ev = events.find((e) => e.id === input.event);
  if (!ev) throw badRequest(`This form has no event "${input.event}". Declare it in form.json "routing": { "events": [...] }.`);
  const title = input.title?.replace(/[\r\n]+/g, " ").trim();
  if (!title) throw badRequest("A routed event needs a title (one line, no resident details).");
  const link = sitePath(input.link) ?? (form.kind === "code" ? `/apps/${form.slug}` : input.entryId ? `/f/${form.slug}/entries/${input.entryId}` : `/f/${form.slug}`);
  let routes = opts.routes ?? (await loadRouting(form, opts.manifest)).routes;
  if (opts.onlyRoute) routes = routes.filter((r) => r.id === opts.onlyRoute);
  const plans = await planRoutes(form, routes, input);
  const reach = plans.reduce((n, p) => n + p.people.length + p.emails.length, 0);
  const subjectOf = (r: Route | undefined) => (r?.subject ? render(r.subject, form, input, ev.label) : title.slice(0, 200)) || title.slice(0, 200);
  const describe = plans.map((p) => `${p.routeName}: ${[...p.people.map((x) => x.name), ...p.emails].join(", ") || "nobody"}`).join("; ");

  if (opts.dryRun) return { event: input.event, routes: plans, told: 0, emailed: 0, reason: reach ? undefined : "No route matches, or the matching routes reach nobody." };

  if (opts.preview) {
    let told = 0;
    if (opts.previewUserId && plans.length) {
      const out = await notify({ to: { users: [opts.previewUserId] }, type: "forms.message", title: `Preview: ${subjectOf(routes.find((r) => r.id === plans[0].routeId))}`, body: input.body ?? null, link, source: `form:${form.slug}`, sourceLabel: form.title, formId: form.id });
      told = out.sent;
    }
    return { event: input.event, routes: plans, told, emailed: 0, preview: true, reason: `The draft tells only you. Published, “${ev.label}” would go to ${describe || "nobody (no route matches)"}.` };
  }

  if (!reach) {
    if (plans.some((p) => p.notes.length)) await writeLog(form.id, { event: input.event, entryId: input.entryId ?? null, routes: plans, told: 0, emailed: 0, actor: opts.actor.name, title });
    return { event: input.event, routes: plans, told: 0, emailed: 0, reason: plans.length ? "The matching routes reach nobody." : "No route matches." };
  }

  const now = Date.now();
  const recent = (sentLastHour.get(form.id) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length + reach > PER_FORM_HOURLY) throw badRequest(`This form has told ${recent.length} people in the last hour through routing; the most is ${PER_FORM_HOURLY}. Try again later.`);
  for (let i = 0; i < reach; i++) recent.push(now);
  sentLastHour.set(form.id, recent);

  let told = 0;
  let emailed = 0;
  const failures: string[] = [];
  for (const plan of plans) {
    const route = routes.find((r) => r.id === plan.routeId)!;
    const subject = subjectOf(route);
    if (plan.people.length) {
      try {
        const out = await notify({
          to: { users: plan.people.map((p) => p.id) },
          type: "forms.message",
          title: subject,
          body: input.body ?? null,
          link,
          source: `form:${form.slug}`,
          sourceLabel: form.title,
          formId: form.id,
          forceEmail: route.email !== "prefs",
          urgent: route.urgent,
        });
        told += out.sent;
        emailed += out.emailed;
      } catch (err) {
        failures.push(`${plan.routeName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (plan.emails.length) {
      if (!mailConfigured()) plan.notes.push(`Not emailed (${plan.emails.join(", ")}): email isn't set up on this server (MAIL_FROM).`);
      else {
        const lead = `There's something for you in “${form.title}”${input.site ? ` for ${input.site.name}` : ""}.`;
        for (const to of plan.emails) {
          // One email each, so nobody sees who else is on the list.
          void sendMail({ to: [to], subject, html: linkOnlyHtml(lead, `${appBaseUrl}${link}`) }).catch((err) =>
            audit({ actor: opts.actor, action: "forms.routing_email_failed", summary: `“${form.title}” couldn't email ${to}: ${subject} (${err instanceof Error ? err.message : err})` }).catch(() => undefined)
          );
          emailed++;
        }
      }
    }
  }
  await writeLog(form.id, { event: input.event, entryId: input.entryId ?? null, site: input.site?.code ?? null, title, routes: plans, told, emailed, failures, actor: opts.actor.name });
  await audit({ actor: opts.actor, action: "forms.routed", summary: `“${form.title}” ${ev.label.toLowerCase()}: told ${describe}`.slice(0, 1000) }).catch(() => undefined);
  return { event: input.event, routes: plans, told, emailed, ...(failures.length ? { reason: failures.join(" ") } : {}) };
}

/** routeEvent that never throws: for saves, where a routing problem mustn't fail the entry. */
export async function routeQuietly(form: BuiltForm, input: RouteInput, actor: Actor, manifest?: Known): Promise<RouteOutcome | null> {
  try {
    return await routeEvent(form, input, { actor, manifest });
  } catch (err) {
    console.error(`[routing] ${form.slug} ${input.event} failed:`, err);
    await writeLog(form.id, { event: input.event, entryId: input.entryId ?? null, routes: [], told: 0, emailed: 0, failures: [err instanceof Error ? err.message : String(err)], actor: actor.name, title: input.title }).catch(() => undefined);
    return null;
  }
}

/** One line for an entry's notes: who routing told. */
export function outcomeNote(out: RouteOutcome | null): string | null {
  if (!out || !out.routes.length) return null;
  const who = out.routes.map((p) => `${p.routeName} → ${[...p.people.map((x) => x.name), ...p.emails].join(", ") || "nobody"}`).join("; ");
  return `Routing: ${who}.${out.reason ? ` ${out.reason}` : ""}`.slice(0, 2000);
}

// ── Entries ──────────────────────────────────────────────────────────────

/** The routing input for a saved entry (entry.created), either kind of form. */
export async function entryInput(form: BuiltForm, entry: { id: string; data: string; siteId: string | null; createdById: string | null }): Promise<RouteInput> {
  const site = entry.siteId ? await prisma.site.findUnique({ where: { id: entry.siteId }, select: { id: true, code: true, name: true } }) : null;
  const data = JSON.parse(entry.data) as Values;
  return {
    event: ENTRY_CREATED,
    title: `New entry: ${form.title}${site ? ` at ${site.name}` : ""}`,
    link: form.kind === "code" ? `/apps/${form.slug}` : `/f/${form.slug}/entries/${entry.id}`,
    site,
    data,
    people: data,
    submitterId: entry.createdById,
    entryId: entry.id,
  };
}

/** Send an entry's "entry.created" routes again (or only one route), e.g. after fixing a list. */
export async function rerouteEntry(form: BuiltForm, entryId: string, actor: Actor, opts: { route?: string; dryRun?: boolean } = {}) {
  const entry = await prisma.formEntry.findFirst({ where: { id: entryId, formId: form.id } });
  if (!entry) throw notFound("That form has no such entry.");
  return routeEvent(form, await entryInput(form, entry), { actor, onlyRoute: opts.route, dryRun: opts.dryRun });
}
