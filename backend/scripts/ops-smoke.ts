/**
 * Smoke test for the operations behind the MCP tools and /api/v1 (src/ops).
 *
 *   npm run smoke:ops                 checks that need no database: the registry,
 *                                     who a delegated key acts as, in-process routes
 *   npm run smoke:ops -- --e2e        also drives a real server over HTTP (REST and
 *                                     MCP) against DATABASE_URL, which must name a
 *                                     throwaway database with "smoke" in its name
 *                                     (it creates people, sites, residents and keys)
 *
 * Exits non-zero on the first failed check. Names and data are invented.
 */
import type { AddressInfo } from "node:net";
import { Router } from "express";
import { asyncHandler, HttpError } from "../src/http.js";
import { requireAuth, requirePermission, type CurrentUser } from "../src/auth/middleware.js";
import { ROLES, permissionsFor } from "../src/services/permissions.js";
import { API_SCOPES, type ApiScope, type ResolvedKey } from "../src/services/apiKeys.js";
import { OPS } from "../src/ops/index.js";
import { SCOPE_GRANTS, delegatedUser } from "../src/ops/principal.js";
import { callRoute } from "../src/ops/callRoute.js";

let passed = 0;
function check(cond: unknown, what: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${what}`);
    process.exit(1);
  }
  passed++;
  console.log(`✓ ${what}`);
}
async function rejects(p: Promise<unknown>, status: number, what: string) {
  try {
    await p;
  } catch (err) {
    check(err instanceof HttpError && err.status === status, `${what} (got ${err instanceof HttpError ? err.status : String(err)})`);
    return;
  }
  check(false, `${what} (it succeeded)`);
}

// ── Registry ─────────────────────────────────────────────────────────────

function registry() {
  const names = OPS.map((o) => o.name);
  check(new Set(names).size === names.length, `operation names are unique (${names.length})`);
  const routes = OPS.map((o) => `${o.http.method} ${o.http.path}`);
  check(new Set(routes).size === routes.length, "REST method + path pairs are unique");
  check(OPS.every((o) => (API_SCOPES as readonly string[]).includes(o.scope)), "every operation's scope is a real scope");
  check(OPS.filter((o) => o.as === "creator").every((o) => SCOPE_GRANTS[o.scope]), "every creator operation uses a delegated scope");
  check(OPS.filter((o) => o.annotations?.destructiveHint).every((o) => o.confirm), "every destructive operation needs confirm");
  // An earlier route with a :param must not swallow a later literal path (Express matches in order).
  const asRegex = (path: string) => new RegExp(`^${path.replace(/:[a-zA-Z]+/g, "[^/]+")}$`);
  for (const [i, op] of OPS.entries()) {
    const sample = op.http.path.replace(/:[a-zA-Z]+/g, "x");
    const shadow = OPS.slice(0, i).find((o) => o.http.method === op.http.method && o.http.path !== op.http.path && asRegex(o.http.path).test(sample));
    check(!shadow, `${op.http.method} ${op.http.path} isn't shadowed by an earlier route`);
  }
  for (const op of OPS) {
    const params = [...op.http.path.matchAll(/:([a-zA-Z]+)/g)].map((m) => m[1]);
    check(params.every((p) => p in op.shape), `${op.name}: its path params are in its input`);
  }
}

// ── Who a delegated key acts as ──────────────────────────────────────────

function person(roleKey: string, siteIds: string[] | null, extra: { calendarEditor?: boolean; globalAdmin?: boolean } = {}): CurrentUser {
  const role = ROLES.find((r) => r.key === roleKey)!;
  return { userId: `u-${roleKey}`, name: `Jane Example (${roleKey})`, email: "jane@example.org", roleKey, roleName: role.name, permissions: permissionsFor(role, extra), siteIds } as CurrentUser;
}
const key = (siteId: string | null = null) => ({ name: "smoke", siteId });

