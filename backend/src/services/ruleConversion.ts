import { createHash } from "node:crypto";
import type { BuiltForm } from "@prisma/client";
import { prisma } from "../prisma.js";
import { badRequest } from "../http.js";
import type { Conditional, FormDoc, Notification } from "../forms/engine.js";
import { ENTRY_CREATED, type Recipient } from "../forms/routingSchema.js";
import { readDoc, saveDraft } from "../forms/service.js";
import { loadRouting, newRouteId, saveRouting } from "./routing.js";
import { audit, type Actor } from "./audit.js";

/**
 * One place for a form's notifications: a builder form's own email and
 * in-app rules (Settings → Notifications, saved in the form) become routes of
 * its notification routing, keeping who's told, when, the subject, What to do
 * and the chosen answers. Webhooks stay in the form.
 *
 * What each converted rule was is kept (FormRecord "routing"/"converted-rules"):
 * forms/entries.ts skips exactly those rules from then on, so a published
 * version that still has them doesn't tell people twice, while a new rule
 * that happens to get the same id still runs. They're also taken out of the draft.
 */

const COLLECTION = "routing";
const CONVERTED = "converted-rules";

/** One rule exactly as it was: its id and everything in it. */
export const ruleSignature = (n: Notification) => `${n.id}:${createHash("sha256").update(JSON.stringify(n)).digest("hex").slice(0, 16)}`;

async function loadConverted(formId: string): Promise<{ ids: string[]; sigs: string[] }> {
  const row = await prisma.formRecord.findUnique({ where: { formId_collection_docId: { formId, collection: COLLECTION, docId: CONVERTED } } });
  try {
    const d = row ? (JSON.parse(row.data) as { ids?: string[]; sigs?: string[] }) : {};
    return { ids: d.ids ?? [], sigs: d.sigs ?? [] };
  } catch {
    return { ids: [], sigs: [] };
  }
}

/** Whether forms/entries.ts should skip a rule: it's one that was moved into routing. */
export async function movedRuleCheck(formId: string): Promise<(n: Notification) => boolean> {
  const { sigs } = await loadConverted(formId);
  const set = new Set(sigs);
  return (n) => n.kind !== "webhook" && set.has(ruleSignature(n));
}

/** The form's email and in-app rules not converted yet (from the live version, else the draft). */
export async function rulesToConvert(form: BuiltForm): Promise<Notification[]> {
  if (form.kind !== "basic") return [];
  const done = new Set((await loadConverted(form.id)).sigs);
  const doc = readDoc(form.liveSchema ?? form.draftSchema);
  const draft = readDoc(form.draftSchema);
  const all = [...(doc.settings.notifications ?? []), ...(draft.settings.notifications ?? [])];
  const seen = new Set<string>();
  return all.filter((n) => n.kind !== "webhook" && !done.has(ruleSignature(n)) && !seen.has(n.id) && seen.add(n.id));
}

const TAGS: Record<string, string> = { "{form:title}": "{form}", "{site:name}": "{site}", "{date:today}": "{date}" };
const NEGATE: Record<string, string> = { is: "is_not", is_not: "is", contains: "not_contains", not_contains: "contains", gt: "lte", lt: "gte", gte: "lt", lte: "gt", empty: "not_empty", not_empty: "empty" };

/** A rule's "only when" as a route's: a "hide when" becomes its opposite. Null when it can't be said that way. */
function whenOf(c: Conditional | undefined): { ok: true; when?: { match: "all" | "any"; rules: { field: string; op: string; value?: string | number | boolean }[] } } | { ok: false } {
  if (!c || !c.rules?.length) return { ok: true };
  if (c.action !== "hide") return { ok: true, when: { match: c.match, rules: c.rules.map((r) => ({ field: r.field, op: r.op, ...(r.value !== undefined ? { value: r.value as string } : {}) })) } };
  if (c.rules.some((r) => !NEGATE[r.op])) return { ok: false };
  // Not (a and b) = not a or not b, and the other way round.
  return { ok: true, when: { match: c.match === "all" ? "any" : "all", rules: c.rules.map((r) => ({ field: r.field, op: NEGATE[r.op], ...(r.value !== undefined ? { value: r.value as string } : {}) })) } };
}

