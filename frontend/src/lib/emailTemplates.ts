import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

/**
 * The organization's email templates (backend services/emailTemplates.ts,
 * routes/emailTemplates.ts): Admin → Notifications → Templates, and the
 * Wording picker on every route and weekly report.
 */

/** message: routes and code forms; report: weekly reports; system: the site's own emails. */
export type TemplateKind = "message" | "report" | "system";

export interface TemplateUse { formId: string | null; form: string; kind: "route" | "report" | "site"; name: string }

export interface EmailTemplate {
  id: string;
  key: string;
  name: string;
  description: string | null;
  kind: TemplateKind;
  subject: string | null;
  heading: string | null;
  intro: string | null;
  whatToDo: string | null;
  details: string[];
  buttonLabel: string | null;
  urgent: boolean;
  preset: boolean;
  /** A preset changed from what the site ships. */
  changed: boolean;
  hidden: boolean;
  revision: number;
  createdByName: string | null;
  updatedByName: string | null;
  createdAt: string;
  updatedAt: string;
  uses: TemplateUse[];
}

export interface TemplatesView {
  templates: EmailTemplate[];
  tags: Record<TemplateKind, { tag: string; means: string }[]>;
  /** Each system email's own tags, by key. */
  systemTags: Record<string, { tag: string; means: string }[]>;
  details: { id: string; label: string }[];
  defaults: { message: string; report: string };
  /** Super Admins only. */
  canEdit: boolean;
}

/** What a template saves: its wording. */
export type TemplateDraft = Pick<EmailTemplate, "name" | "description" | "kind" | "subject" | "heading" | "intro" | "whatToDo" | "details" | "buttonLabel" | "urgent">;

export interface EmailPreview { subject: string; from: string; inside: string; outside: string; form?: string }

export const templateKeys = { all: ["email", "templates"] as const, one: (id: string) => ["email", "templates", id] as const };

export function useEmailTemplates() {
  return useQuery({ queryKey: templateKeys.all, queryFn: () => api.get<TemplatesView>("/email/templates"), staleTime: 30_000 });
}

export const templatesApi = {
  get: (id: string) => api.get<EmailTemplate>(`/email/templates/${encodeURIComponent(id)}`),
  create: (template: TemplateDraft, key?: string) => api.post<EmailTemplate>("/email/templates", { template, ...(key ? { key } : {}) }),
  copy: (id: string, name?: string) => api.post<EmailTemplate>("/email/templates", { copyOf: id, ...(name ? { name } : {}) }),
  update: (id: string, template: TemplateDraft, revision: number) => api.put<EmailTemplate>(`/email/templates/${encodeURIComponent(id)}`, { template, revision }),
  reset: (id: string) => api.post<EmailTemplate>(`/email/templates/${encodeURIComponent(id)}/reset`, {}),
  setHidden: (id: string, hidden: boolean) => api.post<EmailTemplate>(`/email/templates/${encodeURIComponent(id)}/hidden`, { hidden }),
  remove: (id: string) => api.delete(`/email/templates/${encodeURIComponent(id)}`),
  preview: (template: TemplateDraft, form?: string, key?: string) => api.post<EmailPreview>("/email/templates/preview", { template, ...(form ? { form } : {}), ...(key ? { key } : {}) }),
};

/** How every email looks (backend services/emailLook.ts). */
export interface EmailLook { orgName: string; bandColor: string; accentColor: string; buttonColor: string; logoUrl: string; footer: string }
export interface LookView { look: EmailLook; defaults: EmailLook; sender: string | null; canEdit: boolean }

export const lookApi = {
  get: () => api.get<LookView>("/email/look"),
  save: (look: EmailLook) => api.put<{ look: EmailLook }>("/email/look", { look }),
  preview: (look: EmailLook) => api.post<EmailPreview>("/email/look/preview", { look }),
};

/** WCAG contrast of white text on a color (the band and button carry white text): 4.5 is the least. */
export function whiteContrast(color: string) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return 0;
  const c = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 1.05 / (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] + 0.05);
}

/** "Site, Submitted and Submitted by". */
export function listWords(items: string[]) {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The Wording picker's list: templates of a kind, keeping a hidden one a route already uses. */
export function templateOptions(view: TemplatesView | undefined, kind: TemplateKind, current?: string) {
  return (view?.templates ?? []).filter((t) => t.kind === kind && (!t.hidden || t.key === current));
}
