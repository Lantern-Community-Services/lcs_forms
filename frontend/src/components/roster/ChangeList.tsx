import type { AuditEvent } from "@/lib/types";
import { formatDate } from "@/lib/utils";

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
  if (field === "moveInDate" && typeof v === "string") return formatDate(v);
  const s = String(v);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

export function changeLines(e: Pick<AuditEvent, "action" | "changes">): { label: string; from: string; to: string }[] {
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
    <ul className={className ?? "mt-0.5 space-y-0.5 text-[12.5px] text-muted"}>
      {lines.map((l) => (
        <li key={l.label}>
          <span className="font-semibold">{l.label}:</span> <span className="line-through decoration-muted/60">{l.from}</span> <span aria-hidden>→</span>
          <span className="sr-only"> changed to </span> <span className="text-ink">{l.to}</span>
        </li>
      ))}
    </ul>
  );
}
