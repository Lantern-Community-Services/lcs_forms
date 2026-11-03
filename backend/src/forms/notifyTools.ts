import { z } from "zod";
import { EMAIL_WHEN, NOTIFICATION_TYPES, TYPE_CHOICES } from "../services/notifications.js";
import { saveSystemRules, typesOverview } from "../services/notificationTypes.js";
import type { Actor } from "../services/audit.js";
import { API_NOTIFY_TYPES, apiNotifyShape, sendFromKey } from "../services/notifyApi.js";
import { ROLES } from "../services/permissions.js";
import type { ResolvedKey } from "../services/apiKeys.js";
import type { ToolRegistrar } from "./mcp.js";

/**
 * MCP tools for notifications: send one now (send_notification), and the
 * reference for building them into forms (notification_reference), since
 * forms send their own: a basic form's "notify" rule and a code form's
 * ctx.notify.send. Sending needs notifications:send; the reference needs nothing.
 * The notification types (the site's and each form's routes) are read and set
 * with forms:build, like routing.
 */
export function registerNotificationTools(tool: ToolRegistrar, need: (scope: string) => void, key: ResolvedKey, actor: Actor) {
  tool(
    "send_notification",
    "Send a notification to people with an account on the site: it shows under the bell in the app, and is emailed (link-only: the title as subject plus a link) to whoever wants that type by email. For something a form should send every time, build it into the form instead (see notification_reference). Answers { sent, recipients, emailed, muted, unknown? }.",
    apiNotifyShape,
    async (args) => {
      need("notifications:send");
      return sendFromKey(key, args, "MCP");
    }
  );

  tool(
    "notification_reference",
    "How notifications work and how forms send them: the types people choose between, who can be reached (roles, sites), a basic form's \"notify\" rule, and code forms' ctx.notify.send.",
    {},
    async () => ({
      types: Object.entries(NOTIFICATION_TYPES).map(([k, t]) => ({ key: k, label: t.label, description: t.description, defaultInApp: t.inApp, defaultEmail: t.email })),
      sendableByApiKey: API_NOTIFY_TYPES,
      sendableByForms: ["forms.message", "forms.entry"],
      roles: ROLES.map((r) => ({ key: r.key, name: r.name, everySite: r.allSites })),
      rules: [
        "Only people with an active account are notified. Addresses that aren't one come back in `unknown`.",
        "Everything is sent as a notification type: the site's own (types below), each route of each form, or a form's follow-up. On Profile → Notifications each person sees every type that could reach them and chooses: in the app or not, and email as it comes, in their daily summary (at an hour they pick), or not at all. A type set \"required\" always shows in the app; \"locked\" can't be changed. See get_notification_types. Pass `form` so people can tell your notifications apart.",
        "Email is link-only: the title is the subject, then a line and a link. The body is shown in the app only. Keep resident names and answers out of the title.",
        "link must be a page of this site (a path like /apps/<slug>/… or /f/<slug>/entries/<id>). Opening the notification goes there.",
        "sites narrows roles / permissions / everyone to people at those sites; Admins and Main Office (every site) always count.",
      ],
      basicForm:
        'A rule in settings.notifications: { id, name, enabled: true, kind: "notify", roles?: ["site_manager"], to?: "{user:email}, someone@lanterncommunity.org", siteOnly?: true, subject: "New request at {site:name}", body?: "Text with any merge tag, answers included ({field_id}, {all_fields})", link?: "/f/<slug>/entries/{entry:id}", conditional? }. subject takes form/entry/site/user/date tags only (it may be emailed). link defaults to the entry. Type is forms.entry.',
      routing:
        "When who's told is an organisational choice (Main Office, a site's leadership, the supervisor someone picked), use the form's notification routing instead of hard-coding people: get_routing / save_route / set_routing / preview_routing / routing_log (Admin → Notification routing in the app). Every form has the event entry.created; code forms declare more in form.json \"routing\" and fire them with ctx.notify.route(event, { entry, title, link, data, people }).",
      codeForm:
        'Server code: ctx.notify.send({ to?: ["person@lanterncommunity.org", entry.createdById], roles?: ["site_manager"], sites?: [entry.site], title, body?, link?: `${ctx.url}/request?id=${entry.id}`, type?: "forms.message" | "forms.entry" }) → { sent, recipients, emailed, muted, unknown?, preview? }. In the draft only the person previewing is notified (title starts "Preview:"). At most 200 people a call and 1,000 an hour per form.',
    }),
    { readOnlyHint: true }
  );

  tool(
    "get_notification_types",
    "Every notification type people can set on Profile → Notifications, with how it reaches people who haven't chosen and how much they may change it (choice: optional = anything, required = always in the app but they choose the email, locked = nobody can change it), and how many people have set it themselves. `system`: the site's own types (change with set_notification_type). `forms`: each form's routes and follow-ups (change a route's label, description, email and emailDefault with save_route).",
    {},
    async () => {
      need("forms:build");
      return typesOverview();
    },
    { readOnlyHint: true }
  );

  tool(
    "set_notification_type",
    "Change one of the site's own notification types (account, people.request, forms.problem, announcement, forms.message, forms.entry): what people who haven't chosen get, and how much they may change it. reset: true puts it back to the site's default. A form's routes are set on the route (save_route).",
    {
      type: z.string().describe("The type's key, from get_notification_types system[].key"),
      inApp: z.boolean().optional().describe("Shown in the app by default"),
      email: z.boolean().optional().describe("Emailed by default"),
      emailWhen: z.enum(EMAIL_WHEN).nullable().optional().describe("\"daily\": in people's daily summary by default; null: as each person's own default says"),
      choice: z.enum(TYPE_CHOICES).optional().describe("optional: people change anything; required: always in the app, people choose the email; locked: nobody can change it"),
      reset: z.boolean().optional(),
    },
    async ({ type, reset, ...rule }) => {
      need("forms:build");
      const out = await saveSystemRules({ [type]: reset ? null : rule }, actor);
      return out.system.find((t) => t.key === type);
    }
  );
}
