import { z } from "zod";
import { prisma } from "../prisma.js";
import { HttpError } from "../http.js";
import type { Actor } from "../services/audit.js";
import { ROLES } from "../services/permissions.js";
import {
  eventsOf, loadRouting, newRouteId, planRoutes, rerouteEntry, resetRouting, routingForm, routingLog, saveRouting, emailableFields, routeEmailPreview,
} from "../services/routing.js";
import { loadReports, saveReports, sendReport } from "../services/emailReports.js";
import { sentEmails } from "../services/mailer.js";
import { followUpView, saveFollowUp, setFollowUp } from "../services/followUp.js";
import { convertRules } from "../services/ruleConversion.js";
import { DEFAULT_MESSAGE_TEMPLATE, DEFAULT_REPORT_TEMPLATE, listTemplates } from "../services/emailTemplates.js";
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
  .describe('One of: { kind: "person", email, name?, sites?: [site codes] } (anyone: an account holder is told in the app and by email, anyone else gets a link-only email; sites = only for events at those sites) · { kind: "role", role, siteOnly?: true } (everyone with the role at the event\'s site; siteOnly false = everywhere) · { kind: "field", field } (a person the event names, e.g. "supervisor") · { kind: "submitter" } (whoever filed the entry) · { kind: "sharer" } (the employee whose share link the entry came through, on a form shared by link) · { kind: "group", group: <staff group id from list_staff_groups>, siteOnly?: true } (everyone in that team; default wherever they work, siteOnly = only at the event\'s site) · { kind: "title", title, siteOnly?: true } (everyone with that exact job title, a position)');

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
  template: z
    .string()
    .optional()
    .describe(`An organization email template's key (get_email_settings lists them; "${DEFAULT_MESSAGE_TEMPLATE}" is the everyday one): its subject, heading, line, What to do, details and button are the email's wording, instead of subject and whatToDo. The route still says who, when, which answers and whether it's urgent. Omit to use the route's own subject and whatToDo.`),
  subject: z.string().optional().describe("Title and email subject when the route has no template; tags {form} {site} {event} {title} {date}. Default: the event's own title. Never resident details."),
  whatToDo: z.string().optional().describe("What the people on this route have to do, shown in the email, e.g. \"Review and sign within 24 hours.\" Plain text; no resident details."),
  fields: z
    .array(z.string())
    .optional()
    .describe("Answers shown in the email, to Lantern addresses only: ids from get_email_settings' emailFields (never residents, names, contact details, signatures, files or paragraphs). Anyone else gets the link-only email."),
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
          "Account holders get a notification in the app plus an email; addresses without an account get the email only. The email is the branded layout with the route's whatToDo and, for Lantern addresses only, the answers chosen in `fields` (get_email_settings lists which may be chosen). Resident details never go in an email.",
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

  // ── Emails: what they say, weekly summary reports, what was sent ──

  tool(
    "get_email_settings",
    "A form's emails: the answers that may be put in an email (emailFields; never residents, names, contact details, signatures, files or paragraphs), each route's whatToDo and chosen fields, and its weekly summary reports. Change a route's email with save_route (whatToDo, fields); reports with save_email_report.",
    { form: formRef },
    async ({ form }) => {
      need("forms:build");
      const f = await routingForm(form);
      const routing = await loadRouting(f);
      return {
        form: { id: f.id, slug: f.slug, title: f.title, kind: f.kind },
        emailFields: emailableFields(f),
        routes: routing.routes.map((r) => ({ id: r.id, name: r.name, event: r.event, template: r.template ?? null, subject: r.subject ?? null, whatToDo: r.whatToDo ?? null, fields: r.fields ?? [], urgent: Boolean(r.urgent) })),
        reports: (await loadReports(f)).reports,
        // The organization's templates a route or report can use (Super Admins change them: list_email_templates).
        templates: (await listTemplates())
          .filter((t) => !t.hidden)
          .map((t) => ({ key: t.key, name: t.name, kind: t.kind, description: t.description, urgent: t.urgent })),
        defaults: { route: DEFAULT_MESSAGE_TEMPLATE, report: DEFAULT_REPORT_TEMPLATE },
        rules: [
          "Every email uses the Lantern layout: band, heading, What to do, the chosen answers, a button into the site.",
          "Chosen answers go to Lantern addresses only. Anyone else gets the same email without them.",
          "Subjects never carry answers: use {form} {site} {title} {date}.",
          "A route or report with a template uses the template's wording: change it for every form in Admin → Notifications → Templates (Super Admins), or give that one route its own subject and whatToDo instead.",
        ],
      };
    }
  );

  tool(
    "preview_email",
    "The email a route sends, rendered (HTML), for the form's latest entry or a given one: as a Lantern address gets it (inside) and as anyone else does (outside). Pass a saved route's id, or a whole route to try before saving. Nothing is sent.",
    {
      form: formRef,
      routeId: z.string().optional().describe("A saved route's id (get_routing)"),
      route: z.object(routeShape).optional().describe("A route to try instead of a saved one"),
      entryId: z.string().optional().describe("Default: the latest entry"),
    },
    async ({ form, routeId, route, entryId }) => {
      need("forms:build");
      const f = await routingForm(form);
      const saved = routeId ? (await loadRouting(f)).routes.find((r) => r.id === routeId) : undefined;
      if (routeId && !saved) throw new HttpError(404, `No route "${routeId}". Use get_routing.`);
      const r = saved ?? (route ? { enabled: true, email: "always" as const, urgent: false, ...route, id: route.id ?? "preview", to: route.to as never } : null);
      if (!r) throw new HttpError(400, "Pass routeId or route.");
      return routeEmailPreview(f, r as never, entryId);
    }
  );

  tool(
    "save_email_report",
    "Add a weekly summary report to a form, or change one (pass its id): the past 7 days' entries, emailed on a day (0 Sunday … 6 Saturday) and hour (0-23, New York time) to the same kinds of recipients as a route. split \"all\" sends one report for every site; \"site\" one per site, each to that site's people. fields are the table's columns (get_email_settings emailFields), shown to Lantern addresses only; anyone else gets the count and a button. includeEmpty sends a \"nothing this week\" email too.",
    {
      form: formRef,
      id: z.string().optional().describe("Keep a report's id to change it; omit to add one"),
      name: z.string().describe('e.g. "Unit Inspection Weekly Report"'),
      enabled: z.boolean().optional(),
      day: z.number().int().min(0).max(6),
      hour: z.number().int().min(0).max(23),
      split: z.enum(["all", "site"]).optional(),
      includeEmpty: z.boolean().optional(),
      fields: z.array(z.string()).optional(),
      to: z.array(recipient).describe("Who gets it: the same recipient kinds as a route"),
      template: z.string().optional().describe(`A report template's key (get_email_settings templates, kind "report"; "${DEFAULT_REPORT_TEMPLATE}" is the standard one): its subject, heading and What to do. Omit for the report's own whatToDo.`),
      whatToDo: z.string().optional().describe("What to do, when the report has no template"),
    },
    async ({ form, ...report }) => {
      need("forms:build");
      const f = await routingForm(form);
      const now = await loadReports(f);
      const id = report.id ?? (report.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "report");
      const list = now.reports.map(({ nextRun: _n, ...r }) => r);
      const next = list.some((r) => r.id === id) ? list.map((r) => (r.id === id ? { ...r, ...report, id } : r)) : [...list, { ...report, id }];
      const saved = await saveReports(f, next, actor, now.revision);
      return { saved: saved.reports.find((r) => r.id === id), reports: saved.reports.length };
    },
    { destructiveHint: true }
  );

  tool(
    "remove_email_report",
    "Remove a weekly summary report from a form. Destructive: pass confirm: true after checking with the person.",
    { form: formRef, id: z.string(), confirm: z.boolean().optional() },
    async ({ form, id, confirm }) => {
      need("forms:build");
      if (!confirm) throw new HttpError(400, "Removing a report stops it being sent. Pass confirm: true once the person has agreed.");
      const f = await routingForm(form);
      const now = await loadReports(f);
      if (!now.reports.some((r) => r.id === id)) throw new HttpError(404, `No report "${id}".`);
      const saved = await saveReports(f, now.reports.filter((r) => r.id !== id).map(({ nextRun: _n, ...r }) => r), actor, now.revision);
      return { removed: id, reports: saved.reports.length };
    },
    { destructiveHint: true }
  );

  tool(
    "send_email_report",
    "Send a saved weekly summary report now, on top of its weekly run, or with dryRun: true see who it would go to per site and the rendered email without sending anything.",
    { form: formRef, id: z.string(), dryRun: z.boolean().optional() },
    async ({ form, id, dryRun }) => {
      need("forms:build");
      const f = await routingForm(form);
      const r = (await loadReports(f)).reports.find((x) => x.id === id);
      if (!r) throw new HttpError(404, `No report "${id}". Use get_email_settings.`);
      const { nextRun: _n, ...report } = r;
      return sendReport(f, report, { actor, dryRun });
    },
    { destructiveHint: true }
  );

  tool(
    "list_sent_emails",
    "Emails the site has sent, newest first: to whom, the subject, the kind (notification, digest, route, rule, report, code), whether it went (sent, failed, skipped, with the error) and whether it carried answers. For one form, or every form. Never the email's body.",
    { form: formRef.optional(), limit: z.number().int().min(1).max(200).optional(), before: z.string().optional().describe("An ISO time: page back past the last one seen") },
    async ({ form, limit, before }) => {
      need("forms:build");
      const f = form ? await routingForm(form) : null;
      return { items: await sentEmails({ formId: f?.id, limit, before }) };
    }
  );


  // ── Follow-ups ──

  tool(
    "get_follow_up",
    "A basic form's follow-up: whether its entries are tracked (open until someone it's for marks them done), who they're for (doers, the same recipient kinds as a route), the reminders (remindAfterDays, maxReminders), whether whoever filed it is told when it's done, and how many are open now.",
    { form: formRef },
    async ({ form }) => {
      need("forms:build");
      return followUpView(await routingForm(form));
    }
  );

  tool(
    "set_follow_up",
    "Turn a basic form's follow-up on or off and set it: doers (who marks entries done and is reminded; route recipient kinds), remindAfterDays (remind them this many days after it was filed and again every as many days; null for never), maxReminders, tellSubmitter (tell whoever filed it when it's done), whatToDo (shown in reminders). Applies to entries saved after it's turned on.",
    {
      form: formRef,
      enabled: z.boolean(),
      doers: z.array(recipient),
      remindAfterDays: z.number().int().min(1).max(60).nullable().optional(),
      maxReminders: z.number().int().min(1).max(10).optional(),
      tellSubmitter: z.boolean().optional(),
      whatToDo: z.string().optional(),
    },
    async ({ form, ...settings }) => {
      need("forms:build");
      return saveFollowUp(await routingForm(form), settings, actor);
    },
    { destructiveHint: true }
  );

  tool(
    "list_follow_ups",
    "A form's entries by follow-up: still open (default) or done, oldest first, with who filed them, when, and (when done) who did it and their note. Entry answers aren't included: use get_entry.",
    { form: formRef, status: z.enum(["open", "done"]).optional(), limit: z.number().int().min(1).max(200).optional() },
    async ({ form, status = "open", limit = 50 }) => {
      need("entries:read");
      const f = await routingForm(form);
      const rows = await prisma.formEntry.findMany({
        where: { formId: f.id, status: "active", followUp: status },
        orderBy: { createdAt: status === "open" ? "asc" : "desc" },
        take: limit,
        select: { id: true, createdAt: true, createdByName: true, siteId: true, followUpDoneAt: true, followUpDoneByName: true, followUpNote: true, followUpReminders: true },
      });
      return { status, count: rows.length, items: rows };
    }
  );

  tool(
    "mark_follow_up",
    "Mark an entry's follow-up done, with a note of what was done (whoever filed it is told), or open it again with done: false. Acts as this key (the admin who made it).",
    { form: formRef, entryId: z.string(), done: z.boolean(), note: z.string().max(2000).optional() },
    async ({ form, entryId, done, note }) => {
      need("entries:manage");
      const f = await routingForm(form);
      const entry = await prisma.formEntry.findFirst({ where: { id: entryId, formId: f.id } });
      if (!entry) throw new HttpError(404, "That form has no such entry.");
      const out = await setFollowUp(f, entry, { userId: null, name: actor.name }, { done, note });
      return { id: out.id, followUp: out.followUp, doneAt: out.followUpDoneAt, doneByName: out.followUpDoneByName, note: out.followUpNote };
    },
    { destructiveHint: true }
  );


  tool(
    "convert_notification_rules",
    "Move a builder form's own email and in-app notification rules (its settings.notifications, not webhooks) into its notification routing, so who's told is in one place. Keeps the people, the only-when rules, the subject, whatToDo, the chosen answers and urgent; says what couldn't come across. The moved rules stop running at once and leave the draft. dryRun: true shows the routes without saving.",
    { form: formRef, dryRun: z.boolean().optional() },
    async ({ form, dryRun }) => {
      need("forms:build");
      return convertRules(await routingForm(form), actor, { dryRun });
    },
    { destructiveHint: true }
  );

}
