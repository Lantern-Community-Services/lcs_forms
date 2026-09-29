import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, GripVertical, ListPlus, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CodeEditor } from "@/components/formkit/CodeEditor";
import { ConditionalEditor } from "./ConditionalEditor";
import { CHOICE_PRESETS, valueFromLabel } from "./docOps";
import { cn } from "@/lib/utils";
import {
  ADDRESS_PARTS, CODE_BLOCK_API, EXPRESSION_FUNCTIONS, FIELD_ID_RE, FIELD_TYPES, NAME_PARTS, evaluate, expressionRefs, hasChoices,
  isInputField, newField, parseExpression, typeInfo,
  type Choice, type Field, type FieldType,
} from "@/lib/formEngine";

type Tab = "general" | "choices" | "logic" | "advanced" | "code";

const NOT_IN_REPEATER: FieldType[] = ["repeater", "page", "file", "signature", "code", "resident", "site"];

/**
 * Everything about one field. `siblings` are the fields its rules and
 * calculations can read — the whole form, or a repeater's row.
 * `onRename` changes the id everywhere it's referenced (top-level fields).
 */
export function FieldProperties({
  field,
  siblings,
  onChange,
  onRename,
  nested,
}: {
  field: Field;
  siblings: Field[];
  onChange: (f: Field) => void;
  onRename?: (newId: string) => void;
  nested?: boolean;
}) {
  const info = typeInfo(field.type);
  const tabs: { key: Tab; label: string }[] = [
    { key: "general", label: "General" },
    ...(hasChoices(field) ? [{ key: "choices" as Tab, label: field.type === "likert" ? "Scale & rows" : "Choices" }] : []),
    ...(field.type === "code" ? [{ key: "code" as Tab, label: "Code" }] : []),
    { key: "logic", label: field.conditional ? "Logic ●" : "Logic" },
    { key: "advanced", label: "Advanced" },
  ];
  const [tab, setTab] = useState<Tab>("general");
  const active = tabs.some((t) => t.key === tab) ? tab : "general";
  const set = (patch: Partial<Field>) => {
    const next = { ...field, ...patch } as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) if (v === undefined || v === "") delete next[k];
    onChange(next as unknown as Field);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-hairline px-4 pb-0 pt-3">
        <p className="text-micro font-bold uppercase tracking-[0.04em] text-muted">{info?.label ?? field.type}</p>
        <p className="truncate font-heading text-[15px] font-extrabold text-ink">{field.label || field.id}</p>
        <div className="-mb-px mt-2 flex gap-3 overflow-x-auto">
          {tabs.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)} className={cn("whitespace-nowrap border-b-2 pb-2 text-[12.5px] font-semibold", active === t.key ? "border-navy text-accent dark:border-white dark:text-white" : "border-transparent text-muted hover:text-ink")}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 scroll-thin">
        {active === "general" && <General field={field} set={set} siblings={siblings} nested={nested} />}
        {active === "choices" && <ChoicesTab field={field} set={set} />}
        {active === "code" && <CodeTab field={field} set={set} />}
        {active === "logic" && (
          <>
            <ConditionalEditor value={field.conditional} onChange={(c) => set({ conditional: c })} fields={siblings} selfId={field.id} noun={field.type === "page" ? "this page" : field.type === "section" ? "this section" : "this field"} />
            {(field.type === "section" || field.type === "page") && <p className="text-micro text-muted">A {field.type}'s rule applies to every field under it, up to the next {field.type === "page" ? "page break" : "section or page break"}.</p>}
          </>
        )}
        {active === "advanced" && <Advanced field={field} set={set} onRename={onRename} siblings={siblings} />}
      </div>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[12px] font-semibold text-muted">{label}</label>
      {children}
      {hint && <p className="mt-1 text-micro text-muted">{hint}</p>}
    </div>
  );
}

function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3">
      <span>
        <span className="block text-[13px] font-semibold text-ink">{label}</span>
        {hint && <span className="block text-micro text-muted">{hint}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5" />
    </label>
  );
}

const num = (v: string) => (v === "" ? undefined : Number(v));

