import { ConfidentialClientApplication } from "@azure/msal-node";
import { env } from "../env.js";
import { prisma } from "../prisma.js";
import { brandedEmail } from "./emailTemplate.js";

/**
 * Outbound email for form notifications, through Microsoft Graph sendMail with
 * the app's own credentials (client-credentials flow, no signed-in user).
 *
 * Off until MAIL_FROM names the mailbox to send as. The Entra app registration
 * also needs the Mail.Send *application* permission with admin consent —
 * ideally fenced to that one mailbox with an Exchange application access
 * policy. Until then notifications are recorded on the entry as "not sent".
 *
 * Every email uses the branded layout (services/emailTemplate.ts). Answers
 * only appear where a route, rule or report chose them, and only for a
 * Lantern address; nothing is ever attached. Each send is logged (EmailLog).
 */
export const mailConfigured = () =>
  Boolean(env.mailFrom && env.microsoft.tenantId && env.microsoft.clientId && env.microsoft.clientSecret);

let client: ConfidentialClientApplication | null = null;

export async function graphToken(): Promise<string> {
  client ??= new ConfidentialClientApplication({
    auth: {
      clientId: env.microsoft.clientId,
      authority: `https://login.microsoftonline.com/${env.microsoft.tenantId}`,
      clientSecret: env.microsoft.clientSecret,
    },
  });
  const res = await client.acquireTokenByClientCredential({ scopes: ["https://graph.microsoft.com/.default"] });
  if (!res?.accessToken) throw new Error("Could not get a Graph token.");
  return res.accessToken;
}

/**
 * The email with no answers: one line saying where to look, and a button into
 * Lantern Forms, in the branded layout. For anyone outside Lantern, and
 * wherever nothing was chosen to show.
 */
export function linkOnlyHtml(lead: string, url: string, opts: { kicker?: string | null; whatToDo?: string | null; urgent?: boolean } = {}) {
  return brandedEmail({
    kicker: opts.kicker,
    heading: lead,
    whatToDo: opts.whatToDo,
    urgent: opts.urgent,
    button: { label: "Open it in Lantern Forms", url },
    note: "The details aren't in this email. Sign in to see them.",
  });
}

export type EmailKind = "notification" | "digest" | "route" | "rule" | "report" | "code";

/** A line in EmailLog: what went (or didn't), never the body. */
export async function logEmail(e: { to: string; subject: string; kind: EmailKind; status: "sent" | "failed" | "skipped"; formId?: string | null; error?: string | null; withAnswers?: boolean }) {
  await prisma.emailLog
    .create({
      data: {
        to: e.to.slice(0, 320),
        subject: e.subject.slice(0, 255),
        kind: e.kind,
        status: e.status,
        formId: e.formId ?? null,
        error: e.error ? e.error.slice(0, 2000) : null,
        withAnswers: Boolean(e.withAnswers),
      },
    })
    .catch((err) => console.error("[mail] couldn't log an email:", err));
}

/** sendMail, logged once per address (sent or failed). Throws like sendMail. */
export async function sendLogged(opts: { to: string[]; subject: string; html: string; replyTo?: string; kind: EmailKind; formId?: string | null; withAnswers?: boolean }) {
  try {
    await sendMail(opts);
    for (const to of opts.to) await logEmail({ to, subject: opts.subject, kind: opts.kind, status: "sent", formId: opts.formId, withAnswers: opts.withAnswers });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    for (const to of opts.to) await logEmail({ to, subject: opts.subject, kind: opts.kind, status: mailConfigured() ? "failed" : "skipped", formId: opts.formId, error, withAnswers: opts.withAnswers });
    throw err;
  }
}

/** Sent emails, newest first: for one form, or all of them. */
export async function sentEmails(opts: { formId?: string; limit?: number; before?: string } = {}) {
  return prisma.emailLog.findMany({
    where: { ...(opts.formId ? { formId: opts.formId } : {}), ...(opts.before ? { createdAt: { lt: new Date(opts.before) } } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
  });
}

export async function sendMail(opts: { to: string[]; subject: string; html: string; replyTo?: string }): Promise<void> {
  if (!mailConfigured()) throw new Error("Email isn't set up on this server (MAIL_FROM).");
  const token = await graphToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.mailFrom)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      message: {
        subject: opts.subject,
        body: { contentType: "HTML", content: opts.html },
        toRecipients: opts.to.map((address) => ({ emailAddress: { address } })),
        ...(opts.replyTo ? { replyTo: [{ emailAddress: { address: opts.replyTo } }] } : {}),
      },
      saveToSentItems: false,
    }),
  });
  if (!res.ok) throw new Error(`Graph sendMail answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
