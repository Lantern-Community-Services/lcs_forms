import { z } from "zod";
import { FIELD_ID_RE, FIELD_TYPE_KEYS, FORMAT, FORMAT_VERSION, lintForm, type FormDoc } from "./engine.js";

/**
 * The lcs-form document, as a zod schema. Strict on purpose: an unknown key is
 * almost always a typo ("requried", "option" for "choices"), and saying so at
 * save time beats a field that silently ignores it. The code editor, imports,
 * the CLI and the MCP server all go through parseFormDoc().
 */

const choice = z.object({
  label: z.string().max(500),
  value: z.string().max(500),
}).strict();

const rule = z.object({
  field: z.string().min(1).max(130),
  op: z.enum(["is", "is_not", "gt", "lt", "gte", "lte", "contains", "not_contains", "starts_with", "ends_with", "empty", "not_empty"]),
  value: z.union([z.string().max(500), z.number(), z.boolean()]).optional(),
}).strict();

const conditional = z.object({
  action: z.enum(["show", "hide"]).default("show"),
  match: z.enum(["all", "any"]).default("all"),
  rules: z.array(rule).max(200),
}).strict();

const codeBlock = z.object({
  html: z.string().max(100_000).optional(),
  css: z.string().max(100_000).optional(),
  js: z.string().max(200_000).optional(),
  height: z.number().int().min(20).max(4000).optional(),
}).strict();

const fieldId = z.string().regex(FIELD_ID_RE, "Ids start with a lowercase letter and use only a-z, 0-9 and _ (max 64).");

const baseField = z.object({
  id: fieldId,
  type: z.enum(FIELD_TYPE_KEYS as [string, ...string[]]),
  label: z.string().max(500),
  description: z.string().max(5000).optional(),
  placeholder: z.string().max(300).optional(),
  required: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  width: z.enum(["full", "half", "third"]).optional(),
  adminOnly: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  conditional: conditional.optional(),
  cssClass: z.string().max(200).optional(),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(1).optional(),
  pattern: z.string().max(500).optional(),
  patternMessage: z.string().max(300).optional(),
  rows: z.number().int().min(1).max(40).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  prefix: z.string().max(20).optional(),
  suffix: z.string().max(20).optional(),
  minDate: z.string().max(20).optional(),
  maxDate: z.string().max(20).optional(),
  choices: z.array(choice).max(2000).optional(),
  allowOther: z.boolean().optional(),
  columns: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  maxSelections: z.number().int().min(1).optional(),
  statements: z.array(choice).max(200).optional(),
  nameParts: z.array(z.enum(["prefix", "first", "middle", "last", "suffix"])).min(1).optional(),
  addressParts: z.array(z.enum(["line1", "line2", "city", "state", "zip", "country"])).min(1).optional(),
  accept: z.string().max(300).optional(),
  maxFiles: z.number().int().min(1).max(20).optional(),
  maxSizeMb: z.number().min(0.1).max(10).optional(),
  consentText: z.string().max(5000).optional(),
  minRows: z.number().int().min(0).optional(),
  maxRows: z.number().int().min(1).max(500).optional(),
  addLabel: z.string().max(60).optional(),
  expression: z.string().max(5000).optional(),
  decimals: z.number().int().min(0).max(10).optional(),
  display: z.enum(["number", "currency", "percent"]).optional(),
  siteField: z.string().max(64).optional(),
  logActivity: z.boolean().optional(),
  content: z.string().max(200_000).optional(),
  nextLabel: z.string().max(60).optional(),
  code: codeBlock.optional(),
});

type FieldIn = z.infer<typeof baseField> & { fields?: FieldIn[] };

const field: z.ZodType<FieldIn> = baseField
  .extend({ fields: z.lazy(() => z.array(field).max(100)).optional() })
  .strict() as z.ZodType<FieldIn>;

const notification = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(120),
  enabled: z.boolean().default(true),
  kind: z.enum(["email", "webhook"]).default("email"),
  to: z.string().max(2000).optional(),
  subject: z.string().max(500).optional(),
  body: z.string().max(100_000).optional(),
  url: z.string().max(2000).optional(),
  secret: z.string().max(200).optional(),
  conditional: conditional.optional(),
}).strict();

const settings = z.object({
  submitLabel: z.string().max(60).optional(),
  access: z.object({
    mode: z.enum(["signed_in", "roles", "public"]).default("signed_in"),
    roles: z.array(z.string()).optional(),
  }).strict().optional(),
  entriesRoles: z.array(z.string()).optional(),
  requireSite: z.boolean().optional(),
  limits: z.object({
    maxEntries: z.number().int().min(1).optional(),
    perUser: z.object({ count: z.number().int().min(1), period: z.enum(["day", "week", "month", "ever"]) }).strict().optional(),
    opensAt: z.string().datetime({ offset: true }).optional().or(z.literal("")),
    closesAt: z.string().datetime({ offset: true }).optional().or(z.literal("")),
    closedMessage: z.string().max(2000).optional(),
  }).strict().optional(),
  confirmation: z.object({
    type: z.enum(["message", "redirect"]).default("message"),
    message: z.string().max(50_000).optional(),
    url: z.string().max(2000).optional(),
    showSummary: z.boolean().optional(),
  }).strict().optional(),
  notifications: z.array(notification).max(300).optional(),
  progressBar: z.boolean().optional(),
  saveDrafts: z.boolean().optional(),
  customCss: z.string().max(100_000).optional(),
  icon: z.string().max(40).optional(),
}).strict();

export const formDocSchema = z.object({
  $schema: z.string().optional(),
  format: z.literal(FORMAT).default(FORMAT),
  version: z.literal(FORMAT_VERSION).default(FORMAT_VERSION),
  title: z.string().trim().min(1, "Give the form a title.").max(200),
  description: z.string().max(10_000).optional(),
  fields: z.array(field).max(500),
  settings: settings.default({}),
}).strict();

export interface DocProblem {
  path: string;
  message: string;
}

function pathOf(p: (string | number)[]) {
  return p.reduce<string>((s, k) => (typeof k === "number" ? `${s}[${k}]` : s ? `${s}.${k}` : k), "");
}

/**
 * Parse and check a form document. `problems` covers both the shape (zod) and
 * the meaning (lintForm: duplicate ids, rules pointing nowhere, bad
 * expressions). A doc is only returned when there are no problems.
 */
export function parseFormDoc(input: unknown): { doc: FormDoc; problems: [] } | { doc: null; problems: DocProblem[] } {
  const raw = typeof input === "string" ? safeJson(input) : input;
  if (raw instanceof Error) return { doc: null, problems: [{ path: "", message: raw.message }] };
  const parsed = formDocSchema.safeParse(raw);
  if (!parsed.success) {
    return { doc: null, problems: parsed.error.issues.slice(0, 50).map((i) => ({ path: pathOf(i.path), message: i.message })) };
  }
  const { $schema: _ignored, ...doc } = parsed.data;
  const problems = lintForm(doc as FormDoc);
  if (problems.length) return { doc: null, problems };
  return { doc: doc as FormDoc, problems: [] };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    return new Error(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}
