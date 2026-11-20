/**
 * Checks Applicants (services/applicants.ts, routes/applicants.ts) end to end,
 * over HTTP against an in-process server: add, stages, accept (a resident not
 * moved in, with client information filled), move in, close and reopen, the
 * report, who may do what (another site, view only, the roster alone, the
 * switch off), and the MCP tools.
 *
 *   DEV_AUTH=true DATABASE_URL=<a throwaway database> FORM_BACKUP_REPO=" " FORM_BACKUP_TOKEN=" " \
 *     npx tsx scripts/applicants-check.ts --throwaway=<that database's name>
 *
 * It makes its own sites, people and an API key (names are invented), turns
 * case management on while it runs, and puts the setting back after. Stops at
 * the first failed check, exiting non-zero.
 */
import type { AddressInfo } from "node:net";

// Named, and checked against the database actually reached, so a stray DATABASE_URL can't send it anywhere else.
const throwaway = process.argv.find((a) => a.startsWith("--throwaway="))?.slice("--throwaway=".length);
if (!throwaway) {
  console.error("This writes test sites, people and applicants: run it against a throwaway database, naming it with --throwaway=<database>.");
  process.exit(1);
}

const { prisma } = await import("../src/prisma.js");
const [{ db }] = await prisma.$queryRawUnsafe<{ db: string }[]>("SELECT DB_NAME() AS db");
if (db !== throwaway) {
  console.error(`DATABASE_URL reaches "${db}", not "${throwaway}". Nothing was written.`);
  process.exit(1);
}
const { createApp } = await import("../src/app.js");
const { setTestPrograms } = await import("../src/services/clientFields.js");
const { generateKey } = await import("../src/services/apiKeys.js");
const { todayNY, addDays } = await import("../src/services/checklist.js");

let passed = 0;
class Failed extends Error {}
function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Failed(what);
  passed++;
  console.log(`✓ ${what}`);
}

const stamp = Date.now().toString(36);
const today = todayNY();
const before = await prisma.setting.findUnique({ where: { key: "caseManagement" } });
const setSwitch = (on: boolean) => prisma.setting.upsert({ where: { key: "caseManagement" }, create: { key: "caseManagement", value: String(on) }, update: { value: String(on) } });

// Sites: two supportive, each with a made-up program, and a shelter.
const siteA = await prisma.site.create({ data: { code: `appl-a-${stamp}`, name: `Applewood Hall ${stamp}`, siteType: "supportive" } });
const siteB = await prisma.site.create({ data: { code: `appl-b-${stamp}`, name: `Birchall House ${stamp}`, siteType: "supportive" } });
const shelter = await prisma.site.create({ data: { code: `appl-s-${stamp}`, name: `Crestmoor Shelter ${stamp}`, siteType: "shelter" } });
const PROGRAM_A = `Applewood Hall ${stamp} - Test Single Adults`;
const PROGRAM_B = `Birchall House ${stamp} - Test Families`;
setTestPrograms([{ site: siteA.code, value: PROGRAM_A }, { site: siteB.code, value: PROGRAM_B }]);

