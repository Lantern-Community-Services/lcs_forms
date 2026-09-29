/**
 * The form engine: what a built form *means*, shared by the server and the
 * browser so both sides agree on it exactly.
 *
 *   - the lcs-form document types (a form is one JSON document)
 *   - the field type catalog (the builder palette, the MCP reference)
 *   - conditional logic (show/hide fields, pages and sections)
 *   - calculations (a small, safe expression language — never eval)
 *   - merge tags ({field_id}, {user:name}, {all_fields} …)
 *   - submission validation
 *
 * THIS FILE IS THE ORIGINAL. frontend/src/lib/formEngine.ts is a copy made by
 * `npm run sync:engine` (backend). Edit here, then sync; `npm run check:engine`
 * fails when the copies differ. It must stay dependency-free.
 */

// ───────────────────────── Document types ─────────────────────────

export const FORMAT = "lcs-form" as const;
export const FORMAT_VERSION = 1 as const;

export type FieldType =
  // Standard
  | "text" | "textarea" | "number" | "email" | "phone" | "url" | "date" | "time"
  | "select" | "multiselect" | "radio" | "checkbox" | "consent" | "hidden"
  // Advanced
  | "name" | "address" | "file" | "signature" | "rating" | "slider" | "likert" | "repeater" | "calculation"
  // Lantern
  | "site" | "resident"
  // Layout
  | "section" | "html" | "page"
  // Code
  | "code";

export interface Choice {
  label: string;
  value: string;
}

export type RuleOp =
  | "is" | "is_not" | "gt" | "lt" | "gte" | "lte"
  | "contains" | "not_contains" | "starts_with" | "ends_with" | "empty" | "not_empty";

export interface Rule {
  /** Field id the rule looks at. For name/address, "field.part" (e.g. "applicant.first"). */
  field: string;
  op: RuleOp;
  value?: string | number | boolean;
}

export interface Conditional {
  action: "show" | "hide";
  match: "all" | "any";
  rules: Rule[];
}

export interface CodeBlock {
  /** Markup placed in the block's body. */
  html?: string;
  css?: string;
  /**
   * Runs inside a sandboxed frame (no access to the app, its cookies or its
   * data). Talks to the form through the `lcs` object — see CODE_BLOCK_API.
   */
  js?: string;
  /** Starting height in pixels; the block can resize itself with lcs.resize(). */
  height?: number;
}

export interface Field {
  /** Stable key: entries, merge tags, rules and calculations all use it. a-z, 0-9, _. */
  id: string;
  type: FieldType;
  label: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  /** Starting value. Strings may use merge tags: {user:name}, {date:today}. */
  defaultValue?: unknown;
  width?: "full" | "half" | "third";
  /** Not shown to the person filling in (kept for "administrative" fields, set by entry editors). */
  adminOnly?: boolean;
  /** Can't be changed by the person filling in (shown, sent with its default). */
  readOnly?: boolean;
  conditional?: Conditional;
  cssClass?: string;

  // Text-like validation
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  patternMessage?: string;
  /** Rows for a textarea. */
  rows?: number;

  // number / slider / rating
  min?: number;
  max?: number;
  step?: number;
  /** Shown before / after a number ("$", "hrs"). */
  prefix?: string;
  suffix?: string;

  // date
  minDate?: string;
  maxDate?: string;

  // choices (select, multiselect, radio, checkbox, likert columns)
  choices?: Choice[];
  /** radio / checkbox: add an "Other" option with a text box. */
  allowOther?: boolean;
  /** radio / checkbox: lay choices out in columns. */
  columns?: 1 | 2 | 3;
  /** checkbox / multiselect: at most this many picked. */
  maxSelections?: number;

  // likert
  /** Statements, each rated on the `choices` scale. */
  statements?: Choice[];

  // name
  nameParts?: ("prefix" | "first" | "middle" | "last" | "suffix")[];
  // address
  addressParts?: ("line1" | "line2" | "city" | "state" | "zip" | "country")[];

  // file
  accept?: string;
  maxFiles?: number;
  maxSizeMb?: number;

  // consent
  consentText?: string;

  // repeater
  fields?: Field[];
  minRows?: number;
  maxRows?: number;
  addLabel?: string;

  // calculation
  expression?: string;
  decimals?: number;
  /** "number" | "currency" | "percent" */
  display?: "number" | "currency" | "percent";

  // resident
  /** Id of the site field that picks which roster to show. Empty = the form's site. */
  siteField?: string;
  /** Log a roster activity for the picked resident when the entry is saved (default true). */
  logActivity?: boolean;

  // section / html / page
  /** HTML for an html block, or the lead text of a section / page. Merge tags work. */
  content?: string;
  /** page: label on the Next button. */
  nextLabel?: string;

  // code
  code?: CodeBlock;
}

export interface Notification {
  id: string;
  name: string;
  enabled: boolean;
  /** "email" sends mail; "webhook" POSTs the entry as signed JSON. */
  kind: "email" | "webhook";
  /** email: comma-separated addresses; merge tags allowed ({email_field}). */
  to?: string;
  subject?: string;
  /** email body (HTML). {all_fields} lists every answer. */
  body?: string;
  /** webhook: where to POST. */
  url?: string;
  /** webhook: HMAC secret; the X-Lantern-Signature header is sha256=<hex>. */
  secret?: string;
  /** Only send when these rules pass. */
  conditional?: Conditional;
}

export interface FormSettings {
  submitLabel?: string;
  /**
   * Who can fill it in. "signed_in": anyone with an account. "roles": only
   * the listed roles. "public": anyone with the link, no sign-in (/p/<slug>).
   */
  access?: { mode: "signed_in" | "roles" | "public"; roles?: string[] };
  /** Roles (besides Admin) that can read entries. Default: Main Office, Site Admin, Site Manager. */
  entriesRoles?: string[];
  /** Ask which site the entry is for (entries are then limited to that site's staff). */
  requireSite?: boolean;
  limits?: {
    maxEntries?: number;
    perUser?: { count: number; period: "day" | "week" | "month" | "ever" };
    /** ISO date-times. */
    opensAt?: string;
    closesAt?: string;
    closedMessage?: string;
  };
  confirmation?: {
    type: "message" | "redirect";
    /** HTML; merge tags work. */
    message?: string;
    url?: string;
    /** Show the person a copy of their answers under the message. */
    showSummary?: boolean;
  };
  notifications?: Notification[];
  progressBar?: boolean;
  /** Keep an unfinished form on the device so it survives a reload. Default true. */
  saveDrafts?: boolean;
  /** CSS applied to this form only (selectors are scoped to the form). */
  customCss?: string;
  /** Catalog icon key (see FORM_ICONS). */
  icon?: string;
}

