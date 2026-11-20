/**
 * Checks for a resident's record (routes/clientRecord.ts): the timeline, their
 * documents, the MCP tools, basic-form entries keeping their resident, and the
 * backfill of older ones — main paths and the permission edges.
 *
 *   DATABASE_URL=<a throwaway database> DEV_AUTH=true FORM_BACKUP_REPO=" " FORM_BACKUP_TOKEN=" " \
 *     npx tsx scripts/client-record-check.ts
 *
 * Runs the API in this process against DATABASE_URL, which must name a
 * throwaway database (its name has "smoke", "test" or "_a<number>" in it, e.g. lcs_forms_a1): it
 * adds people, forms, entries, units and documents there, and turns case
 * management on and off. Names and data are invented. Exits non-zero on the
 * first failed check.
 */
import type { AddressInfo } from "node:net";

const url = process.env.DATABASE_URL ?? "";
const db = /database=([^;]+)/i.exec(url)?.[1] ?? "";
if (!/smoke|test|_a\d+/i.test(db)) {
  console.error(`This writes test data: point DATABASE_URL at a throwaway database (now: "${db || "none"}").`);
  process.exit(1);
}
process.env.DEV_AUTH ??= "true";

const { prisma } = await import("../src/prisma.js");
const { createApp } = await import("../src/app.js");
const { accessReady, ensureStartingGroups } = await import("../src/services/staffGroups.js");
const { setSetting } = await import("../src/services/settings.js");
const { createForm, publishForm } = await import("../src/forms/service.js");
const { createProject, publishProject } = await import("../src/apps/service.js");
const { emptyForm, newField } = await import("../src/forms/engine.js");
const { backfillEntryTenants } = await import("../src/services/clientTimeline.js");
const { generateKey } = await import("../src/services/apiKeys.js");
const { callRoute } = await import("../src/ops/callRoute.js");
const { delegatedUser } = await import("../src/ops/principal.js");
const { currentUserById } = await import("../src/auth/middleware.js");
const { clientRecordRouter } = await import("../src/routes/clientRecord.js");
const { AWAY_REASONS } = await import("../src/services/residency.js");
const { HttpError } = await import("../src/http.js");

let passed = 0;
function check(cond: unknown, what: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${what}`);
    process.exit(1);
  }
  passed++;
  console.log(`✓ ${what}`);
}

const stamp = Date.now().toString(36);
const actor = { id: null, name: "Check script" };

// ── Setup ────────────────────────────────────────────────────────────────

await setSetting("caseManagement", "true");
await ensureStartingGroups();
await accessReady();

const [siteA, siteB] = await prisma.site.findMany({ where: { siteType: "supportive", active: true }, orderBy: { code: "asc" }, take: 2 });
check(siteA && siteB, "two supportive sites to work with");

const person = (name: string, roleKey: string, sites: string[], extra: Record<string, unknown> = {}) =>
  prisma.user.create({
    data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}.${stamp}@example.org`, roleKey, status: "active", ...extra, sites: { create: sites.map((siteId) => ({ siteId })) } },
  });
const admin = await person("Ada Admin", "admin", []);
const cm = await person("Casey Lead", "site_staff", [siteA.id], { clientInfoAccess: true });
const cm2 = await person("Robin Second", "site_staff", [siteA.id], { clientInfoAccess: true });
const plain = await person("Pat Plain", "site_staff", [siteA.id]);
const other = await person("Olu Other", "site_staff", [siteB.id], { clientInfoAccess: true });

const r1 = await prisma.tenant.create({ data: { siteId: siteA.id, firstName: "Timeline", lastName: `Example ${stamp}`, movedIn: false } });
const r2 = await prisma.tenant.create({ data: { siteId: siteB.id, firstName: "Elsewhere", lastName: `Example ${stamp}` } });

// Forms: one anyone fills in (each sees only their own entries), one per site (staff see their sites').
const resident = newField("resident", [], "Resident");
const note = newField("textarea", [resident.id], "Note");
const residentField = resident.id;
const noteField = note.id;
const docOwn = emptyForm(`Check case note ${stamp}`);
docOwn.fields = [resident, note];
const formOwn = await publishForm((await createForm({ doc: docOwn }, actor)).id, actor);
const docSite = emptyForm(`Check visit ${stamp}`);
docSite.settings.requireSite = true;
docSite.fields = [resident, note];
const formSite = await publishForm((await createForm({ doc: docSite }, actor)).id, actor);
const { setEntryAccess } = await import("../src/services/staffGroups.js");
await setEntryAccess(formSite.id, { mode: "site", seeAll: { groupIds: [], titles: [], userIds: [], roles: [] }, notified: true }, "Check script");
const code = await publishProject((await createProject({ title: `Check code form ${stamp}` }, actor)).id, actor);

