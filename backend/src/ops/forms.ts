import { z } from "zod";
import { prisma } from "../prisma.js";
import { appBaseUrl } from "../env.js";
import { HttpError } from "../http.js";
import { fillRouter } from "../routes/fill.js";
import { appsRouter } from "../routes/apps.js";
import { findForm, formDetail, listForms, readDoc, versionDoc } from "../forms/service.js";
import { docForEntry, entryRow, entryWhere, submitEntry } from "../forms/entries.js";
import { defineOp, flag, int } from "./registry.js";

/**
 * Forms and their entries. The first group acts as the key itself (forms:build,
 * entries:read, entries:write), as the MCP tools always have; it used to live
 * in forms/mcp.ts and now also answers on /api/v1. The second group (entries:manage,
 * and entries:read for code-form history) acts as the key's creator through the
 * entry routes the Entries screens use.
 */

const formRef = z.string().describe("The form's id or its slug (URL name).");
const enc = (v: string) => encodeURIComponent(v);

/** A form's status and URLs, as the MCP tools report it. */
export function summarize(row: Awaited<ReturnType<typeof findForm>>) {
  if (row.kind === "code") {
    return { id: row.id, slug: row.slug, title: row.title, kind: "code", status: row.status, revision: row.revision, liveVersion: row.liveVersion, url: `${appBaseUrl}/apps/${row.slug}`, editorUrl: `${appBaseUrl}/admin/apps/${row.id}` };
  }
  const d = formDetail(row);
  return {
    id: d.id,
    slug: d.slug,
    title: d.title,
    status: d.status,
    revision: d.revision,
    liveVersion: d.liveVersion,
    unpublishedChanges: d.unpublishedChanges,
    url: `${appBaseUrl}/${d.draft.settings.access?.mode === "public" ? "p" : "f"}/${d.slug}`,
    editorUrl: `${appBaseUrl}/admin/builder/${d.id}`,
  };
}