export interface FormDoc {
  format: typeof FORMAT;
  version: typeof FORMAT_VERSION;
  title: string;
  description?: string;
  fields: Field[];
  settings: FormSettings;
}

export type Values = Record<string, unknown>;

// ───────────────────────── Field catalog ─────────────────────────

export interface FieldTypeInfo {
  type: FieldType;
  label: string;
  group: "Standard" | "Choices" | "Advanced" | "Lantern" | "Layout" | "Code";
  description: string;
  /** Holds an answer (layout blocks don't). */
  input: boolean;
  /** Uses the `choices` list. */
  choices?: boolean;
  /** Shape of the stored value, for docs and exports. */
  value: string;
}

export const FIELD_TYPES: FieldTypeInfo[] = [
  { type: "text", label: "Single line", group: "Standard", input: true, value: "string", description: "One line of text. minLength, maxLength, pattern." },
  { type: "textarea", label: "Paragraph", group: "Standard", input: true, value: "string", description: "Several lines of text. rows, maxLength." },
  { type: "number", label: "Number", group: "Standard", input: true, value: "number", description: "A number. min, max, step, prefix, suffix." },
  { type: "email", label: "Email", group: "Standard", input: true, value: "string", description: "An email address, checked for shape." },
  { type: "phone", label: "Phone", group: "Standard", input: true, value: "string", description: "A phone number (10+ digits)." },
  { type: "url", label: "Website", group: "Standard", input: true, value: "string", description: "An http(s) link." },
  { type: "date", label: "Date", group: "Standard", input: true, value: "string YYYY-MM-DD", description: "A calendar date. minDate / maxDate accept YYYY-MM-DD or 'today'." },
  { type: "time", label: "Time", group: "Standard", input: true, value: "string HH:MM", description: "A time of day, 24-hour." },
  { type: "hidden", label: "Hidden", group: "Standard", input: true, value: "string", description: "Not shown; carries defaultValue (merge tags work, e.g. {user:email})." },
  { type: "select", label: "Dropdown", group: "Choices", input: true, choices: true, value: "string (a choice value)", description: "Pick one from a list." },
  { type: "multiselect", label: "Multi-select", group: "Choices", input: true, choices: true, value: "string[]", description: "Pick several from a searchable list. maxSelections." },
  { type: "radio", label: "Multiple choice", group: "Choices", input: true, choices: true, value: "string", description: "Pick one; all options visible. allowOther, columns." },
  { type: "checkbox", label: "Checkboxes", group: "Choices", input: true, choices: true, value: "string[]", description: "Tick any number. allowOther, columns, maxSelections." },
  { type: "consent", label: "Consent", group: "Choices", input: true, value: "boolean", description: "A single 'I agree' tick box. consentText." },
  { type: "likert", label: "Likert / matrix", group: "Choices", input: true, choices: true, value: "{ [rowValue]: columnValue }", description: "Several statements (`statements`) rated on one scale (choices)." },
  { type: "name", label: "Name", group: "Advanced", input: true, value: "{ prefix?, first, middle?, last, suffix? }", description: "A person's name in parts. nameParts." },
  { type: "address", label: "Address", group: "Advanced", input: true, value: "{ line1, line2?, city, state, zip, country? }", description: "A postal address. addressParts." },
  { type: "file", label: "File upload", group: "Advanced", input: true, value: "[{ id, name, size, mime }]", description: "Upload files. accept, maxFiles, maxSizeMb (max 10)." },
  { type: "signature", label: "Signature", group: "Advanced", input: true, value: "PNG data URL", description: "Sign with a finger, mouse or pen." },
  { type: "rating", label: "Rating", group: "Advanced", input: true, value: "number", description: "Stars from 1 to max (default 5)." },
  { type: "slider", label: "Slider", group: "Advanced", input: true, value: "number", description: "A range slider. min, max, step." },
  { type: "repeater", label: "Repeater", group: "Advanced", input: true, value: "Values[] (one per row)", description: "A group of sub-fields (fields) the person can add rows of. minRows, maxRows." },
  { type: "calculation", label: "Calculation", group: "Advanced", input: true, value: "number | string", description: "Worked out from other fields with `expression`. Read-only; recomputed on the server." },
  { type: "site", label: "Site", group: "Lantern", input: true, value: "string (site code)", description: "Pick a Lantern site, limited to the person's own sites." },
  { type: "resident", label: "Resident", group: "Lantern", input: true, value: "{ id, name, unit }", description: "Pick a resident from a site's roster (siteField). Logs roster activity." },
  { type: "section", label: "Section", group: "Layout", input: false, value: "—", description: "A heading that groups the fields after it. Its conditional hides the whole section." },
  { type: "html", label: "Content", group: "Layout", input: false, value: "—", description: "Text, links, images (HTML in `content`). Merge tags work." },
  { type: "page", label: "Page break", group: "Layout", input: false, value: "—", description: "Starts a new page. Its conditional skips the whole page." },
  { type: "code", label: "Custom code", group: "Code", input: true, value: "whatever the code sets", description: "Your own HTML/CSS/JS in a sandboxed frame (`code`). Can read answers and set its own value." },
];

export const FIELD_TYPE_KEYS = FIELD_TYPES.map((t) => t.type);

export function typeInfo(type: string): FieldTypeInfo | undefined {
  return FIELD_TYPES.find((t) => t.type === type);
}

export const isInputField = (f: Pick<Field, "type">) => Boolean(typeInfo(f.type)?.input);
export const hasChoices = (f: Pick<Field, "type">) => Boolean(typeInfo(f.type)?.choices);

export const NAME_PARTS = { prefix: "Prefix", first: "First", middle: "Middle", last: "Last", suffix: "Suffix" } as const;
export const ADDRESS_PARTS = { line1: "Street address", line2: "Address line 2", city: "City", state: "State", zip: "ZIP code", country: "Country" } as const;
export const DEFAULT_NAME_PARTS: NonNullable<Field["nameParts"]> = ["first", "last"];
export const DEFAULT_ADDRESS_PARTS: NonNullable<Field["addressParts"]> = ["line1", "line2", "city", "state", "zip"];

/** The documented `lcs` API a custom code block runs against. */
export const CODE_BLOCK_API = `lcs.value            // this block's current value
lcs.values           // every answer in the form, by field id (read-only copy)
lcs.setValue(v)      // store a value for this block (any JSON)
lcs.setValid(ok, message?)  // block submit until ok is true
lcs.onChange(fn)     // fn(values) whenever any answer changes
lcs.resize(px?)      // fit the frame to its content, or a given height
lcs.user             // { name, email } of the person filling in (null on public forms)`;