const server = createApp().listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function signIn(userId: string) {
  const res = await fetch(`${base}/api/auth/dev-login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }) });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!res.ok || !cookie) throw new Error(`dev sign-in failed for ${userId}: ${res.status}`);
  return cookie;
}
const as = {
  admin: await signIn(admin.id),
  cm: await signIn(cm.id),
  cm2: await signIn(cm2.id),
  plain: await signIn(plain.id),
  other: await signIn(other.id),
};
type Who = keyof typeof as;

async function call(who: Who, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const raw = Buffer.isBuffer(body);
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { cookie: as[who], ...(body !== undefined && !raw ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : raw ? (body as Buffer) : JSON.stringify(body),
  });
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("application/json") ? ((await res.json()) as any) : Buffer.from(await res.arrayBuffer());
  return { status: res.status, body: data, headers: res.headers };
}

try {
  // ── Entries keep the resident they're about ────────────────────────────
  const submit = async (who: Who, form: { slug: string }, note: string, site?: string) => {
    const r = await call(who, "POST", `/f/${form.slug}/submit`, { values: { [residentField]: { id: r1.id }, [noteField]: note }, ...(site ? { siteCode: site } : {}) });
    if (r.status !== 201) throw new Error(`submit failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.id as string;
  };
  const own1 = await submit("cm", formOwn, "First note");
  const own2 = await submit("cm2", formOwn, "Second note");
  const site1 = await submit("cm", formSite, "Visit one", siteA.code);
  const site2 = await submit("cm2", formSite, "Visit two", siteA.code);
  check((await prisma.formEntry.findUniqueOrThrow({ where: { id: own1 } })).tenantId === r1.id, "a basic form's entry keeps the resident it's about (tenantId)");

  const codeEntry = async (who: Who, note: string) => {
    const r = await call(who, "POST", `/apps/${code.slug}/entries`, { data: { note }, site: siteA.code, tenantId: r1.id });
    if (r.status !== 201) throw new Error(`code entry failed: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body.entry?.id ?? r.body.id;
  };
  const codeMine = await codeEntry("cm", "Code note one");
  const codeTheirs = await codeEntry("cm2", "Code note two");
  check(typeof codeMine === "string" && typeof codeTheirs === "string", "code-form entries about the resident");

  // An entry from before entries kept their resident, then the backfill.
  const old = await prisma.formEntry.create({
    data: { formId: formOwn.id, formVersion: 1, data: JSON.stringify({ [residentField]: { id: r1.id, name: "x" }, [noteField]: "Old" }), createdByName: "Someone", createdById: admin.id, createdAt: new Date("2026-09-01T15:00:00Z") },
  });
  const oldUpdated = (await prisma.formEntry.findUniqueOrThrow({ where: { id: old.id } })).updatedAt;
  await prisma.setting.deleteMany({ where: { key: "entryTenantsFilled" } });
  const filled = await backfillEntryTenants();
  const after = await prisma.formEntry.findUniqueOrThrow({ where: { id: old.id } });
  check(filled >= 1 && after.tenantId === r1.id, `the backfill gives older entries their resident (${filled})`);
  check(after.updatedAt.getTime() === oldUpdated.getTime(), "the backfill doesn't move updatedAt");
  check((await backfillEntryTenants()) === 0, "the backfill runs once");

  // A voided entry stays out.
  const voided = await submit("cm", formOwn, "Mistake");
  await prisma.formEntry.update({ where: { id: voided }, data: { status: "voided" } });

  // ── Moves, time away, the checklist ────────────────────────────────────
  const unit1 = await call("admin", "POST", "/residency/units", { site: siteA.code, label: `C${stamp}`.slice(0, 20) });
  const unit2 = await call("admin", "POST", "/residency/units", { site: siteA.code, label: `D${stamp}`.slice(0, 20) });
  check(unit1.status === 201 && unit2.status === 201, "two units");
  check((await call("admin", "POST", `/residency/units/${unit1.body.id}/move-in`, { date: "2026-10-01", people: [{ tenantId: r1.id }] })).status === 200, "moved in");
  check((await call("admin", "POST", `/residency/tenants/${r1.id}/away`, { lastSeen: "2026-10-10", reason: AWAY_REASONS[0] })).status === 200, "away");
  check((await call("admin", "POST", `/residency/tenants/${r1.id}/returned`, { date: "2026-10-12" })).status === 200, "back");
  check((await call("admin", "POST", `/residency/tenants/${r1.id}/transfer`, { toUnitId: unit2.body.id, date: "2026-10-20" })).status === 200, "moved to another unit");
  const res = await call("admin", "GET", `/residency/tenants/${r1.id}`);
  const task = (res.body.tasks as { id: string; status: string }[]).find((t) => t.status === "open");
  check(task, "an open checklist item");
  check((await call("cm", "POST", `/residency/tasks/${task.id}`, { status: "done", doneOn: "2026-10-03", note: "Done in person" })).status === 200, "checklist item done");

  // Entries sharing one time (imported ones often do), for paging.
  const tieAt = new Date("2026-08-15T16:00:00Z");
  for (let i = 0; i < 5; i++) {
    await prisma.formEntry.create({
      data: { formId: formOwn.id, formVersion: 1, tenantId: r1.id, source: "import", data: JSON.stringify({ [residentField]: { id: r1.id }, [noteField]: `Tie ${i}` }), createdByName: "Import", createdAt: tieAt, occurredAt: tieAt },
    });
  }

  // ── Timeline ────────────────────────────────────────────────────────────
  const timeline = async (who: Who, query = "") => call(who, "GET", `/tenants/${r1.id}/timeline${query}`);
  const all = await timeline("admin", "?limit=100");
  check(all.status === 200 && Array.isArray(all.body.items) && all.body.next === null, "the admin's timeline, one page");
  const items = all.body.items as { key: string; kind: string; at: string; entry?: { id: string; link: string; form: { kind: string } } }[];
  const entryIds = new Set(items.filter((i) => i.entry).map((i) => i.entry!.id));
  check([own1, own2, site1, site2, codeMine, codeTheirs, old.id].every((id) => entryIds.has(id)), "it has every entry about them");
  check(!entryIds.has(voided), "but not a voided one");
  const kinds = new Set(items.map((i) => i.kind));
  check(["moved_in", "transferred", "away", "back", "task_done"].every((k) => kinds.has(k)), `with moves, time away and the checklist (${[...kinds].join(", ")})`);
  check(items.every((i, n) => n === 0 || Date.parse(items[n - 1].at) >= Date.parse(i.at)), "newest first");
  const basic = items.find((i) => i.entry?.id === own1)!;
  check(basic.entry!.link === `/f/${formOwn.slug}/entries/${own1}`, "a basic entry links to its entry page");
  check(items.find((i) => i.entry?.id === codeMine)!.entry!.link === `/apps/${code.slug}`, "a code entry links to its form");

  // Only what each person may open, by each form's own rules.
  const mine = await timeline("cm", "?limit=100");
  const mineIds = new Set((mine.body.items as typeof items).filter((i) => i.entry).map((i) => i.entry!.id));
  check(mineIds.has(own1) && !mineIds.has(own2), "case manager: their own entry on an own-entries form, not a colleague's");
  check(mineIds.has(site1) && mineIds.has(site2), "case manager: everyone's at their site on a per-site form");
  check(mineIds.has(codeMine) && !mineIds.has(codeTheirs), "case manager: only their own on a code form that shows people their own");
  const listed = await call("cm", "GET", `/f/${formOwn.slug}/entries?take=200`);
  const listedIds = new Set((listed.body.items as { id: string }[]).map((e) => e.id));
  check([...mineIds].filter((id) => [own1, own2, old.id].includes(id)).every((id) => listedIds.has(id)), "the same entries the form's own Entries shows them");
  const opened = await call("cm", "GET", `/f/${formOwn.slug}/entries/${own1}`);
  check(opened.status === 200, "and each opens from its link");

  // Paging: small pages, every item once, ties included.
  const keys: string[] = [];
  let before: string | null = null;
  let pages = 0;
  do {
    const page: { status: number; body: any } = await timeline("admin", `?limit=2${before ? `&before=${encodeURIComponent(before)}` : ""}`);
    check(page.status === 200, `page ${++pages}`);
    keys.push(...(page.body.items as { key: string }[]).map((i) => i.key));
    before = page.body.next;
  } while (before && pages < 60);
  check(keys.length === new Set(keys).size, "no item twice across pages");
  check(keys.length === items.length && items.every((i) => keys.includes(i.key)), `every item across pages (${keys.length} of ${items.length}), the five sharing one time too`);
  check((await timeline("admin", "?before=not-a-cursor")).status === 400, "a broken cursor is a 400");

  // Who may see it at all.
  check((await timeline("plain")).status === 403, "someone without client information: 403");
  check((await timeline("other")).status === 404, "someone at another site: 404");
  await setSetting("caseManagement", "false");
  check((await timeline("admin")).status === 404, "case management off: 404");
  check((await call("admin", "GET", `/tenants/${r1.id}/documents`)).status === 404, "case management off: documents 404");
  await setSetting("caseManagement", "true");

  // ── Documents ───────────────────────────────────────────────────────────
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
  const upload = (who: Who, data: Buffer, name: string, kind: string, label = "") =>
    call(who, "POST", `/tenants/${r1.id}/documents`, data, { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name), "x-document-kind": kind, "x-document-label": encodeURIComponent(label) });
  const added = await upload("cm", pdf, "lease 2026.pdf", "lease", "Lease renewal 2026");
  check(added.status === 201 && added.body.id && added.body.mime === "application/pdf" && added.body.kindLabel === "Lease", "a case manager adds a PDF");
  const docId = added.body.id as string;
  check(Boolean(await prisma.auditEvent.findFirst({ where: { action: "client.document_added", tenantId: r1.id } })), "adding is audited");
  check((await upload("cm", Buffer.from("MZ not a pdf"), "fake.pdf", "lease")).status === 400, "a file that isn't what its name says: 400");
  check((await upload("cm", Buffer.from("MZ"), "tool.exe", "other")).status === 400, "a program: 400");
  check((await upload("cm", pdf, "x.pdf", "")).status === 400, "no kind: 400");
  check((await upload("cm", Buffer.alloc(0), "x.pdf", "lease")).status === 400, "an empty file: 400");
  const big = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(20 * 1024 * 1024)]);
  check((await upload("cm", big, "big.pdf", "lease")).status === 413, "over 20 MB: 413");
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  check((await upload("cm", png, "id-front.png", "id")).status === 201, "a photo of their ID");
  check((await upload("plain", pdf, "x.pdf", "lease")).status === 403, "without client information: can't add");
  check((await upload("other", pdf, "x.pdf", "lease")).status === 404, "at another site: can't add");

  const list = await call("cm", "GET", `/tenants/${r1.id}/documents`);
  check(list.status === 200 && list.body.items.length === 2 && list.body.canEdit === true, "the list");
  check((await call("plain", "GET", `/tenants/${r1.id}/documents`)).status === 403, "without client information: no list");
  check((await call("other", "GET", `/tenants/${r1.id}/documents`)).status === 404, "another site: no list");

  const file = await call("cm", "GET", `/tenants/${r1.id}/documents/${docId}`);
  check(file.status === 200 && Buffer.isBuffer(file.body) && file.body.equals(pdf), "it opens, the same bytes");
  check(file.headers.get("content-type")?.startsWith("application/pdf") && /^inline/.test(file.headers.get("content-disposition") ?? ""), "a PDF opens in the browser");
  check(file.headers.get("cache-control") === "no-store" && /sandbox/.test(file.headers.get("content-security-policy") ?? ""), "never cached, never run as a page");
  const dl = await call("cm", "GET", `/tenants/${r1.id}/documents/${docId}?download=1`);
  check(/^attachment/.test(dl.headers.get("content-disposition") ?? "") && dl.headers.get("content-type") === "application/octet-stream", "download=1 saves it");
  check((await prisma.auditEvent.count({ where: { action: "client.document_opened", tenantId: r1.id } })) === 2, "each open and download is audited");
  check((await call("plain", "GET", `/tenants/${r1.id}/documents/${docId}`)).status === 403, "without client information: can't open");
  check((await call("other", "GET", `/tenants/${r1.id}/documents/${docId}`)).status === 404, "another site: can't open");
  check((await call("cm", "GET", `/tenants/${r2.id}/documents/${docId}`)).status === 404, "not through another resident");

  const tl = await timeline("cm", "?limit=100");
  check((tl.body.items as { kind: string; document?: { id: string } }[]).some((i) => i.kind === "document" && i.document?.id === docId), "the timeline shows the document added");

  // Seeing client information without changing it (an API key with clients:read).
  const cmUser = (await currentUserById(cm.id))!;
  const readOnly = { user: delegatedUser(cmUser, { name: "check", siteId: null }, "clients:read") };
  const refused = await callRoute(clientRecordRouter, { method: "DELETE", path: `/${r1.id}/documents/${docId}` }, readOnly).then(
    () => 0,
    (e) => (e instanceof HttpError ? e.status : -1)
  );
  check(refused === 403, "clients.view without clients.edit: can't remove");

  check((await call("plain", "DELETE", `/tenants/${r1.id}/documents/${docId}`)).status === 403, "without client information: can't remove");
  check((await call("cm", "DELETE", `/tenants/${r1.id}/documents/${docId}`)).status === 200, "a case manager removes it");
  const row = await prisma.clientDocument.findUniqueOrThrow({ where: { id: docId } });
  check(row.removedAt && row.removedByName === cm.name && row.data, "removing keeps the row and the bytes, marked removed");
  check((await call("cm", "GET", `/tenants/${r1.id}/documents/${docId}`)).status === 404, "a removed document doesn't open");
  check((await call("cm", "GET", `/tenants/${r1.id}/documents`)).body.items.length === 1, "and leaves the list");
  check(Boolean(await prisma.auditEvent.findFirst({ where: { action: "client.document_removed", tenantId: r1.id } })), "removing is audited");

  // Document events stay with people who see client information.
  const historyPlain = await call("plain", "GET", `/tenants/${r1.id}`);
  check(historyPlain.status === 200 && !(historyPlain.body.history as { action: string }[]).some((h) => h.action.startsWith("client.document")), "History hides document events from someone without client information");
  const historyCm = await call("cm", "GET", `/tenants/${r1.id}`);
  check((historyCm.body.history as { action: string }[]).some((h) => h.action === "client.document_added"), "and shows them to a case manager");
  const feed = await call("plain", "GET", `/activity/audit?site=${siteA.code}&limit=200`);
  check(feed.status === 200 && !(feed.body.items as { action: string }[]).some((h) => h.action.startsWith("client.")), "the roster's Activity feed leaves them out");

  // ── The MCP tools and /api/v1 ───────────────────────────────────────────
  const makeKey = async (createdById: string, scopes: string[]) => {
    const k = generateKey();
    await prisma.apiKey.create({ data: { name: `check ${stamp}`, prefix: k.prefix, hash: k.hash, scopes: scopes.join(","), createdById } });
    return k.key;
  };
  const kRead = await makeKey(admin.id, ["clients:read"]);
  const kRoster = await makeKey(admin.id, ["roster:read"]);
  const v1 = async (k: string, path: string) => {
    const r = await fetch(`${base}/api/v1${path}`, { headers: { authorization: `Bearer ${k}` } });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  const viaRest = await v1(kRead, `/residents/${r1.id}/timeline?limit=5`);
  check(viaRest.status === 200 && viaRest.body.items.length === 5 && typeof viaRest.body.next === "string", "GET /api/v1/residents/:id/timeline");
  const docsRest = await v1(kRead, `/residents/${r1.id}/documents`);
  check(docsRest.status === 200 && docsRest.body.items.length === 1, "GET /api/v1/residents/:id/documents");
  check((await v1(kRoster, `/residents/${r1.id}/timeline`)).status === 403, "a key without clients:read: 403");
  const mcp = async (k: string, name: string, args: Record<string, unknown>) => {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${k}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const out = (await r.json()) as any;
    const text = out.result?.content?.[0]?.text ?? "";
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      // plain text
    }
    return { isError: Boolean(out.result?.isError), data };
  };
  const t1 = await mcp(kRead, "get_timeline", { id: r1.id, limit: 3 });
  check(!t1.isError && t1.data.items.length === 3 && t1.data.next, "MCP get_timeline");
  const t2 = await mcp(kRead, "get_timeline", { id: r1.id, limit: 3, before: t1.data.next });
  check(!t2.isError && t2.data.items.every((i: { key: string }) => !t1.data.items.some((j: { key: string }) => j.key === i.key)), "MCP get_timeline's next page");
  const d1 = await mcp(kRead, "list_client_documents", { id: r1.id });
  check(!d1.isError && d1.data.items.length === 1 && d1.data.items[0].mime === "image/png", "MCP list_client_documents");
  await setSetting("caseManagement", "false");
  check((await mcp(kRead, "get_timeline", { id: r1.id })).isError, "MCP get_timeline with case management off is an error");
  await setSetting("caseManagement", "true");
} finally {
  server.close();
  await prisma.$disconnect();
}

console.log(`\n${passed} checks passed.`);
process.exit(0);
