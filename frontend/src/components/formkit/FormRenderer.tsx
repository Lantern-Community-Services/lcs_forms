import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Paperclip, Plus, Search, Star, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SignaturePad, type SignaturePadHandle } from "@/components/attendance/SignaturePad";
import { CodeBlockFrame } from "./CodeBlockFrame";
import { useSites, useTenants } from "@/lib/queries";
import { fillApi } from "@/lib/builder";
import { cn, errorMessage } from "@/lib/utils";
import {
  ADDRESS_PARTS, DEFAULT_ADDRESS_PARTS, DEFAULT_NAME_PARTS, NAME_PARTS, applyCalculations, formatValue, initialValues, isInputField,
  pagesOf, renderTemplate, resolveDate, validateValues, visibleFieldIds,
  type Errors, type Field, type FormDoc, type Values,
} from "@/lib/formEngine";

export interface RendererUser {
  name: string;
  email: string;
}

export interface SubmitExtra {
  siteCode: string | null;
  codeErrors: Record<string, string>;
  honeypot: string;
}

/**
 * Draws any lcs-form document. The same component fills in a form, previews it
 * in the builder, and edits an entry — so what an admin builds is exactly what
 * staff see. Rules, calculations and validation come from the shared engine;
 * the server re-checks all of it on submit.
 */