export const PERIOD_LABELS = { day: "a day", week: "a week", month: "a month", ever: "in total" } as const;

// ───────────────────────── Helpers ─────────────────────────

/** Every field, with repeater sub-fields excluded (they live inside their row). */
export function topLevelInputs(doc: Pick<FormDoc, "fields">): Field[] {
  return doc.fields.filter(isInputField);
}

export function findField(doc: Pick<FormDoc, "fields">, id: string): Field | undefined {
  return doc.fields.find((f) => f.id === id);
}

export function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).every(isEmptyValue);
  return false;
}

/** A valid field id: starts with a letter, then letters, digits, underscores. */
export const FIELD_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** A new unique id from a label ("Date of birth" → "date_of_birth", "date_of_birth_2"). */
export function makeFieldId(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  if (!base || !/^[a-z]/.test(base)) base = `field${base ? `_${base}` : ""}`;
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}_${i}`)) return `${base}_${i}`;
}

/** Resolve "today", "today+7", "today-30" or a literal YYYY-MM-DD. */
export function resolveDate(spec: string | undefined, now = new Date()): string | undefined {
  if (!spec) return undefined;
  const m = /^today\s*([+-]\s*\d+)?$/i.exec(spec.trim());
  if (!m) return spec;
  const d = new Date(now);
  if (m[1]) d.setDate(d.getDate() + Number(m[1].replace(/\s/g, "")));
  return isoDate(d);
}

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

// ───────────────────────── Reading a value ─────────────────────────

/** A field's value as the rules and calculations see it ("applicant.first" reaches a part). */
export function readPath(values: Values, path: string): unknown {
  const [id, part] = path.split(".");
  const v = values[id];
  if (part === undefined) return v;
  if (v && typeof v === "object" && !Array.isArray(v)) return (v as Record<string, unknown>)[part];
  return undefined;
}

function asNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v.replace(/[$,%\s]/g, ""));
    return Number.isFinite(n) ? n : NaN;
  }
  if (Array.isArray(v)) return v.length;
  return NaN;
}

function asText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.map(asText).join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.name === "string") return o.name;
    return Object.values(o).filter((x) => !isEmptyValue(x)).map(asText).join(" ");
  }
  return String(v);
}

// ───────────────────────── Conditional logic ─────────────────────────

export function ruleMatches(rule: Rule, values: Values): boolean {
  const v = readPath(values, rule.field);
  const target = rule.value;
  switch (rule.op) {
    case "empty":
      return isEmptyValue(v);
    case "not_empty":
      return !isEmptyValue(v);
    case "is":
      return equalsLoose(v, target);
    case "is_not":
      return !equalsLoose(v, target);
    case "gt":
    case "lt":
    case "gte":
    case "lte": {
      // Dates compare as strings (YYYY-MM-DD sorts correctly); everything else numerically.
      const dateLike = typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && typeof target === "string";
      const a = dateLike ? (v as string) : asNumber(v);
      const b = dateLike ? resolveDate(String(target)) ?? "" : asNumber(target);
      if (!dateLike && (Number.isNaN(a) || Number.isNaN(b))) return false;
      if (rule.op === "gt") return a > b;
      if (rule.op === "lt") return a < b;
      if (rule.op === "gte") return a >= b;
      return a <= b;
    }
    case "contains":
      return Array.isArray(v) ? v.some((x) => equalsLoose(x, target)) : asText(v).toLowerCase().includes(String(target ?? "").toLowerCase());
    case "not_contains":
      return !(Array.isArray(v) ? v.some((x) => equalsLoose(x, target)) : asText(v).toLowerCase().includes(String(target ?? "").toLowerCase()));
    case "starts_with":
      return asText(v).toLowerCase().startsWith(String(target ?? "").toLowerCase());
    case "ends_with":
      return asText(v).toLowerCase().endsWith(String(target ?? "").toLowerCase());
    default:
      return false;
  }
}

/** Case-insensitive, and an array "is" X when it includes X (a checkbox list). */
function equalsLoose(v: unknown, target: unknown): boolean {
  if (Array.isArray(v)) return v.some((x) => equalsLoose(x, target));
  if (typeof v === "boolean" || typeof target === "boolean") return String(v ?? false) === String(target ?? false);
  if (v && typeof v === "object" && "id" in (v as object)) return String((v as { id: unknown }).id) === String(target);
  return String(v ?? "").trim().toLowerCase() === String(target ?? "").trim().toLowerCase();
}

export function conditionPasses(c: Conditional | undefined, values: Values): boolean {
  if (!c || !c.rules?.length) return true;
  const hits = c.rules.map((r) => ruleMatches(r, values));
  const matched = c.match === "any" ? hits.some(Boolean) : hits.every(Boolean);
  return c.action === "hide" ? !matched : matched;
}

export interface PageInfo {
  /** Index into the pages array. */
  index: number;
  /** The page-break field that starts it (none for the first page). */
  pageField?: Field;
  fields: Field[];
}

/** Split fields into pages at each page break. There is always at least one page. */
export function pagesOf(doc: Pick<FormDoc, "fields">): PageInfo[] {
  const pages: PageInfo[] = [{ index: 0, fields: [] }];
  for (const f of doc.fields) {
    if (f.type === "page") pages.push({ index: pages.length, pageField: f, fields: [] });
    else pages[pages.length - 1].fields.push(f);
  }
  // A leading page break makes an empty first page; drop it.
  if (pages.length > 1 && pages[0].fields.length === 0) {
    pages.shift();
    pages.forEach((p, i) => (p.index = i));
  }
  return pages;
}

/**
 * Which fields are showing for these answers. A field is visible when its own
 * rule passes, its section's rule passes and its page's rule passes. Rules
 * that read a hidden field see it as empty, so a chain of rules collapses the
 * way people expect. Iterates until stable (a rule can depend on a field that
 * comes later).
 */
export function visibleFieldIds(doc: Pick<FormDoc, "fields">, values: Values, opts: { includeAdminOnly?: boolean } = {}): Set<string> {
  let current = { ...values };
  let visible = new Set<string>();
  for (let pass = 0; pass < 6; pass++) {
    const next = new Set<string>();
    let pageOn = true;
    let sectionOn = true;
    for (const f of doc.fields) {
      if (f.type === "page") {
        pageOn = conditionPasses(f.conditional, current);
        sectionOn = true;
        if (pageOn) next.add(f.id);
        continue;
      }
      if (f.type === "section") {
        sectionOn = conditionPasses(f.conditional, current);
        if (pageOn && sectionOn) next.add(f.id);
        continue;
      }
      if (f.adminOnly && !opts.includeAdminOnly) continue;
      if (pageOn && sectionOn && conditionPasses(f.conditional, current)) next.add(f.id);
    }
    const same = next.size === visible.size && [...next].every((id) => visible.has(id));
    visible = next;
    if (same && pass > 0) break;
    current = Object.fromEntries(Object.entries(values).filter(([k]) => visible.has(k) || !doc.fields.some((f) => f.id === k)));
  }
  return visible;
}

// ───────────────────────── Expressions ─────────────────────────
//
// Calculations use a tiny language, parsed here — never eval'd — so a form
// definition from an import or an LLM can't run code on the server.
//
//   {qty} * {price}            field references in braces ("{applicant.first}" reaches a part)
//   + - * / % ^  ( )           arithmetic
//   == != > < >= <=  && || !   comparisons and logic
//   "text"  'text'             strings; + joins text when either side is text
//   sum(a, b, …) min max avg round(x, places) floor ceil abs
//   if(condition, then, else)  len(x)  count(list)  concat(…)  upper lower
//   today()  days_between(dateA, dateB)  age(date)  year(date)

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ref"; v: string }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "(" }
  | { t: ")" }
  | { t: "," };

export class ExprError extends Error {}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "{") {
      const end = src.indexOf("}", i);
      if (end < 0) throw new ExprError("A { has no closing }.");
      out.push({ t: "ref", v: src.slice(i + 1, end).trim() });
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) { s += src[j + 1]; j += 2; continue; }
        s += src[j++];
      }
      if (j >= src.length) throw new ExprError("A string has no closing quote.");
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+(e[+-]?[0-9]+)?/i.exec(src.slice(i));
      if (!m) throw new ExprError(`Unexpected "${c}".`);
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[a-z_]/i.test(c)) {
      const m = /^[a-z_][a-z0-9_]*/i.exec(src.slice(i))!;
      const word = m[0].toLowerCase();
      if (word === "true" || word === "false") out.push({ t: "num", v: word === "true" ? 1 : 0 });
      else if (word === "and") out.push({ t: "op", v: "&&" });
      else if (word === "or") out.push({ t: "op", v: "||" });
      else if (word === "not") out.push({ t: "op", v: "!" });
      else out.push({ t: "id", v: word });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", ">=", "<=", "&&", "||"].includes(two)) { out.push({ t: "op", v: two }); i += 2; continue; }
    if ("+-*/%^<>!".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    if (c === "=") { out.push({ t: "op", v: "==" }); i++; continue; }
    if (c === "(") { out.push({ t: "(" }); i++; continue; }
    if (c === ")") { out.push({ t: ")" }); i++; continue; }
    if (c === ",") { out.push({ t: "," }); i++; continue; }
    throw new ExprError(`Unexpected "${c}".`);
  }
  return out;
}

type Node =
  | { k: "lit"; v: number | string }
  | { k: "ref"; path: string }
  | { k: "un"; op: string; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "call"; name: string; args: Node[] };

const PREC: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6, "^": 7 };

export function parseExpression(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const expr = (minPrec: number): Node => {
    let left = unary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== "op" || PREC[t.v] === undefined || PREC[t.v] < minPrec) break;
      p++;
      // ^ is right-associative; everything else left.
      const right = expr(t.v === "^" ? PREC[t.v] : PREC[t.v] + 1);
      left = { k: "bin", op: t.v, a: left, b: right };
    }
    return left;
  };
  const unary = (): Node => {
    const t = peek();
    if (t && t.t === "op" && (t.v === "-" || t.v === "!" || t.v === "+")) {
      p++;
      return { k: "un", op: t.v, a: unary() };
    }
    return primary();
  };
  const primary = (): Node => {
    const t = toks[p++];
    if (!t) throw new ExprError("The expression ends too early.");
    if (t.t === "num") return { k: "lit", v: t.v };
    if (t.t === "str") return { k: "lit", v: t.v };
    if (t.t === "ref") return { k: "ref", path: t.v };
    if (t.t === "(") {
      const e = expr(1);
      if (toks[p++]?.t !== ")") throw new ExprError("A ( has no closing ).");
      return e;
    }
    if (t.t === "id") {
      if (!(t.v in FUNCTIONS)) throw new ExprError(`Unknown function "${t.v}".`);
      if (toks[p++]?.t !== "(") throw new ExprError(`${t.v} needs ( ) after it.`);
      const args: Node[] = [];
      if (peek()?.t !== ")") {
        for (;;) {
          args.push(expr(1));
          const sep = toks[p++];
          if (sep?.t === ")") break;
          if (sep?.t !== ",") throw new ExprError(`Expected , or ) in ${t.v}( ).`);
        }
      } else p++;
      return { k: "call", name: t.v, args };
    }
    throw new ExprError("Unexpected symbol in the expression.");
  };
  const tree = expr(1);
  if (p < toks.length) throw new ExprError("Unexpected text after the end of the expression.");
  return tree;
}

type V = number | string | unknown[] | boolean | null | undefined | object;

const num = (v: V) => { const n = asNumber(v); return Number.isNaN(n) ? 0 : n; };
const truthy = (v: V) => (typeof v === "number" ? v !== 0 : typeof v === "string" ? v !== "" : Array.isArray(v) ? v.length > 0 : Boolean(v));
const dayMs = 86_400_000;
const parseDay = (v: V) => { const s = asText(v); const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };
const flat = (args: V[]) => args.flatMap((a) => (Array.isArray(a) ? a : [a])) as V[];

const FUNCTIONS: Record<string, (args: V[]) => V> = {
  sum: (a) => flat(a).reduce<number>((s, x) => s + num(x), 0),
  min: (a) => { const n = flat(a).map(num); return n.length ? Math.min(...n) : 0; },
  max: (a) => { const n = flat(a).map(num); return n.length ? Math.max(...n) : 0; },
  avg: (a) => { const n = flat(a).map(num); return n.length ? n.reduce((s, x) => s + x, 0) / n.length : 0; },
  round: ([x, d]) => { const f = 10 ** num(d ?? 0); return Math.round(num(x) * f) / f; },
  floor: ([x]) => Math.floor(num(x)),
  ceil: ([x]) => Math.ceil(num(x)),
  abs: ([x]) => Math.abs(num(x)),
  if: ([c, a, b]) => (truthy(c) ? a : b),
  len: ([x]) => (Array.isArray(x) ? x.length : asText(x).length),
  count: ([x]) => (Array.isArray(x) ? x.length : isEmptyValue(x) ? 0 : 1),
  concat: (a) => a.map(asText).join(""),
  upper: ([x]) => asText(x).toUpperCase(),
  lower: ([x]) => asText(x).toLowerCase(),
  today: () => isoDate(new Date()),
  days_between: ([a, b]) => { const x = parseDay(a), y = parseDay(b); return Number.isNaN(x) || Number.isNaN(y) ? 0 : Math.round((y - x) / dayMs); },
  age: ([d]) => {
    const t = parseDay(d);
    if (Number.isNaN(t)) return 0;
    const born = new Date(t), now = new Date();
    let years = now.getFullYear() - born.getUTCFullYear();
    if (now.getMonth() < born.getUTCMonth() || (now.getMonth() === born.getUTCMonth() && now.getDate() < born.getUTCDate())) years--;
    return years;
  },
  year: ([d]) => { const t = parseDay(d); return Number.isNaN(t) ? 0 : new Date(t).getUTCFullYear(); },
};

export const EXPRESSION_FUNCTIONS = Object.keys(FUNCTIONS);

function evalNode(n: Node, values: Values): V {
  switch (n.k) {
    case "lit":
      return n.v;
    case "ref": {
      const v = readPath(values, n.path);
      if (typeof v === "number" || Array.isArray(v)) return v;
      if (typeof v === "boolean") return v ? 1 : 0;
      if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
      return (v ?? "") as V;
    }
    case "un": {
      const a = evalNode(n.a, values);
      if (n.op === "-") return -num(a);
      if (n.op === "!") return truthy(a) ? 0 : 1;
      return num(a);
    }
    case "bin": {
      if (n.op === "&&") return truthy(evalNode(n.a, values)) && truthy(evalNode(n.b, values)) ? 1 : 0;
      if (n.op === "||") return truthy(evalNode(n.a, values)) || truthy(evalNode(n.b, values)) ? 1 : 0;
      const a = evalNode(n.a, values);
      const b = evalNode(n.b, values);
      switch (n.op) {
        case "+":
          return typeof a === "string" || typeof b === "string" ? asText(a) + asText(b) : num(a) + num(b);
        case "-": return num(a) - num(b);
        case "*": return num(a) * num(b);
        case "/": return num(b) === 0 ? 0 : num(a) / num(b);
        case "%": return num(b) === 0 ? 0 : num(a) % num(b);
        case "^": return num(a) ** num(b);
        case "==": return equalsLoose(a, b) ? 1 : 0;
        case "!=": return equalsLoose(a, b) ? 0 : 1;
        default: {
          const bothText = typeof a === "string" && typeof b === "string" && (Number.isNaN(Number(a)) || Number.isNaN(Number(b)));
          const x = bothText ? a : num(a), y = bothText ? b : num(b);
          if (n.op === ">") return x > y ? 1 : 0;
          if (n.op === "<") return x < y ? 1 : 0;
          if (n.op === ">=") return x >= y ? 1 : 0;
          return x <= y ? 1 : 0;
        }
      }
    }
    case "call":
      return FUNCTIONS[n.name](n.args.map((a) => evalNode(a, values)));
  }
}

/** Field ids an expression reads. */
export function expressionRefs(src: string): string[] {
  try {
    return tokenize(src).filter((t): t is { t: "ref"; v: string } => t.t === "ref").map((t) => t.v.split(".")[0]);
  } catch {
    return [];
  }
}

export function evaluate(src: string, values: Values): number | string {
  const v = evalNode(parseExpression(src), values);
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  return asText(v as V);
}

function roundTo(v: number | string, decimals: number | undefined) {
  if (typeof v !== "number") return v;
  const d = decimals ?? 2;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

/**
 * Fill in every calculation field, in order, so one calculation can use
 * another above it. A broken expression gives an empty value rather than
 * breaking the form (the builder reports it before it's ever published).
 */
export function applyCalculations(doc: Pick<FormDoc, "fields">, values: Values): Values {
  const out = { ...values };
  for (const f of doc.fields) {
    if (f.type !== "calculation" || !f.expression) continue;
    try {
      out[f.id] = roundTo(evaluate(f.expression, out), f.decimals);
    } catch {
      out[f.id] = "";
    }
  }
  return out;
}

// ───────────────────────── Display ─────────────────────────

function choiceLabel(f: Field, value: unknown): string {
  const hit = f.choices?.find((c) => c.value === value);
  return hit ? hit.label : asText(value);
}

/** One answer as a person reads it — used by entries, exports, emails and merge tags. */
export function formatValue(f: Field, value: unknown): string {
  if (isEmptyValue(value)) return "";
  switch (f.type) {
    case "select":
    case "radio":
      return choiceLabel(f, value);
    case "checkbox":
    case "multiselect":
      return (Array.isArray(value) ? value : [value]).map((v) => choiceLabel(f, v)).join(", ");
    case "consent":
      return value === true ? "Agreed" : "Not agreed";
    case "name": {
      const o = value as Record<string, string>;
      return ["prefix", "first", "middle", "last", "suffix"].map((k) => o[k]).filter(Boolean).join(" ");
    }
    case "address": {
      const o = value as Record<string, string>;
      const cityLine = [o.city, [o.state, o.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      return [o.line1, o.line2, cityLine, o.country].filter(Boolean).join(", ");
    }
    case "file":
      return (value as { name: string }[]).map((x) => x.name).join(", ");
    case "signature":
      return "Signed";
    case "rating":
      return `${value} / ${f.max ?? 5}`;
    case "likert": {
      const o = value as Record<string, string>;
      return (f.statements ?? []).filter((r) => o[r.value]).map((r) => `${r.label}: ${choiceLabel(f, o[r.value])}`).join("; ");
    }
    case "repeater": {
      const rows = value as Values[];
      return rows
        .map((row, i) => `#${i + 1} ${(f.fields ?? []).filter(isInputField).map((sf) => `${sf.label}: ${formatValue(sf, row[sf.id])}`).filter((s) => !s.endsWith(": ")).join(", ")}`)
        .join("; ");
    }
    case "resident": {
      const o = value as { name?: string; unit?: string };
      return [o.name, o.unit ? `(${o.unit})` : ""].filter(Boolean).join(" ");
    }
    case "calculation": {
      if (typeof value !== "number") return asText(value);
      if (f.display === "currency") return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
      if (f.display === "percent") return `${value}%`;
      return String(value);
    }
    case "number":
      return `${f.prefix ?? ""}${value}${f.suffix ? ` ${f.suffix}` : ""}`;
    case "code":
      return typeof value === "string" ? value : JSON.stringify(value);
    default:
      return asText(value);
  }
}

