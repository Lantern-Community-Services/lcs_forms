import {
  FORMAT, FORMAT_VERSION, emptyForm, makeFieldId, parseExpression,
  type Choice, type Conditional, type Field, type FormDoc, type Notification, type Rule, type RuleOp,
} from "./engine.js";

/**
 * Gravity Forms → lcs-form.
 *
 * Reads what Forms → Import/Export → Export Forms produces (an object keyed
 * "0", "1", … plus "version", or an array), or a single form object as the
 * GF REST API / MCP tools return it. Field ids become readable keys from the
 * labels, and every reference to a GF field number — conditional logic, merge
 * tags in HTML, confirmations and notifications, calculation formulas — is
 * rewritten to the new key. Anything with no equivalent (pricing, post
 * fields, captcha) is left out with a warning, never silently.
 */

type GfObj = Record<string, any>;

export function looksLikeGravityForms(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const forms = gfFormsOf(payload);
  return forms.length > 0 && forms.every((f) => Array.isArray(f.fields) && ("title" in f) && (f.fields.length === 0 || typeof f.fields[0]?.type === "string") && !("format" in f));
}

function gfFormsOf(payload: unknown): GfObj[] {
  if (Array.isArray(payload)) return payload.filter((f) => f && typeof f === "object" && Array.isArray(f.fields));
  const o = payload as GfObj;
  if (Array.isArray(o.fields) && typeof o.title === "string") return [o];
  return Object.entries(o)
    .filter(([k, v]) => /^\d+$/.test(k) && v && typeof v === "object" && Array.isArray((v as GfObj).fields))
    .map(([, v]) => v as GfObj);
}

const NAME_INPUTS: Record<string, NonNullable<Field["nameParts"]>[number]> = { "2": "prefix", "3": "first", "4": "middle", "6": "last", "8": "suffix" };
const ADDRESS_INPUTS: Record<string, NonNullable<Field["addressParts"]>[number]> = { "1": "line1", "2": "line2", "3": "city", "4": "state", "5": "zip", "6": "country" };

const OPS: Record<string, RuleOp> = {
  is: "is", isnot: "is_not", ">": "gt", "<": "lt", contains: "contains", starts_with: "starts_with", ends_with: "ends_with",
  greater_than: "gt", less_than: "lt",
};

const SKIPPED = new Set([
  "captcha", "password", "creditcard", "product", "option", "shipping", "total", "singleproduct", "calculation_product",
  "post_title", "post_content", "post_excerpt", "post_tags", "post_category", "post_image", "post_custom_field", "username",
  "submit", "donation", "stripe_creditcard", "paypal", "square_creditcard",
]);

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const plain = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();

interface Ctx {
  warnings: string[];
  formTitle: string;
  /** GF field number → our field (id + type), for rewriting references. */
  ids: Map<string, { id: string; type: string }>;
}

function uniqueChoices(raw: GfObj[] | undefined): Choice[] {
  const seen = new Set<string>();
  const out: Choice[] = [];
  for (const c of raw ?? []) {
    const label = clip(str(c.text), 500);
    let value = clip(str(c.value !== undefined && c.value !== "" ? c.value : c.text), 500);
    if (!label && !value) continue;
    let n = 2;
    const base = value;
    while (seen.has(value)) value = `${base}_${n++}`;
    seen.add(value);
    out.push({ label: label || value, value });
  }
  return out;
}

/** {Label:3} {Label:3.6} {:3} → {id} / {id.part}; GF system tags → ours. */
function rewriteTags(text: string, ctx: Ctx): string {
  if (!text) return text;
  return text
    .replace(/\{[^{}]*?:(\d+)(?:\.(\d+))?(?::[^{}]*)?\}/g, (whole, num: string, sub?: string) => {
      const f = ctx.ids.get(num);
      if (!f) return whole;
      if (sub && f.type === "name" && NAME_INPUTS[sub]) return `{${f.id}.${NAME_INPUTS[sub]}}`;
      if (sub && f.type === "address" && ADDRESS_INPUTS[sub]) return `{${f.id}.${ADDRESS_INPUTS[sub]}}`;
      return `{${f.id}}`;
    })
    .replace(/\{form_title\}/g, "{form:title}")
    .replace(/\{entry_id\}/g, "{entry:id}")
    .replace(/\{entry_url\}/g, "{entry:url}")
    .replace(/\{date_(mdy|dmy)\}/g, "{date:today}")
    .replace(/\{user:(display_name|user_login|first_name)\}/g, "{user:name}")
    .replace(/\{user:user_email\}/g, "{user:email}")
    .replace(/\{all_fields(:[^}]*)?\}/g, "{all_fields}");
}

