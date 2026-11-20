/**
 * Checks for unfinished answers saved to the person's account (FormDraft,
 * services/formDrafts.ts, routes/formDrafts.ts), over HTTP against a running
 * local backend and its throwaway database:
 *
 *   DATABASE_URL=<throwaway db> npx tsx scripts/drafts-check.ts --db <its name> --base http://localhost:4234
 *
 * The backend must run with DEV_AUTH=true on the same database (and, as
 * always locally, FORM_BACKUP_REPO / FORM_BACKUP_TOKEN blank). --db must repeat
 * the database's name, on localhost, so this can't be pointed at a real one by
 * accident: it makes people and forms (invented names, "drafts-check-" slugs)
 * and removes them again at the end.
 *
 * Exits non-zero on the first failed check.
 */
import { prisma } from "../src/prisma.js";
import { createForm, publishForm } from "../src/forms/service.js";
import { MAX_DRAFTS_PER_FORM, sweepOldDrafts } from "../src/services/formDrafts.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const BASE = (arg("base") ?? "http://localhost:4234").replace(/\/$/, "");
const url = process.env.DATABASE_URL ?? "";
const dbName = /database=([^;]+)/i.exec(url)?.[1];
if (!dbName || dbName !== arg("db") || !/sqlserver:\/\/(localhost|127\.0\.0\.1)[:;]/i.test(url)) {
  console.error("Refusing: pass --db <name> matching DATABASE_URL's database, on localhost (a throwaway database).");
  process.exit(2);
}

