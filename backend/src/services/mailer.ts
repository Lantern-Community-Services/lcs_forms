import { ConfidentialClientApplication } from "@azure/msal-node";
import { env } from "../env.js";

/**
 * Outbound email for form notifications, through Microsoft Graph sendMail with
 * the app's own credentials (client-credentials flow, no signed-in user).
 *
 * Off until MAIL_FROM names the mailbox to send as. The Entra app registration
 * also needs the Mail.Send *application* permission with admin consent —
 * ideally fenced to that one mailbox with an Exchange application access
 * policy. Until then notifications are recorded on the entry as "not sent".
 *
 * What's sent is always linkOnlyHtml: a line and a link, no attachments.
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

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Every email the app sends is this: one line saying where to look, and a link
 * to it in Lantern Forms. Never form contents, answers or resident details:
 * those stay in the app, behind sign-in, whoever the email reaches.
 */
export function linkOnlyHtml(lead: string, url: string) {
  return [
    `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2937">`,
    `<p>${esc(lead)}</p>`,
    `<p><a href="${esc(url)}" style="font-weight:600">Open it in Lantern Forms</a></p>`,
    `<p style="color:#6b7280;font-size:12px">The details aren't in this email. Sign in to see them.</p>`,
    `</div>`,
  ].join("");
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
