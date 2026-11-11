import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "../prisma.js";
import { appBaseUrl } from "../env.js";
import { HttpError } from "../http.js";
import { loadApp, runAction } from "./runtime.js";
import { readManifest, type Files } from "./project.js";
import { importEntries, importedEntry, type ImportResult } from "./importEntries.js";

/**
 * Inbound hooks (form.json "inbound"): another system — the old Gravity Forms
 * site's Webhooks add-on, say — POSTs to /api/hooks/<token> whenever something
 * is filed there. The token names one form and one hook; the hook's server
 * action turns the posted body into entries for this form (or null to ignore
 * it), run as nobody (ctx.user null, args { hook, body }), and they're saved
 * the way import_code_entries saves them (apps/importEntries.ts): as given,
 * nobody notified, the same externalId never twice.
 *
 * Only a hash of each token is kept, in FormRecord's private "__inbound"
 * collection (one doc per hook name), with a few counts for the admin.
 */

const COLLECTION = "__inbound";

export interface InboundDoc {
  hash: string;
  createdAt: string;
  createdByName: string;
  lastAt?: string;
  received?: number;
  saved?: number;
  skipped?: number;
  lastResult?: string;
  lastError?: string | null;
  lastErrorAt?: string;
}

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
export const inboundUrl = (token: string) => `${appBaseUrl}/api/hooks/${token}`;

function publishedManifest(form: { liveSchema: string | null }) {
  if (!form.liveSchema) return null;
  try {
    return readManifest((JSON.parse(form.liveSchema) as { files: Files }).files).manifest ?? null;
  } catch {
    return null;
  }
}

/** A new address for one of the form's hooks; any old one for that hook stops working. The token is shown once. */
export async function createInboundToken(formId: string, name: string, byName: string): Promise<{ url: string }> {
  const token = randomBytes(24).toString("base64url");
  const doc: InboundDoc = { hash: hashOf(token), createdAt: new Date().toISOString(), createdByName: byName, received: 0, saved: 0, skipped: 0 };
  await prisma.formRecord.upsert({
    where: { formId_collection_docId: { formId, collection: COLLECTION, docId: name } },
    create: { formId, collection: COLLECTION, docId: name, data: JSON.stringify(doc), updatedByName: byName },
    update: { data: JSON.stringify(doc), updatedByName: byName },
  });
  return { url: inboundUrl(token) };
}

export async function revokeInboundToken(formId: string, name: string): Promise<boolean> {
  const r = await prisma.formRecord.deleteMany({ where: { formId, collection: COLLECTION, docId: name } });
  return r.count > 0;
}

/** Each hook the form declares, whether it has an address, and how it's been doing (never the token). */
export async function inboundStatus(form: { id: string; liveSchema: string | null; draftSchema?: string | null }) {
  const declared = publishedManifest(form)?.inbound ?? {};
  const docs = await prisma.formRecord.findMany({ where: { formId: form.id, collection: COLLECTION } });
  const byName = new Map(docs.map((d) => [d.docId, JSON.parse(d.data) as InboundDoc]));
  const names = [...new Set([...Object.keys(declared), ...byName.keys()])];
  return names.map((name) => {
    const d = byName.get(name);
    const { hash: _hash, ...rest } = d ?? ({} as InboundDoc);
    return { name, action: declared[name]?.action ?? null, published: Boolean(declared[name]), hasAddress: Boolean(d), ...rest };
  });
}

async function findHook(token: string) {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return null;
  const want = Buffer.from(hashOf(token), "hex");
  const docs = await prisma.formRecord.findMany({ where: { collection: COLLECTION } });
  for (const d of docs) {
    const doc = JSON.parse(d.data) as InboundDoc;
    const have = Buffer.from(doc.hash ?? "", "hex");
    if (have.length === want.length && timingSafeEqual(have, want)) return { record: d, doc };
  }
  return null;
}

async function note(recordId: string, change: (d: InboundDoc) => InboundDoc) {
  const r = await prisma.formRecord.findUnique({ where: { id: recordId } });
  if (!r) return;
  await prisma.formRecord.update({ where: { id: recordId }, data: { data: JSON.stringify(change(JSON.parse(r.data) as InboundDoc)) } });
}

export interface InboundOutcome {
  status: number;
  body: { saved: number; skipped: number; ignored?: string; ids?: Record<string, string>; problems?: ImportResult["problems"]; error?: string };
}

/** Something POSTed to /api/hooks/:token. */
export async function receiveInbound(token: string, body: unknown): Promise<InboundOutcome> {
  const hook = await findHook(token);
  if (!hook) throw new HttpError(410, "This address doesn't work any more.");
  const name = hook.record.docId;
  const now = () => new Date().toISOString();
  const fail = async (status: number, error: string): Promise<InboundOutcome> => {
    await note(hook.record.id, (d) => ({ ...d, lastAt: now(), received: (d.received ?? 0) + 1, lastError: error, lastErrorAt: now(), lastResult: "failed" }));
    return { status, body: { saved: 0, skipped: 0, error } };
  };

  const form = await prisma.builtForm.findUnique({ where: { id: hook.record.formId } });
  if (!form || form.kind !== "code" || form.status !== "published") return fail(409, "The form isn't published.");
  const action = publishedManifest(form)?.inbound?.[name]?.action;
  if (!action) return fail(409, `The published form has no inbound hook "${name}".`);

  const app = await loadApp(form, false);
  const r = await runAction(app, null, action, { hook: name, body: body ?? null });
  if (!r.ok) return fail(r.userError ? 400 : 500, r.error ?? "The form's server code failed.");

  const value = r.value as unknown;
  if (value == null || (typeof value === "object" && !Array.isArray(value) && "ignore" in (value as object))) {
    const why = value && typeof (value as { ignore?: unknown }).ignore === "string" ? String((value as { ignore: string }).ignore) : "Ignored by the form.";
    await note(hook.record.id, (d) => ({ ...d, lastAt: now(), received: (d.received ?? 0) + 1, skipped: (d.skipped ?? 0) + 1, lastResult: `ignored: ${why}`, lastError: null }));
    return { status: 200, body: { saved: 0, skipped: 1, ignored: why } };
  }
  const parsed = importedEntry.array().min(1).max(50).safeParse(Array.isArray(value) ? value : [value]);
  if (!parsed.success) return fail(500, `The ${action} action returned something that isn't an entry: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);

  const out = await importEntries(form, parsed.data);
  if (out.problems.length) return fail(422, out.problems.map((p) => `${p.externalId}: ${p.problem}`).join("; "));
  await note(hook.record.id, (d) => ({
    ...d,
    lastAt: now(),
    received: (d.received ?? 0) + 1,
    saved: (d.saved ?? 0) + out.saved,
    skipped: (d.skipped ?? 0) + out.skipped.length,
    lastResult: out.saved ? `saved ${parsed.data.map((e) => e.externalId).join(", ")}` : `already had ${out.skipped.join(", ")}`,
    lastError: null,
  }));
  return { status: out.saved ? 201 : 200, body: { saved: out.saved, skipped: out.skipped.length, ids: out.ids } };
}