// ───────────────────────── Merge tags ─────────────────────────

export interface MergeContext {
  values: Values;
  doc: Pick<FormDoc, "fields" | "title">;
  user?: { name: string; email: string } | null;
  entry?: { id: string; createdAt?: string | Date } | null;
  site?: { name: string; code: string } | null;
  /** Escape answers for an HTML context (emails, content blocks). */
  html?: boolean;
  /** Absolute link to the entry, for notifications. */
  entryUrl?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function allFieldsText(ctx: MergeContext): string {
  const visible = visibleFieldIds(ctx.doc, ctx.values);
  const rows = ctx.doc.fields
    .filter((f) => isInputField(f) && f.type !== "hidden" && visible.has(f.id))
    .map((f) => [f.label, formatValue(f, ctx.values[f.id])] as const)
    .filter(([, v]) => v !== "");
  if (!ctx.html) return rows.map(([l, v]) => `${l}: ${v}`).join("\n");
  return `<table cellpadding="6" style="border-collapse:collapse">${rows
    .map(([l, v]) => `<tr><td style="border-bottom:1px solid #e5e7eb;color:#555;vertical-align:top"><b>${esc(l)}</b></td><td style="border-bottom:1px solid #e5e7eb">${esc(v)}</td></tr>`)
    .join("")}</table>`;
}

/**
 * Replace merge tags. Unknown tags are left as written so a typo is visible
 * rather than silently blank.
 *   {field_id} {field_id.part} {field_id:value}   an answer (label form, or raw value)
 *   {all_fields}  {form:title}  {entry:id}  {entry:url}  {entry:date}
 *   {user:name}  {user:email}  {site:name}  {site:code}  {date:today}  {date:now}
 */
export function renderTemplate(tpl: string | undefined, ctx: MergeContext): string {
  if (!tpl) return "";
  const out = (s: string) => (ctx.html ? esc(s) : s);
  return tpl.replace(/\{([a-z][a-z0-9_]*)(?:([.:])([a-z0-9_]+))?\}/gi, (whole, key: string, sep?: string, sub?: string) => {
    const k = key.toLowerCase();
    if (k === "all_fields" && !sep) return allFieldsText(ctx);
    if (sep === ":") {
      switch (`${k}:${sub}`) {
        case "form:title": return out(ctx.doc.title);
        case "entry:id": return out(ctx.entry?.id ?? "");
        case "entry:url": return out(ctx.entryUrl ?? "");
        case "entry:date": return out(ctx.entry?.createdAt ? new Date(ctx.entry.createdAt).toLocaleString("en-US", { timeZone: "America/New_York" }) : "");
        case "user:name": return out(ctx.user?.name ?? "");
        case "user:email": return out(ctx.user?.email ?? "");
        case "site:name": return out(ctx.site?.name ?? "");
        case "site:code": return out(ctx.site?.code ?? "");
        case "date:today": return out(isoDate(new Date()));
        case "date:now": return out(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
      }
    }
    const f = ctx.doc.fields.find((x) => x.id === key);
    if (!f) return whole;
    if (sep === ".") return out(asText(readPath(ctx.values, `${key}.${sub}`)));
    if (sep === ":" && sub === "value") return out(asText(ctx.values[key]));
    return out(formatValue(f, ctx.values[key]));
  });
}

/** Resolve a default value (merge tags in strings) for a fresh form. */
export function initialValues(doc: Pick<FormDoc, "fields" | "title">, ctx: Omit<MergeContext, "values" | "doc">): Values {
  const out: Values = {};
  for (const f of doc.fields) {
    if (!isInputField(f) || f.defaultValue === undefined || f.defaultValue === null) continue;
    out[f.id] = typeof f.defaultValue === "string" ? renderTemplate(f.defaultValue, { ...ctx, values: {}, doc }) : f.defaultValue;
  }
  return applyCalculations(doc, out);
}

// ───────────────────────── Validation ─────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SIGNATURE_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

export type Errors = Record<string, string>;

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Problem with one field's value, or null. `values` is the whole form (for context). */
export function fieldError(f: Field, value: unknown): string | null {
  const empty = isEmptyValue(value) || (f.type === "consent" && value !== true);
  if (empty) return f.required && f.type !== "calculation" ? (f.type === "consent" ? "Please tick to agree." : "This is required.") : null;

  const text = typeof value === "string" ? value : null;
  switch (f.type) {
    case "text":
    case "textarea":
    case "hidden": {
      if (text === null) return "Expected text.";
      if (f.minLength && text.length < f.minLength) return `At least ${f.minLength} characters.`;
      if (f.maxLength && text.length > f.maxLength) return `At most ${f.maxLength} characters.`;
      if (f.pattern) {
        try {
          if (!new RegExp(`^(?:${f.pattern})$`).test(text)) return f.patternMessage || "That isn't in the expected format.";
        } catch {
          /* a bad pattern is reported by the builder, not the person filling in */
        }
      }
      return text.length > 20000 ? "That's too long." : null;
    }
    case "email":
      return text !== null && EMAIL_RE.test(text.trim()) ? null : "Enter an email address, like name@example.org.";
    case "phone":
      return text !== null && text.replace(/\D/g, "").length >= 10 && text.length <= 30 ? null : "Enter a phone number with area code.";
    case "url":
      return text !== null && /^https?:\/\/[^\s]+\.[^\s]+/.test(text.trim()) ? null : "Enter a full link starting with https://.";
    case "number":
    case "slider":
    case "rating": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) return "Enter a number.";
      const min = f.type === "rating" ? 1 : f.min;
      const max = f.type === "rating" ? f.max ?? 5 : f.max;
      if (min !== undefined && n < min) return `At least ${min}.`;
      if (max !== undefined && n > max) return `At most ${max}.`;
      return null;
    }
    case "date": {
      if (text === null || !DATE_RE.test(text)) return "Enter a date.";
      const lo = resolveDate(f.minDate), hi = resolveDate(f.maxDate);
      if (lo && text < lo) return `On or after ${lo}.`;
      if (hi && text > hi) return `On or before ${hi}.`;
      return null;
    }
    case "time":
      return text !== null && TIME_RE.test(text) ? null : "Enter a time.";
    case "select":
    case "radio": {
      if (text === null) return "Pick one.";
      if (f.choices?.some((c) => c.value === text)) return null;
      return f.allowOther && f.type === "radio" && text.length <= 500 ? null : "Pick one of the options.";
    }
    case "checkbox":
    case "multiselect": {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return "Pick from the options.";
      if (f.maxSelections && value.length > f.maxSelections) return `Pick at most ${f.maxSelections}.`;
      const known = new Set((f.choices ?? []).map((c) => c.value));
      const unknown = value.filter((v) => !known.has(v));
      if (unknown.length > (f.allowOther && f.type === "checkbox" ? 1 : 0)) return "Pick from the options.";
      return null;
    }
    case "consent":
      return value === true ? null : "Please tick to agree.";
    case "name": {
      if (!isObj(value)) return "Enter a name.";
      const parts = f.nameParts ?? DEFAULT_NAME_PARTS;
      if (f.required) {
        const missing = parts.filter((p) => (p === "first" || p === "last") && isEmptyValue(value[p]));
        if (missing.length) return `Enter the ${missing.map((p) => NAME_PARTS[p].toLowerCase()).join(" and ")} name.`;
      }
      return null;
    }
    case "address": {
      if (!isObj(value)) return "Enter an address.";
      const parts = f.addressParts ?? DEFAULT_ADDRESS_PARTS;
      if (f.required) {
        const need = parts.filter((p) => p !== "line2" && isEmptyValue(value[p]));
        if (need.length) return `Enter the ${need.map((p) => ADDRESS_PARTS[p].toLowerCase()).join(", ")}.`;
      }
      if (typeof value.zip === "string" && value.zip && !/^\d{5}(-\d{4})?$/.test(value.zip) && (!value.country || value.country === "United States")) return "Enter a 5-digit ZIP code.";
      return null;
    }
    case "file": {
      if (!Array.isArray(value) || value.some((x) => !isObj(x) || typeof x.id !== "string")) return "Upload a file.";
      if (value.length > (f.maxFiles ?? 1)) return `At most ${f.maxFiles ?? 1} file${(f.maxFiles ?? 1) === 1 ? "" : "s"}.`;
      return null;
    }
    case "signature":
      return text !== null && SIGNATURE_RE.test(text) && text.length < 600_000 ? null : "Please sign.";
    case "likert": {
      if (!isObj(value)) return "Answer each row.";
      const cols = new Set((f.choices ?? []).map((c) => c.value));
      if (Object.values(value).some((v) => typeof v !== "string" || !cols.has(v))) return "Pick from the scale.";
      if (f.required && (f.statements ?? []).some((r) => isEmptyValue(value[r.value]))) return "Answer each row.";
      return null;
    }
    case "repeater": {
      if (!Array.isArray(value)) return "Expected rows.";
      if (f.minRows && value.length < f.minRows) return `Add at least ${f.minRows} row${f.minRows === 1 ? "" : "s"}.`;
      if (f.maxRows && value.length > f.maxRows) return `At most ${f.maxRows} rows.`;
      return null;
    }
    case "site":
      return text !== null && text.length <= 80 ? null : "Pick a site.";
    case "resident":
      return isObj(value) && typeof value.id === "string" ? null : "Pick a resident.";
    case "code":
      return JSON.stringify(value).length > 200_000 ? "That's too much data." : null;
    default:
      return null;
  }
}