function convertRules(logic: GfObj | null | undefined, ctx: Ctx, where: string): Conditional | undefined {
  if (!logic || !Array.isArray(logic.rules) || logic.rules.length === 0) return undefined;
  const rules: Rule[] = [];
  for (const r of logic.rules as GfObj[]) {
    const [num, sub] = str(r.fieldId).split(".");
    const f = ctx.ids.get(num);
    const op = OPS[str(r.operator)];
    if (!f || !op) {
      ctx.warnings.push(`${ctx.formTitle}: dropped a rule on ${where} (it read GF field ${r.fieldId}${op ? "" : ` with operator "${r.operator}"`}, which wasn't imported).`);
      continue;
    }
    let field = f.id;
    if (sub && f.type === "name" && NAME_INPUTS[sub]) field = `${f.id}.${NAME_INPUTS[sub]}`;
    else if (sub && f.type === "address" && ADDRESS_INPUTS[sub]) field = `${f.id}.${ADDRESS_INPUTS[sub]}`;
    const value = str(r.value);
    rules.push(value === "" && (op === "is" || op === "is_not") ? { field, op: op === "is" ? "empty" : "not_empty" } : { field, op, value: clip(value, 500) });
  }
  if (!rules.length) return undefined;
  return { action: logic.actionType === "hide" ? "hide" : "show", match: logic.logicType === "any" ? "any" : "all", rules };
}

/** GF's "survey"/"quiz"/"poll" fields wear an inputType. */
function effectiveType(g: GfObj): string {
  // GF 2.9's choice fields, and Lantern's own add-on fields (the "basic info" plugin).
  if (g.type === "multi_choice" || g.type === "image_choice") return g.inputType === "checkbox" ? "checkbox" : "radio";
  if (g.type === "basic_info_site_location") return "lcs_site";
  if (g.type === "basic_info_tenant_client_name") return "lcs_tenant";
  if (g.type === "basic_info_room_number") return "lcs_room";
  if (["survey", "quiz", "poll"].includes(g.type)) {
    if (g.inputType === "likert") return "likert";
    if (g.inputType === "rating") return "rating";
    if (g.inputType === "rank") return "rank";
    return g.inputType || "radio";
  }
  if (g.type === "number" && g.enableCalculation) return "calculation";
  return g.type;
}

function widthOf(g: GfObj): Field["width"] {
  const span = Number(g.layoutGridColumnSpan);
  if (span && span <= 4) return "third";
  if (span && span <= 6) return "half";
  if (g.size === "small") return "third";
  return undefined;
}

