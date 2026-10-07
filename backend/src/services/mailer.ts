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

export interface MailAttachment {
  name: string;
  contentType: string;
  body: Buffer;
}

export async function sendMail(opts: { to: string[]; subject: string; html: string; replyTo?: string; attachments?: MailAttachment[] }): Promise<void> {
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
        ...(opts.attachments?.length
          ? {
              attachments: opts.attachments.map((a) => ({
                "@odata.type": "#microsoft.graph.fileAttachment",
                name: a.name,
                contentType: a.contentType,
                contentBytes: a.body.toString("base64"),
              })),
            }
          : {}),
      },
      saveToSentItems: false,
    }),
  });
  if (!res.ok) throw new Error(`Graph sendMail answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