/** Errors inside repeater rows, keyed "repeater.rowIndex.fieldId". */
function repeaterErrors(f: Field, rows: unknown, errors: Errors) {
  if (!Array.isArray(rows)) return;
  const subs = (f.fields ?? []).filter(isInputField);
  rows.forEach((row, i) => {
    const r = isObj(row) ? row : {};
    const vis = visibleFieldIds({ fields: f.fields ?? [] }, r);
    for (const sf of subs) {
      if (!vis.has(sf.id)) continue;
      const e = fieldError(sf, r[sf.id]);
      if (e) errors[`${f.id}.${i}.${sf.id}`] = e;
    }
  });
}

export interface ValidateOptions {
  /** Only check these field ids (one page of a multi-page form). */
  only?: Set<string>;
  includeAdminOnly?: boolean;
  /** Custom code blocks that reported themselves invalid: { fieldId: message }. */
  codeErrors?: Record<string, string>;
}

export function validateValues(doc: Pick<FormDoc, "fields">, values: Values, opts: ValidateOptions = {}): Errors {
  const errors: Errors = {};
  const visible = visibleFieldIds(doc, values, { includeAdminOnly: opts.includeAdminOnly });
  for (const f of doc.fields) {
    if (!isInputField(f) || !visible.has(f.id)) continue;
    if (opts.only && !opts.only.has(f.id)) continue;
    const e = fieldError(f, values[f.id]);
    if (e) errors[f.id] = e;
    else if (f.type === "repeater") repeaterErrors(f, values[f.id], errors);
    if (!errors[f.id] && f.type === "code" && opts.codeErrors?.[f.id]) errors[f.id] = opts.codeErrors[f.id];
  }
  return errors;
}