async function principals() {
  const admin = person("admin", null);
  const superAdmin = person("admin", null, { globalAdmin: true });
  const siteAdmin = person("site_admin", ["s1", "s2"]);
  const staff = person("site_staff", ["s1"]);

  const p = delegatedUser(admin, key(), "people:manage");
  check(p.permissions.includes("users.manage") && p.permissions.length === 2, "admin + people:manage → users.manage, users.manageSite only");
  check(p.name.includes("(API key: smoke)"), "the audit name shows the key");
  check(!delegatedUser(superAdmin, key(), "people:manage").permissions.includes("admins.manage"), "a Super Admin's key never gets admins.manage");

  const pinned = delegatedUser(admin, key("s9"), "people:manage");
  check(pinned.permissions.join() === "users.manageSite" && pinned.siteIds?.join() === "s9", "a pinned key gets the site-bounded half, at its one site");
  await rejects(Promise.resolve().then(() => delegatedUser(admin, key("s9"), "settings:manage")), 403, "settings:manage refuses a pinned key");
  await rejects(Promise.resolve().then(() => delegatedUser(admin, key("s9"), "roster:import")), 403, "roster:import refuses a pinned key");

  const sa = delegatedUser(siteAdmin, key(), "sites:manage");
  check(sa.permissions.join() === "sites.manageRules" && sa.siteIds?.join() === "s1,s2", "site admin + sites:manage → only their sites' rules");
  check(delegatedUser(siteAdmin, key("s2"), "roster:write").siteIds?.join() === "s2", "pin ∩ creator's sites");
  check(delegatedUser(siteAdmin, key("s7"), "roster:write").siteIds?.length === 0, "a pin outside the creator's sites reaches no site");
  await rejects(Promise.resolve().then(() => delegatedUser(staff, key(), "settings:manage")), 403, "a creator without the permission can't use the scope");
  check(!delegatedUser(staff, key(), "roster:archive").permissions.includes("roster.restore"), "site staff + roster:archive: archive, not restore");
  check(delegatedUser(staff, key(), "calendar:read").permissions.length === 0, "calendar:read needs no permission");
  const scopes: ApiScope[] = Object.keys(SCOPE_GRANTS) as ApiScope[];
  check(scopes.every((s) => !delegatedUser(superAdmin, key(), s).permissions.includes("admins.manage")), "no delegated scope grants admins.manage");
}

// ── In-process routes ────────────────────────────────────────────────────

async function routes() {
  const r = Router();
  r.use(requireAuth);
  r.get("/who/:id", requirePermission("roster.view"), (req, res) => res.json({ name: req.user!.name, id: req.params.id, q: req.query.q }));
  r.post("/conflict", (req, res) => res.status(409).json({ error: "Changed since you read it", body: req.body }));
  r.delete("/boom", asyncHandler(async () => { throw new HttpError(422, "nope"); }));
  const as = { user: delegatedUser(person("site_manager", ["s1"]), key(), "roster:read"), apiKey: { id: "k", name: "smoke", scopes: [], siteId: null, createdById: "u" } as ResolvedKey };

  const who = await callRoute(r, { method: "GET", path: "/who/abc", query: { q: "x y" } }, as);
  check(who.status === 200 && (who.body as { id: string; q: string }).id === "abc" && (who.body as { q: string }).q === "x y", "a route runs with params and query");
  const conflict = await callRoute(r, { method: "POST", path: "/conflict", body: { a: 1 } }, as);
  check(conflict.status === 409 && (conflict.body as { body: { a: number } }).body.a === 1, "a route's own status and body come back");
  await rejects(callRoute(r, { method: "DELETE", path: "/boom" }, as), 422, "a thrown HttpError is rethrown");
  await rejects(callRoute(r, { method: "GET", path: "/missing" }, as), 404, "no matching route is a 404");
  const noPerm = { ...as, user: { ...as.user, permissions: [] } };
  await rejects(callRoute(r, { method: "GET", path: "/who/abc" }, noPerm), 403, "the route's permission check applies");
}

// ── End to end (a throwaway database) ────────────────────────────────────

