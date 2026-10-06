import { audit } from "../services/audit.js";
import { mailConfigured, sendMail } from "../services/mailer.js";
import type { CurrentUser } from "../auth/middleware.js";
import type { LoadedApp } from "./runtime.js";

/**
 * ctx.email.send for code forms' server code. Sent through the app's mailbox
 * (services/mailer.ts: Graph sendMail as MAIL_FROM, which needs Mail.Send
 * consent). The call only queues the message — the guest has 3 seconds and
 * Graph can take longer — and the result goes to the server log and the audit log.
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

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function allowed(app: LoadedApp, address: string) {
  const a = address.toLowerCase();
  const domain = a.split("@")[1] ?? "";
  if (ORG_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
  return (app.manifest.email?.to ?? []).some((rule) => {
    const r = rule.trim().toLowerCase();
    return r.startsWith("@") ? domain === r.slice(1) : r === a;
  });
}

export function queueEmail(app: LoadedApp, user: CurrentUser | null, args: { to?: unknown; subject?: unknown; html?: unknown; text?: unknown; replyTo?: unknown }) {
  const to = (Array.isArray(args.to) ? args.to : [args.to]).filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
  if (!to.length) throw new Error("email.send needs at least one address in `to`.");
  if (to.length > MAX_RECIPIENTS) throw new Error(`At most ${MAX_RECIPIENTS} recipients per email.`);
  const bad = to.find((x) => !EMAIL_RE.test(x));
  if (bad) throw new Error(`"${bad}" isn't an email address.`);
  const blocked = to.filter((x) => !allowed(app, x));
  if (blocked.length) throw new Error(`This form can't email ${blocked.join(", ")}. Add the address (or "@their-domain") to form.json "email": { "to": [...] }.`);
  const subject = typeof args.subject === "string" ? args.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 200) : "";
  if (!subject) throw new Error("email.send needs a subject.");
  const body =
    typeof args.html === "string" && args.html.trim()
      ? args.html
      : typeof args.text === "string"
        ? `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;white-space:pre-wrap">${escapeHtml(args.text)}</div>`
        : "";
  if (!body) throw new Error("email.send needs html or text.");
  if (body.length > 200_000) throw new Error("That email is too big (200 KB max).");
  const replyTo = typeof args.replyTo === "string" && EMAIL_RE.test(args.replyTo.trim()) ? args.replyTo.trim() : user?.email;

  if (app.draft) return { queued: false, reason: `The draft (preview) doesn't send email. It would have gone to ${to.join(", ")}: “${subject}”.` };
  if (!mailConfigured()) return { queued: false, reason: "Email isn't set up on this server yet (MAIL_FROM and the Mail.Send permission)." };

  const now = Date.now();
  const recent = (sentLastHour.get(app.form.id) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= PER_FORM_HOURLY) throw new Error(`This form has sent ${PER_FORM_HOURLY} emails in the last hour; try again later.`);
  recent.push(now);
  sentLastHour.set(app.form.id, recent);

  const actor = user ? { id: user.userId, name: user.name } : { id: null, name: `Code form “${app.manifest.title}”` };
  void sendMail({ to, subject, html: body, replyTo })
    .then(() => audit({ actor, action: "apps.email_sent", summary: `“${app.manifest.title}” emailed ${to.join(", ")}: ${subject}` }))
    .catch((err) => {
      console.error(`[apps] ${app.form.slug} email to ${to.join(", ")} failed:`, err);
      return audit({ actor, action: "apps.email_failed", summary: `“${app.manifest.title}” couldn't email ${to.join(", ")}: ${subject} (${err instanceof Error ? err.message : err})` });
    })
    .catch(() => undefined);
  return { queued: true };
}