function General({ field: f, set, siblings, nested }: { field: Field; set: (p: Partial<Field>) => void; siblings: Field[]; nested?: boolean }) {
  const input = isInputField(f);
  return (
    <>
      {f.type !== "html" && (
        <Row label={f.type === "page" ? "Page title" : f.type === "section" ? "Heading" : "Label"}>
          <Input value={f.label} onChange={(e) => set({ label: e.target.value })} />
        </Row>
      )}
      {f.type !== "html" && f.type !== "page" && (
        <Row label="Help text" hint="Shown under the label.">
          <Textarea value={f.description ?? ""} onChange={(e) => set({ description: e.target.value })} className="min-h-[56px]" />
        </Row>
      )}
      {input && f.type !== "calculation" && f.type !== "hidden" && <Toggle label="Required" checked={Boolean(f.required)} onChange={(v) => set({ required: v || undefined })} />}
      {input && !["repeater", "likert"].includes(f.type) && (
        <Row label="Width">
          <div className="inline-flex rounded-input border border-hairline p-0.5">
            {(["full", "half", "third"] as const).map((w) => (
              <button key={w} onClick={() => set({ width: w === "full" ? undefined : w })} className={cn("rounded-[5px] px-3 py-1 text-[12.5px] font-semibold capitalize", (f.width ?? "full") === w ? "bg-navy text-white" : "text-muted")}>{w}</button>
            ))}
          </div>
        </Row>
      )}

      {["text", "textarea", "email", "phone", "url", "number", "select", "multiselect"].includes(f.type) && (
        <Row label="Placeholder"><Input value={f.placeholder ?? ""} onChange={(e) => set({ placeholder: e.target.value })} /></Row>
      )}

      {(f.type === "text" || f.type === "textarea") && (
        <div className="grid grid-cols-2 gap-2">
          <Row label="Min length"><Input type="number" min={0} value={f.minLength ?? ""} onChange={(e) => set({ minLength: num(e.target.value) })} /></Row>
          <Row label="Max length"><Input type="number" min={1} value={f.maxLength ?? ""} onChange={(e) => set({ maxLength: num(e.target.value) })} /></Row>
        </div>
      )}
      {f.type === "textarea" && <Row label="Rows"><Input type="number" min={1} max={40} value={f.rows ?? 4} onChange={(e) => set({ rows: num(e.target.value) })} className="w-24" /></Row>}
      {f.type === "text" && (
        <>
          <Row label="Pattern (regular expression)" hint="The whole answer must match. E.g. \d{5} for a ZIP code.">
            <Input value={f.pattern ?? ""} onChange={(e) => set({ pattern: e.target.value })} className="font-mono text-[12.5px]" />
          </Row>
          {f.pattern && <Row label="Message when it doesn't match"><Input value={f.patternMessage ?? ""} onChange={(e) => set({ patternMessage: e.target.value })} /></Row>}
        </>
      )}

      {(f.type === "number" || f.type === "slider") && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <Row label="Min"><Input type="number" value={f.min ?? ""} onChange={(e) => set({ min: num(e.target.value) })} /></Row>
            <Row label="Max"><Input type="number" value={f.max ?? ""} onChange={(e) => set({ max: num(e.target.value) })} /></Row>
            <Row label="Step"><Input type="number" value={f.step ?? ""} onChange={(e) => set({ step: num(e.target.value) })} /></Row>
          </div>
          {f.type === "number" && (
            <div className="grid grid-cols-2 gap-2">
              <Row label="Before (e.g. $)"><Input value={f.prefix ?? ""} onChange={(e) => set({ prefix: e.target.value })} /></Row>
              <Row label="After (e.g. hrs)"><Input value={f.suffix ?? ""} onChange={(e) => set({ suffix: e.target.value })} /></Row>
            </div>
          )}
        </>
      )}
      {f.type === "rating" && <Row label="Stars"><Input type="number" min={3} max={10} value={f.max ?? 5} onChange={(e) => set({ max: num(e.target.value) })} className="w-24" /></Row>}
      {f.type === "date" && (
        <div className="grid grid-cols-2 gap-2">
          <Row label="Earliest" hint="YYYY-MM-DD, today, today-30"><Input value={f.minDate ?? ""} onChange={(e) => set({ minDate: e.target.value })} /></Row>
          <Row label="Latest" hint="e.g. today"><Input value={f.maxDate ?? ""} onChange={(e) => set({ maxDate: e.target.value })} /></Row>
        </div>
      )}
      {f.type === "consent" && <Row label="Agreement text (HTML)"><Textarea value={f.consentText ?? ""} onChange={(e) => set({ consentText: e.target.value })} /></Row>}

      {f.type === "name" && (
        <PartsPicker label="Parts" all={NAME_PARTS} value={f.nameParts ?? ["first", "last"]} onChange={(v) => set({ nameParts: v as Field["nameParts"] })} />
      )}
      {f.type === "address" && (
        <PartsPicker label="Parts" all={ADDRESS_PARTS} value={f.addressParts ?? ["line1", "line2", "city", "state", "zip"]} onChange={(v) => set({ addressParts: v as Field["addressParts"] })} />
      )}

      {f.type === "file" && (
        <>
          <Row label="Allowed types" hint="e.g. image/*,.pdf — empty allows anything."><Input value={f.accept ?? ""} onChange={(e) => set({ accept: e.target.value })} /></Row>
          <div className="grid grid-cols-2 gap-2">
            <Row label="Max files"><Input type="number" min={1} max={20} value={f.maxFiles ?? 1} onChange={(e) => set({ maxFiles: num(e.target.value) })} /></Row>
            <Row label="Max size (MB)"><Input type="number" min={0.1} max={10} step={0.5} value={f.maxSizeMb ?? 10} onChange={(e) => set({ maxSizeMb: num(e.target.value) })} /></Row>
          </div>
        </>
      )}

      {f.type === "calculation" && <ExpressionEditor field={f} set={set} siblings={siblings} />}

      {f.type === "resident" && (
        <>
          <Row label="Roster from" hint="Which site's residents to list.">
            <Select value={f.siteField ?? ""} onChange={(e) => set({ siteField: e.target.value })} options={[{ value: "", label: "The form's site (Settings → Ask which site)" }, ...siblings.filter((s) => s.type === "site").map((s) => ({ value: s.id, label: `Site field: ${s.label || s.id}` }))]} />
          </Row>
          <Toggle label="Log roster activity" hint="Picking a resident here counts as seeing them, which resets their review clock." checked={f.logActivity !== false} onChange={(v) => set({ logActivity: v ? undefined : false })} />
        </>
      )}

      {f.type === "repeater" && <SubfieldsEditor field={f} set={set} />}

      {(f.type === "html" || f.type === "section" || f.type === "page") && (
        <Row label={f.type === "html" ? "Content (HTML)" : "Lead text (HTML, optional)"} hint="Merge tags work: {field_id}, {user:name}, {date:today}.">
          <CodeEditor language="html" value={f.content ?? ""} onChange={(v) => set({ content: v })} minHeight={f.type === "html" ? 160 : 70} />
        </Row>
      )}
      {f.type === "page" && <Row label="Next button label" hint="On the page before this one."><Input value={f.nextLabel ?? ""} onChange={(e) => set({ nextLabel: e.target.value })} placeholder="Next" /></Row>}

      {input && !["file", "signature", "repeater", "calculation", "code", "resident", "likert", "name", "address"].includes(f.type) && <DefaultValue field={f} set={set} />}
      {nested && NOT_IN_REPEATER.includes(f.type) && <p className="text-micro text-status-redText">This type can't go inside a repeater.</p>}
    </>
  );
}

