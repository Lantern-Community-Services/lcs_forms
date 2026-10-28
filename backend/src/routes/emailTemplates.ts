import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler, badRequest } from "../http.js";
import { requirePermission } from "../auth/middleware.js";
import { actorOf } from "../services/audit.js";
import { brandedEmail } from "../services/emailTemplate.js";
import { env } from "../env.js";
import { DEFAULT_LOOK, checkLook, loadLook, saveLook, type EmailLook } from "../services/emailLook.js";
import {
  DEFAULT_MESSAGE_TEMPLATE, DEFAULT_REPORT_TEMPLATE, SYSTEM_TAGS, TEMPLATE_DETAILS, TEMPLATE_TAGS, checkTemplate, copyTemplate, createTemplate,
  deleteTemplate, fillTags, getTemplate, listTemplates, messageTags, messageWording, resetTemplate, setTemplateHidden, templateInput,
  templateView, updateTemplate, type TemplateInput,
} from "../services/emailTemplates.js";
import { templateUsage, usedBy } from "../services/emailTemplateUsage.js";
import { routeEmailPreview, routingForm } from "../services/routing.js";
import { sentEmails } from "../services/mailer.js";
import { ENTRY_CREATED } from "../forms/routingSchema.js";

/**
 * Admin → Notifications: the organization's email templates and every email
 * sent. Admins (forms.manage) read templates, preview them and pick them on
 * their forms; only Super Admins (email.templates) make or change them.
 */
export const emailRouter = Router();
emailRouter.use(requirePermission("forms.manage"));
const editors = requirePermission("email.templates");

const DETAIL_LABELS: Record<string, string> = { _site: "Site", _date: "Submitted", _by: "Submitted by", _followup: "Follow-up" };

emailRouter.get(
  "/templates",
  asyncHandler(async (req, res) => {
    const [rows, usage] = await Promise.all([listTemplates(), templateUsage()]);
    res.json({
      templates: rows.map((t) => ({ ...templateView(t), uses: usage.get(t.key) ?? [] })),
      tags: TEMPLATE_TAGS,
      systemTags: SYSTEM_TAGS,
      details: TEMPLATE_DETAILS.map((id) => ({ id, label: DETAIL_LABELS[id] })),
      defaults: { message: DEFAULT_MESSAGE_TEMPLATE, report: DEFAULT_REPORT_TEMPLATE },
      canEdit: Boolean(req.user?.permissions.includes("email.templates")),
    });
  })
);

emailRouter.get(
  "/templates/:id",
  asyncHandler(async (req, res) => {
    const t = await getTemplate(req.params.id);
    res.json({ ...templateView(t), uses: (await templateUsage()).get(t.key) ?? [] });
  })
);

/** Make one: { template, key? }, or a copy: { copyOf, name? }. */
emailRouter.post(
  "/templates",
  editors,
  asyncHandler(async (req, res) => {
    const body = z.object({ template: z.unknown().optional(), key: z.string().optional(), copyOf: z.string().optional(), name: z.string().optional() }).parse(req.body ?? {});
    const row = body.copyOf ? await copyTemplate(body.copyOf, actorOf(req), body.name) : await createTemplate(body.template, actorOf(req), { key: body.key });
    res.status(201).json(templateView(row));
  })
);

emailRouter.put(
  "/templates/:id",
  editors,
  asyncHandler(async (req, res) => {
    const body = z.object({ template: z.unknown(), revision: z.number().int().optional() }).parse(req.body ?? {});
    res.json(templateView(await updateTemplate(req.params.id, body.template, actorOf(req), body.revision)));
  })
);

emailRouter.post(
  "/templates/:id/reset",
  editors,
  asyncHandler(async (req, res) => res.json(templateView(await resetTemplate(req.params.id, actorOf(req)))))
);

emailRouter.post(
  "/templates/:id/hidden",
  editors,
  asyncHandler(async (req, res) => {
    const { hidden } = z.object({ hidden: z.boolean() }).parse(req.body ?? {});
    res.json(templateView(await setTemplateHidden(req.params.id, hidden, actorOf(req))));
  })
);

emailRouter.delete(
  "/templates/:id",
  editors,
  asyncHandler(async (req, res) => {
    const t = await getTemplate(req.params.id);
    await deleteTemplate(t.id, actorOf(req), await usedBy(t.key));
    res.json({ ok: true });
  })
);

