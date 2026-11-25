/**
 * Checks ctx.caseload.* (apps/caseload.ts): what a code form can read of case
 * management — residents with their open checklist and last contact, case
 * leads, applicants, and the sign-offs waiting for the person — and who may
 * read it: the switch, permissions, the person's own supportive sites, share-link
 * guests. Ends with a real code form's server action reading it in the sandbox.
 *
 *   DATABASE_URL=<a throwaway database> FORM_BACKUP_REPO=" " FORM_BACKUP_TOKEN=" " \
 *     npx tsx scripts/caseload-app-check.ts --throwaway=<that database's name>
 *
 * It makes its own sites, people, residents and forms (names are invented),
 * turns case management on while it runs and puts the setting back after.
 * Stops at the first failed check, exiting non-zero.
 */
const throwaway = process.argv.find((a) => a.startsWith("--throwaway="))?.slice("--throwaway=".length);
if (!throwaway) {
  console.error("This writes test sites, people and residents: run it against a throwaway database, naming it with --throwaway=<database>.");
  process.exit(1);
}

const { prisma } = await import("../src/prisma.js");
const [{ db }] = await prisma.$queryRawUnsafe<{ db: string }[]>("SELECT DB_NAME() AS db");
if (db !== throwaway) {
  console.error(`DATABASE_URL reaches "${db}", not "${throwaway}". Nothing was written.`);
  process.exit(1);
}
const { currentUserById } = await import("../src/auth/middleware.js");
const { caseloadResidents, caseloadLeads, caseloadApplicants, caseloadSignOffs } = await import("../src/apps/caseload.js");
const { todayNY, addDays, day } = await import("../src/services/checklist.js");
const { createForm, publishForm } = await import("../src/forms/service.js");
const { openSignOffs } = await import("../src/services/signOff.js");
const { createProject, publishProject } = await import("../src/apps/service.js");
const { loadApp, runAction, guestFor } = await import("../src/apps/runtime.js");
const { starterProject } = await import("../src/apps/project.js");

let passed = 0;
class Failed extends Error {}
function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Failed(what);
  passed++;
  console.log(`✓ ${what}`);
}
async function refuses(p: Promise<unknown>, pattern: RegExp, what: string) {
  try {
    await p;
  } catch (e) {
    check(pattern.test((e as Error).message) && (e as { userError?: boolean }).userError === true, `${what} (“${(e as Error).message}”)`);
    return;
  }
  throw new Failed(`${what}: it wasn't refused`);
}

const stamp = Date.now().toString(36);
const today = todayNY();
const before = await prisma.setting.findUnique({ where: { key: "caseManagement" } });
const setSwitch = (on: boolean) => prisma.setting.upsert({ where: { key: "caseManagement" }, create: { key: "caseManagement", value: String(on) }, update: { value: String(on) } });
const actor = { id: null, name: "Caseload check" };