function PartsPicker({ label, all, value, onChange }: { label: string; all: Record<string, string>; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <Row label={label}>
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(all).map(([k, l]) => {
          const on = value.includes(k);
          return (
            <button key={k} onClick={() => onChange(on ? value.filter((x) => x !== k) : Object.keys(all).filter((x) => x === k || value.includes(x)))} className={cn("rounded-pill border px-2.5 py-1 text-[12.5px] font-semibold", on ? "border-navy bg-navsel text-ink" : "border-hairline text-muted")}>
              {l}
            </button>
          );
        })}
      </div>
    </Row>
  );
}

function DefaultValue({ field: f, set }: { field: Field; set: (p: Partial<Field>) => void }) {
  const dv = f.defaultValue;
  if (f.type === "select" || f.type === "radio") {
    return <Row label="Pre-selected"><Select value={typeof dv === "string" ? dv : ""} onChange={(e) => set({ defaultValue: e.target.value || undefined })} placeholder="Nothing" options={(f.choices ?? []).map((c) => ({ value: c.value, label: c.label }))} /></Row>;
  }
  if (f.type === "checkbox" || f.type === "multiselect") {
    const list = Array.isArray(dv) ? (dv as string[]) : [];
    return (
      <Row label="Pre-ticked">
        <div className="flex flex-wrap gap-1.5">
          {(f.choices ?? []).map((c) => {
            const on = list.includes(c.value);
            return <button key={c.value} onClick={() => { const n = on ? list.filter((x) => x !== c.value) : [...list, c.value]; set({ defaultValue: n.length ? n : undefined }); }} className={cn("rounded-pill border px-2.5 py-1 text-[12px]", on ? "border-navy bg-navsel text-ink" : "border-hairline text-muted")}>{c.label}</button>;
          })}
        </div>
      </Row>
    );
  }
  if (f.type === "consent") return <Toggle label="Ticked to start with" checked={dv === true} onChange={(v) => set({ defaultValue: v || undefined })} />;
  if (f.type === "number" || f.type === "slider" || f.type === "rating") {
    return <Row label="Starting value"><Input type="number" value={typeof dv === "number" ? dv : ""} onChange={(e) => set({ defaultValue: num(e.target.value) })} className="w-32" /></Row>;
  }
  return (
    <Row label="Starting value" hint="Merge tags work: {user:name}, {user:email}, {date:today}.">
      <Input value={typeof dv === "string" ? dv : ""} onChange={(e) => set({ defaultValue: e.target.value })} />
    </Row>
  );
}

