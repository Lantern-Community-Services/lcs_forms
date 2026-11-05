import type { BuiltForm } from "@prisma/client";
import { prisma } from "../prisma.js";
import { createFormFile, deleteFiles } from "../services/fileStore.js";
import { fieldError, isEmptyValue, isInputField, type Field, type Values } from "./engine.js";
import { liveDoc } from "./entries.js";
import { displayName } from "../services/roster.js";
import { notFound } from "../http.js";

/**
 * Migrating entries from an old system (Gravity Forms) into a basic form, saved
 * as given: no notifications, routing, follow-up or roster activity, and the
 * entry keeps its old date and filer. Answers are checked for shape against the
 * live form (a choice must be one of its choices, a date a date) but not for
 * being required or visible: an old entry answered what it was asked then.
 *
 *   Resident  { id } is looked up on the roster (name, unit and site come from
 *             there); { name, unit? } with no id keeps a resident who couldn't
 *             be matched, shown by name only.
 *   File      [{ name, mime, base64 }] — the bytes are stored like an upload.
 *   Signature a PNG data URL, as the fill page saves it.
 */

export interface ImportFile { name: string; mime: string; base64: string }
export interface ImportEntry {
  externalId: string;
  values: Values;
  site?: string;
  submittedAt?: string;
  createdByName?: string;
  createdByEmail?: string;
}
export interface ImportResult {
  saved: number;
  wouldSave: number;
  skipped: string[];
  problems: { externalId: string; problem: string }[];
  dryRun: boolean;
  ids?: { externalId: string; id: string }[];
}

export const IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const IMPORT_MAX_ENTRY_BYTES = 25 * 1024 * 1024;
export const importClientId = (externalId: string) => `import:${externalId}`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const b64Bytes = (s: string) => Math.floor((s.replace(/=+$/, "").length * 3) / 4);

