import { z } from "zod";
import { prisma } from "../prisma.js";
import { audit } from "./audit.js";
import { notify } from "./notifications.js";
import type { ResolvedKey } from "./apiKeys.js";

/**
 * Notifications sent by an API key: the MCP server's send_notification and
 * POST /api/v1/notifications (Power Automate). Scope notifications:send.
 *
 * A key sends "forms.message" (the default) or "announcement". A key pinned to
 * a site reaches only people at that site, plus people who work at every site.
 * Every send is in the audit log.
 */

export const API_NOTIFY_TYPES = ["forms.message", "announcement"] as const;
const MAX_RECIPIENTS = 2000;

export const apiNotifyShape = {
  to: z
    .object({
      users: z.array(z.string().max(255)).max(500).optional().describe("Email addresses (or user ids) of people with an account here"),
      roles: z.array(z.string().max(64)).max(10).optional().describe("Role keys: admin, developer, main_office, site_admin, site_manager, site_staff"),
      permissions: z.array(z.string().max(64)).max(10).optional().describe("Everyone who holds one of these permissions, e.g. users.manage"),
      sites: z.array(z.string().max(64)).max(50).optional().describe("Site codes: narrows roles / permissions / everyone to people at these sites (people who work at every site always count)"),
      everyone: z.boolean().optional().describe("Every active person"),
    })
    .strict()
    .describe("Who gets it. At least one of users, roles, permissions or everyone."),
  title: z.string().min(1).max(200).describe("One line. It's also the email's subject, so no resident names or form answers."),
  body: z.string().max(4000).optional().describe("More detail, shown in the app only (never emailed)."),
  link: z.string().max(2000).optional().describe('A page of this site to open, e.g. "/apps/petty-cash/request?id=…" or "/f/slug/entries/<id>".'),
  type: z.enum(API_NOTIFY_TYPES).optional().describe('"forms.message" (default) or "announcement". People choose per type whether they get it in the app and by email.'),
  form: z.string().max(255).optional().describe("Slug of the form it's about. Shown as the sender, and people can turn that form's notifications off."),
  from: z.string().max(120).optional().describe("Sender name shown to people, when it isn't about one form. Defaults to the API key's name."),
};
export const apiNotifyBody = z.object(apiNotifyShape).strict();
export type ApiNotifyInput = z.infer<typeof apiNotifyBody>;

export async function sendFromKey(key: ResolvedKey, input: ApiNotifyInput, via: "MCP" | "API") {
  const to = input.to;
  if (!to.users?.length && !to.roles?.length && !to.permissions?.length && !to.everyone) {
    throw new Error("Say who gets it: to.users, to.roles, to.permissions or to.everyone.");
  }
  const form = input.form ? await prisma.builtForm.findUnique({ where: { slug: input.form }, select: { id: true, slug: true, title: true, kind: true } }) : null;
  if (input.form && !form) throw new Error(`No form "${input.form}".`);
  const result = await notify({
    to,
    type: input.type ?? "forms.message",
    title: input.title,
    body: input.body,
    link: input.link ?? (form ? `${form.kind === "code" ? "/apps" : "/f"}/${form.slug}` : null),
    source: form ? `form:${form.slug}` : `api:${key.name}`,
    sourceLabel: form?.title ?? input.from ?? key.name,
    formId: form?.id ?? null,
    maxRecipients: MAX_RECIPIENTS,
    onlySiteId: key.siteId,
  });
  await audit({
    actor: { id: null, name: `API key: ${key.name}${via === "MCP" ? " (MCP)" : ""}` },
    action: "notifications.sent",
    summary: `Notified ${result.sent} ${result.sent === 1 ? "person" : "people"}: “${input.title.slice(0, 120)}”`,
  });
  return result;
}