try {
  const siteA = await prisma.site.create({ data: { code: `cl-a-${stamp}`, name: `Ashgrove Hall ${stamp}`, siteType: "supportive" } });
  const siteB = await prisma.site.create({ data: { code: `cl-b-${stamp}`, name: `Brindle House ${stamp}`, siteType: "supportive" } });
  const shelter = await prisma.site.create({ data: { code: `cl-s-${stamp}`, name: `Corran Shelter ${stamp}`, siteType: "shelter" } });

  const person = (name: string, roleKey: string, sites: string[], extra: Record<string, unknown> = {}) =>
    prisma.user.create({
      data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}.${stamp}@example.org`, roleKey, status: "active", ...extra, sites: { create: sites.map((siteId) => ({ siteId, approved: true })) } },
    });
  const admin = await person("Ada Admin", "admin", []);
  const managerA = await person("Mona Manager", "site_manager", [siteA.id]);
  const cmA = await person("Casey Lead", "site_staff", [siteA.id], { clientInfoAccess: true });
  const staffA = await person("Sid Staff", "site_staff", [siteA.id]);
  const as = async (u: { id: string }) => (await currentUserById(u.id))!;

  // Residents: led by Casey (one has left and owes the exit assessment), by Mona, nobody, not moved in yet, at site B, at the shelter.
  const resident = (siteId: string, first: string, extra: Record<string, unknown> = {}) =>
    prisma.tenant.create({ data: { siteId, firstName: first, lastName: `Sample ${stamp}`, unit: "1A", moveInDate: day(addDays(today, -400)), ...extra } });
  const r1 = await resident(siteA.id, "Arden", { awaySince: day(addDays(today, -3)), awayReason: "Hospital" });
  const r2 = await resident(siteA.id, "Blair");
  const r3 = await resident(siteA.id, "Corin");
  const r4 = await resident(siteA.id, "Dell", { status: "archived", moveOutDate: day(addDays(today, -2)) });
  const r5 = await resident(siteA.id, "Emery", { movedIn: false });
  const r6 = await resident(siteB.id, "Fenn");
  const r7 = await resident(shelter.id, "Gale");
  const lead = (tenantId: string, caseLeadId: string) => prisma.tenantProfile.create({ data: { tenantId, caseLeadId } });
  await lead(r1.id, cmA.id);
  await lead(r4.id, cmA.id);
  await lead(r2.id, managerA.id);
  await lead(r6.id, cmA.id);
  const task = (t: { id: string; siteId: string }, key: string, label: string, due: string, status = "open") =>
    prisma.tenantTask.create({ data: { tenantId: t.id, siteId: t.siteId, key, label, dueOn: day(due), status } });
  await task(r1, "housing_assessment", "Housing Assessment", addDays(today, -5));
  await task(r1, "face_sheet_annual", "Annual Face Sheet", addDays(today, 20));
  await task(r1, "psychosocial_annual", "Annual Psychosocial", addDays(today, -40), "done");
  await task(r2, "housing_assessment", "Housing Assessment", addDays(today, 3));
  await task(r4, "hmis_project_exit", "HMIS Project Exit Assessment", addDays(today, 5));
  await task(r4, "housing_assessment", "Housing Assessment", addDays(today, -1)); // left: only the exit assessment counts
  await task(r6, "housing_assessment", "Housing Assessment", addDays(today, 1));

  // A Contact Form (the slug the caseload reads) with a note about Arden.
  const contactSlug = "contact-form";
  let contact = await prisma.builtForm.findUnique({ where: { slug: contactSlug } });
  if (!contact) {
    contact = await publishForm(
      (await createForm({ slug: contactSlug, doc: { format: "lcs-form", version: 1, title: "Contact Form", description: "", fields: [{ id: "who", type: "resident", label: "Tenant" }], settings: { requireSite: true } } }, actor)).id,
      actor
    );
  }
  await prisma.formEntry.create({
    data: { formId: contact.id, data: JSON.stringify({ who: { id: r1.id, name: "Arden" } }), siteId: siteA.id, tenantId: r1.id, occurredAt: new Date(Date.now() - 86_400_000), createdById: cmA.id, createdByName: cmA.name, formVersion: 1 },
  });

  // Applicants: one at each supportive site.
  await prisma.applicant.create({ data: { siteId: siteA.id, firstName: "Hollis", lastName: `Applicant ${stamp}`, stage: "eligible", stageDate: day(addDays(today, -4)) } });
  await prisma.applicant.create({ data: { siteId: siteB.id, firstName: "Ives", lastName: `Applicant ${stamp}`, stage: "referred", stageDate: day(today) } });

  // A form with a sign-off by the site's managers; Casey files one at site A.
  const signForm = await publishForm(
    (
      await createForm(
        {
          doc: {
            format: "lcs-form",
            version: 1,
            title: `Caseload check note ${stamp}`,
            description: "",
            fields: [
              { id: "who", type: "resident", label: "Tenant" },
              { id: "note", type: "textarea", label: "Note" },
              { id: "sup", type: "signature", label: "Supervisor signature", signOff: { by: [{ kind: "role", role: "site_manager" }] } },
            ],
            settings: { requireSite: true },
          },
        },
        actor
      )
    ).id,
    actor
  );
  const filed = await prisma.formEntry.create({
    data: { formId: signForm.id, data: JSON.stringify({ who: { id: r1.id, name: "Arden" }, note: "Visited." }), siteId: siteA.id, tenantId: r1.id, createdById: cmA.id, createdByName: cmA.name, formVersion: 1 },
  });
  await openSignOffs(signForm, JSON.parse(signForm.liveSchema!), filed);

  // ── The switch ──
  await setSwitch(false);
  await refuses(caseloadResidents(await as(cmA), {}), /turned off/, "with case management off, residents are refused");
  await refuses(caseloadSignOffs(await as(managerA)), /turned off/, "with case management off, the sign-off list is refused");
  await setSwitch(true);
  await refuses(caseloadResidents(null, {}), /signed-in person/, "nobody signed in: refused");

  // ── Who ──
  await refuses(caseloadResidents(await as(staffA), {}), /client information or who manage/, "staff without client information can't read the caseload");
  await refuses(caseloadLeads(await as(staffA), {}), /client information or who manage/, "nor its case leads");

  const mine = await caseloadResidents(await as(cmA), { lead: "me" });
  const names = (r: { residents: { name: string }[] }) => r.residents.map((x) => x.name.split(" ")[0]).sort().join(",");
  check(names(mine) === "Arden,Dell", `Casey's own caseload is Arden and Dell (who left): ${names(mine)}`);
  check(mine.sites.length === 1 && mine.sites[0].id === siteA.id, "only Casey's own supportive site");
  const arden = mine.residents.find((x) => x.id === r1.id)!;
  check(arden.tasks.length === 2 && arden.tasks[0].key === "housing_assessment" && arden.tasks[0].forms.includes("housing-assessment"), "Arden's open tasks, soonest first, with the form that does each (the done one left out)");
  check(arden.away?.reason === "Hospital" && arden.living && arden.movedOutOn === null, "Arden is living there and away");
  check(arden.lastContact?.byName === cmA.name, "Arden's last contact is Casey's note");
  check(arden.caseLead?.id === cmA.id && arden.caseLead.name === cmA.name, "Arden's case lead is named");
  const dell = mine.residents.find((x) => x.id === r4.id)!;
  check(!dell.living && dell.movedOutOn === addDays(today, -2) && dell.tasks.length === 1 && dell.tasks[0].key === "hmis_project_exit", "Dell has left and owes only the exit assessment");

  const everyone = await caseloadResidents(await as(cmA), {});
  check(names(everyone) === "Arden,Blair,Corin,Dell", `everyone at Casey's site, without the one not moved in or other sites: ${names(everyone)}`);
  const blair = everyone.residents.find((x) => x.id === r2.id)!;
  check(blair.caseLead?.id === managerA.id && blair.lastContact === null, "Blair is Mona's, with no contact yet");
  check(everyone.residents.find((x) => x.id === r3.id)!.caseLead === null, "Corin has no case lead");
  const outside = await caseloadResidents(await as(cmA), { sites: [siteB.code] });
  check(outside.residents.length === 0 && outside.sites.length === 0, "asking for another site gives nothing");
  const byMona = await caseloadResidents(await as(managerA), { lead: managerA.id });
  check(names(byMona) === "Blair", "Mona's caseload, as Mona");
  const adminAll = await caseloadResidents(await as(admin), { sites: [siteA.code, siteB.code, shelter.code] });
  check(names(adminAll) === "Arden,Blair,Corin,Dell,Fenn" && adminAll.sites.length === 2, "an Admin sees both supportive sites, never the shelter");
  check(!adminAll.residents.some((x) => x.id === r5.id || x.id === r7.id), "nobody not moved in, nobody at the shelter");

  const leads = await caseloadLeads(await as(cmA), {});
  check(leads.length === 2 && leads.find((l) => l.id === cmA.id)?.me === true && leads.find((l) => l.id === cmA.id)?.residents === 1, "case leads at Casey's site: Casey (1 living there, marked me) and Mona");

  // ── Applicants ──
  const apps = await caseloadApplicants(await as(cmA), {});
  check(apps.items.length === 1 && apps.items[0].stage === "eligible" && apps.items[0].site.code === siteA.code && apps.items[0].daysInStage === 4, "Casey sees site A's applicant, 4 days eligible");
  const staffPerms = (await as(staffA)).permissions;
  if (!staffPerms.includes("roster.edit" as never)) await refuses(caseloadApplicants(await as(staffA), {}), /Applicants are for/, "staff who can't edit the roster can't read applicants");
  else check(true, "site staff can edit the roster, so they may read applicants (as on the Applicants page)");
  check((await caseloadApplicants(await as(admin), {})).items.length >= 2, "an Admin sees both sites' applicants");

  // ── Sign-offs ──
  const monaSigns = await caseloadSignOffs(await as(managerA));
  check(monaSigns.length === 1 && monaSigns[0].entryId === filed.id && monaSigns[0].resident?.id === r1.id && monaSigns[0].signOffs[0] === "Supervisor signature", "Mona is asked to sign Casey's note about Arden");
  check(monaSigns[0].link === `/f/${signForm.slug}/entries/${filed.id}`, "with the entry page to sign it on");
  check((await caseloadSignOffs(await as(cmA))).length === 0, "Casey filed it, so it isn't waiting on her");
  check((await caseloadSignOffs(await as(admin))).every((s) => s.entryId !== filed.id), "an Admin could sign it but isn't asked to, so it isn't on theirs");

  // A form whose "Who sees entries" is everyone's at their own sites: one entry at each site, one with no site.
  const { setEntryAccess } = await import("../src/services/staffGroups.js");
  const plans = await publishForm(
    (await createForm({ doc: { format: "lcs-form", version: 1, title: `Caseload check plan ${stamp}`, description: "", fields: [{ id: "who", type: "resident", label: "Tenant" }], settings: { requireSite: false } } }, actor)).id,
    actor
  );
  await setEntryAccess(plans.id, { mode: "site", seeAll: { groupIds: [], titles: [], userIds: [], roles: [] }, notified: true }, "Caseload check");
  const planEntry = (siteId: string | null) =>
    prisma.formEntry.create({ data: { formId: plans.id, formVersion: 1, data: JSON.stringify({ who: { id: r1.id } }), siteId, tenantId: r1.id, createdById: managerA.id, createdByName: managerA.name } });
  await planEntry(siteA.id);
  await planEntry(siteB.id);
  const siteless = await planEntry(null);

  // ── Through a code form's server code ──
  const files = starterProject(`Caseload check ${stamp}`);
  const manifest = JSON.parse(files["form.json"]);
  manifest.reads = [plans.slug];
  files["form.json"] = JSON.stringify(manifest, null, 2);
  files["server/index.ts"] = `import { defineServer } from "@lcs/server";
export default defineServer({
  actions: {
    board(args, ctx) {
      const r = ctx.caseload.residents({ lead: args && args.lead });
      return { n: r.residents.length, names: r.residents.map((x) => x.name), leads: ctx.caseload.leads().length, applicants: ctx.caseload.applicants().items.length, signOffs: ctx.caseload.signOffs().length };
    },
    plans(_args, ctx) {
      const f = ctx.db.form(${JSON.stringify(plans.slug)});
      return { n: f.entries.find({}).length, siteless: f.entries.get(${JSON.stringify(siteless.id)}) !== null };
    },
  },
});
`;
  const code = await publishProject((await createProject({ title: `Caseload check ${stamp}`, files }, actor)).id, actor);
  const app = await loadApp(code, false);
  const viaCode = await runAction(app, await as(cmA), "board", { lead: "me" });
  check(viaCode.ok && (viaCode.value as { n: number }).n === 2 && (viaCode.value as { leads: number }).leads === 2 && (viaCode.value as { applicants: number }).applicants === 1, `a code form reads Casey's caseload in the sandbox: ${JSON.stringify(viaCode.ok ? viaCode.value : viaCode.error)}`);
  const viaMona = await runAction(app, await as(managerA), "board", {});
  check(viaMona.ok && (viaMona.value as { signOffs: number }).signOffs === 1, "and Mona's sign-offs");
  const viaStaff = await runAction(app, await as(staffA), "board", {});
  check(!viaStaff.ok && viaStaff.userError === true && /client information/.test(viaStaff.error ?? ""), "staff without client information get a plain refusal, not a crash");
  const casePlans = await runAction(app, await as(cmA), "plans", {});
  check(casePlans.ok && (casePlans.value as { n: number }).n === 1 && (casePlans.value as { siteless: boolean }).siteless === false, `Casey reads another form's entries at her own site only, not the site-less one: ${JSON.stringify(casePlans.ok ? casePlans.value : casePlans.error)}`);
  const adminPlans = await runAction(app, await as(admin), "plans", {});
  check(adminPlans.ok && (adminPlans.value as { n: number }).n === 3 && (adminPlans.value as { siteless: boolean }).siteless === true, "an Admin reads all three");
  const staffPlans = await runAction(app, await as(staffA), "plans", {});
  check(staffPlans.ok && (staffPlans.value as { n: number }).n === 1, "site staff see their site's entries there too (the form's setting), so the form may read them for them");
  const guest = await runAction(app, guestFor((await as(cmA))!), "board", {}).catch((e: Error) => ({ ok: false, error: e.message }) as const);
  check(!guest.ok, `a share-link guest can't read it: ${"error" in guest ? guest.error : ""}`);
  await setSwitch(false);
  const off = await runAction(app, await as(cmA), "board", {});
  check(!off.ok && /turned off/.test(off.error ?? ""), "and with case management off, the form is told so");

  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error(e instanceof Failed ? `\n✗ ${e.message}` : e);
  process.exitCode = 1;
} finally {
  if (before) await prisma.setting.update({ where: { key: "caseManagement" }, data: { value: before.value } });
  else await prisma.setting.deleteMany({ where: { key: "caseManagement" } });
  await prisma.$disconnect();
}
