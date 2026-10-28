import { prisma } from "../prisma.js";
import { loadRouting } from "./routing.js";
import { loadReports } from "./emailReports.js";
import { PRESETS } from "./emailTemplates.js";

/**
 * Where each email template is used: every form's routes and weekly reports
 * that name it, and the site's own follow-up emails (which use their presets).
 * Shown on each template, so a Super Admin sees what a change reaches, and
 * checked before one is deleted.
 */

export interface TemplateUse {
  formId: string | null;
  form: string;
  kind: "route" | "report" | "site";
  name: string;
}

export async function templateUsage(): Promise<Map<string, TemplateUse[]>> {
  const out = new Map<string, TemplateUse[]>();
  const add = (key: string, use: TemplateUse) => out.set(key, [...(out.get(key) ?? []), use]);
  // The site's own emails: always sent by the site.
  for (const p of PRESETS.filter((x) => x.kind === "system")) add(p.key, { formId: null, form: "Lantern Forms", kind: "site", name: p.description ?? p.name });

  const forms = await prisma.builtForm.findMany({ where: { status: { not: "archived" } }, orderBy: { title: "asc" } });
  for (const form of forms) {
    const [routing, reports] = await Promise.all([loadRouting(form).catch(() => null), loadReports(form).catch(() => null)]);
    for (const r of routing?.routes ?? []) if (r.template) add(r.template, { formId: form.id, form: form.title, kind: "route", name: r.name });
    for (const r of reports?.reports ?? []) if (r.template) add(r.template, { formId: form.id, form: form.title, kind: "report", name: r.name });
  }
  return out;
}

/** How many routes and reports use a template (the site's own uses don't count: they can't be moved). */
export async function usedBy(key: string) {
  return ((await templateUsage()).get(key) ?? []).filter((u) => u.kind !== "site").length;
}