/**
 * What a template (saved or being edited) looks like: with a form, filled in
 * from its latest entry, as a Lantern address and as anyone else would get it;
 * without one, with made-up values. Nothing is sent.
 */
emailRouter.post(
  "/templates/preview",
  asyncHandler(async (req, res) => {
    const body = z.object({ template: z.unknown(), key: z.string().optional(), form: z.string().optional(), entryId: z.string().optional() }).parse(req.body ?? {});
    const parsed = templateInput.safeParse(body.template);
    if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => `${i.path.join(".") || "template"}: ${i.message}`).join("; "));
    const t = parsed.data;
    checkTemplate(t, body.key);
    if (t.kind === "system") return void res.json(systemPreview(t, body.key ?? ""));
    res.json(body.form && t.kind === "message" ? await formPreview(t, body.form, body.entryId) : samplePreview(t));
  })
);

async function formPreview(t: TemplateInput, formRef: string, entryId?: string) {
  const form = await routingForm(formRef);
  const draft = { ...t, details: t.details.join(",") || null };
  const route = { id: "preview", name: "Preview", event: ENTRY_CREATED, enabled: true, to: [{ kind: "submitter" as const }], email: "always" as const, urgent: false };
  return { ...(await routeEmailPreview(form, route, entryId, draft)), form: form.title };
}

/** Made-up values, for a template not tried on a form yet. */
function samplePreview(t: TemplateInput, look?: EmailLook) {
  const now = new Date();
  if (t.kind === "report") {
    const tags = { form: "Unit Inspection", report: "Weekly inspections", site: "Clover Hall", count: "3", date: now.toLocaleDateString("en-US", { timeZone: "America/New_York" }) };
    const line = fillTags(t.intro, tags);
    const countLine = "Entries submitted in the past 7 days: 3";
    const html = (withTable: boolean) =>
      brandedEmail({
        kicker: tags.form,
        heading: fillTags(t.heading, tags, { line: true }) ?? `${tags.report}: ${tags.site}`,
        intro: line ? `${countLine}\n${line}` : countLine,
        whatToDo: fillTags(t.whatToDo, tags),
        table: withTable ? { columns: ["Submitted", "Unit", "Result"], rows: [["10/24/2026, 9:12 AM", "2B", "Passed"], ["10/23/2026, 3:40 PM", "4A", "Needs repair"], ["10/21/2026, 11:05 AM", "1C", "Passed"]] } : null,
        button: { label: fillTags(t.buttonLabel, tags, { line: true }) ?? "Open the entries", url: "https://forms.lanterncommunity.org" },
        note: withTable ? null : "The entries aren't in this email. Sign in to see them.",
      });
    return { subject: fillTags(t.subject, tags, { line: true }) ?? `${tags.report} - ${tags.site} - ${tags.date}`, from: "Made-up values", inside: html(true), outside: html(false) };
  }
  const tags = messageTags({ form: "Employee Separation", title: "New entry: Employee Separation", site: "Clover Hall", event: "A new entry", date: now });
  const w = messageWording({ ...t, details: t.details.join(",") || null }, tags, tags.title);
  const sample: Record<string, string> = { _site: "Clover Hall", _date: now.toLocaleString("en-US", { timeZone: "America/New_York" }), _by: "Jordan Main Office", _followup: "Open" };
  const fields = w.details.map((d) => ({ label: DETAIL_LABELS[d], value: sample[d] }));
  const html = (inside: boolean) =>
    brandedEmail({
      kicker: tags.form,
      heading: w.heading,
      intro: w.intro ?? `There's something for you in “${tags.form}”${tags.for_site}.`,
      whatToDo: w.whatToDo,
      fields: inside && fields.length ? fields : undefined,
      button: { label: w.buttonLabel ?? "Open it in Lantern Forms", url: "https://forms.lanterncommunity.org" },
      note: inside && fields.length ? "The rest is in Lantern Forms." : "The details aren't in this email. Sign in to see them.",
      urgent: w.urgent,
    }, look);
  return { subject: w.urgent ? `Urgent: ${w.subject}` : w.subject, from: "Made-up values", inside: html(true), outside: html(false) };
}