export function FormRenderer({
  doc,
  slug,
  mode = "fill",
  initial,
  user,
  onSubmit,
  submitting,
  serverErrors,
  draftKey,
  disabled,
  submitLabel,
  onValuesChange,
}: {
  doc: FormDoc;
  /** Needed for file uploads; without it (builder preview) uploads are simulated. */
  slug?: string;
  mode?: "fill" | "preview" | "edit";
  initial?: Values;
  user: RendererUser | null;
  onSubmit?: (values: Values, extra: SubmitExtra) => void;
  submitting?: boolean;
  serverErrors?: Errors;
  /** localStorage key to keep unfinished answers under. */
  draftKey?: string;
  disabled?: boolean;
  submitLabel?: string;
  onValuesChange?: (values: Values) => void;
}) {
  const saveDrafts = mode === "fill" && doc.settings.saveDrafts !== false && Boolean(draftKey);
  const fresh = () => ({ ...initialValues(doc, { user }), ...(initial ?? {}) });
  const [values, setValues] = useState<Values>(() => {
    if (saveDrafts) {
      try {
        const saved = JSON.parse(localStorage.getItem(draftKey!) ?? "null");
        if (saved?.values) return saved.values as Values;
      } catch {
        /* storage blocked — start fresh */
      }
    }
    return fresh();
  });
  const [restored] = useState(() => {
    if (!saveDrafts) return false;
    try {
      return Boolean(localStorage.getItem(draftKey!));
    } catch {
      return false;
    }
  });
  const [siteCode, setSiteCode] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [codeErrors, setCodeErrors] = useState<Record<string, string>>({});
  const [page, setPage] = useState(0);
  const [honeypot, setHoneypot] = useState("");
  const topRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (serverErrors) setErrors(serverErrors);
  }, [serverErrors]);

  const computed = useMemo(() => applyCalculations(doc, values), [doc, values]);
  const visible = useMemo(() => visibleFieldIds(doc, computed, { includeAdminOnly: mode === "edit" }), [doc, computed, mode]);
  const pages = useMemo(() => pagesOf(doc).filter((p) => !p.pageField || visible.has(p.pageField.id)), [doc, visible]);
  const current = pages[Math.min(page, pages.length - 1)] ?? pages[0];
  const last = page >= pages.length - 1;

  useEffect(() => {
    onValuesChange?.(computed);
    if (!saveDrafts) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(draftKey!, JSON.stringify({ values, savedAt: Date.now() }));
      } catch {
        /* full or blocked: drafts are a convenience */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [values]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (id: string, v: unknown) => {
    setValues((prev) => ({ ...prev, [id]: v }));
    setErrors((prev) => {
      if (!Object.keys(prev).some((k) => k === id || k.startsWith(`${id}.`))) return prev;
      const next = { ...prev };
      for (const k of Object.keys(next)) if (k === id || k.startsWith(`${id}.`)) delete next[k];
      return next;
    });
  };

  function check(only?: Set<string>) {
    const errs = validateValues(doc, computed, { only, includeAdminOnly: mode === "edit", codeErrors });
    if (doc.settings.requireSite && mode === "fill" && !siteCode && (!only || page === 0)) errs._site = "Pick the site this is for.";
    setErrors(errs);
    if (Object.keys(errs).length) {
      requestAnimationFrame(() => document.querySelector("[data-field-error]")?.scrollIntoView({ block: "center", behavior: "smooth" }));
      return false;
    }
    return true;
  }

  function next() {
    if (!check(new Set(current.fields.map((f) => f.id)))) return;
    setPage((p) => Math.min(p + 1, pages.length - 1));
    topRef.current?.scrollIntoView({ behavior: "smooth" });
  }

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!last) return next();
    if (!check()) {
      // Jump to the first page with an error.
      const errs = validateValues(doc, computed, { includeAdminOnly: mode === "edit", codeErrors });
      const firstBad = pages.findIndex((p) => p.fields.some((f) => errs[f.id] || Object.keys(errs).some((k) => k.startsWith(`${f.id}.`))));
      if (firstBad >= 0 && firstBad !== page) setPage(firstBad);
      return;
    }
    onSubmit?.(computed, { siteCode, codeErrors, honeypot });
  }

  function startOver() {
    try {
      localStorage.removeItem(draftKey!);
    } catch {
      /* ignore */
    }
    setValues(fresh());
    setErrors({});
    setPage(0);
  }

  const scope = useMemo(() => `lcsf-${Math.abs(hash(doc.title + (slug ?? ""))).toString(36)}`, [doc.title, slug]);
  const merge = { values: computed, doc, user, html: true };
  const progress = doc.settings.progressBar !== false && pages.length > 1;

  return (
    <form ref={topRef} onSubmit={submit} noValidate className={cn("lcs-form", scope)}>
      {doc.settings.customCss && <style>{`.${scope} { ${doc.settings.customCss} }`}</style>}

      {restored && saveDrafts && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-input border border-hairline bg-subtle px-3 py-2 text-[13px] text-ink">
          <span>We kept your unfinished answers from last time.</span>
          <button type="button" onClick={startOver} className="font-semibold text-accent underline-offset-2 hover:underline">Start over</button>
        </div>
      )}

      {progress && (
        <div className="mb-5">
          <div className="mb-1.5 flex justify-between text-micro font-semibold text-muted">
            <span>{current.pageField?.label || "Start"}</span>
            <span>Page {page + 1} of {pages.length}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-pill bg-subtle2">
            <div className="h-full rounded-pill bg-navy transition-all" style={{ width: `${((page + 1) / pages.length) * 100}%` }} />
          </div>
        </div>
      )}

      {doc.settings.requireSite && mode === "fill" && page === 0 && (
        <SitePickerRow value={siteCode} onChange={(v) => { setSiteCode(v); setErrors(({ _site, ...rest }) => rest); }} error={errors._site} />
      )}

      {current.pageField?.content && <div className="prose-form mb-4 text-[14px] text-ink" dangerouslySetInnerHTML={{ __html: renderTemplate(current.pageField.content, merge) }} />}

      <div className="grid grid-cols-12 gap-x-4 gap-y-5">
        {current.fields.map((f) =>
          visible.has(f.id) && f.type !== "hidden" ? (
            <div key={f.id} className={cn(widthClass(f), f.cssClass)} data-field={f.id}>
              <FieldView
                field={f}
                value={computed[f.id]}
                values={computed}
                error={errors[f.id]}
                errors={errors}
                onChange={(v) => set(f.id, v)}
                disabled={disabled || f.readOnly}
                slug={slug}
                user={user}
                formSite={siteCode}
                doc={doc}
                onCodeValidity={(msg) => setCodeErrors((prev) => { const n = { ...prev }; if (msg) n[f.id] = msg; else delete n[f.id]; return n; })}
              />
            </div>
          ) : null
        )}
      </div>

      {mode === "fill" && doc.settings.access?.mode === "public" && (
        // Real people never see this; bots that fill every input do.
        <input type="text" name="website_hp" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} className="absolute -left-[9999px] h-0 w-0 opacity-0" aria-hidden />
      )}

      <div className="mt-7 flex flex-wrap items-center gap-2 border-t border-hairline pt-5">
        {page > 0 && (
          <Button type="button" variant="secondary" size="lg" onClick={() => { setPage((p) => p - 1); topRef.current?.scrollIntoView({ behavior: "smooth" }); }}>
            <ChevronLeft className="h-4 w-4" /> Back
          </Button>
        )}
        <div className="flex-1" />
        {Object.keys(errors).length > 0 && <p className="text-[13px] font-semibold text-status-redText">Some answers need a look.</p>}
        {!last ? (
          <Button type="button" size="lg" onClick={next}>
            {pages[page + 1]?.pageField?.nextLabel || current.pageField?.nextLabel || "Next"} <ChevronRight className="h-4 w-4" />
          </Button>
        ) : (
          <Button type="submit" size="lg" disabled={disabled || submitting || (mode === "preview" && !onSubmit)}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {submitLabel ?? doc.settings.submitLabel ?? "Submit"}
          </Button>
        )}
      </div>
    </form>
  );
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function widthClass(f: Field) {
  if (f.type === "section" || f.type === "html" || f.type === "repeater" || f.type === "likert") return "col-span-12";
  if (f.width === "half") return "col-span-12 md:col-span-6";
  if (f.width === "third") return "col-span-12 md:col-span-4";
  return "col-span-12";
}