export const formOps = [
  // ── As the key (unchanged MCP tools, now also REST) ──
  defineOp({
    name: "list_forms",
    description: "Every built form with its status, entry count and URLs.",
    scope: "forms:build",
    as: "key",
    http: { method: "GET", path: "/forms" },
    shape: { includeArchived: flag().optional() },
    annotations: { readOnlyHint: true },
    run: async (_ctx, { includeArchived }) =>
      (await listForms({ includeArchived })).map((f) => ({ ...f, url: `${appBaseUrl}/${f.access === "public" ? "p" : "f"}/${f.slug}`, editorUrl: `${appBaseUrl}/admin/builder/${f.id}` })),
  }),

  defineOp({
    name: "get_form",
    description: "A form's full document (the draft by default) plus its status and revision.",
    scope: "forms:build",
    as: "key",
    http: { method: "GET", path: "/forms/:form" },
    shape: { form: formRef, which: z.enum(["draft", "live"]).optional().describe("draft (default) or the live published version") },
    annotations: { readOnlyHint: true },
    run: async (_ctx, { form, which }) => {
      const row = await findForm(form);
      const doc = which === "live" ? (row.liveSchema ? readDoc(row.liveSchema) : null) : readDoc(row.draftSchema);
      if (!doc) throw new HttpError(404, "This form hasn't been published yet — ask for the draft.");
      return { ...summarize(row), doc };
    },
  }),

  defineOp({
    name: "get_version",
    description: "The document of one published version of a form (list_versions shows them).",
    scope: "forms:build",
    as: "key",
    http: { method: "GET", path: "/forms/:form/versions/:version" },
    shape: { form: formRef, version: int(1, 100000) },
    annotations: { readOnlyHint: true },
    run: async (_ctx, { form, version }) => {
      const row = await findForm(form);
      const doc = await versionDoc(row.id, version);
      if (!doc) throw new HttpError(404, "No such version.");
      return { ...summarize(row), version, doc };
    },
  }),

  defineOp({
    name: "list_entries",
    description: "Entries of a form, newest first.",
    scope: "entries:read",
    as: "key",
    http: { method: "GET", path: "/forms/:form/entries" },
    shape: {
      form: formRef,
      q: z.string().optional().describe("Search text"),
      from: z.string().optional().describe("YYYY-MM-DD"),
      to: z.string().optional().describe("YYYY-MM-DD"),
      status: z.enum(["active", "voided", "all"]).optional(),
      limit: int(1, 200).optional(),
    },
    annotations: { readOnlyHint: true },
    run: async (ctx, { form, q, from, to, status, limit }) => {
      const row = await findForm(form);
      const where = entryWhere(row, undefined, { q, from, to, status });
      if (ctx.key.siteId) (where.AND as object[]).push({ siteId: ctx.key.siteId });
      const [items, total] = await Promise.all([prisma.formEntry.findMany({ where, orderBy: { createdAt: "desc" }, take: limit ?? 50 }), prisma.formEntry.count({ where })]);
      return { total, items: items.map((e) => entryRow(e)) };
    },
  }),

  defineOp({
    name: "get_entry",
    description: "One entry, with the labels of the form version it was filled against, and its notes.",
    scope: "entries:read",
    as: "key",
    http: { method: "GET", path: "/forms/:form/entries/:id" },
    shape: { form: formRef, id: z.string() },
    annotations: { readOnlyHint: true },
    run: async (ctx, { form, id }) => {
      const row = await findForm(form);
      const entry = await prisma.formEntry.findFirst({ where: { id, formId: row.id, ...(ctx.key.siteId ? { siteId: ctx.key.siteId } : {}) } });
      if (!entry) throw new HttpError(404, "No such entry.");
      const doc = await docForEntry(row, entry.formVersion);
      const notes = await prisma.formEntryNote.findMany({ where: { entryId: entry.id }, orderBy: { createdAt: "asc" } });
      return { entry: entryRow(entry), fields: doc.fields.map((f) => ({ id: f.id, type: f.type, label: f.label })), notes };
    },
  }),

  defineOp({
    name: "submit_entry",
    description: "Submit an entry to a live form, validated exactly like a person's submission. Values are keyed by field id.",
    scope: "entries:write",
    as: "key",
    http: { method: "POST", path: "/forms/:form/entries" },
    shape: { form: formRef, values: z.record(z.unknown()), site: z.string().optional().describe("Site code, for forms that require a site") },
    run: async (ctx, { form, values, site }) => {
      const row = await findForm(form);
      const { entry } = await submitEntry({
        form: row, values, siteCode: site, user: undefined, actorName: ctx.actor.name, source: ctx.via === "MCP" ? "mcp" : "api", machineSiteIds: ctx.key.siteId ? [ctx.key.siteId] : null,
      });
      return { id: entry.id, values: JSON.parse(entry.data), url: `${appBaseUrl}/f/${row.slug}/entries/${entry.id}` };
    },
  }),

  // ── As the key's creator: managing entries ──
  defineOp({
    name: "void_entry",
    description: "Void a basic form's entry recorded in error, with a reason. It stays, marked void (restore_entry undoes it).",
    scope: "entries:manage",
    as: "creator",
    http: { method: "POST", path: "/forms/:form/entries/:id/void" },
    shape: { form: formRef, id: z.string(), reason: z.string().min(1).max(500) },
    confirm: true,
    annotations: { destructiveHint: true },
    run: (ctx, a) => ctx.route(fillRouter, { method: "POST", path: `/${enc(a.form)}/entries/${enc(a.id)}/void`, body: { reason: a.reason } }),
    audit: (a) => ({ action: "entries.voided", summary: `Voided entry ${a.id} of form “${a.form}”`, changes: { form: a.form, entry: a.id, reason: a.reason } }),
  }),

  defineOp({
    name: "restore_entry",
    description: "Un-void a basic form's entry (Admins: forms.manage).",
    scope: "entries:manage",
    as: "creator",
    http: { method: "POST", path: "/forms/:form/entries/:id/restore" },
    shape: { form: formRef, id: z.string() },
    run: (ctx, a) => ctx.route(fillRouter, { method: "POST", path: `/${enc(a.form)}/entries/${enc(a.id)}/void`, body: { restore: true } }),
    audit: (a) => ({ action: "entries.restored", summary: `Restored voided entry ${a.id} of form “${a.form}”`, changes: { form: a.form, entry: a.id } }),
  }),

  defineOp({
    name: "update_entry",
    description: "Change a basic form's entry's answers (Admins: forms.manage). values are merged over the entry's, keyed by field id, and validated like a submission.",
    scope: "entries:manage",
    as: "creator",
    http: { method: "PATCH", path: "/forms/:form/entries/:id" },
    shape: { form: formRef, id: z.string(), values: z.record(z.unknown()) },
    confirm: true,
    run: (ctx, a) => ctx.route(fillRouter, { method: "PATCH", path: `/${enc(a.form)}/entries/${enc(a.id)}`, body: { values: a.values } }),
    // Field ids only: the answers can be about a resident.
    audit: (a) => ({ action: "entries.edited", summary: `Edited entry ${a.id} of form “${a.form}”`, changes: { form: a.form, entry: a.id, fields: Object.keys(a.values) } }),
  }),

  defineOp({
    name: "add_entry_note",
    description: "Add a note to a basic form's entry (shown on the entry, with the creator's name and this key).",
    scope: "entries:manage",
    as: "creator",
    http: { method: "POST", path: "/forms/:form/entries/:id/notes" },
    shape: { form: formRef, id: z.string(), body: z.string().min(1).max(4000) },
    run: (ctx, a) => ctx.route(fillRouter, { method: "POST", path: `/${enc(a.form)}/entries/${enc(a.id)}/notes`, body: { body: a.body } }),
  }),

  defineOp({
    name: "delete_entry",
    description: "Delete a basic form's entry and its files for good (Admins: forms.manage). Prefer void_entry: a voided entry can be restored.",
    scope: "entries:manage",
    as: "creator",
    http: { method: "DELETE", path: "/forms/:form/entries/:id" },
    shape: { form: formRef, id: z.string() },
    confirm: true,
    annotations: { destructiveHint: true },
    run: (ctx, a) => ctx.route(fillRouter, { method: "DELETE", path: `/${enc(a.form)}/entries/${enc(a.id)}` }),
    audit: (a) => ({ action: "entries.deleted", summary: `Deleted entry ${a.id} of form “${a.form}”`, changes: { form: a.form, entry: a.id } }),
  }),

  defineOp({
    name: "void_code_entry",
    description: "Void a code form's entry, with a reason, under the form's own void rules.",
    scope: "entries:manage",
    as: "creator",
    http: { method: "POST", path: "/apps/:form/entries/:id/void" },
    shape: { form: formRef, id: z.string(), reason: z.string().min(1).max(500) },
    confirm: true,
    annotations: { destructiveHint: true },
    run: (ctx, a) => ctx.route(appsRouter, { method: "POST", path: `/${enc(a.form)}/entries/${enc(a.id)}/void`, body: { reason: a.reason } }),
    audit: (a) => ({ action: "entries.voided", summary: `Voided entry ${a.id} of code form “${a.form}”`, changes: { form: a.form, entry: a.id, reason: a.reason } }),
  }),

  defineOp({
    name: "restore_code_entry",
    description: "Un-void a code form's entry.",
    scope: "entries:manage",
    as: "creator",
    http: { method: "POST", path: "/apps/:form/entries/:id/restore" },
    shape: { form: formRef, id: z.string() },
    run: (ctx, a) => ctx.route(appsRouter, { method: "POST", path: `/${enc(a.form)}/entries/${enc(a.id)}/restore` }),
    audit: (a) => ({ action: "entries.restored", summary: `Restored voided entry ${a.id} of code form “${a.form}”`, changes: { form: a.form, entry: a.id } }),
  }),

  defineOp({
    name: "code_entry_history",
    description: "A code form's entry's change history: every version of its data, who saved it and why.",
    scope: "entries:read",
    as: "creator",
    http: { method: "GET", path: "/apps/:form/entries/:id/history" },
    shape: { form: formRef, id: z.string() },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.route(appsRouter, { method: "GET", path: `/${enc(a.form)}/entries/${enc(a.id)}/history` }),
  }),
];