const person = (name: string, roleKey: string, sites: string[], extra: { clientInfoAccess?: boolean } = {}) =>
  prisma.user.create({
    data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}.${stamp}@example.org`, roleKey, status: "active", ...extra, sites: { create: sites.map((siteId) => ({ siteId, approved: true })) } },
  });
const admin = await person("Ada Admin", "admin", []);
const managerA = await person("Mona Manager", "site_manager", [siteA.id]);
const managerB = await person("Bo Manager", "site_manager", [siteB.id]);
const viewerA = await person("Vic Viewer", "site_staff", [siteA.id], { clientInfoAccess: true });
const staffA = await person("Sid Staff", "site_staff", [siteA.id]);

const server = createApp().listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function signIn(userId: string) {
  const res = await fetch(`${base}/api/auth/dev-login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }) });
  if (res.status !== 200) throw new Failed(`dev-login answered ${res.status}: is DEV_AUTH=true?`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
const people = { admin, managerA, managerB, viewerA, staffA };
type Who = keyof typeof people;
const jars = {} as Record<Who, string>;
async function call(who: Who, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { cookie: jars[who], "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

try {
  await setSwitch(true);
  for (const [who, u] of Object.entries(people)) jars[who as Who] = await signIn(u.id);

  // ── Add ────────────────────────────────────────────────────────────────
  const empty = await call("managerA", "GET", `/applicants?site=${siteA.code}`);
  check(empty.status === 200 && empty.body.items.length === 0 && empty.body.can.manage === true, "a Site Manager lists their site's applicants (none yet)");

  const referred = addDays(today, -40);
  const add = await call("managerA", "POST", "/applicants", {
    site: siteA.code, firstName: "Juno", middleName: "Q", lastName: `Example${stamp}`, dateOfBirth: "1980-04-02", phone: "(555) 010-1234",
    email: "juno.example@example.com", program: PROGRAM_A, referralSource: "HASA", referralAgency: "Made-up Outreach", referralDate: referred, eligibilityNotes: "Has a letter.",
  });
  check(add.status === 201 && add.body.stage === "referred" && add.body.stageDate === referred && add.body.history.length === 1 && add.body.open === true, "add: starts at Referred on the referral date, with one step");
  let juno = add.body;

  check((await call("managerA", "POST", "/applicants", { site: siteA.code, firstName: "X", email: "not-an-email" })).status === 400, "add: a bad email is refused");
  check((await call("managerA", "POST", "/applicants", { site: siteA.code, firstName: "X", program: PROGRAM_B })).status === 400, "add: another site's program is refused");
  check((await call("managerA", "POST", "/applicants", { site: siteA.code, firstName: "X", dateOfBirth: addDays(today, 3) })).status === 400, "add: a date of birth in the future is refused");
  check((await call("managerA", "POST", "/applicants", { site: siteA.code, firstName: " " })).status === 400, "add: a first name is needed");
  check((await call("admin", "POST", "/applicants", { site: shelter.code, firstName: "X" })).status === 400, "add: a shelter takes no applicants");

  const kai = (await call("managerA", "POST", "/applicants", { site: siteA.code, firstName: "Kai", lastName: `Sample${stamp}`, referralSource: "HPD" })).body;
  check(kai.stage === "referred" && kai.stageDate === today, "add without a referral date: referred today");

  // ── Edit ───────────────────────────────────────────────────────────────
  const edited = await call("managerA", "PATCH", `/applicants/${juno.id}`, { version: juno.version, phone: "(555) 010-9999" });
  check(edited.status === 200 && edited.body.phone === "(555) 010-9999" && edited.body.version === juno.version + 1, "edit: details change and the version moves on");
  check((await call("managerA", "PATCH", `/applicants/${juno.id}`, { version: juno.version, phone: "(555) 010-0000" })).status === 409, "edit: a stale version is refused (409)");
  juno = edited.body;

  // ── Stages ─────────────────────────────────────────────────────────────
  const move = (who: Who, a: { id: string; version: number }, body: Record<string, unknown>) => call(who, "POST", `/applicants/${a.id}/stage`, { version: a.version, ...body });
  let r = await move("managerA", juno, { stage: "eligibility_review", date: addDays(today, -30) });
  check(r.status === 200 && r.body.stage === "eligibility_review" && r.body.history.length === 2, "move: Referred → Eligibility review");
  juno = r.body;
  check((await move("managerA", juno, { stage: "eligibility_review" })).status === 400, "move: to the stage they're at is refused");
  check((await move("managerA", juno, { stage: "eligible", date: addDays(today, 2) })).status === 400, "move: a date in the future is refused");
  r = await move("managerA", juno, { stage: "eligible", date: addDays(today, -20), note: "Documents in." });
  check(r.status === 200 && r.body.stage === "eligible" && r.body.history[0].note === "Documents in.", "move: → Eligible, with a note");
  juno = r.body;
  check((await move("managerA", juno, { stage: "viewing_scheduled" })).status === 400, "move: a viewing needs its day");
  r = await move("managerA", juno, { stage: "viewing_scheduled", date: addDays(today, -10), viewingDate: addDays(today, -5) });
  check(r.status === 200 && r.body.viewingDate === addDays(today, -5), "move: → Viewing scheduled, with the viewing's day");
  juno = r.body;
  check((await move("managerA", { ...juno, version: juno.version - 1 }, { stage: "eligible" })).status === 409, "move: a stale version is refused (409)");
  check((await move("managerA", juno, { stage: "accepted" })).status === 400, "move: Accepted only through Accept");

  // ── Accept ─────────────────────────────────────────────────────────────
  check((await call("managerA", "POST", `/applicants/${kai.id}/accept`, { version: kai.version })).status === 400, "accept: someone only referred can't be accepted yet");
  const acc = await call("managerA", "POST", `/applicants/${juno.id}/accept`, { version: juno.version, date: addDays(today, -3) });
  check(acc.status === 200 && acc.body.applicant.stage === "accepted" && acc.body.applicant.tenantId === acc.body.resident.id, "accept: the applicant points at the new resident");
  check(acc.body.applicant.open === true && acc.body.applicant.outcome === "Waiting to move in", "accept: still open, waiting to move in");
  const tenantId: string = acc.body.resident.id;
  const resident = await call("managerA", "GET", `/tenants/${tenantId}`);
  check(resident.status === 200 && resident.body.movedIn === false && resident.body.siteId === siteA.id && resident.body.status === "active" && resident.body.unitId === null, "accept: on the site's roster, not moved in");
  check(resident.body.displayName === `Juno Example${stamp}`, "accept: the resident has the applicant's name");
  const profile = await call("admin", "GET", `/tenants/${tenantId}/profile`);
  const v = profile.body.profile.values;
  check(
    v.dateOfBirth === "1980-04-02" && v.middleName === "Q" && v.phone === "(555) 010-9999" && v.email === "juno.example@example.com" && v.program === PROGRAM_A &&
      v.referralDate === referred && v.referralSource === "HASA" && v.referralProgram === PROGRAM_A && v.eligible === "Yes",
    "accept: date of birth, contact, program and referral copied into client information"
  );
  check((await call("managerA", "POST", `/applicants/${juno.id}/accept`, { version: acc.body.applicant.version })).status === 400, "accept: twice is refused");
  check((await move("managerA", acc.body.applicant, { stage: "eligible" })).status === 400, "move: an accepted applicant doesn't move any more");
  const created = await prisma.auditEvent.findFirst({ where: { tenantId, action: "tenant.created" } });
  check(created?.actorId === managerA.id, "accept: the resident was added through Add resident (its audit event, by the manager)");

  // ── Move in → done; the report's referral-to-move-in time ───────────────
  const unit = await call("admin", "POST", "/residency/units", { site: siteA.code, label: `A-${stamp.slice(-3)}` });
  check(unit.status === 201 || unit.status === 200, `a unit to move into (${unit.status})`);
  const movedIn = await call("managerA", "POST", `/residency/units/${unit.body.id}/move-in`, { date: today, people: [{ tenantId }] });
  check(movedIn.status === 200, `move in (${movedIn.status} ${JSON.stringify(movedIn.body).slice(0, 120)})`);
  const open = await call("managerA", "GET", `/applicants?site=${siteA.code}`);
  check(!open.body.items.some((a: { id: string }) => a.id === juno.id), "moved in: no longer open");
  const closedList = await call("managerA", "GET", `/applicants?site=${siteA.code}&status=closed`);
  const done = closedList.body.items.find((a: { id: string }) => a.id === juno.id);
  check(done?.outcome === "Moved in" && done.resident.movedIn === true, "moved in: closed, outcome Moved in");

  // ── Close, reopen ──────────────────────────────────────────────────────
  let k = kai;
  check((await move("managerA", k, { stage: "declined" })).status === 400, "close: needs a reason");
  check((await move("managerA", k, { stage: "declined", reason: "Over Income" })).status === 400, "close: the reason must be one of that outcome's");
  check((await move("managerA", k, { stage: "withdrawn", reason: "Other" })).status === 400, "close: Other needs a note");
  r = await move("managerA", k, { stage: "declined", reason: "Unit Size" });
  check(r.status === 200 && r.body.open === false && r.body.outcome === "Declined" && r.body.outcomeReason === "Unit Size", "close: Declined (Unit Size)");
  k = r.body;
  check(!(await call("managerA", "GET", `/applicants?site=${siteA.code}`)).body.items.some((a: { id: string }) => a.id === k.id), "closed: not in the open list");
  check((await call("managerA", "GET", `/applicants?site=${siteA.code}&status=closed`)).body.items.some((a: { id: string }) => a.id === k.id), "closed: in the closed list");
  r = await move("managerA", k, { stage: "eligibility_review", note: "They called back." });
  check(r.status === 200 && r.body.open === true && r.body.outcomeReason === null && r.body.history.length === 3, "reopen: back to Eligibility review, reason cleared, history kept");
  k = r.body;

  // ── Filters ────────────────────────────────────────────────────────────
  const three = (await call("managerA", "POST", "/applicants", { site: siteA.code, firstName: "Lux", lastName: `Sample${stamp}`, program: PROGRAM_A })).body;
  const byStage = await call("managerA", "GET", `/applicants?site=${siteA.code}&stage=eligibility_review`);
  check(byStage.body.items.length === 1 && byStage.body.items[0].id === k.id, "filter: by stage");
  const byProgram = await call("managerA", "GET", `/applicants?site=${siteA.code}&program=${encodeURIComponent(PROGRAM_A)}`);
  check(byProgram.body.items.length === 1 && byProgram.body.items[0].id === three.id, "filter: by program");
  const everyone = await call("admin", "GET", `/applicants?site=${siteA.code},${siteB.code}&status=all`);
  check(everyone.body.items.length === 3, "filter: everyone (open and closed) at two sites");
  check((await call("admin", "GET", `/applicants?stage=nope`)).status === 400, "filter: an unknown stage is refused");

  // ── Report ─────────────────────────────────────────────────────────────
  const rep = await call("managerA", "GET", `/applicants/report?site=${siteA.code}`);
  const rowA = rep.body.bySite?.find((s: { siteId: string }) => s.siteId === siteA.id);
  check(rep.status === 200 && rowA.referred === 1 && rowA.eligibility_review === 1 && rowA.waiting === 0 && rowA.open === 2, "report: open applicants by stage at the site");
  check(rep.body.referralToMoveIn.count === 1 && rep.body.referralToMoveIn.medianDays === 40 && rowA.medianDays === 40, "report: 40 days from referral to move-in");

  // ── Who may do what ────────────────────────────────────────────────────
  check((await call("managerB", "GET", `/applicants?site=${siteA.code}`)).status === 403, "another site's manager can't list it");
  check((await call("managerB", "PATCH", `/applicants/${k.id}`, { version: k.version, phone: "(555) 010-1111" })).status === 404, "another site's manager can't change its applicants");
  check((await call("managerB", "POST", `/applicants/${k.id}/stage`, { version: k.version, stage: "eligible" })).status === 404, "…nor move them");
  check((await call("managerB", "POST", "/applicants", { site: siteA.code, firstName: "X" })).status === 404, "…nor add one there");
  const bOwn = (await call("managerB", "POST", "/applicants", { site: siteB.code, firstName: "Mo", lastName: `Sample${stamp}`, program: PROGRAM_B })).body;
  check((await call("managerB", "PATCH", `/applicants/${bOwn.id}`, { version: bOwn.version, site: siteA.code })).status === 404, "…nor move their own to a site they don't have");
  const mine = await call("managerB", "GET", "/applicants");
  check(mine.status === 200 && mine.body.items.every((a: { siteId: string }) => a.siteId === siteB.id) && mine.body.items.length === 1, "a manager's list is their own sites only");
  const view = await call("viewerA", "GET", `/applicants?site=${siteA.code}`);
  check(view.status === 200 && view.body.can.manage === false && view.body.items.length === 2, "client information (view) sees them, can't manage");
  check((await call("viewerA", "POST", "/applicants", { site: siteA.code, firstName: "X" })).status === 403, "view only: can't add");
  check((await call("viewerA", "POST", `/applicants/${k.id}/stage`, { version: k.version, stage: "eligible" })).status === 403, "view only: can't move");
  check((await call("viewerA", "GET", `/applicants/report?site=${siteA.code}`)).status === 200, "view only: sees the report");
  check((await call("staffA", "GET", `/applicants?site=${siteA.code}`)).status === 403, "roster.view alone: no applicants");
  check((await call("staffA", "GET", "/applicants/meta")).status === 403, "roster.view alone: not even the lists");

  // ── MCP and REST (as the Admin who made the key) ───────────────────────
  const key = generateKey();
  await prisma.apiKey.create({ data: { name: `applicants ${stamp}`, prefix: key.prefix, hash: key.hash, scopes: "clients:read,roster:write", siteId: null, createdById: admin.id } });
  let rpc = 0;
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }),
    });
    const out = (await res.json()) as any;
    const text = out.result?.content?.[0]?.text ?? "";
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* plain text */ }
    return { isError: Boolean(out.result?.isError), data };
  };
  const mAdd = await tool("add_applicant", { site: siteB.code, firstName: "Nia", lastName: `Mcp${stamp}`, referralDate: addDays(today, -15), program: PROGRAM_B });
  check(!mAdd.isError && mAdd.data.stage === "referred", "MCP add_applicant");
  const mUpd = await tool("update_applicant", { id: mAdd.data.id, version: mAdd.data.version, phone: "(555) 010-2222", stage: "eligible", date: addDays(today, -5) });
  check(!mUpd.isError && mUpd.data.stage === "eligible" && mUpd.data.phone === "(555) 010-2222", "MCP update_applicant: details and a stage in one call");
  const mList = await tool("list_applicants", { site: siteB.code });
  check(!mList.isError && mList.data.items.some((a: { id: string }) => a.id === mAdd.data.id), "MCP list_applicants");
  const mAcc = await tool("accept_applicant", { id: mAdd.data.id, version: mUpd.data.version });
  check(!mAcc.isError && mAcc.data.resident.movedIn === false && mAcc.data.copied.includes("program"), "MCP accept_applicant: a resident, not moved in, client information filled");
  const rest = await fetch(`${base}/api/v1/applicants?site=${siteB.code}&status=all`, { headers: { authorization: `Bearer ${key.key}` } });
  check(rest.status === 200, "REST GET /api/v1/applicants");

  // ── Audit ──────────────────────────────────────────────────────────────
  const actions = new Set((await prisma.auditEvent.findMany({ where: { siteId: siteA.id, action: { startsWith: "applicant." } }, select: { action: true } })).map((a) => a.action));
  check(["applicant.created", "applicant.updated", "applicant.moved", "applicant.accepted", "applicant.closed", "applicant.reopened"].every((a) => actions.has(a)), "every change is audited");
  check(Boolean(await prisma.auditEvent.findFirst({ where: { tenantId, action: "tenant.profile_updated" } })), "the client information filled in on accept is audited");
  const history = await call("staffA", "GET", `/tenants/${tenantId}`);
  check(!history.body.history.some((h: { action: string }) => h.action === "tenant.profile_updated"), "…and stays off the resident's History for people without client information");

  // ── Switched off ───────────────────────────────────────────────────────
  await setSwitch(false);
  check((await call("admin", "GET", "/applicants")).status === 404, "switched off: the list is a 404");
  check((await call("admin", "POST", "/applicants", { site: siteA.code, firstName: "X" })).status === 404, "switched off: adding is a 404");
  check((await call("admin", "POST", `/applicants/${k.id}/stage`, { version: k.version, stage: "eligible" })).status === 404, "switched off: moving is a 404");
  check((await tool("list_applicants", {})).isError, "switched off: the MCP tool fails");
} catch (err) {
  console.error(err instanceof Failed ? `✗ ${err.message}` : err);
  process.exitCode = 1;
} finally {
  server.close();
  setTestPrograms(null);
  if (before) await prisma.setting.update({ where: { key: "caseManagement" }, data: { value: before.value } });
  else await prisma.setting.delete({ where: { key: "caseManagement" } }).catch(() => undefined);
  await prisma.$disconnect();
}
if (!process.exitCode) console.log(`\n${passed} checks passed.`);
process.exit(process.exitCode ?? 0);
