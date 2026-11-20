import type { AuditEvent } from "@/lib/types";
import { formatDay } from "@/lib/utils";

/**
 * What a resident edit changed, as "Label: old → new" lines, from the audit
 * event's { field: [before, after] } (backend routes/tenants.ts PATCH). Used
 * by the resident's History and Roster → Activity, so a rename shows the name
 * they had, not just "Updated …".
 */

const LABELS: Record<string, string> = {
  firstName: "First name",
  lastName: "Last name",
  preferredName: "Preferred name",
  unit: "Unit",
  moveInDate: "Move-in date",
  notes: "Notes",
  externalId: "Outside ID",
  highAcuity: "High Acuity",
};

function shown(field: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "none";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (field === "moveInDate" && typeof v === "string") return formatDay(v);
  const s = String(v);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

/** "dateOfBirth" → "Date of birth" (client information keys; the summary names them properly). */
const humanize = (key: string) =>
  key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/ ([A-Z])(?=[a-z])/g, (_, c: string) => ` ${c.toLowerCase()}`)
    .replace(/\bSsn\b/, "SSN")
    .replace(/\bDob\b/, "DOB");

function clientShown(v: unknown): string {
  if (v === null || v === undefined || v === "") return "none";
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? String((x as { name?: string }).name ?? "") : String(x))).join(", ") || "none";
  const s = String(v);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

export function changeLines(e: Pick<AuditEvent, "action" | "changes">): { label: string; from: string; to: string }[] {
  // Client information: { field: { from, to } } (backend services/clientProfile.ts). Ids (case lead,
  // head of household) are left to the summary; the SSN arrives masked.
  if (e.action === "tenant.profile_updated" && e.changes) {
    return Object.entries(e.changes as Record<string, { from: unknown; to: unknown }>)
      .filter(([k, v]) => v && typeof v === "object" && "to" in v && k !== "caseLead")
      .map(([k, v]) => ({ label: k === "ssn" ? "SSN" : humanize(k), from: clientShown(v.from), to: clientShown(v.to) }));
  }
  if (e.action !== "tenant.updated" || !e.changes) return [];
  return Object.entries(e.changes).flatMap(([field, v]) =>
    // The site move is in the summary already ("Moved … from A to B").
    Array.isArray(v) && v.length === 2 && field in LABELS ? [{ label: LABELS[field], from: shown(field, v[0]), to: shown(field, v[1]) }] : []
  );
}

export function ChangeList({ event, className }: { event: Pick<AuditEvent, "action" | "changes">; className?: string }) {
  const lines = changeLines(event);
  if (!lines.length) return null;
  return (
    <ul className={className ?? "mt-0.5 space-y-0.5 text-label text-muted"}>
      {lines.map((l) => (
        <li key={l.label}>
          <span className="font-semibold">{l.label}:</span> <span className="line-through decoration-muted/60">{l.from}</span> <span aria-hidden>→</span>
          <span className="sr-only"> changed to </span> <span className="text-ink">{l.to}</span>
        </li>
      ))}
    </ul>
  );
}