let passed = 0;
function check(cond: unknown, what: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${what}`);
    process.exit(1);
  }
  passed++;
  console.log(`✓ ${what}`);
}

/** A signed-in browser: keeps its cookies. */
class Person {
  cookies = new Map<string, string>();
  constructor(public label: string) {}
  async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const at = pair.indexOf("=");
      const value = pair.slice(at + 1);
      if (value) this.cookies.set(pair.slice(0, at), value);
      else this.cookies.delete(pair.slice(0, at));
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  }
}

const RUN = Date.now().toString(36);
const slugOf = (s: string) => `drafts-check-${s}-${RUN}`;
const made = { users: [] as string[], forms: [] as string[] };

async function person(label: string, roleKey: string, extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({ data: { name: `Draftcheck ${label}`, email: `draftcheck.${label.toLowerCase()}.${RUN}@example.org`, roleKey, status: "active", ...extra } });
  made.users.push(u.id);
  const p = new Person(label);
  const r = await p.call("POST", "/auth/dev-login", { userId: u.id });
  check(r.status === 200, `${label} signs in (dev)`);
  return Object.assign(p, { id: u.id });
}

const fields = [
  { id: "notes", type: "textarea", label: "Notes" },
  { id: "who", type: "text", label: "Who" },
  { id: "sig", type: "signature", label: "Signature" },
  { id: "att", type: "file", label: "Attachment" },
  { id: "rows", type: "repeater", label: "Rows", fields: [{ id: "t", type: "text", label: "Text" }] },
];

async function form(key: string, settings: Record<string, unknown>, publish = true) {
  const actor = { id: null, name: "Drafts check" };
  const doc = {
    format: "lcs-form",
    version: 1,
    title: `Drafts check ${key}`,
    description: "",
    fields,
    settings: { submitLabel: "Submit", access: { mode: "signed_in" }, confirmation: { type: "message", message: "<p>Thanks.</p>" }, notifications: [], saveDrafts: true, ...settings },
  };
  const f = await createForm({ doc, slug: slugOf(key) }, actor);
  made.forms.push(f.id);
  if (publish) await publishForm(f.id, actor);
  return f.slug;
}

const SIG = `data:image/png;base64,${"A".repeat(2000)}`;
const put = (p: Person, slug: string, id: string, body: Record<string, unknown>) => p.call("PUT", `/f/${slug}/drafts/${id}`, body);
const draftId = (n: string) => `dc-${RUN}-${n}`.padEnd(12, "x");

async function main() {
  const a = await person("Avery", "site_staff");
  const b = await person("Blake", "site_staff");
  const admin = await person("Casey", "admin", { viewAsEnabled: true });
  const signedOut = new Person("nobody");

  const F = await form("main", {});

  // ── Only while case management is on (routes/formDrafts.ts); otherwise answers stay on the device ──
  caseManagementWas = (await prisma.setting.findUnique({ where: { key: "caseManagement" } }))?.value ?? null;
  await setCaseManagement("false");
  check((await a.call("GET", `/f/${F}/drafts`)).status === 404, "case management off: drafts aren't offered (404)");
  check((await put(a, F, draftId("off"), { values: { notes: "x" } })).status === 404, "case management off: saving to the account is refused (404)");
  check((await prisma.formDraft.count({ where: { userId: a.id } })) === 0, "case management off: nothing was kept in the account");
  await setCaseManagement("true");

  const PUB = await form("public", { access: { mode: "public" } });
  const LINK = await form("link", { access: { mode: "link" } });
  const OFF = await form("off", { saveDrafts: false });
  const ROLES = await form("roles", { access: { mode: "roles", roles: ["main_office"] } });
  const UNPUBLISHED = await form("unpublished", {}, false);

  // ── Saving, listing, reading ──
  check((await signedOut.call("GET", `/f/${F}/drafts`)).status === 401, "signed out: listing drafts is refused (401)");
  check((await put(signedOut, F, draftId("x"), { values: {}, writer: "writer-out-1" })).status === 401, "signed out: saving a draft is refused (401)");
  let r = await a.call("GET", `/f/${F}/drafts`);
  check(r.status === 200 && Array.isArray(r.body.drafts) && r.body.drafts.length === 0, "a new person has no drafts");

  const d1 = draftId("one");
  r = await put(a, F, d1, {
    values: { notes: "First visit", who: "x", sig: SIG, att: [{ id: "file1", name: "a.pdf", size: 1, mime: "application/pdf" }], rows: [{ t: "row one" }], bogus: "not a question" },
    label: "Pat Example",
    page: 2,
    siteCode: "SITE1",
    formVersion: 1,
    writer: "writer-a-1",
    base: null,
  });
  check(r.status === 200 && r.body.id === d1 && r.body.label === "Pat Example" && r.body.page === 2, "a draft saves under the id the device made, with its label and page");
  check(r.body.dropped === true, "the save says signatures and files were left out");
  const firstSave = r.body.updatedAt as string;
  r = await a.call("GET", `/f/${F}/drafts/${d1}`);
  check(r.status === 200 && r.body.values.notes === "First visit" && r.body.values.who === "x", "the draft reads back with its answers");
  check(!("sig" in r.body.values) && !("att" in r.body.values), "signature and file answers aren't kept");
  check(r.body.values.rows?.[0]?.t === "row one", "repeater rows are kept");
  check(!("bogus" in r.body.values), "answers to questions the form doesn't have aren't kept");
  check(r.body.siteCode === "SITE1", "the picked site is kept");
  r = await a.call("GET", `/f/${F}/drafts`);
  check(r.status === 200 && r.body.drafts.length === 1 && r.body.drafts[0].id === d1 && !("values" in r.body.drafts[0]), "the list shows the draft, without its answers");

  // ── Updating, and the same draft open in two places ──
  await new Promise((res) => setTimeout(res, 20));
  r = await put(a, F, d1, { values: { notes: "Second visit" }, writer: "writer-a-1", base: firstSave });
  check(r.status === 200 && r.body.updatedAt !== firstSave, "saving again updates the draft");
  const secondSave = r.body.updatedAt as string;
  r = await put(a, F, d1, { values: { notes: "Third, same page" }, writer: "writer-a-1", base: firstSave });
  check(r.status === 200, "the same open page saving again is never a conflict (even with an older base)");
  const thirdSave = r.body.updatedAt as string;
  r = await put(a, F, d1, { values: { notes: "From an old iPad" }, writer: "writer-a-ipad", base: secondSave });
  check(r.status === 409 && r.body.details?.reason === "changed", "another copy saving over answers it never saw is refused (409 changed)");
  r = await put(a, F, d1, { values: { notes: "From an old iPad" }, writer: "writer-a-ipad", base: null });
  check(r.status === 409 && r.body.details?.reason === "changed", "another copy that thinks the draft is new is refused too");
  r = await a.call("GET", `/f/${F}/drafts/${d1}`);
  check(r.body.values.notes === "Third, same page", "…and the newer answers are untouched");
  r = await put(a, F, d1, { values: { notes: "Carried on, desktop" }, writer: "writer-a-desk", base: thirdSave });
  check(r.status === 200, "another copy that saw the latest save may carry on with it");

  // ── Only its owner ──
  check((await b.call("GET", `/f/${F}/drafts/${d1}`)).status === 404, "someone else can't read it (404)");
  check((await put(b, F, d1, { values: { notes: "hijack" }, writer: "writer-b-1", base: null })).status === 404, "someone else can't save over it (404)");
  r = await b.call("DELETE", `/f/${F}/drafts/${d1}`);
  check(r.status === 200 && r.body.removed === false, "someone else can't discard it");
  check((await b.call("GET", `/f/${F}/drafts`)).body.drafts.length === 0, "someone else's list doesn't have it");
  check((await admin.call("GET", `/f/${F}/drafts/${d1}`)).status === 404, "an Admin can't read it either");
  check((await admin.call("GET", `/f/${F}/drafts`)).body.drafts.length === 0, "an Admin's list doesn't have it");
  check((await a.call("GET", `/f/${F}/drafts/${d1}`)).body.values.notes === "Carried on, desktop", "…and it's still the owner's, unchanged");

  // Viewing (and acting) as the owner shows nothing of theirs.
  const viewer = new Person("viewer");
  viewer.cookies = new Map(admin.cookies);
  check((await viewer.call("POST", "/auth/view-as", { userId: a.id })).status === 200, "an Admin with View as views the site as the owner");
  check((await viewer.call("GET", `/f/${F}/drafts`)).status === 403, "viewing as the owner: their drafts aren't listed (403)");
  check((await viewer.call("GET", `/f/${F}/drafts/${d1}`)).status === 403, "viewing as the owner: their draft can't be read (403)");
  check((await viewer.call("PATCH", "/auth/view-as", { act: true })).status === 200, "…then acts as them");
  check((await viewer.call("GET", `/f/${F}/drafts/${d1}`)).status === 403, "acting as the owner: still can't read it (403)");
  check((await put(viewer, F, draftId("viewer"), { values: { notes: "x" }, writer: "writer-viewer-1" })).status === 403, "acting as the owner: can't save one in their name (403)");

  // ── Forms that don't keep drafts ──
  check((await a.call("GET", `/f/${PUB}/drafts`)).status === 403, "a public form: no drafts (403)");
  check((await put(a, PUB, draftId("pub"), { values: { notes: "x" }, writer: "writer-a-1" })).status === 403, "a public form: saving refused (403)");
  check((await a.call("GET", `/f/${LINK}/drafts`)).status === 403, "a form shared by link: no drafts (403)");
  check((await put(a, LINK, draftId("link"), { values: { notes: "x" }, writer: "writer-a-1" })).status === 403, "a form shared by link: saving refused (403)");
  check((await a.call("GET", `/f/${OFF}/drafts`)).status === 403, "saveDrafts false: no drafts (403)");
  check((await put(a, OFF, draftId("off"), { values: { notes: "x" }, writer: "writer-a-1" })).status === 403, "saveDrafts false: saving refused (403)");
  check((await a.call("GET", `/f/${ROLES}/drafts`)).status === 403, "a form limited to other roles: no drafts (403)");
  check((await a.call("GET", `/f/${UNPUBLISHED}/drafts`)).status === 404, "a form that isn't published: no drafts (404)");
  check((await a.call("GET", `/f/drafts-check-no-such-form-${RUN}/drafts`)).status === 404, "no such form: 404");

  // ── Bad input ──
  check((await put(a, F, "short", { values: {}, writer: "writer-a-1" })).status === 400, "an id that isn't a draft id is refused (400)");
  check((await put(a, F, draftId("w"), { values: {}, writer: "x" })).status === 400, "a missing or bad writer is refused (400)");
  check((await put(a, F, draftId("big"), { values: { notes: "x".repeat(950_000) }, writer: "writer-a-1" })).status === 413, "answers too long to keep are refused (413)");

  // ── The cap ──
  const have = (await a.call("GET", `/f/${F}/drafts`)).body.drafts.length as number;
  for (let i = have; i < MAX_DRAFTS_PER_FORM; i++) {
    r = await put(a, F, draftId(`cap${i}`), { values: { notes: `resident ${i}` }, label: `Resident ${i}`, writer: "writer-a-cap" });
    if (r.status !== 200) check(false, `draft ${i + 1} of ${MAX_DRAFTS_PER_FORM} saves (got ${r.status})`);
  }
  check((await a.call("GET", `/f/${F}/drafts`)).body.drafts.length === MAX_DRAFTS_PER_FORM, `${MAX_DRAFTS_PER_FORM} drafts of one form are kept`);
  r = await put(a, F, draftId("over"), { values: { notes: "one too many" }, writer: "writer-a-cap" });
  check(r.status === 409 && r.body.details?.reason === "full", `a ${MAX_DRAFTS_PER_FORM + 1}st is refused (409 full), saying why`);
  r = await put(a, F, draftId("cap1"), { values: { notes: "still saves" }, writer: "writer-a-cap", base: null });
  check(r.status === 200, "at the cap, an existing draft still saves");
  r = await put(b, F, draftId("blake1"), { values: { notes: "Blake's own" }, writer: "writer-b-1" });
  check(r.status === 200, "the cap is per person: someone else can still save one");

  // ── Discard ──
  r = await a.call("DELETE", `/f/${F}/drafts/${draftId("cap2")}`);
  check(r.status === 200 && r.body.removed === true, "the owner discards a draft");
  check((await a.call("GET", `/f/${F}/drafts/${draftId("cap2")}`)).status === 404, "…and it's gone");

  // ── Filing removes it ──
  r = await a.call("POST", `/f/${F}/submit`, { values: { notes: "Filed" }, clientId: `dc-${RUN}-submit1`, draftId: d1 });
  check(r.status === 201, "filing the form with its draft id works");
  check((await a.call("GET", `/f/${F}/drafts/${d1}`)).status === 404, "the draft is removed once its entry is filed");
  r = await b.call("POST", `/f/${F}/submit`, { values: { notes: "Blake filed" }, clientId: `dc-${RUN}-submit2`, draftId: draftId("cap3") });
  check(r.status === 201 && (await a.call("GET", `/f/${F}/drafts/${draftId("cap3")}`)).status === 200, "filing with someone else's draft id leaves their draft alone");
  const entries = await a.call("GET", `/f/${F}/entries`);
  check(entries.status === 200 && entries.body.items.every((e: { id: string }) => typeof e.id === "string") && entries.body.total >= 1, "entries list only filed entries");
  check(!JSON.stringify(entries.body).includes("resident 4"), "…none of the drafts' answers are in it");

  // ── The sweep ──
  const old = [draftId("cap4"), draftId("cap5")];
  await prisma.$executeRawUnsafe(`UPDATE [dbo].[FormDraft] SET [updatedAt] = DATEADD(day, -31, SYSUTCDATETIME()) WHERE [id] IN ('${old[0]}', '${old[1]}')`);
  await prisma.$executeRawUnsafe(`UPDATE [dbo].[FormDraft] SET [updatedAt] = DATEADD(day, -29, SYSUTCDATETIME()) WHERE [id] = '${draftId("cap6")}'`);
  const swept = await sweepOldDrafts();
  check(swept >= 2, `the sweep drops drafts not saved for 30 days (${swept})`);
  check((await a.call("GET", `/f/${F}/drafts/${old[0]}`)).status === 404 && (await a.call("GET", `/f/${F}/drafts/${old[1]}`)).status === 404, "…those are gone");
  check((await a.call("GET", `/f/${F}/drafts/${draftId("cap6")}`)).status === 200, "…one saved 29 days ago stays");

  // ── Removed with their person or form ──
  const gone = await person("Drew", "site_staff");
  check((await put(gone, F, draftId("drew"), { values: { notes: "x" }, writer: "writer-d-1" })).status === 200, "another person saves a draft");
  await prisma.user.delete({ where: { id: gone.id } });
  made.users = made.users.filter((id) => id !== gone.id);
  check((await prisma.formDraft.count({ where: { id: draftId("drew") } })) === 0, "deleting a person deletes their drafts");
  const formId = (await prisma.builtForm.findUnique({ where: { slug: F } }))!.id;
  await prisma.formFile.deleteMany({ where: { formId } });
  await prisma.formEntry.deleteMany({ where: { formId } });
  await prisma.builtForm.delete({ where: { id: formId } });
  made.forms = made.forms.filter((id) => id !== formId);
  check((await prisma.formDraft.count({ where: { formId } })) === 0, "deleting a form deletes its drafts");
}

/** The case-management switch as it was before the run (null: never set), put back by cleanUp. */
let caseManagementWas: string | null | undefined;
async function setCaseManagement(value: string | null) {
  if (value === null) await prisma.setting.deleteMany({ where: { key: "caseManagement" } });
  else await prisma.setting.upsert({ where: { key: "caseManagement" }, create: { key: "caseManagement", value }, update: { value } });
}

async function cleanUp() {
  if (caseManagementWas !== undefined) await setCaseManagement(caseManagementWas).catch(() => undefined);
  for (const formId of made.forms) {
    await prisma.formFile.deleteMany({ where: { formId } }).catch(() => undefined);
    await prisma.formEntry.deleteMany({ where: { formId } }).catch(() => undefined);
    await prisma.builtForm.delete({ where: { id: formId } }).catch(() => undefined);
  }
  for (const id of made.users) await prisma.user.delete({ where: { id } }).catch(() => undefined);
}

main()
  .then(async () => {
    await cleanUp();
    console.log(`\n${passed} checks passed.`);
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await cleanUp();
    await prisma.$disconnect();
    process.exit(1);
  });