function ChoicesTab({ field: f, set }: { field: Field; set: (p: Partial<Field>) => void }) {
  return (
    <>
      <ChoicesEditor label={f.type === "likert" ? "Scale (columns)" : "Choices"} value={f.choices ?? []} onChange={(choices) => set({ choices })} />
      {f.type === "likert" && <ChoicesEditor label="Statements (rows)" value={f.statements ?? []} onChange={(statements) => set({ statements })} />}
      {(f.type === "radio" || f.type === "checkbox") && (
        <>
          <Toggle label="Add “Other” with a text box" checked={Boolean(f.allowOther)} onChange={(v) => set({ allowOther: v || undefined })} />
          <Row label="Columns">
            <div className="inline-flex rounded-input border border-hairline p-0.5">
              {([1, 2, 3] as const).map((c) => (
                <button key={c} onClick={() => set({ columns: c === 1 ? undefined : c })} className={cn("rounded-[5px] px-3 py-1 text-[12.5px] font-semibold", (f.columns ?? 1) === c ? "bg-navy text-white" : "text-muted")}>{c}</button>
              ))}
            </div>
          </Row>
        </>
      )}
      {(f.type === "checkbox" || f.type === "multiselect") && (
        <Row label="Most that can be picked" hint="Empty = no limit."><Input type="number" min={1} value={f.maxSelections ?? ""} onChange={(e) => set({ maxSelections: num(e.target.value) })} className="w-24" /></Row>
      )}
    </>
  );
}

