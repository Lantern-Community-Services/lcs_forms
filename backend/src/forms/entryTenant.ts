import type { FormDoc, Values } from "./engine.js";

/**
 * The resident a basic form's entry is about: the first Resident question
 * answered from the roster (its picked id; a resident typed in by name has none).
 * Kept on the entry (FormEntry.tenantId), as code forms already do, so a
 * resident's timeline (services/clientTimeline.ts) finds their entries without
 * reading every form's answers.
 */
export function entryTenantId(doc: Pick<FormDoc, "fields">, values: Values): string | null {
  for (const f of doc.fields) {
    if (f.type !== "resident") continue;
    const v = values[f.id];
    const id = v && typeof v === "object" && !Array.isArray(v) ? (v as { id?: unknown }).id : undefined;
    if (typeof id === "string" && id) return id;
  }
  return null;
}