export async function importEntries(form: BuiltForm, entries: ImportEntry[], opts: { dryRun: boolean }): Promise<ImportResult> {
  const doc = liveDoc(form);
  if (!doc) throw notFound("This form hasn't been published yet.");
  const fields = new Map<string, Field>(doc.fields.filter(isInputField).map((f) => [f.id, f]));
  const problems: ImportResult["problems"] = [];
  const bad = (externalId: string, problem: string) => problems.push({ externalId, problem });

  // Look-ups for the whole batch at once.
  const siteCodes = new Set<string>();
  const tenantIds = new Set<string>();
  const emails = new Set<string>();
  for (const e of entries) {
    if (e.site) siteCodes.add(e.site);
    if (e.createdByEmail) emails.add(e.createdByEmail.trim().toLowerCase());
    for (const [id, v] of Object.entries(e.values)) {
      const f = fields.get(id);
      if (f?.type === "site" && typeof v === "string" && v) siteCodes.add(v);
      if (f?.type === "resident" && isObj(v) && typeof v.id === "string") tenantIds.add(v.id);
    }
  }
  const sites = new Map((await prisma.site.findMany({ where: { code: { in: [...siteCodes] } }, select: { id: true, code: true } })).map((s) => [s.code, s.id]));
  const tenants = new Map((await prisma.tenant.findMany({ where: { id: { in: [...tenantIds] } } })).map((t) => [t.id, t]));
  const users = new Map(
    (await prisma.user.findMany({ where: { email: { in: [...emails] } }, select: { id: true, email: true, name: true } })).map((u) => [u.email.toLowerCase(), u])
  );

  const seen = new Set<string>();
  const prepared: { e: ImportEntry; values: Values; files: Map<string, ImportFile[]>; siteId: string | null; at: Date }[] = [];
  for (const e of entries) {
    const x = e.externalId;
    if (seen.has(x)) bad(x, "Sent twice in this batch.");
    seen.add(x);
    const at = e.submittedAt ? new Date(e.submittedAt) : new Date();
    if (Number.isNaN(at.getTime())) bad(x, `submittedAt "${e.submittedAt}" isn't a date.`);
    if (e.site && !sites.has(e.site)) bad(x, `No site with code "${e.site}".`);

    const values: Values = {};
    const files = new Map<string, ImportFile[]>();
    let bytes = 0;
    for (const [id, raw] of Object.entries(e.values)) {
      const f = fields.get(id);
      if (!f) { bad(x, `The form has no answerable field "${id}".`); continue; }
      let v = typeof raw === "string" ? raw.trim() : raw;
      if (isEmptyValue(v)) continue;
      if (f.type === "file") {
        const list = Array.isArray(v) ? v : [];
        const ok = list.length > 0 && list.every((it) => isObj(it) && typeof it.name === "string" && it.name && typeof it.mime === "string" && typeof it.base64 === "string" && it.base64);
        if (!ok) { bad(x, `${id}: files are [{ name, mime, base64 }].`); continue; }
        for (const it of list as ImportFile[]) {
          const n = b64Bytes(it.base64);
          if (n > IMPORT_MAX_FILE_BYTES) bad(x, `${id}: "${it.name}" is over 10 MB.`);
          bytes += n;
        }
        files.set(id, list as ImportFile[]);
        continue;
      }
      if (f.type === "resident") {
        if (!isObj(v)) { bad(x, `${id}: a resident is { id } or { name, unit? }.`); continue; }
        if (typeof v.id === "string") {
          const t = tenants.get(v.id);
          if (!t) { bad(x, `${id}: no resident with id "${v.id}".`); continue; }
          v = { id: t.id, name: displayName(t), unit: t.unit ?? undefined, siteId: t.siteId };
        } else if (typeof v.name === "string" && v.name.trim()) {
          v = { name: v.name.trim(), ...(typeof v.unit === "string" && v.unit.trim() ? { unit: v.unit.trim() } : {}) };
        } else { bad(x, `${id}: a resident is { id } or { name, unit? }.`); continue; }
        values[id] = v;
        continue;
      }
      if (f.type === "number" || f.type === "slider" || f.type === "rating") v = Number(v);
      if (f.type === "signature" && typeof v === "string") bytes += v.length;
      const err = fieldError({ ...f, required: false }, v);
      if (err) { bad(x, `${id}: ${err} (got ${JSON.stringify(v).slice(0, 80)})`); continue; }
      if (f.type === "site" && !sites.has(String(v))) { bad(x, `${id}: no site with code "${v}".`); continue; }
      values[id] = v;
    }
    if (bytes > IMPORT_MAX_ENTRY_BYTES) bad(x, "Files and signatures together are over 25 MB.");

    let siteId = e.site ? sites.get(e.site) ?? null : null;
    if (!siteId) {
      const sf = doc.fields.find((f) => f.type === "site" && values[f.id]);
      if (sf) siteId = sites.get(String(values[sf.id])) ?? null;
    }
    if (doc.settings.requireSite && !siteId) bad(x, "This form needs a site: send site or a Site field's answer.");
    prepared.push({ e, values, files, siteId, at });
  }

  const existing = new Set(
    (await prisma.formEntry.findMany({ where: { formId: form.id, clientId: { in: entries.map((e) => importClientId(e.externalId)) } }, select: { clientId: true } })).map((r) => r.clientId)
  );
  const fresh = prepared.filter((p) => !existing.has(importClientId(p.e.externalId)));
  const skipped = prepared.filter((p) => existing.has(importClientId(p.e.externalId))).map((p) => p.e.externalId);
  if (problems.length || opts.dryRun) {
    return { saved: 0, wouldSave: problems.length ? 0 : fresh.length, skipped, problems, dryRun: opts.dryRun };
  }

  const ids: { externalId: string; id: string }[] = [];
  for (const p of fresh) {
    const who = p.e.createdByEmail ? users.get(p.e.createdByEmail.trim().toLowerCase()) : undefined;
    const entry = await prisma.formEntry.create({
      data: {
        formId: form.id,
        formVersion: form.liveVersion,
        data: JSON.stringify(p.values),
        siteId: p.siteId,
        source: "import",
        clientId: importClientId(p.e.externalId),
        createdById: who?.id ?? null,
        createdByName: (p.e.createdByName?.trim() || who?.name || "Imported").slice(0, 255),
        occurredAt: p.at,
        createdAt: p.at,
      },
    });
    if (p.files.size) {
      const made: string[] = [];
      try {
        for (const [fieldId, list] of p.files) {
          const refs = [];
          for (const it of list) {
            const row = await createFormFile({ formId: form.id, fieldId, name: it.name.slice(0, 200), mime: it.mime.slice(0, 100) || "application/octet-stream", data: Buffer.from(it.base64, "base64") });
            made.push(row.id);
            refs.push({ id: row.id, name: row.name, size: row.size, mime: row.mime });
          }
          p.values[fieldId] = refs;
        }
        await prisma.formFile.updateMany({ where: { id: { in: made } }, data: { entryId: entry.id } });
        await prisma.formEntry.update({ where: { id: entry.id }, data: { data: JSON.stringify(p.values), updatedAt: p.at } });
      } catch (err) {
        // Leave nothing half-saved: the batch can be sent again.
        if (made.length) await deleteFiles({ id: { in: made } }).catch(() => undefined);
        await prisma.formEntry.delete({ where: { id: entry.id } }).catch(() => undefined);
        throw err;
      }
    }
    ids.push({ externalId: p.e.externalId, id: entry.id });
  }
  return { saved: ids.length, wouldSave: ids.length, skipped, problems: [], dryRun: false, ids };
}