function SitePickerRow({ value, onChange, error }: { value: string | null; onChange: (v: string | null) => void; error?: string }) {
  const { data: sites } = useSites();
  useEffect(() => {
    if (!value && sites?.length === 1) onChange(sites[0].code);
  }, [sites]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="mb-5" data-field-error={error ? true : undefined}>
      <FieldLabel label="Site" required />
      <Select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} placeholder="Pick a site…" options={(sites ?? []).map((s) => ({ value: s.code, label: s.name }))} />
      {error && <FieldError message={error} />}
    </div>
  );
}

function FieldLabel({ label, required, htmlFor }: { label: string; required?: boolean; htmlFor?: string }) {
  if (!label) return null;
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[13.5px] font-semibold text-ink">
      {label}
      {required && <span className="ml-0.5 text-status-redText" aria-hidden>*</span>}
    </label>
  );
}

function FieldError({ message }: { message: string }) {
  return <p className="mt-1.5 text-[12.5px] font-semibold text-status-redText" role="alert">{message}</p>;
}

interface FieldProps {
  field: Field;
  value: unknown;
  values: Values;
  error?: string;
  errors: Errors;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  slug?: string;
  user: RendererUser | null;
  formSite: string | null;
  doc: FormDoc;
  onCodeValidity?: (message: string | null) => void;
}

/** Label + control + help + error for one field. */
export function FieldView(props: FieldProps) {
  const { field: f, error } = props;
  if (f.type === "section") {
    return (
      <div className="border-b border-hairline pb-2 pt-3">
        <h3 className="font-heading text-[17px] font-extrabold text-ink">{f.label}</h3>
        {f.description && <p className="mt-0.5 text-[13px] text-muted">{f.description}</p>}
        {f.content && <div className="prose-form mt-1 text-[13.5px] text-ink" dangerouslySetInnerHTML={{ __html: renderTemplate(f.content, { values: props.values, doc: props.doc, user: props.user, html: true }) }} />}
      </div>
    );
  }
  if (f.type === "html") {
    return <div className="prose-form text-[14px] text-ink" dangerouslySetInnerHTML={{ __html: renderTemplate(f.content, { values: props.values, doc: props.doc, user: props.user, html: true }) }} />;
  }
  const inputId = `f_${f.id}`;
  const labelled = !["consent"].includes(f.type);
  return (
    <div data-field-error={error ? true : undefined}>
      {labelled && <FieldLabel label={f.label} required={f.required && f.type !== "calculation"} htmlFor={inputId} />}
      {f.description && f.type !== "consent" && <p className="-mt-0.5 mb-2 text-[12.5px] text-muted">{f.description}</p>}
      <FieldControl {...props} inputId={inputId} />
      {error && <FieldError message={error} />}
    </div>
  );
}