async function e2e() {
  const url = process.env.DATABASE_URL ?? "";
  const db = /database=([^;]+)/i.exec(url)?.[1] ?? "";
  if (!/smoke/i.test(db)) {
    console.error(`--e2e writes test people, sites and residents: point DATABASE_URL at a database with "smoke" in its name (now: "${db || "none"}").`);
    process.exit(1);
  }
  const { prisma } = await import("../src/prisma.js");
  const { createApp } = await import("../src/app.js");
  const { generateKey } = await import("../src/services/apiKeys.js");

  const stamp = Date.now().toString(36);
  const siteX = await prisma.site.create({ data: { code: `smoke-x-${stamp}`, name: "Smoke Hall X", entityName: `Smoke Hall X ${stamp} LP` } });
  const siteY = await prisma.site.create({ data: { code: `smoke-y-${stamp}`, name: "Smoke Hall Y" } });
  const admin = await prisma.user.create({ data: { name: "Ada Example", email: `ada.${stamp}@example.org`, roleKey: "admin", status: "active" } });
  const siteAdmin = await prisma.user.create({ data: { name: "Sam Sample", email: `sam.${stamp}@example.org`, roleKey: "site_admin", status: "active", sites: { create: [{ siteId: siteX.id }] } } });
  const makeKey = async (createdById: string | null, scopes: string[], siteId: string | null = null) => {
    const k = generateKey();
    await prisma.apiKey.create({ data: { name: `smoke ${stamp}`, prefix: k.prefix, hash: k.hash, scopes: scopes.join(","), siteId, createdById } });
    return k.key;
  };
  const delegated = Object.keys(SCOPE_GRANTS);
  const kAdmin = await makeKey(admin.id, [...delegated, "forms:build", "entries:write"]);
  const kSite = await makeKey(siteAdmin.id, ["roster:read", "roster:write", "people:manage", "sites:manage"]);
  const kPinned = await makeKey(admin.id, ["settings:manage", "people:manage"], siteX.id);
  const kOrphan = await makeKey(null, ["roster:read"]);

  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (k: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api/v1${path}`, { method, headers: { authorization: `Bearer ${k}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  let rpcId = 0;
  const mcp = async (k: string, method: string, params: unknown) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${k}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    return (await res.json()) as any;
  };
  const tool = async (k: string, name: string, args: Record<string, unknown>) => {
    const out = await mcp(k, "tools/call", { name, arguments: args });
    const text = out.result?.content?.[0]?.text ?? "";
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* plain text */ }
    return { isError: Boolean(out.result?.isError), data };
  };

  try {
    // Who am I
    const me = await api(kAdmin, "GET", "/me");
    check(me.status === 200 && me.body.actsOnBehalfOf?.name === "Ada Example" && me.body.delegated["roster:write"]?.usable, "GET /me shows the creator and usable scopes");
    check((await api(kOrphan, "GET", "/residents")).status === 403, "a key with no creator can't use a delegated operation");
    const pinned = await api(kPinned, "GET", "/settings");
    check(pinned.status === 403 && /every site/.test(pinned.body.error), "settings on a pinned key: 403 with the reason");

    // Residents
    const added = await api(kAdmin, "POST", "/residents", { site: siteX.code, firstName: "Jane", lastName: "Example", unit: "1A" });
    check(added.status === 200 && added.body.id, "POST /residents adds a resident");
    const rid = added.body.id as string;
    const list = await api(kAdmin, "GET", `/residents?site=${siteX.code}&q=Example`);
    check(list.status === 200 && list.body.items.some((t: { id: string }) => t.id === rid), "GET /residents finds them");
    const one = await api(kAdmin, "GET", `/residents/${rid}`);
    check(one.status === 200 && typeof one.body.version === "number", "GET /residents/:id has a version");
    check((await api(kAdmin, "PATCH", `/residents/${rid}`, { version: one.body.version + 5, unit: "2B" })).status === 409, "a stale version is refused (409)");
    const upd = await api(kAdmin, "PATCH", `/residents/${rid}`, { version: one.body.version, unit: "2B" });
    check(upd.status === 200 && upd.body.unit === "2B", "PATCH /residents/:id with the right version");
    check((await api(kAdmin, "POST", `/residents/${rid}/keep`)).status === 200, "keep");
    const noConfirm = await api(kAdmin, "POST", `/residents/${rid}/archive`, { reason: "Moved out" });
    check(noConfirm.status === 400 && /confirm/.test(noConfirm.body.error), "archive without confirm is refused");
    check((await api(kAdmin, "POST", `/residents/${rid}/archive`, { reason: "Moved out", confirm: true })).status === 200, "archive with confirm");
    check((await api(kAdmin, "POST", `/residents/${rid}/restore`)).status === 200, "restore");
    const auditRow = await prisma.auditEvent.findFirst({ where: { tenantId: rid, action: "tenant.archived" } });
    check(auditRow?.actorName === "Ada Example (API key: smoke " + stamp + ")" && auditRow.actorId === admin.id, "the route's own audit event names the creator and the key");
    const auditLog = await api(kAdmin, "GET", `/audit?site=${siteX.code}&limit=20`);
    check(auditLog.status === 200 && JSON.stringify(auditLog.body).includes("tenant.created"), "GET /audit shows the roster events");
    const att = await api(kAdmin, "POST", "/attendance", { site: siteX.code, title: "Smoke meeting", description: "Invented", entries: [{ tenantId: rid }] });
    check(att.status === 201 || att.status === 200, `take attendance (${att.status})`);

    // A Site Admin's key stays a Site Admin
    check((await api(kSite, "POST", "/residents", { site: siteY.code, firstName: "Sam", lastName: "Sample" })).status === 403, "site admin's key can't add at a site they don't have");
    check((await api(kSite, "POST", "/people", { email: `x.${stamp}@example.org`, roleKey: "admin", confirm: true })).status === 403, "site admin's key can't make an Admin");
    const invited = await api(kSite, "POST", "/people", { email: `pat.${stamp}@example.org`, roleKey: "site_staff", siteIds: [siteX.id] });
    check(invited.status === 201 || invited.status === 200, `site admin's key invites site staff at their site (${invited.status})`);
    check((await api(kSite, "POST", "/sites", { name: "Nope", code: `nope-${stamp}` })).status === 403, "site admin's key can't create a site");
    check((await api(kSite, "PATCH", `/sites/${siteX.id}/rules`, { attentionHours: 48 })).status === 200, "site admin's key sets their site's rules");

    // An Admin's key never touches Admins
    const pat = await prisma.user.findUniqueOrThrow({ where: { email: `pat.${stamp}@example.org` } });
    check((await api(kAdmin, "PATCH", `/people/${pat.id}`, { roleKey: "admin", confirm: true })).status === 403, "an Admin's key can't make someone an Admin");
    check((await api(kAdmin, "PATCH", `/people/${pat.id}`, { roleKey: "site_manager" })).status === 400, "a role change needs confirm");
    check((await api(kAdmin, "PATCH", `/people/${pat.id}`, { roleKey: "site_manager", confirm: true })).status === 200, "role change with confirm");

    // The creator loses access → so does the key
    await prisma.user.update({ where: { id: admin.id }, data: { status: "deactivated" } });
    check((await api(kAdmin, "GET", "/residents")).status === 403, "deactivating the creator turns the key's delegated scopes off");
    await prisma.user.update({ where: { id: admin.id }, data: { status: "active" } });

    // Settings, dev log, calendar
    check((await api(kAdmin, "GET", "/settings")).status === 200, "GET /settings");
    check((await api(kAdmin, "PATCH", "/settings", { autoApproveStaff: false })).status === 400, "access settings need confirm");
    check((await api(kAdmin, "GET", "/devlog/summary?range=1h")).status === 200, "GET /devlog/summary");
    const cat = await api(kAdmin, "POST", "/calendar/categories", { name: `Smoke ${stamp}`, colorSlot: 2 });
    check(cat.status === 201 || cat.status === 200, `create a calendar category (${cat.status})`);
    const today = new Date().toISOString().slice(0, 10);
    const ev = await api(kAdmin, "POST", "/calendar/events", { title: "Smoke event", allSites: false, siteIds: [siteX.id], allDay: true, startDate: today, endDate: today });
    check(ev.status === 200 && ev.body.id, "create a calendar event");
    const evs = await api(kAdmin, "GET", `/calendar/events?from=${today}&to=${today}`);
    check(evs.status === 200 && JSON.stringify(evs.body).includes("Smoke event"), "list calendar events");
    check((await api(kAdmin, "DELETE", `/calendar/events/${ev.body.id}`)).status === 400, "delete event needs confirm");
    check((await api(kAdmin, "DELETE", `/calendar/events/${ev.body.id}?confirm=true`)).status === 200, "delete event with ?confirm=true");

    // Import (dry run)
    const dry = await api(kAdmin, "POST", "/residents/import", { csv: `Property,Unit,Tenant\n${siteX.entityName},3C,"Placeholder, Maria"\n` });
    check(dry.status === 200 && dry.body.committed === false, "import dry run");

    // MCP: the same operations as tools
    const tools = await mcp(kAdmin, "tools/list", {});
    const toolNames: string[] = tools.result?.tools?.map((t: { name: string }) => t.name) ?? [];
    check(["whoami", "list_residents", "archive_resident", "create_calendar_event", "update_person", "create_form"].every((n) => toolNames.includes(n)), `MCP lists the new tools with the old (${toolNames.length})`);
    const viaMcp = await tool(kAdmin, "list_residents", { site: siteX.code });
    check(!viaMcp.isError && viaMcp.data.items.some((t: { id: string }) => t.id === rid), "MCP list_residents");
    const mcpNoConfirm = await tool(kAdmin, "archive_resident", { id: rid, reason: "Moved out" });
    check(mcpNoConfirm.isError && /confirm/.test(String(mcpNoConfirm.data)), "MCP archive_resident without confirm is refused");
    const created = await tool(kAdmin, "create_form", { title: `Smoke form ${stamp}`, publish: true });
    check(!created.isError && created.data.slug, "MCP create_form still works");

    // Entries: submit (as the key), void / restore / delete (as the creator)
    const sub = await api(kAdmin, "POST", `/forms/${created.data.slug}/entries`, { values: {} });
    check(sub.status === 200 && sub.body.id, `POST /forms/:form/entries (${sub.status} ${JSON.stringify(sub.body).slice(0, 120)})`);
    const eid = sub.body.id;
    check((await api(kAdmin, "POST", `/forms/${created.data.slug}/entries/${eid}/void`, { reason: "Test" })).status === 400, "void needs confirm");
    check((await api(kAdmin, "POST", `/forms/${created.data.slug}/entries/${eid}/void`, { reason: "Test", confirm: true })).status === 200, "void with confirm");
    check((await prisma.formEntry.findUniqueOrThrow({ where: { id: eid } })).status === "voided", "the entry is void");
    check(Boolean(await prisma.auditEvent.findFirst({ where: { action: "entries.voided", actorId: admin.id } })), "voiding is audited");
    check((await api(kAdmin, "POST", `/forms/${created.data.slug}/entries/${eid}/restore`)).status === 200, "restore entry");
    check((await api(kAdmin, "DELETE", `/forms/${created.data.slug}/entries/${eid}?confirm=true`)).status === 200, "delete entry with confirm");
    check(!(await prisma.formEntry.findUnique({ where: { id: eid } })), "the entry is gone");
  } finally {
    server.close();
    await prisma.$disconnect();
  }
}

await registry();
await principals();
await routes();
if (process.argv.includes("--e2e")) await e2e();
console.log(`\n${passed} checks passed.`);
process.exit(0);