/**
 * What gets stored: calculations recomputed, hidden fields' answers dropped
 * (an answer to a question the person never saw means nothing), layout blocks
 * and unknown keys removed, strings trimmed.
 */
export function cleanValues(doc: Pick<FormDoc, "fields">, values: Values, opts: { includeAdminOnly?: boolean } = {}): Values {
  const calculated = applyCalculations(doc, values);
  const visible = visibleFieldIds(doc, calculated, opts);
  const out: Values = {};
  for (const f of doc.fields) {
    if (!isInputField(f) || !visible.has(f.id)) continue;
    let v = calculated[f.id];
    if (typeof v === "string") v = v.trim();
    if (f.type === "number" || f.type === "slider" || f.type === "rating") v = isEmptyValue(v) ? undefined : Number(v);
    if (f.type === "repeater" && Array.isArray(v)) {
      const sub = { fields: f.fields ?? [] };
      v = v.map((row) => cleanValues(sub, isObj(row) ? row : {}));
    }
    if (!isEmptyValue(v) || v === false || v === 0) out[f.id] = v;
  }
  return out;
}

// ───────────────────────── Structural checks ─────────────────────────

/**
 * Problems with a form definition that the JSON shape can't express: repeated
 * ids, rules pointing at fields that don't exist, expressions that don't
 * parse. Returned as { path, message } so the code editor and the MCP server
 * can point at the exact spot.
 */
