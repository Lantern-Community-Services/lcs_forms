import type { BuiltForm } from "@prisma/client";
import type { CurrentUser } from "../auth/middleware.js";
import { audit, type Actor } from "../services/audit.js";
import type { FormDoc } from "./engine.js";

/**
 * Clinical records: a basic form marked settings.clinical (the Psychosocial,
 * the Face Sheet) holds diagnoses, medications, substance use and suicide or
 * homicide risk. "Who sees entries" still decides whose entries a person sees;
 * on top of that, a clinical record's entries, their files, its exports and the
 * MCP/REST entry tools are only for Admins and people who can see client
 * information (clients.view, the "Client information" switch on their account).
 *
 * The rule sits in forms/entries.ts canSeeEntry, visibleWhere and
 * canReadEntries, so everything that reads entries through them keeps to it.
 * Every opening of a clinical entry and every export is audited (which form and
 * entries, never the answers); exports carry the 42 CFR Part 2 notice; and the
 * answers never go in an email (services/routing.ts emailableFields). Its
 * sign-offs only go to people who can see it (services/signOff.ts).
 */

/** Whether a basic form is a clinical record, as published (or its draft, before it ever is). */
export function isClinicalForm(form: Pick<BuiltForm, "kind" | "liveSchema" | "draftSchema">): boolean {
  if (form.kind === "code") return false;
  const raw = form.liveSchema ?? form.draftSchema;
  // Most forms aren't: no need to read the whole document to know.
  if (!raw || !raw.includes('"clinical"')) return false;
  try {
    return (JSON.parse(raw) as FormDoc).settings?.clinical === true;
  } catch {
    return false;
  }
}

/** Admins and people with the "Client information" switch on (clients.view). */
export const seesClinical = (user: Pick<CurrentUser, "permissions"> | null | undefined) => Boolean(user?.permissions.includes("clients.view"));

/** This person is kept out of this form's entries because it's a clinical record. */
export const clinicalBlocked = (form: Pick<BuiltForm, "kind" | "liveSchema" | "draftSchema">, user: Pick<CurrentUser, "permissions"> | null | undefined) =>
  isClinicalForm(form) && !seesClinical(user);

export const CLINICAL_REFUSAL = "This form is a clinical record: only Admins and people who can see client information can open its entries.";

/**
 * The redisclosure notice that goes with a clinical record when it leaves the
 * site (42 CFR § 2.32(a)(1), "Statement 1", as amended 89 FR 12626, Feb. 16, 2024).
 */
export const PART2_NOTICE =
  "This record which has been disclosed to you is protected by Federal confidentiality rules (42 CFR part 2). These rules prohibit you from using or disclosing this record, or testimony that describes the information contained in this record, in any civil, criminal, administrative, or legislative proceedings by any Federal, State, or local authority, against the patient, unless authorized by the consent of the patient, except as provided at 42 CFR 2.12(c)(5) or as authorized by a court in accordance with 42 CFR 2.64 or 2.65. In addition, the Federal rules prohibit you from making any other use or disclosure of this record unless at least one of the following applies: (i) Further use or disclosure is expressly permitted by the written consent of the individual whose information is being disclosed in this record or as otherwise permitted by 42 CFR part 2. (ii) You are a covered entity or business associate and have received the record for treatment, payment, or health care operations, or (iii) You have received the record from a covered entity or business associate as permitted by 45 CFR part 164, subparts A and E. A general authorization for the release of medical or other information is NOT sufficient to meet the required elements of written consent to further use or redisclose the record (see 42 CFR 2.31).";

/** § 2.32(a)(2), "Statement 2": the short form, for a PDF's page footers. */
export const PART2_NOTICE_SHORT = "42 CFR part 2 prohibits unauthorized use or disclosure of these records.";

/** Someone opened a clinical entry (or one of its files). Never the answers. */
export async function auditClinicalView(actor: Actor, form: Pick<BuiltForm, "id" | "slug" | "title">, entry: { id: string; siteId: string | null }, via?: { fileId?: string; tool?: string }) {
  await audit({
    actor,
    action: "entry.viewed",
    summary: `Opened ${via?.fileId ? "a file on " : ""}an entry of “${form.title}” (clinical record)${via?.tool ? ` with ${via.tool}` : ""}`,
    siteId: entry.siteId,
    changes: { formId: form.id, form: form.slug, entryId: entry.id, ...(via?.fileId ? { fileId: via.fileId } : {}), ...(via?.tool ? { via: via.tool } : {}) },
  });
}

/** Someone exported a clinical record's entries: which ones, and how. Never the answers. */
export async function auditClinicalExport(actor: Actor, form: Pick<BuiltForm, "id" | "slug" | "title">, entryIds: string[], format: string) {
  await audit({
    actor,
    action: "entries.exported",
    summary: `Exported ${entryIds.length} entr${entryIds.length === 1 ? "y" : "ies"} of “${form.title}” (clinical record) as ${format.toUpperCase()}`,
    changes: { formId: form.id, form: form.slug, format, count: entryIds.length, entryIds },
  });
}
