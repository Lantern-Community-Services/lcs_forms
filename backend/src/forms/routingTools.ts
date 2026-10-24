import { z } from "zod";
import { prisma } from "../prisma.js";
import { HttpError } from "../http.js";
import type { Actor } from "../services/audit.js";
import { ROLES } from "../services/permissions.js";
import {
  eventsOf, loadRouting, newRouteId, planRoutes, rerouteEntry, resetRouting, routingForm, routingLog, saveRouting,
} from "../services/routing.js";
import { ENTRY_CREATED } from "./routingSchema.js";
import type { ToolRegistrar } from "./mcp.js";

/**
 * MCP tools for notification routing (services/routing.ts): read a form's
 * routes, change them (the whole list, or one route), see who a route would
 * reach, read what was sent, and send an entry's routes again. The same rules
 * as Admin → Notification routing. Needs forms:build.
 */

const formRef = z.string().describe("The form's id or slug — either kind.");

const recipient = z
  .record(z.unknown())
  .describe('One of: { kind: "person", email, name?, sites?: [site codes] } (anyone: an account holder is told in the app and by email, anyone else gets a link-only email; sites = only for events at those sites) · { kind: "role", role, siteOnly?: true } (everyone with the role at the event\'s site; siteOnly false = everywhere) · { kind: "field", field } (a person the event names, e.g. "supervisor") · { kind: "submitter" } (whoever filed the entry) · { kind: "group", group: <staff group id from list_staff_groups>, siteOnly?: true } (everyone in that team; default wherever they work, siteOnly = only at the event\'s site) · { kind: "title", title, siteOnly?: true } (everyone with that exact job title, a position)');

const routeShape = {
  id: z.string().optional().describe("Keep a route's id to change it; omit to add a new one (made from the name)."),
  name: z.string().describe('What it\'s for, e.g. "Main Office copy"'),
  event: z.string().describe(`An event from get_routing (every form has "${ENTRY_CREATED}")`),
  enabled: z.boolean().optional(),
  when: z
    .object({ match: z.enum(["all", "any"]).optional(), rules: z.array(z.object({ field: z.string(), op: z.string(), value: z.union([z.string(), z.number(), z.boolean()]).optional() })) })
    .optional()
    .describe('Only when the event\'s values match, e.g. { match: "any", rules: [{ field: "status", op: "is", value: "Immediate intervention" }] }. Ops: is, is_not, contains, not_contains, gt, lt, gte, lte, starts_with, ends_with, empty, not_empty. "site" holds the site code.'),
  sites: z.array(z.string()).optional().describe("Only events at these sites (codes, see list_sites). Omit for every site."),
  to: z.array(recipient).describe("Who's told"),
  email: z.enum(["always", "prefs"]).optional().describe('"always" (default): everyone on it is emailed (link-only) whatever their settings. "prefs": account holders get it as they chose on their Profile.'),
  subject: z.string().optional().describe("Title and email subject; tags {form} {site} {event} {title} {date}. Default: the event's own title. Never resident details."),
  urgent: z
    .boolean()
    .optional()
    .describe("Needs attention now (an incident, a request that can't wait): red in the bell, pinned at the top of their notifications until read, and emailed at once even to people on a daily summary. Default false."),
};