function convertField(raw: GfObj, taken: Set<string>, ctx: Ctx, pageLabel?: string): Field | null {
  // The GF API sends "" rather than null for empty choices, inputs and logic.
  const g: GfObj = {
    ...raw,
    choices: Array.isArray(raw.choices) ? raw.choices : undefined,
    inputs: Array.isArray(raw.inputs) ? raw.inputs : undefined,
    conditionalLogic: raw.conditionalLogic && typeof raw.conditionalLogic === "object" ? raw.conditionalLogic : undefined,
  };
  const type = effectiveType(g);
  const label = clip(plain(str(g.label)) || plain(str(g.adminLabel)) || "", 500);
  if (SKIPPED.has(type) || SKIPPED.has(g.type)) {
    ctx.warnings.push(`${ctx.formTitle}: left out "${label || g.type}" (${g.type} fields have no equivalent here).`);
    return null;
  }
  const id = makeFieldId(g.inputName && /^[a-z]/i.test(g.inputName) ? g.inputName : label || type, taken);
  const f: Field = { id, type: "text", label };
  if (g.description) f.description = clip(str(g.description), 5000);
  if (g.placeholder) f.placeholder = clip(str(g.placeholder), 300);
  if (g.isRequired) f.required = true;
  if (g.cssClass) f.cssClass = clip(str(g.cssClass), 200);
  if (g.visibility === "administrative" || g.visibility === "hidden") f.adminOnly = true;
  const w = widthOf(g);
  if (w) f.width = w;
  const maxLength = Number(g.maxLength);
  if (maxLength > 0) f.maxLength = maxLength;
  const selected = (g.choices as GfObj[] | undefined)?.filter((c) => c.isSelected);

  switch (type) {
    case "text":
      f.type = "text";
      if (g.defaultValue) f.defaultValue = str(g.defaultValue);
      break;
    case "textarea":
      f.type = "textarea";
      if (g.defaultValue) f.defaultValue = str(g.defaultValue);
      break;
    case "email": f.type = "email"; break;
    case "phone": f.type = "phone"; break;
    case "website": f.type = "url"; break;
    case "date": f.type = "date"; break;
    case "time": f.type = "time"; break;
    case "hidden":
      f.type = "hidden";
      if (g.defaultValue) f.defaultValue = str(g.defaultValue);
      break;
    case "number": {
      f.type = "number";
      const lo = Number(g.rangeMin), hi = Number(g.rangeMax);
      if (g.rangeMin !== "" && g.rangeMin !== undefined && Number.isFinite(lo)) f.min = lo;
      if (g.rangeMax !== "" && g.rangeMax !== undefined && Number.isFinite(hi)) f.max = hi;
      if (g.numberFormat === "currency") f.prefix = "$";
      if (g.defaultValue !== undefined && g.defaultValue !== "" && Number.isFinite(Number(g.defaultValue))) f.defaultValue = Number(g.defaultValue);
      break;
    }
    case "calculation":
      f.type = "calculation";
      f.expression = str(g.calculationFormula) || "0";
      f.decimals = g.calculationRounding === "norounding" || g.calculationRounding === undefined || g.calculationRounding === "" ? 2 : Number(g.calculationRounding);
      if (g.numberFormat === "currency") f.display = "currency";
      break;
    case "select":
    case "multiselect":
    case "radio":
    case "checkbox": {
      f.type = type as Field["type"];
      f.choices = uniqueChoices(g.choices);
      if (g.enableOtherChoice && (type === "radio" || type === "checkbox")) f.allowOther = true;
      if (selected?.length) f.defaultValue = type === "checkbox" || type === "multiselect" ? selected.map((c) => str(c.value || c.text)) : str(selected[0].value || selected[0].text);
      if (!f.choices.length) {
        ctx.warnings.push(`${ctx.formTitle}: "${label}" had no choices (probably filled in by a WordPress plugin), so it came in as a text box.`);
        f.type = "text";
        delete f.choices;
        delete f.allowOther;
        delete f.defaultValue;
      }
      break;
    }
    case "rank":
      f.type = "checkbox";
      f.choices = uniqueChoices(g.choices);
      ctx.warnings.push(`${ctx.formTitle}: "${label}" was a ranking question; it came in as checkboxes.`);
      break;
    case "likert": {
      f.type = "likert";
      f.choices = uniqueChoices(g.choices);
      const rows = g.gsurveyLikertEnableMultipleRows && Array.isArray(g.gsurveyLikertRows) ? g.gsurveyLikertRows : [{ text: label || "Rating", value: "row_1" }];
      f.statements = uniqueChoices(rows);
      break;
    }
    case "rating":
      f.type = "rating";
      f.max = Math.min(10, Math.max(3, (g.choices as unknown[] | undefined)?.length ?? 5));
      break;
    case "consent":
      f.type = "consent";
      f.consentText = clip(plain(str(g.checkboxLabel)) || "I agree.", 5000);
      break;
    case "name": {
      f.type = "name";
      const parts = ((g.inputs as GfObj[] | undefined) ?? [])
        .filter((i) => !i.isHidden)
        .map((i) => NAME_INPUTS[str(i.id).split(".")[1]])
        .filter(Boolean);
      f.nameParts = parts.length ? [...new Set(parts)] : ["first", "last"];
      break;
    }
    case "address": {
      f.type = "address";
      const parts = ((g.inputs as GfObj[] | undefined) ?? [])
        .filter((i) => !i.isHidden)
        .map((i) => ADDRESS_INPUTS[str(i.id).split(".")[1]])
        .filter(Boolean);
      f.addressParts = parts.length ? [...new Set(parts)] : ["line1", "line2", "city", "state", "zip"];
      break;
    }
    case "fileupload": {
      f.type = "file";
      const ext = str(g.allowedExtensions).split(/[,\s]+/).filter(Boolean);
      if (ext.length) f.accept = ext.map((e) => `.${e.replace(/^\./, "")}`).join(",");
      f.maxFiles = g.multipleFiles ? Math.min(20, Number(g.maxFiles) || 5) : 1;
      const mb = Number(g.maxFileSize);
      f.maxSizeMb = mb > 0 ? Math.min(10, mb) : 10;
      if (mb > 10) ctx.warnings.push(`${ctx.formTitle}: "${label}" allowed ${mb} MB files; the limit here is 10 MB.`);
      break;
    }
    case "signature": f.type = "signature"; break;
    case "list": {
      f.type = "repeater";
      const cols: GfObj[] = g.enableColumns && Array.isArray(g.choices) ? g.choices : [];
      const subTaken = new Set<string>();
      f.fields = cols.length
        ? cols.map((c) => ({ id: makeFieldId(str(c.text) || "column", subTaken), type: "text" as const, label: clip(str(c.text), 500) }))
        : [{ id: "item", type: "text", label: label || "Item" }];
      const max = Number(g.maxRows);
      if (max > 0) f.maxRows = max;
      f.addLabel = "Add row";
      break;
    }
    case "lcs_site":
      f.type = "site";
      break;
    case "lcs_tenant":
      f.type = "resident";
      if (g.includeOther) ctx.warnings.push(`${ctx.formTitle}: "${label}" let staff type a name not on the roster ("Other"); the Resident field only picks from the roster.`);
      break;
    case "lcs_room":
      f.type = "text";
      ctx.warnings.push(`${ctx.formTitle}: "${label}" was the room-number lookup; it's a text box now. The Resident field already records the room, so you may not need it.`);
      break;
    case "html":
      f.type = "html";
      f.content = str(g.content);
      break;
    case "section":
      f.type = "section";
      break;
    case "page":
      f.type = "page";
      f.label = pageLabel || label || "Next page";
      if (g.nextButton?.text) f.nextLabel = clip(str(g.nextButton.text), 60);
      break;
    default:
      ctx.warnings.push(`${ctx.formTitle}: "${label || type}" was a ${g.type} field, which has no equivalent; it came in as a text box.`);
      f.type = "text";
  }
  if (!f.label && f.type !== "html") f.label = type === "page" ? "Next page" : "Untitled";
  return f;
}

