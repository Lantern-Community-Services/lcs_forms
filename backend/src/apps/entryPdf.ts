import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { appBaseUrl } from "../env.js";
import { HttpError } from "../http.js";
import type { CurrentUser } from "../auth/middleware.js";
import { buildExport } from "./exports.js";
import { exportDocument } from "./exportDocuments.js";
import { dateWhere, loadLiveApp, runAction, type LoadedApp } from "./runtime.js";

/**
 * Entries as one PDF, without opening a page: Claude's export_pdf (ops/person.ts)
 * and the API key's export_code_entries_pdf (apps/mcpTools.ts).
 *
 * The form says how an entry looks on paper: form.json "pdf": { action } names a
 * server action that is run AS THE PERSON with { ids } and returns
 * { documents, title?, filename? } — the paper-form documents app.print draws
 * (apps/exportDocuments.ts), one per entry that person may see. So the form's own
 * rules decide what's in the file, exactly as on its pages; the platform only
 * finds which entries to ask for and draws the pages.
 *
 * A PDF isn't something an MCP tool can hand back, so the tool returns a link:
 * /api/pdf/<token>, good for an hour, that opens only for the same person signed
 * in (or their API key). The file is drawn again when it's opened — nothing is
 * kept but the request, in the form's private "__pdf" collection, as a hash.
 */

export const MAX_PDF_ENTRIES = 300;
const BATCH = 40; // ids per action call: the sandbox stops server code after 3 s
const LINK_HOURS = 1;
const COLLECTION = "__pdf";

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** Which entries: given ids, or a filter. Every filter is also limited to the person's sites. */
export const pdfFilter = {
  ids: z.array(z.string().max(40)).max(MAX_PDF_ENTRIES).optional().describe("Entry ids, in the order to print them. Or leave out and filter instead."),
  resident: z.string().max(40).optional().describe("A resident's roster id (from list_residents): entries linked to them, plus any that name them in the text (older imported entries often aren't linked)."),
  search: z.string().max(120).optional().describe("Text the entry contains, e.g. a name."),
  site: z.string().max(200).optional().describe("Site code (comma-separate several)."),
  from: z.string().max(10).optional().describe("YYYY-MM-DD"),
  to: z.string().max(10).optional().describe("YYYY-MM-DD"),
  includeVoided: z.boolean().optional(),
};
export type PdfFilter = { ids?: string[]; resident?: string; search?: string; site?: string; from?: string; to?: string; includeVoided?: boolean };

/**
 * The entries a filter picks, oldest first (ids: in the order given). Only ids leave here: what's in each
 * entry, and whether this person may see it, is the form's pdf action's to decide.
 */
export async function pickEntryIds(app: LoadedApp, user: CurrentUser, f: PdfFilter): Promise<{ ids: string[]; more: boolean; matched: string | null }> {
  const and: Prisma.FormEntryWhereInput[] = [{ formId: app.form.id }, { source: { not: "preview" } }];
  if (!f.includeVoided) and.push({ status: "active" });
  if (user.siteIds) and.push({ OR: [{ siteId: null }, { siteId: { in: user.siteIds } }] });
  if (f.ids?.length) and.push({ id: { in: f.ids } });
  if (f.site) {
    const sites = await prisma.site.findMany({ where: { code: { in: f.site.split(",").map((s) => s.trim()) } }, select: { id: true } });
    and.push({ siteId: { in: sites.map((s) => s.id) } });
  }
  const occurred = dateWhere(f.from, f.to);
  if (occurred) and.push({ occurredAt: occurred });
  if (f.search?.trim()) and.push({ data: { contains: f.search.trim() } });
  let matched: string | null = null;
  if (f.resident) {
    const t = await prisma.tenant.findUnique({ where: { id: f.resident }, select: { id: true, firstName: true, lastName: true, preferredName: true, siteId: true } });
    if (!t || (user.siteIds && !user.siteIds.includes(t.siteId))) throw new HttpError(404, "No such resident at your sites.");
    const names = [...new Set([`${t.firstName} ${t.lastName}`, t.preferredName ? `${t.preferredName} ${t.lastName}` : ""].map((s) => s.trim()).filter((s) => s.includes(" ")))];
    matched = names.join(" / ");
    and.push({ OR: [{ tenantId: t.id }, ...names.map((n) => ({ AND: [{ siteId: t.siteId }, { data: { contains: n } }] }))] });
  }
  if (!f.ids?.length && !f.resident && !f.search?.trim() && !f.from && !f.to) throw new HttpError(400, "Say which entries: ids, a resident, search text or dates.");
  const rows = await prisma.formEntry.findMany({ where: { AND: and }, orderBy: { occurredAt: "asc" }, take: MAX_PDF_ENTRIES + 1, select: { id: true } });
  let ids = rows.map((r) => r.id);
  if (f.ids?.length) {
    const found = new Set(ids);
    ids = f.ids.filter((id, i) => found.has(id) && f.ids!.indexOf(id) === i);
  }
  return { ids: ids.slice(0, MAX_PDF_ENTRIES), more: ids.length > MAX_PDF_ENTRIES, matched };
}

const actionResult = z.object({
  documents: z.array(z.unknown()).max(BATCH * 2),
  title: z.string().max(160).optional(),
  filename: z.string().max(120).optional(),
});