export function registerRoutingTools(tool: ToolRegistrar, need: (scope: string) => void, actor: Actor) {
  tool(
    "get_routing",
    "A form's notification routing: the events it can route (with the values a route can test and the people it names), its routes (who's told about what, at which sites), whether they're still the form's defaults, its revision, and the last sends. Works for basic and code forms. Change it with set_routing or save_route.",
    { form: formRef },
    async ({ form }) => {
      need("forms:build");
      const f = await routingForm(form);
      return {
        form: { id: f.id, slug: f.slug, title: f.title, kind: f.kind },
        events: eventsOf(f),
        roles: ROLES.map((r) => ({ key: r.key, name: r.name, everySite: r.allSites })),
        ...(await loadRouting(f)),
        recent: await routingLog(f.id, { limit: 10 }),
        howItWorks: [
          `Every form has "${ENTRY_CREATED}" (routed when an entry is saved). Code forms add their own events in form.json "routing" and fire them with ctx.notify.route.`,
          "A route matches its event, then its sites (if any), then its `when` rules. Every matching route is sent; nobody is told twice for one event.",
          "Account holders get a notification in the app plus a link-only email; addresses without an account get the link-only email. Emails never carry answers or resident details.",
          "Until routing is saved the form's defaults (form.json routing.defaults) apply; reset_routing returns to them.",
        ],
      };
    },
    { readOnlyHint: true }
  );

  tool(
    "set_routing",
    "Replace a form's whole routing with this list of routes (an empty list stops all routed notifications). Pass the revision from get_routing so you don't overwrite someone else's change. Answers the saved routing.",
    { form: formRef, routes: z.array(z.object(routeShape)).max(100), revision: z.number().int().optional() },
    async ({ form, routes, revision }) => {
      need("forms:build");
      const f = await routingForm(form);
      const taken: string[] = routes.flatMap((r) => (r.id ? [r.id] : []));
      const withIds = routes.map((r) => {
        if (r.id) return r;
        const id = newRouteId(taken, r.name);
        taken.push(id);
        return { ...r, id };
      });
      return saveRouting(f, withIds, actor, revision);
    }
  );

  tool(
    "save_route",
    "Add one route to a form's routing, or change one (pass its id). Other routes are kept. Starting from the form's defaults, the defaults are kept too.",
    { form: formRef, ...routeShape },
    async ({ form, ...route }) => {
      need("forms:build");
      const f = await routingForm(form);
      const now = await loadRouting(f);
      const exists = route.id ? now.routes.some((r) => r.id === route.id) : false;
      const id = route.id ?? newRouteId(now.routes.map((r) => r.id), route.name);
      const next = exists ? now.routes.map((r) => (r.id === id ? { ...route, id } : r)) : [...now.routes, { ...route, id }];
      const saved = await saveRouting(f, next, actor, now.revision);
      return { saved: saved.routes.find((r) => r.id === id), added: !exists, routes: saved.routes.length, revision: saved.revision };
    }
  );

  tool(
    "remove_route",
    "Remove one route from a form's routing. Destructive: pass confirm: true after checking with the person.",
    { form: formRef, id: z.string(), confirm: z.boolean().optional() },
    async ({ form, id, confirm }) => {
      need("forms:build");
      if (!confirm) throw new HttpError(400, "Removing a route stops those people being told. Pass confirm: true once the person has agreed.");
      const f = await routingForm(form);
      const now = await loadRouting(f);
      if (!now.routes.some((r) => r.id === id)) throw new HttpError(404, `No route "${id}". Routes: ${now.routes.map((r) => r.id).join(", ") || "(none)"}.`);
      const saved = await saveRouting(f, now.routes.filter((r) => r.id !== id), actor, now.revision);
      return { removed: id, routes: saved.routes.length, revision: saved.revision };
    },
    { destructiveHint: true }
  );

  tool(
    "reset_routing",
    "Throw away a form's saved routing and go back to the routes the form ships with (form.json routing.defaults; none for a basic form). Destructive: pass confirm: true.",
    { form: formRef, confirm: z.boolean().optional() },
    async ({ form, confirm }) => {
      need("forms:build");
      if (!confirm) throw new HttpError(400, "This discards the form's saved routing. Pass confirm: true once the person has agreed.");
      return resetRouting(await routingForm(form), actor);
    },
    { destructiveHint: true }
  );

  tool(
    "preview_routing",
    "Who an event would reach, without sending anything: give the event, a site code and the values routes test (and the people it names, by field). Uses the saved routes, or `routes` to try a change first.",
    {
      form: formRef,
      event: z.string().optional().describe(`Default "${ENTRY_CREATED}"`),
      site: z.string().optional().describe("Site code"),
      data: z.record(z.unknown()).optional().describe('Values routes test, e.g. { "status": "Follow-up needed" }'),
      people: z.record(z.unknown()).optional().describe('People the event names, e.g. { "supervisor": "someone@lanterncommunity.org" }'),
      submitter: z.string().optional().describe("Email or user id of whoever filed it"),
      routes: z.array(z.object(routeShape)).optional().describe("Try these instead of the saved routes"),
    },
    async ({ form, event, site, data, people, submitter, routes }) => {
      need("forms:build");
      const f = await routingForm(form);
      const s = site ? await prisma.site.findFirst({ where: { OR: [{ id: site }, { code: site }] }, select: { id: true, code: true, name: true } }) : null;
      if (site && !s) throw new HttpError(400, `No site "${site}".`);
      let submitterId: string | null = null;
      if (submitter) {
        const u = await prisma.user.findFirst({ where: { OR: [{ id: submitter }, { email: submitter.toLowerCase() }] }, select: { id: true } });
        submitterId = u?.id ?? null;
      }
      const list = routes ? routes.map((r, i) => ({ enabled: true, email: "always" as const, ...r, id: r.id ?? `try-${i + 1}` })) : (await loadRouting(f)).routes;
      const plans = await planRoutes(f, list as never, { event: event ?? ENTRY_CREATED, title: "Preview", site: s, data: data ?? {}, people: people ?? {}, submitterId });
      return { event: event ?? ENTRY_CREATED, site: s?.code ?? null, routes: plans, nobody: !plans.some((p) => p.people.length || p.emails.length) };
    },
    { readOnlyHint: true }
  );

  tool(
    "routing_log",
    "What a form's routing has sent, newest first: the event, each route that matched and whom it told, and any problems. Pass entry to see one entry's.",
    { form: formRef, entry: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
    async ({ form, entry, limit }) => {
      need("forms:build");
      const f = await routingForm(form);
      return { items: await routingLog(f.id, { limit, entryId: entry }) };
    },
    { readOnlyHint: true }
  );

  tool(
    "reroute_entry",
    `Send one saved entry's "${ENTRY_CREATED}" routes again (all of them, or one route), e.g. after fixing a list. dryRun: true says who'd be told without sending. Events a code form fires itself (ctx.notify.route) can't be resent from here.`,
    { form: formRef, entry: z.string(), route: z.string().optional(), dryRun: z.boolean().optional() },
    async ({ form, entry, route, dryRun }) => {
      need("forms:build");
      need("notifications:send");
      return rerouteEntry(await routingForm(form), entry, actor, { route, dryRun });
    }
  );
}
