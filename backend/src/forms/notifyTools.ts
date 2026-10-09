import { NOTIFICATION_TYPES } from "../services/notifications.js";
import { API_NOTIFY_TYPES, apiNotifyShape, sendFromKey } from "../services/notifyApi.js";
import { ROLES } from "../services/permissions.js";
import type { ResolvedKey } from "../services/apiKeys.js";
import type { ToolRegistrar } from "./mcp.js";

/**
 * MCP tools for notifications: send one now (send_notification), and the
 * reference for building them into forms (notification_reference), since
 * forms send their own: a basic form's "notify" rule and a code form's
 * ctx.notify.send. Sending needs notifications:send; the reference needs nothing.
 */
export function registerNotificationTools(tool: ToolRegistrar, need: (scope: string) => void, key: ResolvedKey) {
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
        "Everyone chooses per type, on Profile → Notifications, whether they get it in the app and by email, and can set each form's kinds differently (or turn a form off). Pass `form` so people can tell your notifications apart.",
        "Email is link-only: the title is the subject, then a line and a link. The body is shown in the app only. Keep resident names and answers out of the title.",
        "link must be a page of this site (a path like /apps/<slug>/… or /f/<slug>/entries/<id>). Opening the notification goes there.",
        "sites narrows roles / permissions / everyone to people at those sites; Admins and Main Office (every site) always count.",
      ],
      basicForm:
        'A rule in settings.notifications: { id, name, enabled: true, kind: "notify", roles?: ["site_manager"], to?: "{user:email}, someone@lanterncommunity.org", siteOnly?: true, subject: "New request at {site:name}", body?: "Text with any merge tag, answers included ({field_id}, {all_fields})", link?: "/f/<slug>/entries/{entry:id}", conditional? }. subject takes form/entry/site/user/date tags only (it may be emailed). link defaults to the entry. Type is forms.entry.',
      codeForm:
        'Server code: ctx.notify.send({ to?: ["person@lanterncommunity.org", entry.createdById], roles?: ["site_manager"], sites?: [entry.site], title, body?, link?: `${ctx.url}/request?id=${entry.id}`, type?: "forms.message" | "forms.entry" }) → { sent, recipients, emailed, muted, unknown?, preview? }. In the draft only the person previewing is notified (title starts "Preview:"). At most 200 people a call and 1,000 an hour per form.',
    }),
    { readOnlyHint: true }
  );
}
