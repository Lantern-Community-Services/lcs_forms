import { z } from "zod";

/**
 * The shape of a form's notification routing (services/routing.ts), kept apart
 * from the service so form.json's schema (apps/project.ts) can use it without
 * importing the database.
 *
 * A form's routing is a list of routes. Each route says: when this event
 * happens (optionally only at these sites, only when these answers match),
 * tell these people. People are named addresses (anyone: an account holder is
 * told in the app, anyone else gets a link-only email), everyone with a role
 * (at the event's site, or everywhere), a person the event names (a field such
 * as "the supervisor chosen on the form"), or whoever filed the entry.
 */

export const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
export const ROUTE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
export const EVENT_ID_RE = /^[a-z][a-z0-9_.-]{0,63}$/;

/** Every form has this event: an entry was saved. */
export const ENTRY_CREATED = "entry.created";

export const recipientSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("person"),
    email: z.string().trim().toLowerCase().regex(EMAIL_RE, "That isn't an email address."),
    name: z.string().trim().max(120).optional(),
    /** Only for events at these sites (codes). Omit for every site. */
    sites: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
  }).strict(),
  z.object({
    kind: z.literal("role"),
    role: z.string().trim().min(1).max(64),
    /** Only people with the role at the event's site (default). False: everyone with the role. */
    siteOnly: z.boolean().optional(),
  }).strict(),
  z.object({
    kind: z.literal("field"),
    /** A person the event names: one of the event's `people` (or an answer holding an address). */
    field: z.string().trim().min(1).max(64),
  }).strict(),
  z.object({ kind: z.literal("submitter") }).strict(),
  z.object({
    kind: z.literal("group"),
    /** A staff group's id: everyone in it, from their job title or added by an admin. */
    group: z.string().trim().min(1).max(64),
    /** True: only those at the event's site. Default: the whole group, wherever they work. */
    siteOnly: z.boolean().optional(),
  }).strict(),
  z.object({
    kind: z.literal("title"),
    /** A position: everyone with this exact job title, any case. */
    title: z.string().trim().min(1).max(255),
    /** True: only those at the event's site. Default: everyone with it, wherever they work. */
    siteOnly: z.boolean().optional(),
  }).strict(),
]);

const ruleSchema = z.object({
  field: z.string().trim().min(1).max(130),
  op: z.enum(["is", "is_not", "gt", "lt", "gte", "lte", "contains", "not_contains", "starts_with", "ends_with", "empty", "not_empty"]),
  value: z.union([z.string().max(500), z.number(), z.boolean()]).optional(),
}).strict();

export const routeSchema = z.object({
  id: z.string().regex(ROUTE_ID_RE, "Route ids use letters, digits, - and _ (max 64)."),
  name: z.string().trim().min(1, "Give the route a name.").max(120),
  /** The event it answers: "entry.created", or one the form declares in form.json "routing". */
  event: z.string().regex(EVENT_ID_RE, "Event ids are lowercase: letters, digits, . - and _."),
  enabled: z.boolean().default(true),
  /** Only when the event's values match: all of the rules (default) or any. */
  when: z.object({ match: z.enum(["all", "any"]).default("all"), rules: z.array(ruleSchema).max(50) }).strict().optional(),
  /** Only events at these sites (codes). Omit or empty for every site. */
  sites: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
  to: z.array(recipientSchema).min(1, "Add at least one person to tell.").max(200),
  /**
   * "always" (default): everyone on the route is emailed (link-only), whatever their own
   * notification settings, and account holders see it in the app too. "prefs": account
   * holders get it as each has chosen on their Profile.
   */
  email: z.enum(["always", "prefs"]).default("always"),
  /** What the people on this route have to do, shown in the email (plain text, no answers). */
  whatToDo: z.string().trim().max(500).optional(),
  /** Answers shown in the email (to Lantern addresses only): ids from emailableFields. */
  fields: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  /** Needs attention now: marked urgent in the app and emailed at once (services/notifications.ts). */
  urgent: z.boolean().default(false),
  /** The notification's title and email subject. {form} {site} {event} {title} {date}. Default: the event's own title. */
  subject: z.string().trim().max(200).optional(),
}).strict();

export type Recipient = z.infer<typeof recipientSchema>;
export type Route = z.infer<typeof routeSchema>;

/** An event a form can route, as form.json "routing" declares it (and entry.created, which every form has). */
export const routingEventSchema = z.object({
  id: z.string().regex(EVENT_ID_RE),
  label: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  /** Values a route can test (`when`). choices: the values it can take, for a picker. */
  fields: z.array(z.object({ id: z.string().min(1).max(64), label: z.string().min(1).max(80), choices: z.array(z.string().max(120)).max(100).optional() }).strict()).max(40).optional(),
  /** People the event names, whom a route can tell ({ kind: "field" }). */
  people: z.array(z.object({ id: z.string().min(1).max(64), label: z.string().min(1).max(80) }).strict()).max(20).optional(),
}).strict();

export type RoutingEvent = z.infer<typeof routingEventSchema>;

/** form.json "routing": the events server code routes (ctx.notify.route) and the routes the form starts with. */
export const manifestRoutingSchema = z.object({
  events: z.array(routingEventSchema).max(30).optional(),
  /** Used until someone saves the form's routing (Admin → Notification routing or the MCP). */
  defaults: z.array(routeSchema).max(50).optional(),
}).strict();
