import { audit } from "../services/audit.js";
import { notify, sitePath, type NotificationTypeKey } from "../services/notifications.js";
import type { CurrentUser } from "../auth/middleware.js";
import type { LoadedApp } from "./runtime.js";

/**
 * ctx.notify.send for code forms' server code: a notification in the app (the
 * bell), emailed too to whoever wants that kind by email (services/notifications.ts).
 *
 * Who: people with an account, by address or user id (`to`: an entry's
 * createdById, ctx.user.id), and/or everyone with `roles`, narrowed to `sites`.
 * No form.json allow-list: it only reaches people already on the site, and
 * each of them can turn this form's notifications off on their Profile.
 *
 * The title can be emailed (link-only: subject + a link), so it must not carry
 * resident details; `body` is shown in the app only.
 *
 * In the draft only the person previewing gets it, titled "Preview: …", so a
 * developer can see it without reaching anyone else.
 */

const FORM_TYPES: NotificationTypeKey[] = ["forms.message", "forms.entry"];
const MAX_PER_CALL = 200;
const PER_FORM_HOURLY = 1000;
const sentLastHour = new Map<string, number[]>();

const list = (v: unknown): string[] => (Array.isArray(v) ? v : v == null ? [] : [v]).filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());

export async function sendNotification(
  app: LoadedApp,
  user: CurrentUser | null,
  args: { to?: unknown; roles?: unknown; sites?: unknown; title?: unknown; body?: unknown; link?: unknown; type?: unknown }
) {
  const to = list(args.to);
  const roles = list(args.roles);
  const sites = list(args.sites);
  if (!to.length && !roles.length) throw new Error("notify.send needs people: `to` (addresses or user ids) and/or `roles`.");
  if (sites.length && !roles.length) throw new Error("`sites` narrows `roles`; give roles too (people in `to` are reached wherever they work).");
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) throw new Error("notify.send needs a title.");
  const type = (args.type ?? "forms.message") as NotificationTypeKey;
  if (!FORM_TYPES.includes(type)) throw new Error(`type is "forms.message" (default) or "forms.entry".`);
  const body = typeof args.body === "string" ? args.body : null;
  // Checked here so a bad link is the author's error even in the draft.
  const link = sitePath(args.link) ?? `/apps/${app.form.slug}`;

  const base = { type, body, link, source: `form:${app.form.slug}`, sourceLabel: app.manifest.title, formId: app.form.id };

  if (app.draft) {
    if (!user) return { sent: 0, recipients: 0, emailed: 0, muted: 0, preview: true, reason: "The draft (preview) notifies only the person previewing it, and nobody is." };
    const out = await notify({ ...base, to: { users: [user.userId] }, title: `Preview: ${title}` });
    return { ...out, preview: true, reason: `The draft notifies only you. Published, it would go to ${[to.length ? to.join(", ") : null, roles.length ? `roles ${roles.join(", ")}${sites.length ? ` at ${sites.join(", ")}` : ""}` : null].filter(Boolean).join(" and ")}.` };
  }

  const now = Date.now();
  const recent = (sentLastHour.get(app.form.id) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= PER_FORM_HOURLY) throw new Error(`This form has sent ${PER_FORM_HOURLY} notifications in the last hour; try again later.`);

  const out = await notify({ ...base, to: { users: to, roles, sites: sites.length ? sites : undefined }, title, maxRecipients: MAX_PER_CALL });
  for (let i = 0; i < out.sent; i++) recent.push(now);
  sentLastHour.set(app.form.id, recent);
  if (out.sent) {
    const actor = user ? { id: user.userId, name: user.name } : { id: null, name: `Code form “${app.manifest.title}”` };
    void audit({ actor, action: "apps.notified", summary: `“${app.manifest.title}” notified ${out.sent} ${out.sent === 1 ? "person" : "people"}: ${title.slice(0, 120)}` }).catch(() => undefined);
  }
  return out;
}