function FieldControl(props: FieldProps & { inputId: string }) {
  const { field: f, value, onChange, disabled, inputId } = props;
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const invalid = props.error ? "border-status-redDot" : "";
  switch (f.type) {
    case "text":
    case "email":
    case "phone":
    case "url":
      return (
        <Input
          id={inputId}
          type={f.type === "phone" ? "tel" : f.type === "url" ? "url" : f.type === "email" ? "email" : "text"}
          inputMode={f.type === "phone" ? "tel" : f.type === "email" ? "email" : undefined}
          autoComplete={f.type === "email" ? "email" : f.type === "phone" ? "tel" : undefined}
          value={text}
          placeholder={f.placeholder}
          maxLength={f.maxLength}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={cn("min-h-[44px] md:min-h-9", invalid)}
        />
      );
    case "textarea":
      return (
        <div>
          <Textarea id={inputId} value={text} placeholder={f.placeholder} rows={f.rows ?? 4} maxLength={f.maxLength} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={invalid} />
          {f.maxLength && <p className="mt-1 text-right text-micro text-muted">{text.length} / {f.maxLength}</p>}
        </div>
      );
    case "number":
      return (
        <div className="flex items-center gap-2">
          {f.prefix && <span className="text-[14px] font-semibold text-muted">{f.prefix}</span>}
          <Input id={inputId} type="number" inputMode="decimal" value={text} min={f.min} max={f.max} step={f.step ?? "any"} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} disabled={disabled} className={cn("min-h-[44px] max-w-[220px] md:min-h-9", invalid)} />
          {f.suffix && <span className="text-[14px] text-muted">{f.suffix}</span>}
        </div>
      );
    case "date":
      return <Input id={inputId} type="date" value={text} min={resolveDate(f.minDate)} max={resolveDate(f.maxDate)} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={cn("min-h-[44px] max-w-[220px] md:min-h-9", invalid)} />;
    case "time":
      return <Input id={inputId} type="time" value={text} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={cn("min-h-[44px] max-w-[180px] md:min-h-9", invalid)} />;
    case "select":
      return <Select id={inputId} value={text} onChange={(e) => onChange(e.target.value)} disabled={disabled} placeholder={f.placeholder ?? "Choose…"} options={(f.choices ?? []).map((c) => ({ value: c.value, label: c.label }))} className={cn("min-h-[44px] md:min-h-9", invalid)} />;
    case "multiselect":
      return <MultiSelect field={f} value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} disabled={disabled} />;
    case "radio":
    case "checkbox":
      return <ChoiceList field={f} value={value} onChange={onChange} disabled={disabled} />;
    case "consent":
      return (
        <label className="flex cursor-pointer items-start gap-3 rounded-input border border-hairline bg-surface p-3">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} disabled={disabled} className="mt-0.5 h-5 w-5 accent-[rgb(var(--c-brand))]" />
          <span className="text-[14px] text-ink">
            <span className="font-semibold">{f.label}{f.required && <span className="text-status-redText"> *</span>}</span>
            {f.consentText && <span className="prose-form mt-0.5 block text-[13px] text-muted" dangerouslySetInnerHTML={{ __html: f.consentText }} />}
            {f.description && <span className="mt-0.5 block text-[12.5px] text-muted">{f.description}</span>}
          </span>
        </label>
      );
    case "name":
    case "address": {
      const parts = (f.type === "name" ? f.nameParts ?? DEFAULT_NAME_PARTS : f.addressParts ?? DEFAULT_ADDRESS_PARTS) as string[];
      const labels = (f.type === "name" ? NAME_PARTS : ADDRESS_PARTS) as Record<string, string>;
      const o = (value && typeof value === "object" ? value : {}) as Record<string, string>;
      const span = (p: string) => (f.type === "name" ? (p === "prefix" || p === "suffix" ? "sm:col-span-2" : "sm:col-span-4") : p === "line1" || p === "line2" ? "sm:col-span-12" : p === "city" ? "sm:col-span-5" : p === "state" ? "sm:col-span-3" : "sm:col-span-4");
      return (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
          {parts.map((p) => (
            <div key={p} className={span(p)}>
              <Input
                id={p === parts[0] ? inputId : undefined}
                value={o[p] ?? ""}
                autoComplete={AUTOCOMPLETE[p]}
                inputMode={p === "zip" ? "numeric" : undefined}
                onChange={(e) => onChange({ ...o, [p]: e.target.value })}
                disabled={disabled}
                className={cn("min-h-[44px] md:min-h-9", invalid)}
                aria-label={labels[p]}
              />
              <span className="mt-0.5 block text-micro text-muted">{labels[p]}</span>
            </div>
          ))}
        </div>
      );
    }
    case "file":
      return <FileInput field={f} value={Array.isArray(value) ? (value as UploadedFile[]) : []} onChange={onChange} disabled={disabled} slug={props.slug} />;
    case "signature":
      return <SignatureInput value={typeof value === "string" ? value : ""} onChange={onChange} disabled={disabled} />;
    case "rating": {
      const max = f.max ?? 5;
      const n = Number(value) || 0;
      return (
        <div className="flex gap-1" role="radiogroup" aria-label={f.label}>
          {Array.from({ length: max }, (_, i) => i + 1).map((i) => (
            <button key={i} type="button" role="radio" aria-checked={n === i} aria-label={`${i} of ${max}`} disabled={disabled} onClick={() => onChange(n === i ? "" : i)} className="rounded p-1 transition-transform hover:scale-110">
              <Star className={cn("h-8 w-8", i <= n ? "fill-[#f5a524] text-[#f5a524]" : "text-strongline")} />
            </button>
          ))}
        </div>
      );
    }
    case "slider": {
      const min = f.min ?? 0, max = f.max ?? 10;
      const n = value === "" || value === undefined ? min : Number(value);
      return (
        <div className="flex items-center gap-3">
          <span className="text-micro text-muted">{min}</span>
          <input id={inputId} type="range" min={min} max={max} step={f.step ?? 1} value={n} onChange={(e) => onChange(Number(e.target.value))} disabled={disabled} className="flex-1 accent-[rgb(var(--c-brand))]" />
          <span className="text-micro text-muted">{max}</span>
          <span className="tabular min-w-[3ch] rounded-input bg-subtle px-2 py-1 text-center text-[14px] font-bold text-ink">{value === "" || value === undefined ? "–" : n}</span>
        </div>
      );
    }
    case "likert":
      return <Likert field={f} value={(value && typeof value === "object" ? value : {}) as Record<string, string>} onChange={onChange} disabled={disabled} />;
    case "repeater":
      return <Repeater {...props} />;
    case "calculation":
      return <div className="tabular min-h-[40px] rounded-input border border-dashed border-hairline bg-subtle px-3 py-2 text-[15px] font-bold text-ink">{formatValue(f, value) || "—"}</div>;
    case "site":
      return <SiteSelect inputId={inputId} value={text} onChange={onChange} disabled={disabled} />;
    case "resident": {
      const siteCode = (f.siteField ? String(props.values[f.siteField] ?? "") : props.formSite) || null;
      return <ResidentPicker siteCode={siteCode} value={value as ResidentValue | undefined} onChange={onChange} disabled={disabled} needsSite={f.siteField ? "Pick a site above first." : "Pick the site first."} />;
    }
    case "code":
      return f.code ? (
        <CodeBlockFrame code={f.code} value={value} values={props.values} user={props.user} onChange={disabled ? undefined : onChange} onValidity={props.onCodeValidity} title={f.label || f.id} />
      ) : null;
    default:
      return null;
  }
}