function scheduleIso(date: unknown, hour: unknown, minute: unknown, ampm: unknown): string | undefined {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(str(date));
  if (!m) return undefined;
  let h = Number(hour) || 0;
  if (str(ampm).toLowerCase() === "pm" && h < 12) h += 12;
  if (str(ampm).toLowerCase() === "am" && h === 12) h = 0;
  // Treated as New York time, which is where Lantern's WordPress site runs.
  const local = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(Number(minute) || 0).padStart(2, "0")}:00`;
  const probe = new Date(`${local}Z`);
  const ny = new Date(probe.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const utc = new Date(probe.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(probe.getTime() + (utc.getTime() - ny.getTime())).toISOString();
}

function convertForm(gf: GfObj, warnings: string[]): FormDoc {
  const doc = emptyForm(clip(plain(str(gf.title)) || "Imported form", 200));
  const ctx: Ctx = { warnings, formTitle: doc.title, ids: new Map() };
  doc.description = str(gf.description);
  const taken = new Set<string>();
  const gfFields: GfObj[] = gf.fields ?? [];
  const pageNames: string[] = Array.isArray(gf.pagination?.pages) ? gf.pagination.pages : [];
  let pageIndex = 0;

  // Pass 1: create fields and learn the id mapping.
  const pairs: [GfObj, Field][] = [];
  for (const g of gfFields) {
    if (g.type === "page") pageIndex++;
    const f = convertField(g, taken, ctx, g.type === "page" ? str(pageNames[pageIndex]) : undefined);
    if (!f) continue;
    taken.add(f.id);
    ctx.ids.set(str(g.id), { id: f.id, type: f.type });
    pairs.push([g, f]);
  }
  // Pass 2: everything that refers to other fields.
  for (const [g, f] of pairs) {
    f.conditional = convertRules(g.conditionalLogic, ctx, `"${f.label}"`);
    if (!f.conditional) delete f.conditional;
    if (typeof f.defaultValue === "string") f.defaultValue = rewriteTags(f.defaultValue, ctx);
    if (f.content) f.content = rewriteTags(f.content, ctx);
    if (f.type === "calculation" && f.expression) {
      f.expression = rewriteTags(f.expression, ctx);
      try {
        parseExpression(f.expression);
      } catch {
        warnings.push(`${ctx.formTitle}: the formula for "${f.label}" (${f.expression}) couldn't be read; set it again in the builder.`);
        f.expression = "0";
      }
    }
  }
  doc.fields = pairs.map(([, f]) => f);
  // Residents list the roster of the form's site field (or ask for a site if there isn't one).
  const siteField = doc.fields.find((f) => f.type === "site");
  for (const f of doc.fields) {
    if (f.type !== "resident" || f.siteField) continue;
    if (siteField) f.siteField = siteField.id;
    else doc.settings.requireSite = true;
  }
  const scripted = doc.fields.filter((f) => f.type === "html" && /<script/i.test(f.content ?? ""));
  for (const f of scripted) {
    warnings.push(`${ctx.formTitle}: the content block "${f.label || f.id}" contains a <script>, which doesn't run here${doc.fields.some((x) => x.type === "hidden") ? " (it probably filled the hidden fields)" : ""}. Rebuild it as a Custom code field (sandboxed, can set its own value) or with regular fields.`);
  }
  if (gf.pagination?.pages?.[0] && doc.fields.some((f) => f.type === "page")) doc.settings.progressBar = gf.pagination.type !== "none";

  if (gf.button?.text) doc.settings.submitLabel = clip(str(gf.button.text), 60);

  // Confirmation: the default one (GF can hold several, routed by rules).
  const confirmations = Object.values((gf.confirmations ?? {}) as Record<string, GfObj>);
  const conf = confirmations.find((c) => c.isDefault) ?? confirmations[0];
  if (conf) {
    if (conf.type === "redirect" && conf.url) doc.settings.confirmation = { type: "redirect", url: str(conf.url) };
    else {
      doc.settings.confirmation = { type: "message", message: rewriteTags(str(conf.message) || "<p>Thanks — your response has been saved.</p>", ctx) };
      if (conf.type === "page") warnings.push(`${ctx.formTitle}: the confirmation sent people to a WordPress page; it's a thank-you message here instead.`);
    }
    if (confirmations.length > 1) warnings.push(`${ctx.formTitle}: only the default confirmation was brought over (${confirmations.length} existed).`);
  }

  // Notifications become email notifications.
  const notes: Notification[] = [];
  for (const [key, n] of Object.entries((gf.notifications ?? {}) as Record<string, GfObj>)) {
    let to = "";
    if (n.toType === "field" && ctx.ids.get(str(n.to))) to = `{${ctx.ids.get(str(n.to))!.id}}`;
    else if (n.toType === "routing" && Array.isArray(n.routing) && n.routing.length) {
      // Routing rows ("send to X when field Y is Z") become one notification per
      // recipient, sent when any of that recipient's rows match.
      const byAddress = new Map<string, GfObj[]>();
      for (const r of n.routing as GfObj[]) {
        const address = rewriteTags(str(r.email), ctx).trim();
        if (address) byAddress.set(address, [...(byAddress.get(address) ?? []), r]);
      }
      let i = 0;
      for (const [address, rows] of byAddress) {
        const rule = convertRules({ actionType: "show", logicType: "any", rules: rows.map((r) => ({ fieldId: r.fieldId, operator: r.operator, value: r.value })) }, ctx, `notification "${n.name}" routing`);
        notes.push({
          id: clip(`${key.replace(/[^a-z0-9_]/gi, "") || "n"}_r${++i}`, 64),
          name: clip(`${str(n.name) || "Notification"} → ${address}`, 120),
          enabled: n.isActive !== false && Boolean(rule),
          kind: "email",
          to: address,
          subject: rewriteTags(str(n.subject) || "New entry: {form:title}", ctx),
          body: rewriteTags(str(n.message) || "{all_fields}", ctx),
          ...(rule ? { conditional: rule } : {}),
        });
      }
      continue;
    } else if (n.toType === "routing") {
      warnings.push(`${ctx.formTitle}: notification "${n.name}" used routing with no rules; set its To address in Settings.`);
      to = "";
    } else to = rewriteTags(str(n.to), ctx);
    if (to.includes("{admin_email}")) {
      warnings.push(`${ctx.formTitle}: notification "${n.name}" went to the WordPress admin email; set its To address in Settings.`);
      to = to.replace(/\{admin_email\}/g, "").replace(/^[,\s]+|[,\s]+$/g, "");
    }
    const enabled = n.isActive !== false && Boolean(to);
    notes.push({
      id: clip(key.replace(/[^a-z0-9_]/gi, "") || `n${notes.length + 1}`, 64),
      name: clip(str(n.name) || "Notification", 120),
      enabled,
      kind: "email",
      to,
      subject: rewriteTags(str(n.subject) || "New entry: {form:title}", ctx),
      body: rewriteTags(str(n.message) || "{all_fields}", ctx),
      conditional: convertRules(n.conditionalLogic, ctx, `notification "${n.name}"`),
    });
    if (!notes[notes.length - 1].conditional) delete notes[notes.length - 1].conditional;
  }
  doc.settings.notifications = notes;

  if (gf.limitEntries && Number(gf.limitEntriesCount) > 0) {
    if (gf.limitEntriesPeriod) warnings.push(`${ctx.formTitle}: the entry limit was per ${gf.limitEntriesPeriod} on WordPress; here it's a total.`);
    doc.settings.limits = { ...doc.settings.limits, maxEntries: Number(gf.limitEntriesCount), closedMessage: plain(str(gf.limitEntriesMessage)) || undefined };
  }
  if (gf.scheduleForm) {
    const opensAt = scheduleIso(gf.scheduleStart, gf.scheduleStartHour, gf.scheduleStartMinute, gf.scheduleStartAmpm);
    const closesAt = scheduleIso(gf.scheduleEnd, gf.scheduleEndHour, gf.scheduleEndMinute, gf.scheduleEndAmpm);
    doc.settings.limits = { ...doc.settings.limits, ...(opensAt ? { opensAt } : {}), ...(closesAt ? { closesAt } : {}), closedMessage: plain(str(gf.scheduleMessage)) || doc.settings.limits?.closedMessage };
  }
  if (doc.settings.limits && !doc.settings.limits.closedMessage) delete doc.settings.limits.closedMessage;
  if (!gf.requireLogin) warnings.push(`${ctx.formTitle}: this form didn't need a login on WordPress. It's set to signed-in staff here; switch Access to Public in Settings if outsiders fill it in.`);

  if (str(gf.cssClass)) warnings.push(`${ctx.formTitle}: the form's CSS class "${gf.cssClass}" wasn't carried over; add styles under Settings → Custom CSS.`);
  return { ...doc, format: FORMAT, version: FORMAT_VERSION };
}

export function convertGravityForms(payload: unknown): { forms: FormDoc[]; warnings: string[] } {
  const warnings: string[] = [];
  const forms = gfFormsOf(payload).map((gf) => convertForm(gf, warnings));
  return { forms, warnings };
}
