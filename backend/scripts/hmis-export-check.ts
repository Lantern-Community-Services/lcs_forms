/**
 * Check for the HMIS CSV export (services/hmisExport.ts) against a throwaway
 * database: builds residents, stays and hmis-assessment entries on a new test
 * site, downloads the export over HTTP the way the Moves page does, unzips it,
 * and checks every file's header against the FY2026 spec's columns (written out
 * again below, so a slip in the service's list shows), every row's column count,
 * the rows for a few known people, who may export (and with SSNs), and that the
 * case management switch hides it.
 *
 *   DEV_AUTH=true DATABASE_URL=<throwaway> FORM_BACKUP_REPO=" " FORM_BACKUP_TOKEN=" " \
 *     npx tsx scripts/hmis-export-check.ts --throwaway [--form <hmis-assessment.json>] [--made-up]
 *
 *   --throwaway   required: it writes people, sites, residents and entries, and turns
 *                 case management on. Refused on the live site.
 *   --form        the hmis-assessment form definition, when the database hasn't got
 *                 the form yet (it is created and published there).
 *   --made-up     first replace the database's residents with made-up ones
 *                 (services/testData.ts), so the export across every site is checked too.
 *
 * Exits non-zero on the first failed check. Names and data are invented; the SSN
 * is 078-05-1120, the one printed on wallet inserts in 1938 and voided since.
 */
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { testSite } from "../src/env.js";