const AUTOCOMPLETE: Record<string, string> = {
  prefix: "honorific-prefix", first: "given-name", middle: "additional-name", last: "family-name", suffix: "honorific-suffix",
  line1: "address-line1", line2: "address-line2", city: "address-level2", state: "address-level1", zip: "postal-code", country: "country-name",
};

function ChoiceList({ field: f, value, onChange, disabled }: { field: Field; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const multi = f.type === "checkbox";
  const picked: string[] = multi ? (Array.isArray(value) ? (value as string[]) : []) : typeof value === "string" && value ? [value] : [];
  const known = new Set((f.choices ?? []).map((c) => c.value));
  const other = picked.find((v) => !known.has(v));
  const [otherOn, setOtherOn] = useState(other !== undefined);
  const cols = f.columns === 3 ? "sm:grid-cols-3" : f.columns === 2 ? "sm:grid-cols-2" : "";
  const toggle = (v: string) => {
    if (!multi) return onChange(picked[0] === v ? "" : v);
    const on = picked.includes(v);
    if (!on && f.maxSelections && picked.length >= f.maxSelections) return;
    onChange(on ? picked.filter((x) => x !== v) : [...picked, v]);
  };
  const setOther = (text: string) => {
    const base = picked.filter((v) => known.has(v));
    onChange(multi ? (text ? [...base, text] : base) : text);
  };
  return (
    <div className={cn("grid gap-2", cols)} role={multi ? "group" : "radiogroup"}>
      {(f.choices ?? []).map((c) => {
        const on = picked.includes(c.value);
        return (
          <label key={c.value} className={cn("flex min-h-[44px] cursor-pointer items-center gap-3 rounded-input border px-3 py-2 text-[14px] transition-colors", on ? "border-navy bg-navsel text-ink" : "border-hairline bg-surface text-ink hover:border-strongline", disabled && "cursor-default opacity-70")}>
            <input type={multi ? "checkbox" : "radio"} checked={on} onChange={() => toggle(c.value)} disabled={disabled} className="h-[18px] w-[18px] shrink-0 accent-[rgb(var(--c-brand))]" />
            <span>{c.label}</span>
          </label>
        );
      })}
      {f.allowOther && (
        <div className={cn("rounded-input border px-3 py-2", otherOn ? "border-navy bg-navsel" : "border-hairline bg-surface")}>
          <label className="flex min-h-[28px] cursor-pointer items-center gap-3 text-[14px] text-ink">
            <input
              type={multi ? "checkbox" : "radio"}
              checked={otherOn}
              disabled={disabled}
              onChange={() => {
                const on = !otherOn;
                setOtherOn(on);
                if (!on) setOther("");
                else if (!multi) onChange("");
              }}
              className="h-[18px] w-[18px] accent-[rgb(var(--c-brand))]"
            />
            Other
          </label>
          {otherOn && <Input autoFocus value={other ?? ""} onChange={(e) => setOther(e.target.value)} disabled={disabled} placeholder="Please say…" className="mt-2" />}
        </div>
      )}
      {multi && f.maxSelections && <p className="text-micro text-muted">Pick up to {f.maxSelections}.</p>}
    </div>
  );
}

function MultiSelect({ field: f, value, onChange, disabled }: { field: Field; value: string[]; onChange: (v: unknown) => void; disabled?: boolean }) {
  const [q, setQ] = useState("");
  const choices = f.choices ?? [];
  const shown = choices.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));
  const label = (v: string) => choices.find((c) => c.value === v)?.label ?? v;
  return (
    <div className="rounded-input border border-hairline bg-surface">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-hairline p-2">
          {value.map((v) => (
            <span key={v} className="inline-flex items-center gap-1 rounded-pill bg-navsel px-2.5 py-1 text-[12.5px] font-semibold text-ink">
              {label(v)}
              {!disabled && <button type="button" aria-label={`Remove ${label(v)}`} onClick={() => onChange(value.filter((x) => x !== v))}><X className="h-3 w-3" /></button>}
            </span>
          ))}
        </div>
      )}
      {choices.length > 8 && (
        <div className="relative border-b border-hairline">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="w-full bg-transparent py-2 pl-9 pr-3 text-[14px] text-ink outline-none" />
        </div>
      )}
      <ul className="max-h-56 overflow-y-auto p-1">
        {shown.map((c) => {
          const on = value.includes(c.value);
          const full = !on && Boolean(f.maxSelections && value.length >= f.maxSelections);
          return (
            <li key={c.value}>
              <label className={cn("flex min-h-[38px] cursor-pointer items-center gap-2.5 rounded px-2 text-[14px] text-ink hover:bg-rowhover", full && "opacity-50")}>
                <input type="checkbox" checked={on} disabled={disabled || full} onChange={() => onChange(on ? value.filter((x) => x !== c.value) : [...value, c.value])} className="h-4 w-4 accent-[rgb(var(--c-brand))]" />
                {c.label}
              </label>
            </li>
          );
        })}
        {!shown.length && <li className="px-2 py-2 text-[13px] text-muted">Nothing matches.</li>}
      </ul>
    </div>
  );
}

