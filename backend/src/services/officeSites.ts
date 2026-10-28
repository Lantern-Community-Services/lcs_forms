import type { BuiltForm, Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { badRequest } from "../http.js";
import { audit, type Actor } from "./audit.js";

/**
 * Office sites (siteType "office", e.g. the Main Office): a place staff work,
 * not housing. They have no roster, so the roster screens, imports and every
 * form's site list leave them out, except forms whose editors turn on
 * "Include the Main Office" (kept with the form, like Who sees entries, and
 * saved straight away, not with Publish). Anyone filling such a form may pick
 * an office site, whatever sites they're assigned to.
 */

export const OFFICE = "office";

export const isOffice = (site: { siteType: string } | null | undefined) => site?.siteType === OFFICE;

/** A Prisma where-part: leave office sites out. */
export const notOffice: Prisma.SiteWhereInput = { siteType: { not: OFFICE } };

const COLLECTION = "access";
const DOC = "sites";

export async function formIncludesOffice(formId: string): Promise<boolean> {
  const row = await prisma.formRecord.findUnique({ where: { formId_collection_docId: { formId, collection: COLLECTION, docId: DOC } }, select: { data: true } });
  if (!row) return false;
  try {
    return JSON.parse(row.data)?.includeOffice === true;
  } catch {
    return false;
  }
}

/** By slug or id; false for an unknown form. */
export async function formRefIncludesOffice(ref: unknown): Promise<boolean> {
  if (typeof ref !== "string" || !ref) return false;
  const form = await prisma.builtForm.findFirst({ where: { OR: [{ slug: ref }, { id: ref }] }, select: { id: true } });
  return form ? formIncludesOffice(form.id) : false;
}

export interface OfficeSitesView {
  includeOffice: boolean;
  /** The office sites there are (name and code), so the editor can say which. */
  offices: { code: string; name: string }[];
  updatedByName: string | null;
  updatedAt: string | null;
}

export async function officeSitesView(form: Pick<BuiltForm, "id">): Promise<OfficeSitesView> {
  const [row, offices] = await Promise.all([
    prisma.formRecord.findUnique({ where: { formId_collection_docId: { formId: form.id, collection: COLLECTION, docId: DOC } }, select: { updatedByName: true, updatedAt: true } }),
    prisma.site.findMany({ where: { siteType: OFFICE, active: true }, select: { code: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return {
    includeOffice: await formIncludesOffice(form.id),
    offices,
    updatedByName: row?.updatedByName ?? null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

export async function saveOfficeSites(form: Pick<BuiltForm, "id" | "title">, input: unknown, actor: Actor): Promise<OfficeSitesView> {
  const on = (input as { includeOffice?: unknown } | null)?.includeOffice;
  if (typeof on !== "boolean") throw badRequest("includeOffice must be true or false.");
  const data = JSON.stringify({ includeOffice: on });
  await prisma.formRecord.upsert({
    where: { formId_collection_docId: { formId: form.id, collection: COLLECTION, docId: DOC } },
    create: { formId: form.id, collection: COLLECTION, docId: DOC, data, updatedByName: actor.name.slice(0, 255) },
    update: { data, updatedByName: actor.name.slice(0, 255) },
  });
  await audit({ actor, action: "forms.office_sites_changed", summary: `“${form.title}”: the Main Office is ${on ? "in" : "out of"} its site list` }).catch(() => undefined);
  return officeSitesView(form);
}