/** Label / value rows, reorderable, with bulk add and presets. */
export function ChoicesEditor({ label, value, onChange }: { label: string; value: Choice[]; onChange: (v: Choice[]) => void }) {
  const [bulk, setBulk] = useState<string | null>(null);
  const [showValues, setShowValues] = useState(() => value.some((c) => c.value !== valueFromLabel(c.label)));
  const unique = (base: string, taken: Set<string>) => {
    let v = base, n = 2;
    while (taken.has(v)) v = `${base}_${n++}`;
    return v;
  };
  const fromLabels = (labels: string[]) => {
    const taken = new Set<string>();
    return labels.map((l) => l.trim()).filter(Boolean).map((l) => {
      const [text, val] = l.split("|").map((s) => s.trim());
      const v = unique(val || valueFromLabel(text), taken);
      taken.add(v);
      return { label: text, value: v };
    });
  };
  const setAt = (i: number, patch: Partial<Choice>) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const move = (i: number, d: number) => {
    const n = [...value];
    const [c] = n.splice(i, 1);
    n.splice(i + d, 0, c);
    onChange(n);
  };
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[12px] font-semibold text-muted">{label}</span>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-micro text-muted"><input type="checkbox" checked={showValues} onChange={(e) => setShowValues(e.target.checked)} /> Values</label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><button className="text-micro font-semibold text-accent">Presets</button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {CHOICE_PRESETS.map((p) => <DropdownMenuItem key={p.name} onSelect={() => onChange(fromLabels(p.labels))}>{p.name}</DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
          <button onClick={() => setBulk(value.map((c) => (showValues ? `${c.label} | ${c.value}` : c.label)).join("\n"))} className="text-micro font-semibold text-accent">Bulk edit</button>
        </div>
      </div>
      {bulk !== null ? (
        <div>
          <Textarea value={bulk} onChange={(e) => setBulk(e.target.value)} className="min-h-[160px] font-mono text-[12.5px]" autoFocus />
          <p className="mt-1 text-micro text-muted">One per line. Add “ | value” to set a value.</p>
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setBulk(null)}>Cancel</Button>
            <Button size="sm" onClick={() => { onChange(fromLabels(bulk.split("\n"))); setBulk(null); }}>Apply</Button>
          </div>
        </div>
      ) : (
        <ul className="space-y-1.5">
          {value.map((c, i) => (
            <li key={i} className="flex items-center gap-1">
              <GripVertical className="h-4 w-4 shrink-0 text-strongline" />
              <Input
                value={c.label}
                onChange={(e) => {
                  const lbl = e.target.value;
                  // The value follows the label until someone sets it by hand.
                  const follows = c.value === valueFromLabel(c.label) || !c.value;
                  setAt(i, follows ? { label: lbl, value: unique(valueFromLabel(lbl), new Set(value.filter((_, j) => j !== i).map((x) => x.value))) } : { label: lbl });
                }}
                className="min-h-8 flex-1 py-1 text-[13px]"
              />
              {showValues && <Input value={c.value} onChange={(e) => setAt(i, { value: e.target.value })} className="min-h-8 w-24 py-1 font-mono text-[12px]" />}
              <button disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-1 text-muted disabled:opacity-30" aria-label="Move up"><ArrowUp className="h-3.5 w-3.5" /></button>
              <button disabled={i === value.length - 1} onClick={() => move(i, 1)} className="rounded p-1 text-muted disabled:opacity-30" aria-label="Move down"><ArrowDown className="h-3.5 w-3.5" /></button>
              <button onClick={() => onChange(value.filter((_, j) => j !== i))} className="rounded p-1 text-muted hover:text-status-redText" aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></button>
            </li>
          ))}
        </ul>
      )}
      {bulk === null && (
        <Button size="sm" variant="secondary" className="mt-2" onClick={() => {
          const lbl = `Choice ${value.length + 1}`;
          onChange([...value, { label: lbl, value: unique(valueFromLabel(lbl), new Set(value.map((c) => c.value))) }]);
        }}><Plus className="h-3.5 w-3.5" /> Add choice</Button>
      )}
    </div>
  );
}