function Likert({ field: f, value, onChange, disabled }: { field: Field; value: Record<string, string>; onChange: (v: unknown) => void; disabled?: boolean }) {
  const cols = f.choices ?? [];
  const set = (row: string, col: string) => onChange({ ...value, [row]: col });
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th />
              {cols.map((c) => <th key={c.value} className="px-2 pb-2 text-center font-semibold text-muted">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {(f.statements ?? []).map((r) => (
              <tr key={r.value} className="border-t border-hairline">
                <td className="py-2.5 pr-3 text-[14px] text-ink">{r.label}</td>
                {cols.map((c) => (
                  <td key={c.value} className="text-center">
                    <input type="radio" name={`${f.id}.${r.value}`} aria-label={`${r.label}: ${c.label}`} checked={value[r.value] === c.value} disabled={disabled} onChange={() => set(r.value, c.value)} className="h-[18px] w-[18px] accent-[rgb(var(--c-brand))]" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-4 md:hidden">
        {(f.statements ?? []).map((r) => (
          <div key={r.value}>
            <p className="mb-1.5 text-[14px] font-semibold text-ink">{r.label}</p>
            <Select value={value[r.value] ?? ""} onChange={(e) => set(r.value, e.target.value)} disabled={disabled} placeholder="Choose…" options={cols.map((c) => ({ value: c.value, label: c.label }))} className="min-h-[44px]" />
          </div>
        ))}
      </div>
    </>
  );
}

function Repeater(props: FieldProps) {
  const { field: f, value, onChange, disabled, errors } = props;
  const rows = Array.isArray(value) ? (value as Values[]) : [];
  const subs = f.fields ?? [];
  const min = f.minRows ?? 0;
  useEffect(() => {
    if (rows.length < Math.max(1, min) && !disabled) onChange([...rows, ...Array.from({ length: Math.max(1, min) - rows.length }, () => ({}))]);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const setRow = (i: number, id: string, v: unknown) => onChange(rows.map((r, j) => (j === i ? { ...r, [id]: v } : r)));
  return (
    <div className="space-y-3">
      {rows.map((row, i) => {
        const vis = visibleFieldIds({ fields: subs }, applyCalculations({ fields: subs }, row));
        const computedRow = applyCalculations({ fields: subs }, row);
        return (
          <div key={i} className="rounded-card border border-hairline bg-subtle/50 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-micro font-bold uppercase tracking-[0.04em] text-muted">#{i + 1}</span>
              {!disabled && rows.length > min && (
                <button type="button" onClick={() => onChange(rows.filter((_, j) => j !== i))} className="rounded p-1 text-muted hover:bg-rowhover hover:text-status-redText" aria-label={`Remove row ${i + 1}`}>
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
            <div className="grid grid-cols-12 gap-3">
              {subs.map((sf) =>
                vis.has(sf.id) && sf.type !== "hidden" ? (
                  <div key={sf.id} className={widthClass(sf)}>
                    <FieldView {...props} field={sf} value={computedRow[sf.id]} values={computedRow} error={errors[`${f.id}.${i}.${sf.id}`]} onChange={(v) => setRow(i, sf.id, v)} />
                  </div>
                ) : null
              )}
            </div>
          </div>
        );
      })}
      {!disabled && (!f.maxRows || rows.length < f.maxRows) && (
        <Button type="button" variant="secondary" onClick={() => onChange([...rows, {}])}>
          <Plus className="h-4 w-4" /> {f.addLabel || "Add row"}
        </Button>
      )}
    </div>
  );
}

interface UploadedFile {
  id: string;
  name: string;
  size: number;
  mime: string;
}

function FileInput({ field: f, value, onChange, disabled, slug }: { field: Field; value: UploadedFile[]; onChange: (v: unknown) => void; disabled?: boolean; slug?: string }) {
  const [busy, setBusy] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const max = f.maxFiles ?? 1;
  const latest = useRef(value);
  latest.current = value;
  async function add(files: FileList | null) {
    if (!files) return;
    setErr(null);
    const room = max - latest.current.length;
    const list = Array.from(files).slice(0, room);
    if (files.length > room) setErr(`You can add ${max} file${max === 1 ? "" : "s"} at most.`);
    for (const file of list) {
      if (file.size > (f.maxSizeMb ?? 10) * 1024 * 1024) {
        setErr(`${file.name} is bigger than ${f.maxSizeMb ?? 10} MB.`);
        continue;
      }
      setBusy((n) => n + 1);
      try {
        const up = slug ? await fillApi.upload(slug, f.id, file) : { id: `preview-${Math.random().toString(36).slice(2)}`, name: file.name, size: file.size, mime: file.type };
        latest.current = [...latest.current, up];
        onChange(latest.current);
      } catch (e) {
        setErr(errorMessage(e, `${file.name} didn't upload.`));
      } finally {
        setBusy((n) => n - 1);
      }
    }
  }
  return (
    <div>
      {value.length > 0 && (
        <ul className="mb-2 space-y-1.5">
          {value.map((file) => (
            <li key={file.id} className="flex items-center gap-2 rounded-input border border-hairline bg-surface px-3 py-2 text-[13.5px] text-ink">
              <Paperclip className="h-4 w-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
              <span className="text-micro text-muted">{formatBytes(file.size)}</span>
              {!disabled && (
                <button type="button" onClick={() => onChange(value.filter((x) => x.id !== file.id))} className="rounded p-1 text-muted hover:text-status-redText" aria-label={`Remove ${file.name}`}>
                  <X className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && value.length < max && (
        <label className="flex min-h-[56px] cursor-pointer items-center justify-center gap-2 rounded-input border border-dashed border-strongline bg-subtle/40 px-3 text-[13.5px] font-semibold text-accent hover:bg-subtle">
          {busy > 0 ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
          {busy > 0 ? "Uploading…" : max > 1 ? "Add files" : "Add a file"}
          <input type="file" className="sr-only" accept={f.accept} multiple={max > 1} onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
        </label>
      )}
      <p className="mt-1 text-micro text-muted">
        {f.accept ? `${f.accept.replace(/,/g, ", ")} · ` : ""}up to {f.maxSizeMb ?? 10} MB{max > 1 ? ` · ${max} files` : ""}
      </p>
      {err && <p className="mt-1 text-[12.5px] text-status-redText">{err}</p>}
    </div>
  );
}

const formatBytes = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function SignatureInput({ value, onChange, disabled }: { value: string; onChange: (v: unknown) => void; disabled?: boolean }) {
  const pad = useRef<SignaturePadHandle>(null);
  const [redo, setRedo] = useState(!value);
  if (value && !redo) {
    return (
      <div>
        <img src={value} alt="Signature" className="h-40 w-full rounded-card border border-hairline bg-white object-contain" />
        {!disabled && <button type="button" onClick={() => { onChange(""); setRedo(true); }} className="mt-1.5 text-[13px] font-semibold text-accent">Sign again</button>}
      </div>
    );
  }
  return (
    <div onPointerUp={() => setTimeout(() => onChange(pad.current?.toDataURL() ?? ""), 0)}>
      <SignaturePad ref={pad} className={cn("h-40 w-full", disabled && "pointer-events-none opacity-60")} />
      <div className="mt-1.5 flex justify-between text-micro text-muted">
        <span>Sign with your finger, a pen or the mouse.</span>
        <button type="button" onClick={() => { pad.current?.clear(); onChange(""); }} className="font-semibold text-accent">Clear</button>
      </div>
    </div>
  );
}

function SiteSelect({ inputId, value, onChange, disabled }: { inputId: string; value: string; onChange: (v: unknown) => void; disabled?: boolean }) {
  const { data: sites, isLoading } = useSites();
  useEffect(() => {
    if (!value && sites?.length === 1) onChange(sites[0].code);
  }, [sites]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Select id={inputId} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled || isLoading} placeholder={isLoading ? "Loading…" : "Pick a site…"} options={(sites ?? []).map((s) => ({ value: s.code, label: s.name }))} className="min-h-[44px] md:min-h-9" />;
}

interface ResidentValue {
  id: string;
  name: string;
  unit?: string;
}

function ResidentPicker({ siteCode, value, onChange, disabled, needsSite }: { siteCode: string | null; value?: ResidentValue; onChange: (v: unknown) => void; disabled?: boolean; needsSite: string }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(!value);
  const { data, isLoading } = useTenants(siteCode ?? undefined, "active", Boolean(siteCode) && open && !disabled);
  if (value?.id && !open) {
    return (
      <div className="flex min-h-[44px] items-center gap-2 rounded-input border border-navy bg-navsel px-3 py-2 text-[14px] text-ink">
        <span className="min-w-0 flex-1 truncate font-semibold">{value.name}{value.unit ? <span className="font-normal text-muted"> · {value.unit}</span> : null}</span>
        {!disabled && <button type="button" onClick={() => { setOpen(true); onChange(undefined); }} className="text-[13px] font-semibold text-accent">Change</button>}
      </div>
    );
  }
  if (!siteCode) return <p className="rounded-input border border-dashed border-hairline px-3 py-2.5 text-[13px] text-muted">{needsSite}</p>;
  const needle = q.trim().toLowerCase();
  const people = (data?.items ?? []).filter((t) => !needle || t.displayName.toLowerCase().includes(needle) || `${t.firstName} ${t.lastName}`.toLowerCase().includes(needle) || (t.unit ?? "").toLowerCase().includes(needle));
  return (
    <div className="rounded-input border border-hairline bg-surface">
      <div className="relative border-b border-hairline">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or room…" disabled={disabled} className="w-full bg-transparent py-2.5 pl-9 pr-3 text-[14px] text-ink outline-none" />
      </div>
      <ul className="max-h-60 overflow-y-auto p-1">
        {isLoading && <li className="px-2 py-2 text-[13px] text-muted">Loading the roster…</li>}
        {people.slice(0, 200).map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => { onChange({ id: t.id, name: t.displayName, unit: t.unit ?? undefined }); setOpen(false); setQ(""); }} className="flex min-h-[40px] w-full items-center gap-2 rounded px-2 text-left text-[14px] text-ink hover:bg-rowhover">
              <span className="min-w-0 flex-1 truncate">{t.displayName}</span>
              {t.unit && <span className="text-micro text-muted">{t.unit}</span>}
            </button>
          </li>
        ))}
        {!isLoading && !people.length && <li className="px-2 py-2 text-[13px] text-muted">Nobody matches.</li>}
      </ul>
    </div>
  );
}

/** A read-only list of answers — the entry view, the confirmation summary and printouts. */
export function AnswerList({ doc, values, slug, compact }: { doc: FormDoc; values: Values; slug?: string; compact?: boolean }) {
  const visible = visibleFieldIds(doc, values, { includeAdminOnly: true });
  return (
    <dl className={cn("divide-y divide-hairline", compact && "text-[13px]")}>
      {doc.fields.map((f) => {
        if (f.type === "section" && visible.has(f.id)) return <dt key={f.id} className="pb-1 pt-4 font-heading text-[14px] font-extrabold text-ink">{f.label}</dt>;
        if (!isInputField(f) || !visible.has(f.id)) return null;
        const v = values[f.id];
        return (
          <div key={f.id} className="grid gap-1 py-2.5 sm:grid-cols-[minmax(140px,32%)_1fr] sm:gap-4">
            <dt className="text-[13px] font-semibold text-muted">{f.label || f.id}{f.adminOnly && <span className="ml-1 text-micro font-normal">(admin)</span>}</dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words text-[14px] text-ink">
              <AnswerValue field={f} value={v} slug={slug} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function AnswerValue({ field: f, value, slug }: { field: Field; value: unknown; slug?: string }) {
  if (value === undefined || value === null || value === "") return <span className="text-muted">—</span>;
  if (f.type === "signature" && typeof value === "string") return <img src={value} alt="Signature" className="h-24 max-w-[320px] rounded border border-hairline bg-white object-contain" />;
  if (f.type === "file" && Array.isArray(value)) {
    return (
      <ul className="space-y-1">
        {(value as UploadedFile[]).map((file) => (
          <li key={file.id}>
            {slug ? <a href={fillApi.fileUrl(slug, file.id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-semibold text-accent hover:underline"><Paperclip className="h-3.5 w-3.5" />{file.name}</a> : file.name}
            <span className="ml-1.5 text-micro text-muted">{formatBytes(file.size)}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (f.type === "repeater" && Array.isArray(value)) {
    const subs = (f.fields ?? []).filter(isInputField);
    return (
      <div className="overflow-x-auto">
        <table className="text-[13px]">
          <thead><tr>{subs.map((s) => <th key={s.id} className="pb-1 pr-4 text-left font-semibold text-muted">{s.label}</th>)}</tr></thead>
          <tbody>{(value as Values[]).map((row, i) => <tr key={i} className="border-t border-hairline">{subs.map((s) => <td key={s.id} className="py-1 pr-4">{formatValue(s, row[s.id])}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
  if (f.type === "likert" && value && typeof value === "object") {
    return (
      <ul>
        {(f.statements ?? []).map((r) => {
          const col = (value as Record<string, string>)[r.value];
          return col ? <li key={r.value}><span className="text-muted">{r.label}:</span> {f.choices?.find((c) => c.value === col)?.label ?? col}</li> : null;
        })}
      </ul>
    );
  }
  return <>{formatValue(f, value)}</>;
}