export function lintForm(doc: Pick<FormDoc, "fields" | "settings">): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = [];
  const ids = new Map<string, number>();
  doc.fields.forEach((f, i) => {
    if (ids.has(f.id)) problems.push({ path: `fields[${i}].id`, message: `"${f.id}" is used by another field (fields[${ids.get(f.id)}]). Ids must be unique.` });
    else ids.set(f.id, i);
  });
  const known = new Set(doc.fields.map((f) => f.id));
  const checkRules = (c: Conditional | undefined, path: string) =>
    c?.rules?.forEach((r, j) => {
      const id = r.field.split(".")[0];
      if (!known.has(id)) problems.push({ path: `${path}.rules[${j}].field`, message: `No field with id "${id}".` });
    });
  doc.fields.forEach((f, i) => {
    const p = `fields[${i}]`;
    checkRules(f.conditional, `${p}.conditional`);
    if (f.conditional?.rules?.some((r) => r.field.split(".")[0] === f.id)) problems.push({ path: `${p}.conditional`, message: "A field's rule can't depend on the field itself." });
    if (hasChoices(f) && !(f.choices ?? []).length) problems.push({ path: `${p}.choices`, message: `${f.label || f.id} needs at least one choice.` });
    if (hasChoices(f)) {
      const seen = new Set<string>();
      (f.choices ?? []).forEach((c, j) => {
        if (seen.has(c.value)) problems.push({ path: `${p}.choices[${j}].value`, message: `Two choices share the value "${c.value}".` });
        seen.add(c.value);
      });
    }
    if (f.type === "likert" && !(f.statements ?? []).length) problems.push({ path: `${p}.statements`, message: "A likert field needs at least one row." });
    if (f.type === "calculation") {
      if (!f.expression) problems.push({ path: `${p}.expression`, message: "A calculation needs an expression." });
      else {
        try {
          parseExpression(f.expression);
          for (const ref of expressionRefs(f.expression)) if (!known.has(ref)) problems.push({ path: `${p}.expression`, message: `The expression reads {${ref}}, which isn't a field.` });
        } catch (e) {
          problems.push({ path: `${p}.expression`, message: e instanceof Error ? e.message : "The expression doesn't parse." });
        }
      }
    }
    if (f.pattern) {
      try {
        new RegExp(f.pattern);
      } catch {
        problems.push({ path: `${p}.pattern`, message: "The pattern isn't a valid regular expression." });
      }
    }
    if (f.type === "resident" && f.siteField) {
      const sf = doc.fields.find((x) => x.id === f.siteField);
      if (!sf || sf.type !== "site") problems.push({ path: `${p}.siteField`, message: `siteField must be the id of a Site field.` });
    }
    if (f.type === "repeater") {
      if (!(f.fields ?? []).length) problems.push({ path: `${p}.fields`, message: "A repeater needs at least one sub-field." });
      const subIds = new Set<string>();
      (f.fields ?? []).forEach((sf, j) => {
        if (subIds.has(sf.id)) problems.push({ path: `${p}.fields[${j}].id`, message: `"${sf.id}" is repeated inside the repeater.` });
        subIds.add(sf.id);
        if (["repeater", "page", "file", "signature", "code", "resident"].includes(sf.type)) problems.push({ path: `${p}.fields[${j}].type`, message: `A ${sf.type} field can't go inside a repeater.` });
      });
    }
  });
  (doc.settings.notifications ?? []).forEach((n, i) => {
    checkRules(n.conditional, `settings.notifications[${i}].conditional`);
    if (n.enabled && n.kind === "email" && !n.to) problems.push({ path: `settings.notifications[${i}].to`, message: "An email notification needs a To address." });
    if (n.enabled && n.kind === "webhook" && !/^https:\/\//.test(n.url ?? "")) problems.push({ path: `settings.notifications[${i}].url`, message: "A webhook needs an https:// URL." });
  });
  if (doc.settings.access?.mode === "public") {
    doc.fields.forEach((f, i) => {
      if (f.type === "resident" || f.type === "site") problems.push({ path: `fields[${i}].type`, message: `A public form can't use a ${f.type} field — it would show roster data to anyone.` });
    });
    if (doc.settings.requireSite) problems.push({ path: "settings.requireSite", message: "A public form can't require a site." });
  }
  return problems;
}

