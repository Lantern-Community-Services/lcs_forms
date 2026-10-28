import { z } from "zod";
import { emailRouter } from "../routes/emailTemplates.js";
import { defineOp, int } from "./registry.js";

/**
 * Admin → Notifications as operations: the organization's email templates and
 * every email sent. The key acts as the admin who made it: an Admin's key can
 * read and preview templates, and only a Super Admin's key can make, change,
 * hide, reset or delete them (email.templates). A form's routes and reports
 * pick a template with save_route / save_email_report (template: its key).
 */

const enc = encodeURIComponent;

const templateShape = z
  .object({
    name: z.string().describe("What it's called where people pick it, e.g. “HR request”"),
    description: z.string().optional().describe("When to use it, one line"),
    kind: z.enum(["message", "report", "system"]).optional().describe('"message" (default for a new one): routes and code forms. "report": weekly summary reports. "system": the site\'s own emails (can only be changed, not made). Leave it out when changing one.'),
    subject: z.string().optional().describe("The email subject (and the in-app title). Message tags: {title} {form} {site} {at_site} {for_site} {event} {date}. Report tags: {report} {form} {site} {count} {date}. Never answers or resident details."),
    heading: z.string().optional().describe("The big line at the top of the email. Default: the subject."),
    intro: z.string().optional().describe("A line under the heading, e.g. “A request came in on “{form}”{for_site}.”"),
    whatToDo: z.string().optional().describe("What the reader has to do, in the highlighted box. Plain text."),
    details: z.array(z.enum(["_site", "_date", "_by", "_followup"])).optional().describe("Built-in details shown above the route's own chosen answers (message templates only): site, when it was submitted, who filed it, its follow-up."),
    buttonLabel: z.string().optional().describe("The button's words. Default “Open it in Lantern Forms”."),
    urgent: z.boolean().optional().describe("Always urgent, whatever the route says: red in the bell, emailed straight away."),
  })
  .describe("The template's wording. Tags are filled in when it's sent; anything else in {braces} is refused.");

