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
export function linkOnlyHtml(lead: string, url: string, opts: { kicker?: string | null; whatToDo?: string | null; urgent?: boolean; intro?: string | null; buttonLabel?: string | null } = {}) {
  return brandedEmail({
    kicker: opts.kicker,
    heading: lead,
    intro: opts.intro,
    whatToDo: opts.whatToDo,
    urgent: opts.urgent,
    button: { label: opts.buttonLabel || "Open it in Lantern Forms", url },
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
export async function sentEmails(opts: { formId?: string; limit?: number; before?: string; kind?: string; status?: string; to?: string } = {}) {
  return prisma.emailLog.findMany({
    where: {
      ...(opts.formId ? { formId: opts.formId } : {}),
      ...(opts.before ? { createdAt: { lt: new Date(opts.before) } } : {}),
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.to ? { to: { contains: opts.to.trim().toLowerCase() } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
  });
}

/**
 * Sends at once from this server. Exchange takes only a few requests at a time
 * from one mailbox ("MailboxConcurrency"); past that it holds or refuses them,
 * which showed up as 10-second timeouts whenever a busy minute (an onboarding
 * request to 20 people, a deploy) sent everything together (2026-11-12).
 */
const MAX_PARALLEL = 2;
/** How long one Graph call may take: a held request can take well over 10 seconds and still go. */
const SEND_TIMEOUT_MS = 30_000;
/** Tries for one email when Graph is busy (429, 5xx, a timeout); a bad address or request isn't tried again. */
const SEND_TRIES = 2;
/** The longest a Retry-After is waited for here; anything longer is left to the caller's own retries. */
const MAX_WAIT_MS = 30_000;

let active = 0;
const waiting: (() => void)[] = [];

async function inLane<T>(go: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await go();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An error from one Graph call, saying whether trying again later could work, and how long Graph asked us to wait. */
class SendError extends Error {
  constructor(message: string, readonly transient: boolean, readonly waitMs?: number) {
    super(message);
  }
}

/** Retry-After as milliseconds: seconds, or an HTTP date. */
function retryAfterMs(h: string | null): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

async function graphSend(opts: { to: string[]; subject: string; html: string; replyTo?: string }) {
  const token = await graphToken();
  let res: Response;
  try {
    res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.mailFrom)}/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
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
  } catch (err) {
    // A timeout or a dropped connection: Graph may be holding it, so it's worth another go.
    throw new SendError(err instanceof Error ? err.message : String(err), true);
  }
  if (res.ok) return;
  const transient = res.status === 429 || res.status >= 500;
  throw new SendError(`Graph sendMail answered ${res.status}: ${(await res.text()).slice(0, 300)}`, transient, retryAfterMs(res.headers.get("retry-after")));
}

/**
 * Send one email through Graph: at most MAX_PARALLEL at a time from this
 * server, and once more after a short wait when Graph is busy (honouring its
 * Retry-After). Throws when it still couldn't go; the error says which try.
 */
export async function sendMail(opts: { to: string[]; subject: string; html: string; replyTo?: string }): Promise<void> {
  if (!mailConfigured()) throw new Error("Email isn't set up on this server (MAIL_FROM).");
  for (let attempt = 1; ; attempt++) {
    try {
      return await inLane(() => graphSend(opts));
    } catch (err) {
      const e = err instanceof SendError ? err : new SendError(err instanceof Error ? err.message : String(err), false);
      const wait = e.waitMs ?? 2_000 * attempt;
      if (!e.transient || attempt >= SEND_TRIES || wait > MAX_WAIT_MS) throw new Error(attempt > 1 ? `${e.message} (after ${attempt} tries)` : e.message);
      console.warn(`[mail] ${e.message}; trying again in ${Math.round(wait / 1000)}s`);
      // Out of the lane while it waits, so other emails keep going.
      await sleep(wait);
    }
  }
}