/** Made-up values for each of the site's own emails. */
const SYSTEM_SAMPLES: Record<string, { kicker: string; tags: Record<string, string> }> = {
  "access-request": { kicker: "People & roles", tags: { person: "Riley Case Worker", email: "riley@lanterncommunity.org", position: "Case Manager", sites: "Clover Hall", all_sites: "Clover Hall" } },
  "access-granted": { kicker: "People & roles", tags: { by: "Morgan Site Manager", role: "Site Staff", a_role: "a Site Staff", where: "Clover Hall" } },
  "access-changed": { kicker: "People & roles", tags: { by: "Morgan Site Manager", role: "Site Manager", a_role: "a Site Manager", where: "Clover Hall and Main Office" } },
  "sites-added": { kicker: "People & roles", tags: { by: "Morgan Site Manager", role: "Site Staff", a_role: "a Site Staff", where: "Clover Hall and Main Office", sites: "Main Office" } },
  "entry-problem": { kicker: "Hot Foods", tags: { source: "“Hot Foods”", target: "Meal Count" } },
  "daily-summary": { kicker: "Your daily summary", tags: { count: "3", notifications: "3 new notifications", unread: "3 notifications" } },
  "follow-up-done": { kicker: "Employee Separation", tags: messageTags({ form: "Employee Separation", title: "Employee Separation", site: "Clover Hall" }) },
  reminder: { kicker: "Employee Separation", tags: messageTags({ form: "Employee Separation", title: "Employee Separation", site: "Clover Hall" }) },
};

function systemPreview(t: TemplateInput, key: string) {
  const sample = SYSTEM_SAMPLES[key] ?? { kicker: "Lantern Forms", tags: {} };
  const w = messageWording({ ...t, details: null }, sample.tags, t.name);
  const extra = key === "follow-up-done" ? [{ label: "Done by", value: "Jordan Main Office" }, { label: "What was done", value: "Accounts closed, laptop collected." }] : key === "reminder" ? [{ label: "Filed by", value: "Riley Case Worker" }, { label: "Open for", value: "3 days" }] : [];
  const html = (inside: boolean) =>
    brandedEmail({
      kicker: sample.kicker,
      heading: w.heading,
      intro: w.intro,
      whatToDo: w.whatToDo,
      fields: inside && extra.length ? extra : undefined,
      button: { label: w.buttonLabel ?? "Open it in Lantern Forms", url: "https://forms.lanterncommunity.org" },
      note: inside && extra.length ? "The rest is in Lantern Forms." : "The details aren't in this email. Sign in to see them.",
      urgent: w.urgent,
    });
  return { subject: w.urgent ? `Urgent: ${w.subject}` : w.subject, from: "Made-up values", inside: html(true), outside: html(false) };
}

// ── How every email looks ────────────────────────────────────────────────

emailRouter.get(
  "/look",
  asyncHandler(async (req, res) => {
    res.json({
      look: await loadLook(),
      defaults: DEFAULT_LOOK,
      sender: env.mailFrom || null,
      canEdit: Boolean(req.user?.permissions.includes("email.templates")),
    });
  })
);

emailRouter.put(
  "/look",
  editors,
  asyncHandler(async (req, res) => {
    const { look } = z.object({ look: z.unknown() }).parse(req.body ?? {});
    res.json({ look: await saveLook(look, actorOf(req)) });
  })
);

/** An email in a look that isn't saved yet. Nothing is sent or saved. */
emailRouter.post(
  "/look/preview",
  asyncHandler(async (req, res) => {
    const { look } = z.object({ look: z.unknown() }).parse(req.body ?? {});
    const l: EmailLook = checkLook(look);
    const sample = samplePreview({ name: "Preview", description: null, kind: "message", subject: "{title}{at_site}", heading: "{title}", intro: "There's a new entry in “{form}”{for_site}.", whatToDo: "Open the entry and check it.", details: ["_site", "_date", "_by"], buttonLabel: "Open it in Lantern Forms", urgent: false }, l);
    res.json(sample);
  })
);

/** Every email the site sent (who, subject, whether it went; never the body), newest first. */
emailRouter.get(
  "/sent",
  asyncHandler(async (req, res) => {
    const q = (k: string) => (typeof req.query[k] === "string" && req.query[k] ? String(req.query[k]) : undefined);
    const items = await sentEmails({ formId: q("form"), kind: q("kind"), status: q("status"), to: q("to"), before: q("before"), limit: Number(req.query.limit) || 50 });
    const ids = [...new Set(items.map((i) => i.formId).filter(Boolean) as string[])];
    const forms = new Map((await prisma.builtForm.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } })).map((f) => [f.id, f.title]));
    res.json({ items: items.map((i) => ({ ...i, form: i.formId ? forms.get(i.formId) ?? "A deleted form" : null })) });
  })
);
