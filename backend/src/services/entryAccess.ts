import type { BuiltForm } from "@prisma/client";
import { prisma } from "../prisma.js";
import { notFound } from "../http.js";
import { DEFAULT_ENTRIES_ROLES } from "../forms/entries.js";
import { readDoc } from "../forms/service.js";
import { DEFAULT_ENTRY_READERS } from "../apps/project.js";
import { manifestOf } from "./routing.js";
import { audit, type Actor } from "./audit.js";
import { entryAccessOf, setEntryAccess, type EntryAccess } from "./staffGroups.js";

/**
 * A form's "Who sees entries", as its editors show and change it (both kinds
 * of form). The rules themselves are in staffGroups.ts (entryReach); this is
 * the view: the setting, or, for a form saved before it existed, the old
 * reader roles that still apply until someone reviews it.
 */

export interface EntryAccessView {
  form: { id: string; slug: string; title: string; kind: string };
  /** The saved setting; null while the old readers apply. */
  access: EntryAccess | null;
  /** The form's old reader roles (they see every entry until it's reviewed). */
  legacyReaders: string[];
  updatedByName: string | null;
  updatedAt: string | null;
}

export async function builtFormRef(idOrSlug: string): Promise<BuiltForm> {
  const form = await prisma.builtForm.findFirst({ where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] } });
  if (!form) throw notFound(`No form "${idOrSlug}".`);
  return form;
}

/** The roles that saw every entry before "Who sees entries": entriesRoles, or form.json entries.read. */
export function legacyReadersOfForm(form: BuiltForm): string[] {
  if (form.kind === "code") return manifestOf(form)?.entries?.read ?? DEFAULT_ENTRY_READERS;
  return readDoc(form.liveSchema ?? form.draftSchema).settings.entriesRoles ?? DEFAULT_ENTRIES_ROLES;
}

export async function entryAccessView(form: BuiltForm): Promise<EntryAccessView> {
  const row = await prisma.formRecord.findUnique({ where: { formId_collection_docId: { formId: form.id, collection: "access", docId: "entries" } }, select: { updatedByName: true, updatedAt: true } });
  return {
    form: { id: form.id, slug: form.slug, title: form.title, kind: form.kind },
    access: entryAccessOf(form.id),
    legacyReaders: legacyReadersOfForm(form),
    updatedByName: row?.updatedByName ?? null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

export async function saveEntryAccess(form: BuiltForm, input: unknown, actor: Actor): Promise<EntryAccessView> {
  const saved = await setEntryAccess(form.id, input, actor.name);
  const who = { own: "only their own", site: "their sites'", everyone: "everyone's" }[saved.mode];
  await audit({ actor, action: "forms.entry_access_changed", summary: `“${form.title}”: everyone sees ${who} entries` }).catch(() => undefined);
  return entryAccessView(form);
}

/** Every live form and who sees its entries: for the catalog to flag the ones still on their old readers. */
export async function entryAccessReview() {
  const forms = await prisma.builtForm.findMany({ where: { status: { not: "archived" } }, orderBy: { title: "asc" } });
  return forms.map((f) => {
    const access = entryAccessOf(f.id);
    return {
      id: f.id,
      slug: f.slug,
      title: f.title,
      kind: f.kind,
      reviewed: Boolean(access),
      mode: access?.mode ?? null,
      legacyReaders: access ? [] : legacyReadersOfForm(f),
    };
  });
}
