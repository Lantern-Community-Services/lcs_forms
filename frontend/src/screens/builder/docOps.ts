import { expressionRefs, type Field, type FormDoc } from "@/lib/formEngine";

/** Pure helpers the builder uses to change a form document. */

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/**
 * Change a field's id everywhere it's used: other fields' rules, siteField,
 * calculations, merge tags in text, notifications. Renaming by hand would
 * silently break every rule that pointed at the old id.
 */
export function renameFieldId(doc: FormDoc, oldId: string, newId: string): FormDoc {
  const tag = new RegExp(`\\{${oldId}([.:}])`, "g");
  const walk = (node: unknown, key?: string): unknown => {
    if (typeof node === "string") {
      if (key === "field" && (node === oldId || node.startsWith(`${oldId}.`))) return newId + node.slice(oldId.length);
      if ((key === "siteField" || key === "id") && node === oldId) return newId;
      return node.replace(tag, `{${newId}$1`);
    }
    if (Array.isArray(node)) return node.map((n) => walk(n));
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, k)]));
    return node;
  };
  const next = clone(doc);
  // Only top-level ids are renamed; a repeater's sub-field ids are their own namespace.
  next.fields = next.fields.map((f) => {
    const w = walk({ ...f, fields: undefined }) as Field;
    if (f.fields) w.fields = f.fields;
    else delete w.fields;
    return w;
  });
  next.settings = walk(next.settings) as FormDoc["settings"];
  next.description = typeof next.description === "string" ? (walk(next.description) as string) : next.description;
  return next;
}

/** Labels of the fields (and notifications) that refer to a field id — to warn before deleting it. */
export function referencesTo(doc: FormDoc, id: string): string[] {
  const out: string[] = [];
  const tag = new RegExp(`\\{${id}[.:}]`);
  for (const f of doc.fields) {
    if (f.id === id) continue;
    const uses =
      f.conditional?.rules.some((r) => r.field.split(".")[0] === id) ||
      f.siteField === id ||
      (f.expression && expressionRefs(f.expression).includes(id)) ||
      (typeof f.content === "string" && tag.test(f.content)) ||
      (typeof f.defaultValue === "string" && tag.test(f.defaultValue));
    if (uses) out.push(f.label || f.id);
  }
  for (const n of doc.settings.notifications ?? []) {
    if (n.conditional?.rules.some((r) => r.field.split(".")[0] === id) || [n.to, n.subject, n.body, n.link].some((s) => s && tag.test(s))) out.push(`notification “${n.name}”`);
  }
  if (doc.settings.confirmation?.message && tag.test(doc.settings.confirmation.message)) out.push("the confirmation message");
  return out;
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to > from ? to - 1 : to, 0, item);
  return next;
}

/** A value from a label: "Needs follow-up?" → "needs_follow_up". */
export const valueFromLabel = (label: string) => label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "option";

export const CHOICE_PRESETS: { name: string; labels: string[] }[] = [
  { name: "Yes / No", labels: ["Yes", "No"] },
  { name: "Yes / No / Not sure", labels: ["Yes", "No", "Not sure"] },
  { name: "Days of the week", labels: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] },
  { name: "Months", labels: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] },
  { name: "Agreement (5)", labels: ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"] },
  { name: "Satisfaction (5)", labels: ["Very unsatisfied", "Unsatisfied", "Neutral", "Satisfied", "Very satisfied"] },
  { name: "NYC boroughs", labels: ["Bronx", "Brooklyn", "Manhattan", "Queens", "Staten Island"] },
  { name: "Gender", labels: ["Woman", "Man", "Non-binary", "Prefer to self-describe", "Prefer not to say"] },
  {
    name: "US states",
    labels: ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "District of Columbia", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming"],
  },
];