export const emailOps = [
  defineOp({
    name: "list_email_templates",
    description:
      "The organization's email templates (Admin → Notifications → Templates): presets that ship with the site and ones Super Admins made, each with its key (what routes, reports and code forms name it by), its wording, whether it's hidden, and every route, report and site email that uses it. Also the tags each kind fills in, the defaults new routes and reports start on, and whether this key may change templates (Super Admins' keys only).",
    scope: "email:manage",
    as: "creator",
    http: { method: "GET", path: "/email/templates" },
    shape: {},
    annotations: { readOnlyHint: true },
    run: (ctx) => ctx.route(emailRouter, { method: "GET", path: "/templates" }),
  }),

  defineOp({
    name: "get_email_template",
    description: "One email template (by id or key) with everything that uses it.",
    scope: "email:manage",
    as: "creator",
    http: { method: "GET", path: "/email/templates/:template" },
    shape: { template: z.string().describe("Template id or key, e.g. new-entry") },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.route(emailRouter, { method: "GET", path: `/templates/${enc(a.template)}` }),
  }),

  defineOp({
    name: "preview_email_template",
    description:
      "What a template looks like, saved or not: the subject and the email as a Lantern address gets it (with the chosen details) and as anyone else does (link only). With form, it's filled in from that form's latest entry (message templates); without, with made-up values. Nothing is sent. Try a template here before save_email_template.",
    scope: "email:manage",
    as: "creator",
    http: { method: "POST", path: "/email/templates/preview" },
    shape: {
      template: templateShape,
      key: z.string().optional().describe("For one of the site's own emails (kind system): its key, so its own tags are checked and filled in"),
      form: z.string().optional().describe("A form's id or slug, to fill it in from its latest entry"),
      entryId: z.string().optional().describe("A particular entry of that form"),
    },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.route(emailRouter, { method: "POST", path: "/templates/preview", body: { template: a.template, key: a.key, form: a.form, entryId: a.entryId } }),
  }),

  defineOp({
    name: "save_email_template",
    description:
      "Make an email template, or change one (give template: its id or key; revision from get_email_template stops you overwriting someone's change). Changing one changes every email that uses it: check its uses first. A preset can be changed and put back with reset_email_template. Super Admins' keys only. The key of a new template comes from its name unless you give one (lowercase, dashes); it never changes.",
    scope: "email:manage",
    as: "creator",
    http: { method: "POST", path: "/email/templates/save" },
    shape: {
      template: z.string().optional().describe("Id or key of the template to change; omit to make a new one"),
      key: z.string().optional().describe("A new template's key, e.g. hr-request"),
      revision: z.number().int().optional(),
      wording: templateShape,
    },
    run: (ctx, a) =>
      a.template
        ? ctx.route(emailRouter, { method: "PUT", path: `/templates/${enc(a.template)}`, body: { template: a.wording, revision: a.revision } })
        : ctx.route(emailRouter, { method: "POST", path: "/templates", body: { template: a.wording, key: a.key } }),
  }),

  defineOp({
    name: "copy_email_template",
    description: "A new template that starts as a copy of another (a preset, say), to change without touching the original. Super Admins' keys only.",
    scope: "email:manage",
    as: "creator",
    http: { method: "POST", path: "/email/templates/copy" },
    shape: { template: z.string().describe("Id or key to copy"), name: z.string().optional().describe("The copy's name. Default “<name> (copy)”.") },
    run: (ctx, a) => ctx.route(emailRouter, { method: "POST", path: "/templates", body: { copyOf: a.template, name: a.name } }),
  }),

  defineOp({
    name: "reset_email_template",
    description: "Put a preset back to the wording the site ships with. Every email that uses it changes back too. Super Admins' keys only.",
    scope: "email:manage",
    as: "creator",
    http: { method: "POST", path: "/email/templates/:template/reset" },
    shape: { template: z.string().describe("Id or key of a preset"), confirm: z.boolean().optional() },
    confirm: true,
    run: (ctx, a) => ctx.route(emailRouter, { method: "POST", path: `/templates/${enc(a.template)}/reset` }),
  }),

  defineOp({
    name: "set_email_template_hidden",
    description: "Hide a template so it isn't offered for new routes and reports (whatever already uses it keeps working), or show it again. The defaults new routes and reports start on can't be hidden. Super Admins' keys only.",
    scope: "email:manage",
    as: "creator",
    http: { method: "POST", path: "/email/templates/:template/hidden" },
    shape: { template: z.string(), hidden: z.boolean() },
    run: (ctx, a) => ctx.route(emailRouter, { method: "POST", path: `/templates/${enc(a.template)}/hidden`, body: { hidden: a.hidden } }),
  }),

  defineOp({
    name: "delete_email_template",
    description: "Delete a template nothing uses. Presets can't be deleted (hide them); move the routes and reports that use one to another template first. Super Admins' keys only.",
    scope: "email:manage",
    as: "creator",
    http: { method: "DELETE", path: "/email/templates/:template" },
    shape: { template: z.string(), confirm: z.boolean().optional() },
    confirm: true,
    annotations: { destructiveHint: true },
    run: (ctx, a) => ctx.route(emailRouter, { method: "DELETE", path: `/templates/${enc(a.template)}` }),
  }),

  defineOp({
    name: "get_email_look",
    description: "How every email from the site looks (Admin → Notifications → Look): the name in the band, the band, stripe and button colors, the logo address and the footer, with the defaults. The sender is the MAIL_FROM mailbox under its own Microsoft 365 name; that isn't set here.",
    scope: "email:manage",
    as: "creator",
    http: { method: "GET", path: "/email/look" },
    shape: {},
    annotations: { readOnlyHint: true },
    run: (ctx) => ctx.route(emailRouter, { method: "GET", path: "/look" }),
  }),

  defineOp({
    name: "set_email_look",
    description: "Change how every email looks. Give all of it (get_email_look first). The band and button carry white text, so colors too light to read it on (under 4.5:1 contrast) are refused. A logo must be an https:// image anyone can open. Super Admins' keys only. Every email from then on uses it.",
    scope: "email:manage",
    as: "creator",
    http: { method: "PUT", path: "/email/look" },
    shape: {
      orgName: z.string().describe("The name in the band, e.g. Lantern Community Services"),
      bandColor: z.string().describe("#rrggbb: the band at the top, headings and table headers"),
      accentColor: z.string().describe("#rrggbb: the stripe under the band and the What to do box's edge"),
      buttonColor: z.string().describe("#rrggbb: the button"),
      logoUrl: z.string().optional().describe("https:// address of a logo image, or empty for none"),
      footer: z.string().describe("The line at the bottom"),
      confirm: z.boolean().optional(),
    },
    confirm: true,
    run: (ctx, { confirm: _c, ...look }) => ctx.route(emailRouter, { method: "PUT", path: "/look", body: { look: { logoUrl: "", ...look } } }),
  }),

  defineOp({
    name: "list_all_sent_emails",
    description: "Every email the site sent, newest first: when, to whom, the subject, which form, what kind (route, notification, digest, report, rule, code), and whether it went (sent, failed with why, or skipped). Never the body. Filter by form, kind, status or address.",
    scope: "email:manage",
    as: "creator",
    http: { method: "GET", path: "/email/sent" },
    shape: {
      form: z.string().optional().describe("A form's id"),
      kind: z.string().optional(),
      status: z.enum(["sent", "failed", "skipped"]).optional(),
      to: z.string().optional().describe("Part of an address"),
      before: z.string().optional().describe("ISO time, for the next page"),
      limit: int(1, 200).optional(),
    },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.route(emailRouter, { method: "GET", path: "/sent", query: { form: a.form, kind: a.kind, status: a.status, to: a.to, before: a.before, limit: a.limit?.toString() } }),
  }),
];
