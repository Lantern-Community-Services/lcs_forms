import { audit } from "../services/audit.js";
import { linkOnlyHtml, mailConfigured, sendMail } from "../services/mailer.js";
import { appBaseUrl } from "../env.js";
import type { CurrentUser } from "../auth/middleware.js";
import type { LoadedApp } from "./runtime.js";

/**
 * ctx.email.send for code forms' server code. Sent through the app's mailbox
 * (services/mailer.ts: Graph sendMail as MAIL_FROM, which needs Mail.Send
 * consent). The call only queues the message — the guest has 3 seconds and
 * Graph can take longer — and the result goes to the server log and the audit log.
 *
 * Link-only: the email is the subject, one line naming the form, and a link
 * into the form (`link`, a path of this site; the form's own page by default).
 * Whatever server code passes as html, text or attachments is not sent: form
 * contents and resident details stay in the app, behind sign-in. The result
 * says so (`dropped`), so the form's author can see it in the console.
 *
 * Who can be emailed: Lantern addresses (ORG_DOMAINS), plus addresses or
 * "@domain" entries the form lists in form.json "email": { "to": [...] },
 * which only a developer or admin can publish.
 */

const ORG_DOMAINS = ["lanterncommunity.org"];
const MAX_RECIPIENTS = 10;
const PER_FORM_HOURLY = 200;
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

const sentLastHour = new Map<string, number[]>();

function allowed(app: LoadedApp, address: string) {
  const a = address.toLowerCase();
  const domain = a.split("@")[1] ?? "";
  if (ORG_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
  return (app.manifest.email?.to ?? []).some((rule) => {
    const r = rule.trim().toLowerCase();
    return r.startsWith("@") ? domain === r.slice(1) : r === a;
  });
}

/** Where the email's link goes: a page of this site (`/apps/…`, `${ctx.url}/request?id=…`), the form by default. */
function linkFor(app: LoadedApp, raw: unknown): string {
  const formUrl = `${appBaseUrl}/apps/${app.form.slug}`;
  if (typeof raw !== "string" || !raw.trim()) return formUrl;
  const v = raw.trim();
  if (v.startsWith(appBaseUrl + "/")) return v;
  if (v.startsWith("/") && !v.startsWith("//")) return `${appBaseUrl}${v}`;
  throw new Error(`email.send's link must be a page of this site (a path like "/apps/${app.form.slug}/…" or \`\${ctx.url}/…\`).`);
}

export function queueEmail(app: LoadedApp, user: CurrentUser | null, args: { to?: unknown; subject?: unknown; link?: unknown; html?: unknown; text?: unknown; replyTo?: unknown; attachments?: unknown }) {
  const to = (Array.isArray(args.to) ? args.to : [args.to]).filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
  if (!to.length) throw new Error("email.send needs at least one address in `to`.");
  if (to.length > MAX_RECIPIENTS) throw new Error(`At most ${MAX_RECIPIENTS} recipients per email.`);
  const bad = to.find((x) => !EMAIL_RE.test(x));
  if (bad) throw new Error(`"${bad}" isn't an email address.`);
  const blocked = to.filter((x) => !allowed(app, x));
  if (blocked.length) throw new Error(`This form can't email ${blocked.join(", ")}. Add the address (or "@their-domain") to form.json "email": { "to": [...] }.`);
  const subject = typeof args.subject === "string" ? args.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 200) : "";
  if (!subject) throw new Error("email.send needs a subject.");
  const link = linkFor(app, args.link);
  const replyTo = typeof args.replyTo === "string" && EMAIL_RE.test(args.replyTo.trim()) ? args.replyTo.trim() : user?.email;
  const dropped = [
    typeof args.html === "string" && args.html.trim() ? "html" : null,
    typeof args.text === "string" && args.text.trim() ? "text" : null,
    Array.isArray(args.attachments) && args.attachments.length ? "attachments" : null,
  ].filter((x): x is string => Boolean(x));
  const note = dropped.length
    ? { dropped, note: `Emails are link-only: the ${dropped.join(", ")} given ${dropped.length === 1 ? "isn't" : "aren't"} sent. Put the details on a page of the form and pass its path as \`link\`.` }
    : {};

  if (app.draft) return { queued: false, reason: `The draft (preview) doesn't send email. It would have gone to ${to.join(", ")}: “${subject}”, linking to ${link}.`, ...note };
  if (!mailConfigured()) return { queued: false, reason: "Email isn't set up on this server yet (MAIL_FROM and the Mail.Send permission).", ...note };

  const now = Date.now();
  const recent = (sentLastHour.get(app.form.id) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= PER_FORM_HOURLY) throw new Error(`This form has sent ${PER_FORM_HOURLY} emails in the last hour; try again later.`);
  recent.push(now);
  sentLastHour.set(app.form.id, recent);

  const actor = user ? { id: user.userId, name: user.name } : { id: null, name: `Code form “${app.manifest.title}”` };
  void sendMail({ to, subject, html: linkOnlyHtml(`You have something to look at in “${app.manifest.title}”.`, link), replyTo })
    .then(() => audit({ actor, action: "apps.email_sent", summary: `“${app.manifest.title}” emailed ${to.join(", ")}: ${subject}` }))
    .catch((err) => {
      console.error(`[apps] ${app.form.slug} email to ${to.join(", ")} failed:`, err);
      return audit({ actor, action: "apps.email_failed", summary: `“${app.manifest.title}” couldn't email ${to.join(", ")}: ${subject} (${err instanceof Error ? err.message : err})` });
    })
    .catch(() => undefined);
  return { queued: true, ...note };
}