function ExpressionEditor({ field: f, set, siblings }: { field: Field; set: (p: Partial<Field>) => void; siblings: Field[] }) {
  const expr = f.expression ?? "";
  const [sample, setSample] = useState<Record<string, string>>({});
  const refs = useMemo(() => [...new Set(expressionRefs(expr))], [expr]);
  let status: { ok: boolean; text: string };
  try {
    parseExpression(expr);
    const missing = refs.filter((r) => !siblings.some((s) => s.id === r));
    if (missing.length) status = { ok: false, text: `Not a field: ${missing.map((m) => `{${m}}`).join(", ")}` };
    else {
      const out = evaluate(expr, Object.fromEntries(Object.entries(sample).map(([k, v]) => [k, v === "" || Number.isNaN(Number(v)) ? v : Number(v)])));
      status = { ok: true, text: `With the sample values below: ${out}` };
    }
  } catch (e) {
    status = { ok: false, text: e instanceof Error ? e.message : "Doesn't parse." };
  }
  const insert = (s: string) => set({ expression: `${expr}${expr && !expr.endsWith(" ") ? " " : ""}${s}` });
  return (
    <>
      <Row label="Expression">
        <Textarea value={expr} onChange={(e) => set({ expression: e.target.value })} className="min-h-[70px] font-mono text-[12.5px]" />
      </Row>
      <p className={cn("text-micro font-semibold", status.ok ? "text-status-greenText" : "text-status-redText")}>{status.text}</p>
      <div>
        <p className="mb-1 text-micro font-semibold text-muted">Insert a field</p>
        <div className="flex flex-wrap gap-1">
          {siblings.filter((s) => isInputField(s) && s.id !== f.id).map((s) => (
            <button key={s.id} onClick={() => insert(`{${s.id}}`)} className="rounded border border-hairline px-1.5 py-0.5 font-mono text-[11.5px] text-ink hover:border-navy">{`{${s.id}}`}</button>
          ))}
        </div>
        <p className="mb-1 mt-2 text-micro font-semibold text-muted">Functions</p>
        <div className="flex flex-wrap gap-1">
          {EXPRESSION_FUNCTIONS.map((fn) => <button key={fn} onClick={() => insert(`${fn}()`)} className="rounded bg-subtle px-1.5 py-0.5 font-mono text-[11.5px] text-ink hover:bg-subtle2">{fn}</button>)}
        </div>
      </div>
      {refs.length > 0 && (
        <div className="rounded-input bg-subtle p-2">
          <p className="mb-1 text-micro font-semibold text-muted">Try it</p>
          <div className="grid grid-cols-2 gap-1.5">
            {refs.map((r) => <label key={r} className="text-micro text-muted">{r}<Input value={sample[r] ?? ""} onChange={(e) => setSample({ ...sample, [r]: e.target.value })} className="min-h-7 py-0.5 text-[12px]" /></label>)}
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Row label="Decimals"><Input type="number" min={0} max={10} value={f.decimals ?? 2} onChange={(e) => set({ decimals: num(e.target.value) })} /></Row>
        <Row label="Show as"><Select value={f.display ?? "number"} onChange={(e) => set({ display: e.target.value === "number" ? undefined : (e.target.value as Field["display"]) })} options={[{ value: "number", label: "Number" }, { value: "currency", label: "Dollars" }, { value: "percent", label: "Percent" }]} /></Row>
      </div>
    </>
  );
}

function SubfieldsEditor({ field: f, set }: { field: Field; set: (p: Partial<Field>) => void }) {
  const subs = f.fields ?? [];
  const [editing, setEditing] = useState<string | null>(null);
  const current = subs.find((s) => s.id === editing);
  const types = FIELD_TYPES.filter((t) => !NOT_IN_REPEATER.includes(t.type) && t.type !== "section" && t.type !== "page");
  if (current) {
    return (
      <div className="-mx-4 -my-4 flex h-[70vh] flex-col border-l-4 border-navsel">
        <button onClick={() => setEditing(null)} className="flex items-center gap-1 px-4 py-2 text-[12.5px] font-semibold text-accent"><ChevronLeft className="h-4 w-4" /> Back to {f.label || "repeater"}</button>
        <FieldProperties
          nested
          field={current}
          siblings={subs}
          onChange={(nf) => set({ fields: subs.map((s) => (s.id === current.id ? nf : s)) })}
          onRename={(newId) => {
            if (subs.some((s) => s.id === newId)) return;
            set({ fields: subs.map((s) => (s.id === current.id ? { ...s, id: newId } : s)) });
            setEditing(newId);
          }}
        />
      </div>
    );
  }
  return (
    <>
      <Row label="Sub-fields" hint="Each row the person adds has these.">
        <ul className="space-y-1.5">
          {subs.map((s, i) => (
            <li key={s.id} className="flex items-center gap-1.5 rounded-input border border-hairline px-2 py-1.5">
              <button onClick={() => setEditing(s.id)} className="min-w-0 flex-1 text-left">
                <span className="block truncate text-[13px] font-semibold text-ink">{s.label || s.id}{s.required ? " *" : ""}</span>
                <span className="text-micro text-muted">{typeInfo(s.type)?.label} · {s.id}</span>
              </button>
              <button disabled={i === 0} onClick={() => { const n = [...subs]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; set({ fields: n }); }} className="p-1 text-muted disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
              <button onClick={() => set({ fields: subs.filter((x) => x.id !== s.id) })} className="p-1 text-muted hover:text-status-redText"><Trash2 className="h-3.5 w-3.5" /></button>
            </li>
          ))}
        </ul>
      </Row>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button size="sm" variant="secondary"><ListPlus className="h-3.5 w-3.5" /> Add sub-field</Button></DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
          {types.map((t) => <DropdownMenuItem key={t.type} onSelect={() => set({ fields: [...subs, newField(t.type, subs.map((s) => s.id))] })}>{t.label}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="grid grid-cols-2 gap-2">
        <Row label="Min rows"><Input type="number" min={0} value={f.minRows ?? ""} onChange={(e) => set({ minRows: num(e.target.value) })} /></Row>
        <Row label="Max rows"><Input type="number" min={1} value={f.maxRows ?? ""} onChange={(e) => set({ maxRows: num(e.target.value) })} /></Row>
      </div>
      <Row label="Add button label"><Input value={f.addLabel ?? ""} onChange={(e) => set({ addLabel: e.target.value })} placeholder="Add row" /></Row>
    </>
  );
}

function CodeTab({ field: f, set }: { field: Field; set: (p: Partial<Field>) => void }) {
  const [lang, setLang] = useState<"html" | "css" | "js">("js");
  const code = f.code ?? {};
  return (
    <>
      <div className="inline-flex rounded-input border border-hairline p-0.5">
        {(["html", "css", "js"] as const).map((l) => (
          <button key={l} onClick={() => setLang(l)} className={cn("rounded-[5px] px-3 py-1 text-[12.5px] font-semibold uppercase", lang === l ? "bg-navy text-white" : "text-muted")}>{l}</button>
        ))}
      </div>
      <CodeEditor key={lang} language={lang === "js" ? "javascript" : lang} value={code[lang] ?? ""} onChange={(v) => set({ code: { ...code, [lang]: v } })} minHeight={240} />
      <Row label="Starting height (px)" hint="The block grows to fit its content on its own."><Input type="number" min={20} max={4000} value={code.height ?? 120} onChange={(e) => set({ code: { ...code, height: num(e.target.value) } })} className="w-28" /></Row>
      <div className="rounded-input bg-subtle p-3">
        <p className="mb-1 text-micro font-bold uppercase tracking-[0.04em] text-muted">The lcs object</p>
        <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-ink">{CODE_BLOCK_API}</pre>
        <p className="mt-2 text-micro text-muted">Runs in a sandbox: no access to the app, cookies or the network. Whatever you pass to lcs.setValue is saved with the entry.</p>
      </div>
    </>
  );
}

function Advanced({ field: f, set, onRename, siblings }: { field: Field; set: (p: Partial<Field>) => void; onRename?: (id: string) => void; siblings: Field[] }) {
  const [id, setId] = useState(f.id);
  const taken = siblings.some((s) => s.id === id && s.id !== f.id);
  const valid = FIELD_ID_RE.test(id) && !taken;
  return (
    <>
      <Row label="Field id" hint="Entries, rules, calculations and merge tags use this. Renaming updates them all.">
        <div className="flex gap-1.5">
          <Input value={id} onChange={(e) => setId(e.target.value)} className="font-mono text-[12.5px]" />
          <Button size="sm" variant="secondary" disabled={!valid || id === f.id || !onRename} onClick={() => onRename?.(id)}>Rename</Button>
        </div>
        {!valid && <p className="mt-1 text-micro text-status-redText">{taken ? "Another field uses that id." : "Lowercase letters, digits and _; start with a letter."}</p>}
      </Row>
      {isInputField(f) && (
        <>
          <Toggle label="Admin only" hint="Hidden from the person filling in; admins set it when editing the entry." checked={Boolean(f.adminOnly)} onChange={(v) => set({ adminOnly: v || undefined })} />
          <Toggle label="Read-only" hint="Shown with its starting value; can't be changed." checked={Boolean(f.readOnly)} onChange={(v) => set({ readOnly: v || undefined })} />
        </>
      )}
      <Row label="CSS class" hint="For styles in Settings → Custom CSS."><Input value={f.cssClass ?? ""} onChange={(e) => set({ cssClass: e.target.value })} /></Row>
      <div>
        <p className="mb-1 text-[12px] font-semibold text-muted">This field as code</p>
        <pre className="max-h-60 overflow-auto rounded-input bg-subtle p-2 font-mono text-[11px] text-ink">{JSON.stringify(f, null, 2)}</pre>
      </div>
    </>
  );
}