/** A new, empty form document. */
export function emptyForm(title = "Untitled form"): FormDoc {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    title,
    description: "",
    fields: [],
    settings: {
      submitLabel: "Submit",
      access: { mode: "signed_in" },
      confirmation: { type: "message", message: "<p>Thanks — your response has been saved.</p>", showSummary: false },
      notifications: [],
      saveDrafts: true,
    },
  };
}

/** A starter field of a type, with sensible defaults, for the builder and the MCP add_field tool. */
export function newField(type: FieldType, taken: Iterable<string>, label?: string): Field {
  const info = typeInfo(type);
  const text = label ?? info?.label ?? "Field";
  const f: Field = { id: makeFieldId(text, taken), type, label: text };
  switch (type) {
    case "select":
    case "radio":
    case "checkbox":
    case "multiselect":
      f.choices = [{ label: "First choice", value: "first_choice" }, { label: "Second choice", value: "second_choice" }, { label: "Third choice", value: "third_choice" }];
      break;
    case "likert":
      f.choices = ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"].map((l) => ({ label: l, value: l.toLowerCase().replace(/\s+/g, "_") }));
      f.statements = [{ label: "First statement", value: "row_1" }, { label: "Second statement", value: "row_2" }];
      break;
    case "rating":
      f.max = 5;
      break;
    case "slider":
      f.min = 0;
      f.max = 10;
      f.step = 1;
      break;
    case "textarea":
      f.rows = 4;
      break;
    case "consent":
      f.consentText = "I agree.";
      break;
    case "file":
      f.maxFiles = 1;
      f.maxSizeMb = 10;
      break;
    case "name":
      f.nameParts = [...DEFAULT_NAME_PARTS];
      break;
    case "address":
      f.addressParts = [...DEFAULT_ADDRESS_PARTS];
      break;
    case "repeater":
      f.fields = [{ id: "item", type: "text", label: "Item" }, { id: "quantity", type: "number", label: "Quantity", min: 0 }];
      f.addLabel = "Add row";
      break;
    case "calculation":
      f.expression = "0";
      f.decimals = 2;
      break;
    case "html":
      f.label = "Content";
      f.content = "<p>Write something here.</p>";
      break;
    case "section":
      f.label = label ?? "New section";
      break;
    case "page":
      f.label = label ?? "Next page";
      break;
    case "resident":
      f.logActivity = true;
      break;
    case "code":
      f.code = {
        html: `<label>Type something <input id="box"></label>`,
        css: "body { font-family: system-ui; margin: 0; }",
        js: "const box = document.getElementById('box');\nbox.value = lcs.value ?? '';\nbox.addEventListener('input', () => lcs.setValue(box.value));\nlcs.resize();",
        height: 80,
      };
      break;
  }
  return f;
}