/** Run the form's pdf action as the person, in batches, and check what it returns. */
export async function documentsFor(app: LoadedApp, user: CurrentUser, ids: string[]) {
  const action = app.manifest.pdf?.action;
  if (!action) throw new HttpError(409, `“${app.manifest.title}” can't make PDFs of its entries yet (its form.json has no "pdf" action).`);
  const documents: z.infer<typeof exportDocument>[] = [];
  let title: string | undefined;
  let filename: string | undefined;
  for (let i = 0; i < ids.length; i += BATCH) {
    const r = await runAction(app, user, action, { ids: ids.slice(i, i + BATCH) });
    if (!r.ok) throw new HttpError(422, `The form couldn't lay its entries out: ${r.error ?? "its pdf action failed"}.`);
    const out = actionResult.safeParse(r.value);
    if (!out.success) throw new HttpError(422, `The form's pdf action returned something else than { documents }: ${out.error.issues[0]?.message ?? ""}`);
    for (const [j, d] of out.data.documents.entries()) {
      const doc = exportDocument.safeParse(d);
      if (!doc.success) throw new HttpError(422, `Document ${i + j + 1} from the form's pdf action isn't a paper-form document: ${doc.error.issues[0]?.path.join(".")} ${doc.error.issues[0]?.message}`);
      documents.push(doc.data);
    }
    title ??= out.data.title;
    filename ??= out.data.filename;
  }
  return { documents, title: title ?? app.manifest.title, filename: filename ?? app.manifest.title };
}

interface PdfDoc {
  userId: string;
  ids: string[];
  title: string;
  filename: string;
  expiresAt: string;
}

/**
 * Check the entries can be drawn for this person (the form's rules apply now, not only when opened) and
 * make the link. Returns how many entries it holds.
 */
export async function createPdfLink(app: LoadedApp, user: CurrentUser, f: PdfFilter, opts: { title?: string; filename?: string } = {}) {
  const picked = await pickEntryIds(app, user, f);
  if (!picked.ids.length) return { url: null, entries: 0, note: "No entries matched (at your sites)." };
  const made = await documentsFor(app, user, picked.ids);
  if (!made.documents.length) return { url: null, entries: 0, note: `${picked.ids.length} entries matched, but you can't see any of them on this form.` };
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + LINK_HOURS * 3600_000).toISOString();
  const doc: PdfDoc = {
    userId: user.userId,
    ids: picked.ids,
    title: (opts.title?.trim() || made.title).slice(0, 160),
    filename: (opts.filename?.trim() || made.filename).slice(0, 120),
    expiresAt,
  };
  // Old links go as new ones are made.
  await prisma.formRecord.deleteMany({ where: { formId: app.form.id, collection: COLLECTION, updatedAt: { lt: new Date(Date.now() - LINK_HOURS * 3600_000) } } });
  await prisma.formRecord.create({ data: { formId: app.form.id, collection: COLLECTION, docId: hashOf(token), data: JSON.stringify(doc), updatedByName: user.name } });
  return {
    url: `${appBaseUrl}/api/pdf/${app.form.slug}.${token}`,
    expiresAt,
    entries: made.documents.length,
    ...(picked.ids.length > made.documents.length ? { notShown: picked.ids.length - made.documents.length } : {}),
    ...(picked.more ? { truncated: `Only the first ${MAX_PDF_ENTRIES} (oldest first); narrow the dates for the rest.` } : {}),
    ...(picked.matched ? { matchedNames: picked.matched } : {}),
    opens: `Only for ${user.name}, signed in to Lantern Forms, until ${expiresAt}. Give the person the link to open; don't fetch it yourself.`,
  };
}

/** The PDF behind a link, drawn now for the person who made it. `who` is the signed-in person's id (or the key creator's). */
export async function openPdfLink(slugToken: string, who: { userId: string | null; user: CurrentUser | null; loadUser: (id: string) => Promise<CurrentUser | null> }) {
  const dot = slugToken.lastIndexOf(".");
  const slug = slugToken.slice(0, dot);
  const token = slugToken.slice(dot + 1);
  if (dot < 1 || token.length < 20) throw new HttpError(404, "That link isn't right.");
  const app = await loadLiveApp(slug);
  const row = await prisma.formRecord.findUnique({ where: { formId_collection_docId: { formId: app.form.id, collection: COLLECTION, docId: hashOf(token) } } });
  if (!row) throw new HttpError(410, "This PDF link has expired. Ask Claude for a new one.");
  const doc = JSON.parse(row.data) as PdfDoc;
  if (Date.parse(doc.expiresAt) < Date.now()) throw new HttpError(410, "This PDF link has expired. Ask Claude for a new one.");
  if (!who.userId) throw new HttpError(401, "Sign in to open this PDF.");
  if (who.userId !== doc.userId) throw new HttpError(403, "This PDF link was made for someone else.");
  const user = who.user ?? (await who.loadUser(doc.userId));
  if (!user) throw new HttpError(403, "Your account isn't active.");
  const made = await documentsFor(app, user, doc.ids);
  if (!made.documents.length) throw new HttpError(403, "You can't see these entries any more.");
  const file = await buildExport({ format: "pdf", filename: doc.filename, title: doc.title, sheets: [], documents: made.documents }, user.name);
  return { app, user, file, count: made.documents.length, title: doc.title };
}
