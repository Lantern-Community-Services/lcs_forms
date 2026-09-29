import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ADDRESS_PARTS, NAME_PARTS, hasChoices, isInputField, type Conditional, type Field, type Rule, type RuleOp } from "@/lib/formEngine";

const OPS: { value: RuleOp; label: string; noValue?: boolean }[] = [
  { value: "is", label: "is" },
  { value: "is_not", label: "is not" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "doesn't contain" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with", label: "ends with" },
  { value: "gt", label: "is greater than" },
  { value: "lt", label: "is less than" },
  { value: "gte", label: "is at least" },
  { value: "lte", label: "is at most" },
  { value: "empty", label: "is empty", noValue: true },
  { value: "not_empty", label: "is filled in", noValue: true },
];

/** Targets a rule can read: every input field, and each part of name/address fields. */
function targets(fields: Field[], selfId?: string) {
  const out: { value: string; label: string; field: Field }[] = [];
  for (const f of fields) {
    if (!isInputField(f) || f.id === selfId) continue;
    if (f.type === "name" || f.type === "address") {
      out.push({ value: f.id, label: f.label || f.id, field: f });
      const parts = f.type === "name" ? f.nameParts ?? ["first", "last"] : f.addressParts ?? ["line1", "city", "state", "zip"];
      const labels = (f.type === "name" ? NAME_PARTS : ADDRESS_PARTS) as Record<string, string>;
      for (const p of parts) out.push({ value: `${f.id}.${p}`, label: `${f.label || f.id} → ${labels[p]}`, field: f });
    } else out.push({ value: f.id, label: f.label || f.id, field: f });
  }
  return out;
}

/**
 * Show / hide rules. Used for fields, sections, pages and notifications.
 * `value` undefined means "always".
 */
export function ConditionalEditor({
  value,
  onChange,
  fields,
  selfId,
  noun = "this field",
}: {
  value: Conditional | undefined;
  onChange: (c: Conditional | undefined) => void;
  fields: Field[];
  selfId?: string;
  noun?: string;
}) {
  const opts = targets(fields, selfId);
  if (!value) {
    return (
      <div className="rounded-input border border-dashed border-hairline p-4 text-center">
        <p className="text-[13px] text-muted">{noun[0].toUpperCase() + noun.slice(1)} always shows.</p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-2"
          disabled={!opts.length}
          onClick={() => onChange({ action: "show", match: "all", rules: [{ field: opts[0]?.value ?? "", op: "is", value: "" }] })}
        >
          <Plus className="h-3.5 w-3.5" /> Add a rule
        </Button>
        {!opts.length && <p className="mt-2 text-micro text-muted">Add another field first — rules read other answers.</p>}
      </div>
    );
  }
  const setRule = (i: number, patch: Partial<Rule>) => onChange({ ...value, rules: value.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink">
        <Select value={value.action} onChange={(e) => onChange({ ...value, action: e.target.value as "show" | "hide" })} options={[{ value: "show", label: "Show" }, { value: "hide", label: "Hide" }]} className="w-24" />
        <span>{noun} when</span>
        <Select value={value.match} onChange={(e) => onChange({ ...value, match: e.target.value as "all" | "any" })} options={[{ value: "all", label: "all" }, { value: "any", label: "any" }]} className="w-20" />
        <span>of these are true:</span>
      </div>
      {value.rules.map((r, i) => {
        const target = opts.find((o) => o.value === r.field);
        const op = OPS.find((o) => o.value === r.op);
        const whole = target && !r.field.includes(".");
        const choiceField = whole && hasChoices(target.field) && target.field.type !== "likert" ? target.field : null;
        return (
          <div key={i} className="grid gap-1.5 rounded-input border border-hairline bg-subtle/50 p-2">
            <div className="flex gap-1.5">
              <Select value={r.field} onChange={(e) => setRule(i, { field: e.target.value, value: "" })} options={opts.map((o) => ({ value: o.value, label: o.label }))} placeholder={target ? undefined : "Pick a field…"} className="flex-1" />
              <Button variant="ghost" size="icon" aria-label="Remove rule" onClick={() => {
                const rules = value.rules.filter((_, j) => j !== i);
                onChange(rules.length ? { ...value, rules } : undefined);
              }}><Trash2 className="h-4 w-4" /></Button>
            </div>
            <div className="flex gap-1.5">
              <Select value={r.op} onChange={(e) => setRule(i, { op: e.target.value as RuleOp })} options={OPS.map((o) => ({ value: o.value, label: o.label }))} className="w-40 shrink-0" />
              {!op?.noValue &&
                (choiceField ? (
                  <Select value={String(r.value ?? "")} onChange={(e) => setRule(i, { value: e.target.value })} placeholder="Choose…" options={(choiceField.choices ?? []).map((c) => ({ value: c.value, label: c.label }))} className="flex-1" />
                ) : target?.field.type === "consent" ? (
                  <Select value={String(r.value ?? "true")} onChange={(e) => setRule(i, { value: e.target.value === "true" })} options={[{ value: "true", label: "ticked" }, { value: "false", label: "not ticked" }]} className="flex-1" />
                ) : (
                  <Input value={String(r.value ?? "")} onChange={(e) => setRule(i, { value: e.target.value })} placeholder={target?.field.type === "date" ? "YYYY-MM-DD or today" : "value"} className="flex-1" />
                ))}
            </div>
          </div>
        );
      })}
      <div className="flex justify-between">
        <Button variant="secondary" size="sm" onClick={() => onChange({ ...value, rules: [...value.rules, { field: opts[0]?.value ?? "", op: "is", value: "" }] })}>
          <Plus className="h-3.5 w-3.5" /> Add rule
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onChange(undefined)}>Remove all rules</Button>
      </div>
    </div>
  );
}