/** The routes a form's rules become, and what couldn't come across. Nothing is saved. */
export function rulesToRoutes(doc: FormDoc, rules: Notification[], taken: string[]) {
  const emailFields = new Set(doc.fields.filter((f) => f.type === "email").map((f) => f.id));
  const routes: Record<string, unknown>[] = [];
  const converted: Notification[] = [];
  const notes: string[] = [];
  for (const n of rules) {
    const where = `“${n.name}”`;
    const when = whenOf(n.conditional);
    if (!when.ok) {
      notes.push(`${where} left as it is: its “don't send when” rule can't be turned into a route's “only when”. Move it by hand.`);
      continue;
    }
    const to: Recipient[] = [];
    for (const raw of (n.to ?? "").split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean)) {
      if (raw === "{user:email}") to.push({ kind: "submitter" });
      else if (/^\{[a-z][a-z0-9_]*\}$/.test(raw) && emailFields.has(raw.slice(1, -1))) to.push({ kind: "field", field: raw.slice(1, -1) });
      else if (/^[^\s@{}]+@[^\s@{}]+\.[^\s@{}]+$/.test(raw)) to.push({ kind: "person", email: raw.toLowerCase() });
      else notes.push(`${where}: “${raw}” in To isn't an address or an email field, so it's left out.`);
    }
    if (n.kind === "notify") {
      for (const role of n.roles ?? []) to.push({ kind: "role", role, ...(n.siteOnly ? {} : { siteOnly: false }) });
      for (const group of n.groups ?? []) to.push({ kind: "group", group, ...(n.siteOnly ? { siteOnly: true } : {}) });
      for (const title of n.titles ?? []) to.push({ kind: "title", title, ...(n.siteOnly ? { siteOnly: true } : {}) });
    }
    if (!to.length) {
      notes.push(`${where} left as it is: it tells nobody.`);
      continue;
    }
    let subject = n.subject?.trim() || undefined;
    if (subject) {
      for (const [from, toTag] of Object.entries(TAGS)) subject = subject.split(from).join(toTag);
      if (/\{[^}]+\}/.test(subject.replace(/\{(form|site|title|date)\}/g, ""))) {
        notes.push(`${where}: its subject's other merge tags ({user:name}…) don't work in routing and were taken out.`);
        subject = subject.replace(/\{(?!form\}|site\}|title\}|date\})[^}]+\}/g, "").replace(/\s{2,}/g, " ").trim() || undefined;
      }
    }
    let whatToDo = n.whatToDo?.trim() || undefined;
    if (n.kind === "notify" && n.body?.trim()) {
      if (!whatToDo && !/\{[^}]+\}/.test(n.body)) whatToDo = n.body.trim().slice(0, 500);
      else notes.push(`${where}: its in-app message isn't carried over (routes tell people the title and What to do).`);
    }
    if (n.kind === "notify" && n.link?.trim()) notes.push(`${where}: its own “Opens” link isn't carried over; the route opens the entry.`);
    const id = newRouteId(taken, n.name || "rule");
    taken.push(id);
    routes.push({
      id,
      name: (n.name || "Notification").slice(0, 120),
      event: ENTRY_CREATED,
      enabled: n.enabled !== false,
      ...(when.when ? { when: when.when } : {}),
      to,
      // An email rule emailed everyone on it; an in-app rule followed each person's own settings.
      email: n.kind === "email" ? "always" : "prefs",
      ...(subject ? { subject } : {}),
      ...(whatToDo ? { whatToDo } : {}),
      ...(n.fields?.length ? { fields: n.fields } : {}),
      ...(n.urgent ? { urgent: true } : {}),
    });
    converted.push(n);
  }
  return { routes, converted, notes };
}

/** Turn the form's rules into routes (dryRun: only say what would happen). */
export async function convertRules(form: BuiltForm, actor: Actor, opts: { dryRun?: boolean } = {}) {
  if (form.kind !== "basic") throw badRequest("Only forms made in Form builder have notification rules to move.");
  const rules = await rulesToConvert(form);
  const now = await loadRouting(form);
  const { routes, converted: moved, notes } = rulesToRoutes(readDoc(form.liveSchema ?? form.draftSchema), rules, now.routes.map((r) => r.id));
  if (opts.dryRun || !moved.length) return { converted: 0, routes, notes, dryRun: Boolean(opts.dryRun) };

  // Routes first (they're checked like any route), then the rules stop running, then they leave the draft.
  await saveRouting(form, [...now.routes, ...routes], actor, now.revision);
  // The same rule may sit in the live version and the draft, changed in one of them: both are moved.
  const ids = new Set(moved.map((n) => n.id));
  const draft = readDoc(form.draftSchema);
  const draftRules = (draft.settings.notifications ?? []).filter((n) => ids.has(n.id));
  const before = await loadConverted(form.id);
  const data = JSON.stringify({
    ids: [...new Set([...before.ids, ...ids])],
    sigs: [...new Set([...before.sigs, ...moved.map(ruleSignature), ...draftRules.map(ruleSignature)])],
  });
  await prisma.formRecord.upsert({
    where: { formId_collection_docId: { formId: form.id, collection: COLLECTION, docId: CONVERTED } },
    create: { formId: form.id, collection: COLLECTION, docId: CONVERTED, data, updatedByName: actor.name },
    update: { data, updatedByName: actor.name },
  });
  const keep = (draft.settings.notifications ?? []).filter((n) => !ids.has(n.id));
  if (keep.length !== (draft.settings.notifications ?? []).length) {
    await saveDraft(form.id, { doc: { ...draft, settings: { ...draft.settings, notifications: keep } }, revision: form.revision }, actor);
  }
  await audit({ actor, action: "forms.rules_converted", summary: `Moved ${moved.length} notification rule${moved.length === 1 ? "" : "s"} of “${form.title}” into its routing` }).catch(() => undefined);
  return { converted: moved.length, routes, notes, dryRun: false };
}