let passed = 0;
function check(cond: unknown, what: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${what}`);
    process.exit(1);
  }
  passed++;
  console.log(`✓ ${what}`);
}

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
if (!process.argv.includes("--throwaway") || !testSite) {
  console.error("This writes test people, sites, residents and entries: run it with --throwaway, against a throwaway database, on a test site.");
  process.exit(1);
}
process.env.DEV_AUTH ??= "true";

// ── The FY2026 HMIS CSV spec's files and columns ─────────────────────────────
// From HUD's Eva column list and the HUD Data Lab's FY2026 test kit; Enrollment's
// MentalHealthConsultation is placed after ThresholdScore as the Data Lab does.

const SPEC: Record<string, string> = {
  Export: "ExportID,SourceType,SourceID,SourceName,SourceContactFirst,SourceContactLast,SourceContactPhone,SourceContactExtension,SourceContactEmail,ExportDate,ExportStartDate,ExportEndDate,SoftwareName,SoftwareVersion,CSVVersion,ExportPeriodType,ExportDirective,HashStatus,ImplementationID",
  Organization: "OrganizationID,OrganizationName,VictimServiceProvider,OrganizationCommonName,DateCreated,DateUpdated,UserID,DateDeleted,ExportID",
  User: "UserID,UserFirstName,UserLastName,UserPhone,UserExtension,UserEmail,DateCreated,DateUpdated,DateDeleted,ExportID",
  Project: "ProjectID,OrganizationID,ProjectName,ProjectCommonName,OperatingStartDate,OperatingEndDate,ContinuumProject,ProjectType,HousingType,RRHSubType,ResidentialAffiliation,TargetPopulation,HOPWAMedAssistedLivingFac,PITCount,DateCreated,DateUpdated,UserID,DateDeleted,ExportID",
  Funder: "FunderID,ProjectID,Funder,OtherFunder,GrantID,StartDate,EndDate,DateCreated,DateUpdated,UserID,DateDeleted,ExportID",
  ProjectCoC: "ProjectCoCID,ProjectID,CoCCode,Geocode,Address1,Address2,City,State,ZIP,GeographyType,DateCreated,DateUpdated,UserID,DateDeleted,ExportID",
  Inventory: "InventoryID,ProjectID,CoCCode,HouseholdType,Availability,UnitInventory,BedInventory,CHVetBedInventory,YouthVetBedInventory,VetBedInventory,CHYouthBedInventory,YouthBedInventory,CHBedInventory,OtherBedInventory,ESBedType,InventoryStartDate,InventoryEndDate,DateCreated,DateUpdated,UserID,DateDeleted,ExportID",
  Affiliation: "AffiliationID,ProjectID,ResProjectID,DateCreated,DateUpdated,UserID,DateDeleted,ExportID",
  HMISParticipation: "HMISParticipationID,ProjectID,HMISParticipationType,HMISParticipationStatusStartDate,HMISParticipationStatusEndDate,DateCreated,DateUpdated,UserID,DateDeleted,ExportID",
  CEParticipation: "CEParticipationID,ProjectID,AccessPoint,PreventionAssessment,CrisisAssessment,HousingAssessment,DirectServices,ReceivesReferrals,CEParticipationStatusStartDate,CEParticipationStatusEndDate,DateCreated,DateUpdated,UserID,DateDeleted,ExportID",
  Client: "PersonalID,FirstName,MiddleName,LastName,NameSuffix,NameDataQuality,SSN,SSNDataQuality,DOB,DOBDataQuality,Sex,AmIndAKNative,Asian,BlackAfAmerican,HispanicLatinao,MidEastNAfrican,NativeHIPacific,White,RaceNone,AdditionalRaceEthnicity,VeteranStatus,YearEnteredService,YearSeparated,WorldWarII,KoreanWar,VietnamWar,DesertStorm,AfghanistanOEF,IraqOIF,IraqOND,OtherTheater,MilitaryBranch,DischargeStatus,DateCreated,DateUpdated,UserID,DateDeleted,ExportID",
  Enrollment: "EnrollmentID,PersonalID,ProjectID,EntryDate,HouseholdID,RelationshipToHoH,EnrollmentCoC,LivingSituation,RentalSubsidyType,LengthOfStay,LOSUnderThreshold,PreviousStreetESSH,DateToStreetESSH,TimesHomelessPastThreeYears,MonthsHomelessPastThreeYears,DisablingCondition,DateOfEngagement,MoveInDate,DateOfPATHStatus,ClientEnrolledInPATH,ReasonNotEnrolled,PercentAMI,ReferralSource,CountOutreachReferralApproaches,DateOfBCPStatus,EligibleForRHY,ReasonNoServices,RunawayYouth,FormerWardChildWelfare,ChildWelfareYears,ChildWelfareMonths,FormerWardJuvenileJustice,JuvenileJusticeYears,JuvenileJusticeMonths,UnemploymentFam,MentalHealthDisorderFam,PhysicalDisabilityFam,AlcoholDrugUseDisorderFam,InsufficientIncome,IncarceratedParent,VAMCStation,TargetScreenReqd,TimeToHousingLoss,AnnualPercentAMI,LiteralHomelessHistory,ClientLeaseholder,HOHLeaseholder,SubsidyAtRisk,EvictionHistory,CriminalRecord,IncarceratedAdult,PrisonDischarge,SexOffender,DisabledHoH,CurrentPregnant,SingleParent,DependentUnder6,HH5Plus,CoCPrioritized,HPScreeningScore,ThresholdScore,MentalHealthConsultation,DateCreated,DateUpdated,UserID,DateDeleted,ExportID",
  Exit: "ExitID,EnrollmentID,PersonalID,ExitDate,Destination,DestinationSubsidyType,OtherDestination,HousingAssessment,SubsidyInformation,ProjectCompletionStatus,EarlyExitReason,ExchangeForSex,ExchangeForSexPastThreeMonths,CountOfExchangeForSex,AskedOrForcedToExchangeForSex,AskedOrForcedToExchangeForSexPastThreeMonths,WorkplaceViolenceThreats,WorkplacePromiseDifference,CoercedToContinueWork,LaborExploitPastThreeMonths,CounselingReceived,IndividualCounseling,FamilyCounseling,GroupCounseling,SessionCountAtExit,PostExitCounselingPlan,SessionsInPlan,DestinationSafeClient,DestinationSafeWorker,PosAdultConnections,PosPeerConnections,PosCommunityConnections,AftercareDate,AftercareProvided,EmailSocialMedia,Telephone,InPersonIndividual,InPersonGroup,CMExitReason,DateCreated,DateUpdated,UserID,DateDeleted,ExportID",
  IncomeBenefits: "IncomeBenefitsID,EnrollmentID,PersonalID,InformationDate,IncomeFromAnySource,TotalMonthlyIncome,Earned,EarnedAmount,Unemployment,UnemploymentAmount,SSI,SSIAmount,SSDI,SSDIAmount,VADisabilityService,VADisabilityServiceAmount,VADisabilityNonService,VADisabilityNonServiceAmount,PrivateDisability,PrivateDisabilityAmount,WorkersComp,WorkersCompAmount,TANF,TANFAmount,GA,GAAmount,SocSecRetirement,SocSecRetirementAmount,Pension,PensionAmount,ChildSupport,ChildSupportAmount,Alimony,AlimonyAmount,OtherIncomeSource,OtherIncomeAmount,OtherIncomeSourceIdentify,BenefitsFromAnySource,SNAP,WIC,TANFChildCare,TANFTransportation,OtherTANF,OtherBenefitsSource,OtherBenefitsSourceIdentify,InsuranceFromAnySource,Medicaid,NoMedicaidReason,Medicare,NoMedicareReason,SCHIP,NoSCHIPReason,VHAServices,NoVHAReason,EmployerProvided,NoEmployerProvidedReason,COBRA,NoCOBRAReason,PrivatePay,NoPrivatePayReason,StateHealthIns,NoStateHealthInsReason,IndianHealthServices,NoIndianHealthServicesReason,OtherInsurance,OtherInsuranceIdentify,ADAP,NoADAPReason,RyanWhiteMedDent,NoRyanWhiteReason,ConnectionWithSOAR,DataCollectionStage,DateCreated,DateUpdated,UserID,DateDeleted,ExportID",
  HealthAndDV: "HealthAndDVID,EnrollmentID,PersonalID,InformationDate,DomesticViolenceSurvivor,WhenOccurred,CurrentlyFleeing,GeneralHealthStatus,DentalHealthStatus,MentalHealthStatus,PregnancyStatus,DueDate,DataCollectionStage,DateCreated,DateUpdated,UserID,DateDeleted,ExportID",
  EmploymentEducation: "EmploymentEducationID,EnrollmentID,PersonalID,InformationDate,LastGradeCompleted,SchoolStatus,Employed,EmploymentType,NotEmployedReason,DataCollectionStage,DateCreated,DateUpdated,UserID,DateDeleted,ExportID",
  Disabilities: "DisabilitiesID,EnrollmentID,PersonalID,InformationDate,DisabilityType,DisabilityResponse,IndefiniteAndImpairs,TCellCountAvailable,TCellCount,TCellSource,ViralLoadAvailable,ViralLoad,ViralLoadSource,AntiRetroviral,DataCollectionStage,DateCreated,DateUpdated,UserID,DateDeleted,ExportID",
  Services: "ServicesID,EnrollmentID,PersonalID,DateProvided,RecordType,TypeProvided,OtherTypeProvided,MovingOnOtherType,SubTypeProvided,FAAmount,FAStartDate,FAEndDate,ReferralOutcome,DateCreated,DateUpdated,UserID,DateDeleted,ExportID",
  CurrentLivingSituation: "CurrentLivingSitID,EnrollmentID,PersonalID,InformationDate,CurrentLivingSituation,CLSSubsidyType,VerifiedBy,LeaveSituation14Days,SubsequentResidence,ResourcesToObtain,LeaseOwn60Day,MovedTwoOrMore,LocationDetails,DateCreated,DateUpdated,UserID,DateDeleted,ExportID",
  Assessment: "AssessmentID,EnrollmentID,PersonalID,AssessmentDate,AssessmentLocation,AssessmentType,AssessmentLevel,PrioritizationStatus,DateCreated,DateUpdated,UserID,DateDeleted,ExportID",
  AssessmentQuestions: "AssessmentQuestionID,AssessmentID,EnrollmentID,PersonalID,AssessmentQuestionGroup,AssessmentQuestionOrder,AssessmentQuestion,AssessmentAnswer,DateCreated,DateUpdated,UserID,DateDeleted,ExportID",
  AssessmentResults: "AssessmentResultID,AssessmentID,EnrollmentID,PersonalID,AssessmentResultType,AssessmentResult,DateCreated,DateUpdated,UserID,DateDeleted,ExportID",
  Event: "EventID,EnrollmentID,PersonalID,EventDate,Event,ProbSolDivRRResult,ReferralCaseManageAfter,LocationCrisisOrPHHousing,ReferralResult,ResultDate,DateCreated,DateUpdated,UserID,DateDeleted,ExportID",
  YouthEducationStatus: "YouthEducationStatusID,EnrollmentID,PersonalID,InformationDate,CurrentSchoolAttend,MostRecentEdStatus,CurrentEdStatus,DataCollectionStage,DateCreated,DateUpdated,UserID,DateDeleted,ExportID",
};

/** RFC 4180: quoted fields may hold commas, quotes ("") and line breaks. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

type Table = { header: string[]; rows: Record<string, string>[] };

async function main() {
  const { prisma } = await import("../src/prisma.js");
  const { createApp } = await import("../src/app.js");
  const { currentUserById } = await import("../src/auth/middleware.js");
  const { setSetting } = await import("../src/services/settings.js");
  const { programs, setTestPrograms } = await import("../src/services/clientFields.js");
  const { saveProfile } = await import("../src/services/clientProfile.js");
  const { moveIn, moveOut, transfer } = await import("../src/services/residency.js");
  const { addDays, todayNY } = await import("../src/services/checklist.js");
  const { createForm, publishForm } = await import("../src/forms/service.js");
  const { submitEntry } = await import("../src/forms/entries.js");
  const { readZip } = await import("../src/services/zip.js");
  const { HMIS_ASSESSMENT_SLUG } = await import("../src/services/hmisExport.js");

  const stamp = Date.now().toString(36);
  const system = { id: null, name: "HMIS export check" };
  await setSetting("caseManagement", "true");

  if (process.argv.includes("--made-up")) {
    const { replaceWithMadeUpData } = await import("../src/services/testData.js");
    const s = await replaceWithMadeUpData(system);
    check(s.caseManagement && s.caseManagement.sites > 0, `made-up residents, stays and client information at ${s.caseManagement?.sites} sites`);
  }

  // The form, made and published here when this database hasn't got it.
  let form = await prisma.builtForm.findUnique({ where: { slug: HMIS_ASSESSMENT_SLUG } });
  if (!form) {
    const path = arg("--form");
    if (!path) {
      console.error(`No "${HMIS_ASSESSMENT_SLUG}" form in this database: pass --form <hmis-assessment.json>.`);
      process.exit(1);
    }
    const created = await createForm({ doc: JSON.parse(readFileSync(path, "utf8")), slug: HMIS_ASSESSMENT_SLUG }, system);
    form = await publishForm(created.id, system, "HMIS export check");
  }
  check(form.liveSchema, "the hmis-assessment form is published");

  // A test building with families, its people, and the program PlanStreet calls 744.
  const PROGRAM = "Amber Hall - HASA/CoC Single Adults";
  if (!programs().some((p) => p.value === PROGRAM)) setTestPrograms([...programs(), { site: "amber-hall", value: PROGRAM }]);
  const site = await prisma.site.create({
    data: { code: `hmis-check-${stamp}`, name: `HMIS Check Hall ${stamp}`, siteType: "supportive", households: true, address: "100 Example Street, Bronx, NY 10451" },
  });
  const admin = await prisma.user.create({ data: { name: "Ada Example", email: `ada.${stamp}@example.org`, roleKey: "admin", status: "active" } });
  const manager = await prisma.user.create({
    data: { name: "Cam Sample", email: `cam.${stamp}@example.org`, roleKey: "site_manager", status: "active", clientInfoAccess: true, sites: { create: [{ siteId: site.id }] } },
  });
  const staff = await prisma.user.create({ data: { name: "Dee Placeholder", email: `dee.${stamp}@example.org`, roleKey: "site_staff", status: "active", sites: { create: [{ siteId: site.id }] } } });
  const unit = (label: string) => prisma.unit.create({ data: { siteId: site.id, label, program: PROGRAM } });
  const [u1, u2, u3, u4] = await Promise.all([unit("1A"), unit("2B"), unit("3C"), unit("4D")]);
  const person = (firstName: string, lastName: string) => prisma.tenant.create({ data: { siteId: site.id, firstName, lastName, movedIn: false, createdById: admin.id } });
  const hazel = await person("Hazel", "Example");
  const cody = await person("Cody", "Example");
  const sam = await person("Sam", "Sample");
  const tess = await person("Tess", "Transfer");

  const today = todayNY();
  const from = addDays(today, -364);
  const ctx = { actor: { id: admin.id, name: admin.name }, userId: admin.id, byName: admin.name };
  const anySite = () => true;
  await moveIn(ctx, { unitId: u1.id, date: addDays(today, -200), people: [{ tenantId: hazel.id }, { tenantId: cody.id, relation: "Head of household's child" }], program: PROGRAM, canAccessSite: anySite });
  await moveIn(ctx, { unitId: u2.id, date: addDays(today, -900), people: [{ tenantId: sam.id }], program: PROGRAM, canAccessSite: anySite });
  await moveOut(ctx, { tenantIds: [sam.id], date: addDays(today, -100), reason: "Independent Housing", destination: "Rental by client, with HCV voucher (tenant or project based)", canAccessSite: anySite });
  await moveIn(ctx, { unitId: u3.id, date: addDays(today, -300), people: [{ tenantId: tess.id }], program: PROGRAM, canAccessSite: anySite });
  await transfer(ctx, { tenantIds: [tess.id], toUnitId: u4.id, date: addDays(today, -150), canAccessSite: anySite });
  check((await prisma.stay.count({ where: { siteId: site.id } })) === 5, "five stays: a household of two, a move-out, a transfer");

  const tenantOf = async (id: string) => prisma.tenant.findUniqueOrThrow({ where: { id }, include: { site: { select: { id: true, code: true, name: true } } } });
  await saveProfile({
    tenant: await tenantOf(hazel.id),
    before: null,
    version: 0,
    userId: manager.id,
    changes: {
      dateOfBirth: "1980-04-02",
      ssn: "078051120",
      middleName: "Q",
      nameDataQuality: "Full name reported",
      sex: "Female",
      raceEthnicity: ["Black, African American, or African", "Hispanic/Latina/e/o"],
      veteranStatus: "Yes",
      militaryEntryYear: 2001,
      militaryBranch: "Army",
      dischargeStatus: "Honorable",
      theatersOfOperation: ["Iraq (Operation Iraqi Freedom)"],
    },
  });
  await saveProfile({ tenant: await tenantOf(sam.id), before: null, version: 0, userId: manager.id, changes: { raceEthnicity: ["Client prefers not to answer"], veteranStatus: "No", dobDataQuality: "Approximate or partial DOB reported", dateOfBirth: "1975-01-01" } });

  // HMIS assessments: Hazel at project start, Sam's annual one.
  const filer = (await currentUserById(admin.id))!;
  const resident = (t: { id: string; firstName: string; lastName: string }, unitLabel: string) => ({ id: t.id, name: `${t.firstName} ${t.lastName}`, unit: unitLabel });
  const noToAll = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, "0"]));
  const INCOME_KEYS = ["earned", "unemployment", "ssdi", "va_disability_service", "va_disability_non_service", "private_disability", "workers_comp", "tanf", "ga", "soc_sec_retirement", "pension", "child_support", "alimony", "other_income"];
  const health = { developmental_disability: "0", chronic_health: "0", hiv_aids: "0", mental_health: "0", dv_survivor: "0" };
  const file = async (values: Record<string, unknown>) => {
    try {
      return (await submitEntry({ form: form!, values: { site: site.code, ...values }, user: filer, source: "app" })).entry;
    } catch (e) {
      console.error((e as { details?: unknown }).details ?? e);
      throw e;
    }
  };
  const start = await file({
    client: resident(hazel, "1A"),
    information_date: addDays(today, -200),
    data_collection_stage: "1",
    program_id: "744",
    move_in_date: addDays(today, -200),
    relationship_to_hoh: "1",
    living_situation: "101",
    length_of_stay: "6",
    date_homelessness_started: addDays(today, -1200),
    times_homeless_3yrs: "4",
    months_homeless_3yrs: "13",
    income_any: "1",
    ...noToAll(INCOME_KEYS),
    ssi: "1",
    ssi_amount: 914,
    benefits_any: "1",
    snap: "1",
    ...noToAll(["wic", "tanf_child_care", "tanf_transportation", "other_tanf", "other_benefits"]),
    insurance_any: "1",
    medicaid: "1",
    ...noToAll(["medicare", "schip", "vha_services", "employer_provided", "cobra", "private_pay", "state_health_ins", "indian_health_services", "other_insurance"]),
    physical_disability: "1",
    physical_disability_long: "1",
    substance_use: "2",
    substance_use_long: "1",
    disabling_condition: "1",
    ...health,
  });
  const annual = await file({
    client: resident(sam, "2B"),
    information_date: addDays(today, -135),
    data_collection_stage: "5",
    relationship_to_hoh: "1",
    income_any: "0",
    benefits_any: "0",
    insurance_any: "0",
    physical_disability: "0",
    substance_use: "0",
    disabling_condition: "0",
    ...health,
  });
  check(start.id && annual.id, "two HMIS assessments filed");

  // Over HTTP, signed in as each person.
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const signIn = async (userId: string) => {
    const res = await fetch(`${base}/api/auth/dev-login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }) });
    check(res.ok, `dev sign-in (${res.status})`);
    return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  };
  const exportAs = (cookie: string, body: Record<string, unknown>) =>
    fetch(`${base}/api/residency/hmis-export`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });

  try {
    const [cAdmin, cManager, cStaff] = [await signIn(admin.id), await signIn(manager.id), await signIn(staff.id)];
    const body = { from, to: today, sites: [site.code] };

    // ── Who may ──
    check((await exportAs(cStaff, body)).status === 403, "someone without client information can't export");
    check((await exportAs(cManager, { ...body, includeSsn: true })).status === 403, "someone with client information but not clients.ssn can't export SSNs");
    const managerZip = await exportAs(cManager, body);
    check(managerZip.status === 200 && managerZip.headers.get("content-type")?.includes("zip"), `someone with client information can export (${managerZip.status})`);
    const managerFiles = readZip(Buffer.from(await managerZip.arrayBuffer()));
    await setSetting("caseManagement", "false");
    check((await exportAs(cAdmin, body)).status === 404, "with case management off it isn't there");
    await setSetting("caseManagement", "true");

    // ── The files ──
    const res = await exportAs(cAdmin, { ...body, includeSsn: true });
    check(res.status === 200, `an Admin exports with SSNs (${res.status})`);
    check(/attachment; filename="hmis-csv-.*\.zip"/.test(res.headers.get("content-disposition") ?? ""), "it downloads as a zip");
    const zip = readZip(Buffer.from(await res.arrayBuffer()));
    const tables = new Map<string, Table>();
    check(zip.size === Object.keys(SPEC).length, `the zip has all ${Object.keys(SPEC).length} files (${zip.size})`);
    for (const [name, cols] of Object.entries(SPEC)) {
      const raw = zip.get(`${name}.csv`);
      check(raw, `${name}.csv is in the zip`);
      const text = raw.toString("utf8");
      check(!text.startsWith("﻿"), `${name}.csv has no byte-order mark`);
      const [header, ...rest] = parseCsv(text);
      check(header.join(",") === cols, `${name}.csv's header is the spec's ${cols.split(",").length} columns`);
      const bad = rest.findIndex((r) => r.length !== header.length);
      check(bad < 0, `every row of ${name}.csv has ${header.length} columns${bad >= 0 ? ` (row ${bad + 2} has ${rest[bad].length})` : ""}`);
      tables.set(name, { header, rows: rest.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]]))) });
    }
    const t = (name: string) => tables.get(name)!.rows;
    const one = (name: string, where: (r: Record<string, string>) => boolean, what: string) => {
      const hits = t(name).filter(where);
      check(hits.length === 1, `${what} (${hits.length} rows)`);
      return hits[0];
    };

    const ex = t("Export")[0];
    check(ex.CSVVersion === "2026 v1.0" && ex.ExportStartDate === from && ex.ExportEndDate === today && ex.SourceContactLast === "Example", "Export.csv: version, dates and who exported");

    // Client
    const hz = one("Client", (r) => r.PersonalID === hazel.id, "Hazel has one Client row");
    check(hz.SSN === "078051120" && hz.SSNDataQuality === "1", "Client: the whole SSN with SSNs on, data quality 1 for a whole one on file");
    check(hz.DOB === "1980-04-02" && hz.DOBDataQuality === "1" && hz.MiddleName === "Q" && hz.NameDataQuality === "1", "Client: DOB, middle name, data quality");
    check(hz.Sex === "0", "Client: Sex Female = 0");
    check(hz.BlackAfAmerican === "1" && hz.HispanicLatinao === "1" && hz.White === "0" && hz.RaceNone === "", "Client: race and ethnicity ticked, RaceNone blank");
    check(hz.VeteranStatus === "1" && hz.YearEnteredService === "2001" && hz.IraqOIF === "1" && hz.KoreanWar === "0" && hz.MilitaryBranch === "1" && hz.DischargeStatus === "1", "Client: veteran details");
    const sm = one("Client", (r) => r.PersonalID === sam.id, "Sam has one Client row");
    check(sm.RaceNone === "9" && sm.BlackAfAmerican === "0" && sm.VeteranStatus === "0" && sm.WorldWarII === "" && sm.MilitaryBranch === "", "Client: no race ticked = RaceNone 9; a non-veteran's details blank");
    check(sm.SSN === "" && sm.SSNDataQuality === "99" && sm.DOBDataQuality === "2" && sm.Sex === "99", "Client: nothing on file = 99s; the data quality given is used");
    const cd = one("Client", (r) => r.PersonalID === cody.id, "Cody has one Client row");
    check(cd.NameDataQuality === "99" && cd.DOB === "", "Client: someone with no client information still has a row");

    // Enrollment
    const ehz = one("Enrollment", (r) => r.PersonalID === hazel.id, "Hazel has one enrollment");
    check(ehz.ProjectID === "744", `Enrollment: PlanStreet's ProgramID is the ProjectID (${ehz.ProjectID})`);
    check(ehz.EntryDate === addDays(today, -200) && ehz.MoveInDate === ehz.EntryDate, "Enrollment: entry and move-in date are the move-in");
    check(ehz.RelationshipToHoH === "1" && ehz.HouseholdID === ehz.EnrollmentID && ehz.EnrollmentCoC === "NY-600", "Enrollment: the head heads her own household, with the CoC");
    check(ehz.LivingSituation === "101" && ehz.LengthOfStay === "5" && ehz.LOSUnderThreshold === "" && ehz.TimesHomelessPastThreeYears === "4" && ehz.MonthsHomelessPastThreeYears === "113", "Enrollment: prior living situation in HUD's codes (length 6→5, months 13→113)");
    check(ehz.DateToStreetESSH === addDays(today, -1200) && ehz.DisablingCondition === "1", "Enrollment: homeless since, disabling condition");
    const ecd = one("Enrollment", (r) => r.PersonalID === cody.id, "Cody has one enrollment");
    check(ecd.RelationshipToHoH === "2" && ecd.HouseholdID === ehz.EnrollmentID && ecd.EnrollmentCoC === "" && ecd.LivingSituation === "99", "Enrollment: the child is in his mother's household; nothing collected is 99");
    one("Enrollment", (r) => r.PersonalID === tess.id, "a transfer to a unit in the same program is one enrollment");
    check(!t("Exit").some((r) => r.PersonalID === tess.id), "… with no exit");
    const esm = one("Enrollment", (r) => r.PersonalID === sam.id, "Sam has one enrollment, begun before the range");
    check(esm.EntryDate === addDays(today, -900), "Enrollment: an entry before the range keeps its date");

    // Exit
    const xsm = one("Exit", (r) => r.PersonalID === sam.id, "Sam has one exit");
    check(xsm.EnrollmentID === esm.EnrollmentID && xsm.ExitDate === addDays(today, -100), "Exit: his enrollment, on his move-out day");
    check(xsm.Destination === "435" && xsm.DestinationSubsidyType === "433", "Exit: an HCV rental is 435 with subsidy 433");

    // Income, benefits, insurance
    const ihz = one("IncomeBenefits", (r) => r.IncomeBenefitsID === start.id, "Hazel's start assessment has an IncomeBenefits row");
    check(ihz.EnrollmentID === ehz.EnrollmentID && ihz.DataCollectionStage === "1" && ihz.InformationDate === addDays(today, -200), "IncomeBenefits: her enrollment, stage and date");
    check(ihz.IncomeFromAnySource === "1" && ihz.SSI === "1" && ihz.SSIAmount === "914.00" && ihz.Earned === "0" && ihz.EarnedAmount === "" && ihz.TotalMonthlyIncome === "914.00", "IncomeBenefits: SSI and the total");
    check(ihz.BenefitsFromAnySource === "1" && ihz.SNAP === "1" && ihz.WIC === "0" && ihz.InsuranceFromAnySource === "1" && ihz.Medicaid === "1" && ihz.Medicare === "0", "IncomeBenefits: SNAP and Medicaid");
    const ism = one("IncomeBenefits", (r) => r.IncomeBenefitsID === annual.id, "Sam's annual assessment has an IncomeBenefits row");
    check(ism.EnrollmentID === esm.EnrollmentID && ism.DataCollectionStage === "5" && ism.IncomeFromAnySource === "0" && ism.Earned === "0" && ism.TotalMonthlyIncome === "", "IncomeBenefits: no income is 0s");

    // Health and disabilities
    const dhz = t("Disabilities").filter((r) => r.EnrollmentID === ehz.EnrollmentID);
    check(dhz.length === 6, "Disabilities: six rows per assessment");
    const dtype = (n: string) => dhz.find((r) => r.DisabilityType === n)!;
    check(dtype("5").DisabilityResponse === "1" && dtype("5").IndefiniteAndImpairs === "1", "Disabilities: physical, long-continued");
    check(dtype("10").DisabilityResponse === "2" && dtype("10").IndefiniteAndImpairs === "1", "Disabilities: drug use disorder = 2");
    check(dtype("6").DisabilityResponse === "0" && dtype("6").IndefiniteAndImpairs === "", "Disabilities: developmental has no long-continued question");
    const hv = one("HealthAndDV", (r) => r.HealthAndDVID === start.id, "Hazel's start assessment has a HealthAndDV row");
    check(hv.DomesticViolenceSurvivor === "0" && hv.WhenOccurred === "" && hv.CurrentlyFleeing === "", "HealthAndDV: not a survivor, the rest blank");

    // Projects and references hold together
    const proj = one("Project", (r) => r.ProjectID === "744", "the program is one project");
    check(proj.ProjectType === "3" && proj.OperatingStartDate === addDays(today, -900), "Project: PSH, operating since its first move-in");
    check(one("Funder", (r) => r.ProjectID === "744", "one funder").Funder === "2", "Funder: a CoC program is HUD CoC PSH (2)");
    const pc = one("ProjectCoC", (r) => r.ProjectID === "744", "one ProjectCoC");
    check(pc.CoCCode === "NY-600" && pc.City === "Bronx" && pc.State === "NY" && pc.ZIP === "10451", "ProjectCoC: CoC and address");
    const ids = (name: string, col: string) => new Set(t(name).map((r) => r[col]));
    const persons = ids("Client", "PersonalID");
    const enrollmentIds = ids("Enrollment", "EnrollmentID");
    const projectIds = ids("Project", "ProjectID");
    const userIds = ids("User", "UserID");
    check([...ids("Enrollment", "PersonalID")].every((p) => persons.has(p)), "every enrollment's person is in Client.csv");
    check([...ids("Enrollment", "ProjectID")].every((p) => projectIds.has(p)), "every enrollment's project is in Project.csv");
    for (const f of ["Exit", "IncomeBenefits", "HealthAndDV", "Disabilities"]) check([...ids(f, "EnrollmentID")].every((e) => enrollmentIds.has(e)), `every ${f} row's enrollment is in Enrollment.csv`);
    for (const f of ["Organization", "Project", "Funder", "ProjectCoC", "Client", "Enrollment", "Exit", "IncomeBenefits", "HealthAndDV", "Disabilities"]) {
      check(t(f).every((r) => userIds.has(r.UserID) && r.ExportID === ex.ExportID), `every ${f} row's UserID is in User.csv and its ExportID is this export's`);
    }
    for (const f of Object.keys(SPEC)) {
      const pk = SPEC[f].split(",")[0];
      if (f === "Export") continue;
      check(new Set(t(f).map((r) => r[pk])).size === t(f).length && t(f).every((r) => r[pk] && r[pk].length <= 32), `${f}.csv: ${pk} is unique and at most 32 characters`);
    }

    // The manager's copy: no SSNs.
    const mClient = parseCsv(managerFiles.get("Client.csv")!.toString("utf8"));
    const ssnAt = mClient[0].indexOf("SSN");
    check(mClient.slice(1).every((r) => r[ssnAt] === ""), "without SSNs ticked, the SSN column is blank");

    // The audit log: who, the dates, the sites and the SSN flag — never what was in it.
    const logged = await prisma.auditEvent.findMany({ where: { action: "hmis.exported", actorId: { in: [admin.id, manager.id] } }, orderBy: { createdAt: "asc" } });
    check(logged.length === 2, `both exports are audited (${logged.length})`);
    const withSsn = logged.find((l) => l.actorId === admin.id)!;
    const changes = JSON.parse(withSsn.changes ?? "{}") as Record<string, unknown>;
    check(changes.includeSsn === true && changes.from === from && changes.to === today && JSON.stringify(changes.sites) === JSON.stringify([site.code]), "the audit has the range, the sites and the SSN flag");
    check(!JSON.stringify(withSsn).includes("078051120") && !JSON.stringify(withSsn).includes("Hazel"), "the audit has no SSN and no names");

    // Every site at once, made-up residents and all.
    const all = await exportAs(cAdmin, { from, to: today });
    check(all.status === 200, `an Admin exports every site (${all.status})`);
    const allFiles = readZip(Buffer.from(await all.arrayBuffer()));
    for (const [name, cols] of Object.entries(SPEC)) {
      const [header, ...rest] = parseCsv(allFiles.get(`${name}.csv`)!.toString("utf8"));
      check(header.join(",") === cols && rest.every((r) => r.length === header.length), `every site: ${name}.csv has the spec's header and ${rest.length} well-formed rows`);
    }
  } finally {
    server.close();
    await prisma.$disconnect();
  }
}

await main();
console.log(`\n${passed} checks passed.`);
process.exit(0);
