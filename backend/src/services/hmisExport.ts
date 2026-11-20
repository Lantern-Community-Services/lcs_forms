import crypto from "node:crypto";
import type { Site, Stay, Tenant, TenantProfile } from "@prisma/client";
import { prisma } from "../prisma.js";
import { appBaseUrl, env } from "../env.js";
import { liveDoc } from "../forms/entries.js";
import { programs } from "./clientFields.js";
import { valuesOf } from "./clientProfile.js";
import { HEAD } from "./residency.js";
import { day, todayNY, ymd } from "./checklist.js";
import { makeZip } from "./zip.js";

/**
 * HUD HMIS CSV export (case management): what Lantern Forms holds about the
 * people living in supportive housing, as the zip of CSV files a CoC's HMIS
 * imports, so Lantern can upload it instead of re-keying from PlanStreet.
 *
 * Format: HUD's "HMIS CSV Format Specifications", FY2026 (Export.csv CSVVersion
 * "2026 v1.0"; in force from 2025-10-01). The column lists below are the FY2026
 * ones: FY2024's with Client.csv's gender columns gone and Sex added after
 * DOBDataQuality, HispanicLatinaeo renamed HispanicLatinao, and Enrollment.csv's
 * SexualOrientation(Other), TranslationNeeded, PreferredLanguage(Different) gone
 * and MentalHealthConsultation added. They were checked against HUD's own tools
 * (the HUD Data Lab's FY2026 test-kit script and Eva's column list) and an HMIS
 * vendor's FY2026 importer, since the spec PDF itself couldn't be fetched.
 * Columns we weren't sure of:
 *   - Enrollment.MentalHealthConsultation's place: after ThresholdScore (Data Lab
 *     and the vendor) — Eva lists it after RunawayYouth. Importers match headers
 *     by name, so the place shouldn't matter; it's blank for us either way.
 *   - ProjectCoC.ZIP (Eva, HUD's diagram) vs "Zip" (the vendor's files): ZIP.
 *   - Exit.WorkplaceViolenceThreats: HUD's spelling; the vendor writes WorkPlace….
 *   - Export.CSVVersion: "2026 v1.0" (Data Lab); Eva only looks for "2026".
 *   - Services.csv: one vendor says FY2026 added InformationDate; HUD's tools
 *     don't have it. Header-only here, so it changes nothing we send.
 *
 * ── What comes from where (our field → CSV column) ───────────────────────────
 *
 * Export.csv     one row. SourceType 2 (agency database), SourceID the CoC code,
 *                SourceName Lantern Community Services, SourceContact* the person
 *                exporting, ExportStart/EndDate the range picked, ExportPeriodType
 *                3 (reporting period), ExportDirective 2 (full refresh), HashStatus
 *                1 (unhashed), SoftwareName Lantern Forms, ImplementationID this
 *                site's address.
 * Organization   one row: Lantern Community Services (OrganizationID LCS), not a
 *                victim service provider.
 * Project        one per program in the export. ProjectID = PlanStreet's ProgramID
 *                when the hmis-assessment form's program_id choices name the
 *                program (so the CoC sees the projects PlanStreet sent), otherwise
 *                LF- and a short hash of the program's name. Stays with no program
 *                fall back to the resident's client-information program (when it's
 *                one of that building's), then to one project per building
 *                (LF-site-<code>). ProjectType 3 (PSH), HousingType 1 (single
 *                site), ContinuumProject 1, TargetPopulation 4 (NA),
 *                HOPWAMedAssistedLivingFac 2 (not HOPWA). OperatingStartDate = the
 *                program's first move-in on record.
 * Funder         one per project: 2 (HUD: CoC – PSH) when the program's name says
 *                CoC, else 46 (local or other) with OtherFunder the funding part of
 *                its name ("DOHMH Families"; a building's catch-all project: "Not
 *                recorded in Lantern Forms"). StartDate = OperatingStartDate.
 * ProjectCoC     one per project: CoCCode NY-600 (New York City), the building's
 *                address split into Address1, City, State, ZIP; GeographyType 1 (urban).
 * User           everyone named as UserID on another row (who made the stay, ended
 *                it, filed the assessment, last changed the client information),
 *                plus LF-SYSTEM for rows nobody made (projects, people added before
 *                accounts were recorded).
 * Client         Tenant + TenantProfile (services/clientFields.ts):
 *                  PersonalID ← Tenant.id; FirstName/LastName ← the roster's legal
 *                  name (not the preferred name); MiddleName, NameSuffix ← client info;
 *                  NameDataQuality, SSNDataQuality, DOBDataQuality ← the data-quality
 *                  answers (1 full, 2 partial, 8/9/99) — left blank they're 99, or 1
 *                  when a whole SSN / a DOB is on file;
 *                  SSN ← TenantProfile.ssn only when "Include SSNs" was ticked by
 *                  someone with clients.ssn, otherwise blank;
 *                  DOB ← dateOfBirth; Sex ← sex (Female 0, Male 1, blank 99);
 *                  race columns ← raceEthnicity (1 ticked, 0 not), RaceNone 8/9/99
 *                  when none is ticked; AdditionalRaceEthnicity ← raceEthnicityDetail;
 *                  VeteranStatus ← veteranStatus (blank 99); YearEnteredService,
 *                  YearSeparated, the theaters, MilitaryBranch, DischargeStatus ←
 *                  the veteran questions, for veterans only.
 * Enrollment     one per stay (services/residency.ts Stay) that overlaps the range.
 *                A transfer to another unit in the same program is one enrollment
 *                (the stays are joined); to another program it's an exit and a new
 *                enrollment. Removed stays (a duplicate, a mistake) are left out.
 *                  EnrollmentID ← the first stay's id; EntryDate and MoveInDate ←
 *                  its move-in date; HouseholdID ← the head of household's
 *                  enrollment (the person's own when alone); RelationshipToHoH ←
 *                  householdRelation (Self 1, child 2, spouse/partner 3, other
 *                  relation 4, non-relation 5; a member with none 99);
 *                  EnrollmentCoC ← NY-600 for the head. From the hmis-assessment
 *                  entry at project start (stage 1): LivingSituation (and
 *                  RentalSubsidyType), LengthOfStay, LOSUnderThreshold,
 *                  DateToStreetESSH, TimesHomelessPastThreeYears,
 *                  MonthsHomelessPastThreeYears, DisablingCondition (latest
 *                  assessment when there's no start one; 99 with none).
 * Exit           one per enrollment that ended on or before the range's last day.
 *                  ExitDate ← move-out date; Destination ← the exit assessment's
 *                  destination (stage 3), else the move-out's HUD destination
 *                  (EXIT_DESTINATIONS), else 99. A transfer out to another program
 *                  is 435 with subsidy 439 (permanent supportive housing).
 *                  FY2024's rental destinations become 435 + DestinationSubsidyType.
 *                  OtherDestination ← the move-out reason when Destination is 17.
 * IncomeBenefits one per hmis-assessment entry: income_any → IncomeFromAnySource,
 *                each source's 0/1 and <source>_amount, total_monthly_income;
 *                benefits_any and the six benefits; insurance_any and the ten
 *                insurances; DataCollectionStage and InformationDate.
 * HealthAndDV    one per entry: dv_survivor, dv_when, dv_fleeing.
 * Disabilities   six per entry (types 5 physical, 6 developmental, 7 chronic health,
 *                8 HIV/AIDS, 9 mental health, 10 substance use): the answer and, where
 *                HUD asks it, the "long-continued and indefinite" answer. Unanswered = 99.
 *
 * An entry belongs to the enrollment of its resident whose dates hold its
 * information date (within 30 days either side, for one filed just before the
 * move-in or just after the move-out); one that fits none is left out.
 *
 * ── Left blank, and why ──────────────────────────────────────────────────────
 *   - Funder.GrantID: we don't keep grant numbers. The CoC's HMIS admin can fill it.
 *   - ProjectCoC.Geocode: not kept; NYC's geocode is the CoC's to supply.
 *   - Project PITCount, RRHSubType, ResidentialAffiliation: not RRH; no counts kept.
 *   - Client.DifferentIdentityText and the gender columns: gone in FY2026.
 *   - Enrollment.PreviousStreetESSH: the assessment doesn't ask it.
 *   - Enrollment's PATH, RHY, SSVF, HP and VA columns (DateOfEngagement,
 *     PercentAMI, ReferralSource … ThresholdScore, MentalHealthConsultation): for
 *     programs Lantern doesn't run.
 *   - IncomeBenefits' "identify" texts, the No…Reason columns, ADAP, Ryan White,
 *     SOAR: not asked (HOPWA / PATH only).
 *   - Exit's RHY, HP and VASH columns: not Lantern's programs.
 *   - HealthAndDV's health status and pregnancy columns: RHY only.
 *   - Disabilities' T-cell and viral-load columns: HOPWA only.
 *   - Inventory, Affiliation, HMISParticipation, CEParticipation,
 *     EmploymentEducation, Services, CurrentLivingSituation, Assessment,
 *     AssessmentQuestions, AssessmentResults, Event, YouthEducationStatus: header
 *     only — Lantern Forms doesn't keep these.
 *
 * Codes the hmis-assessment form keeps that aren't HUD's own: length_of_stay
 * (1–6 → HUD 10, 11, 2, 3, 4, 5) and months_homeless_3yrs (1–13 → 101–113).
 * Every other answer is kept as HUD's code and passes straight through.
 *
 * Values are written as the CSV spec has them: dates YYYY-MM-DD, times
 * YYYY-MM-DD HH:MM:SS (New York time), money with two decimals, text quoted only
 * when it must be. Not made "spreadsheet safe" (services/spreadsheetSafe.ts): an
 * HMIS reads these, and a changed name would be wrong there.
 */

// ── The spec's files and columns (FY2026), in its order ──────────────────────

const AUDIT_COLS = ["DateCreated", "DateUpdated", "UserID", "DateDeleted", "ExportID"] as const;

export const HMIS_CSV_VERSION = "2026 v1.0";

export const HMIS_COLUMNS = {
  Export: [
    "ExportID", "SourceType", "SourceID", "SourceName", "SourceContactFirst", "SourceContactLast", "SourceContactPhone", "SourceContactExtension",
    "SourceContactEmail", "ExportDate", "ExportStartDate", "ExportEndDate", "SoftwareName", "SoftwareVersion", "CSVVersion", "ExportPeriodType",
    "ExportDirective", "HashStatus", "ImplementationID",
  ],
  Organization: ["OrganizationID", "OrganizationName", "VictimServiceProvider", "OrganizationCommonName", ...AUDIT_COLS],
  User: ["UserID", "UserFirstName", "UserLastName", "UserPhone", "UserExtension", "UserEmail", "DateCreated", "DateUpdated", "DateDeleted", "ExportID"],
  Project: [
    "ProjectID", "OrganizationID", "ProjectName", "ProjectCommonName", "OperatingStartDate", "OperatingEndDate", "ContinuumProject", "ProjectType",
    "HousingType", "RRHSubType", "ResidentialAffiliation", "TargetPopulation", "HOPWAMedAssistedLivingFac", "PITCount", ...AUDIT_COLS,
  ],
  Funder: ["FunderID", "ProjectID", "Funder", "OtherFunder", "GrantID", "StartDate", "EndDate", ...AUDIT_COLS],
  ProjectCoC: ["ProjectCoCID", "ProjectID", "CoCCode", "Geocode", "Address1", "Address2", "City", "State", "ZIP", "GeographyType", ...AUDIT_COLS],
  Inventory: [
    "InventoryID", "ProjectID", "CoCCode", "HouseholdType", "Availability", "UnitInventory", "BedInventory", "CHVetBedInventory", "YouthVetBedInventory",
    "VetBedInventory", "CHYouthBedInventory", "YouthBedInventory", "CHBedInventory", "OtherBedInventory", "ESBedType", "InventoryStartDate",
    "InventoryEndDate", ...AUDIT_COLS,
  ],
  Affiliation: ["AffiliationID", "ProjectID", "ResProjectID", ...AUDIT_COLS],
  HMISParticipation: ["HMISParticipationID", "ProjectID", "HMISParticipationType", "HMISParticipationStatusStartDate", "HMISParticipationStatusEndDate", ...AUDIT_COLS],
  CEParticipation: [
    "CEParticipationID", "ProjectID", "AccessPoint", "PreventionAssessment", "CrisisAssessment", "HousingAssessment", "DirectServices", "ReceivesReferrals",
    "CEParticipationStatusStartDate", "CEParticipationStatusEndDate", ...AUDIT_COLS,
  ],
  Client: [
    "PersonalID", "FirstName", "MiddleName", "LastName", "NameSuffix", "NameDataQuality", "SSN", "SSNDataQuality", "DOB", "DOBDataQuality", "Sex",
    "AmIndAKNative", "Asian", "BlackAfAmerican", "HispanicLatinao", "MidEastNAfrican", "NativeHIPacific", "White", "RaceNone", "AdditionalRaceEthnicity",
    "VeteranStatus", "YearEnteredService", "YearSeparated", "WorldWarII", "KoreanWar", "VietnamWar", "DesertStorm", "AfghanistanOEF", "IraqOIF",
    "IraqOND", "OtherTheater", "MilitaryBranch", "DischargeStatus", ...AUDIT_COLS,
  ],
  Enrollment: [
    "EnrollmentID", "PersonalID", "ProjectID", "EntryDate", "HouseholdID", "RelationshipToHoH", "EnrollmentCoC", "LivingSituation", "RentalSubsidyType",
    "LengthOfStay", "LOSUnderThreshold", "PreviousStreetESSH", "DateToStreetESSH", "TimesHomelessPastThreeYears", "MonthsHomelessPastThreeYears",
    "DisablingCondition", "DateOfEngagement", "MoveInDate", "DateOfPATHStatus", "ClientEnrolledInPATH", "ReasonNotEnrolled", "PercentAMI",
    "ReferralSource", "CountOutreachReferralApproaches", "DateOfBCPStatus", "EligibleForRHY", "ReasonNoServices", "RunawayYouth",
    "FormerWardChildWelfare", "ChildWelfareYears", "ChildWelfareMonths", "FormerWardJuvenileJustice", "JuvenileJusticeYears", "JuvenileJusticeMonths",
    "UnemploymentFam", "MentalHealthDisorderFam", "PhysicalDisabilityFam", "AlcoholDrugUseDisorderFam", "InsufficientIncome", "IncarceratedParent",
    "VAMCStation", "TargetScreenReqd", "TimeToHousingLoss", "AnnualPercentAMI", "LiteralHomelessHistory", "ClientLeaseholder", "HOHLeaseholder",
    "SubsidyAtRisk", "EvictionHistory", "CriminalRecord", "IncarceratedAdult", "PrisonDischarge", "SexOffender", "DisabledHoH", "CurrentPregnant",
    "SingleParent", "DependentUnder6", "HH5Plus", "CoCPrioritized", "HPScreeningScore", "ThresholdScore", "MentalHealthConsultation", ...AUDIT_COLS,
  ],
  Exit: [
    "ExitID", "EnrollmentID", "PersonalID", "ExitDate", "Destination", "DestinationSubsidyType", "OtherDestination", "HousingAssessment",
    "SubsidyInformation", "ProjectCompletionStatus", "EarlyExitReason", "ExchangeForSex", "ExchangeForSexPastThreeMonths", "CountOfExchangeForSex",
    "AskedOrForcedToExchangeForSex", "AskedOrForcedToExchangeForSexPastThreeMonths", "WorkplaceViolenceThreats", "WorkplacePromiseDifference",
    "CoercedToContinueWork", "LaborExploitPastThreeMonths", "CounselingReceived", "IndividualCounseling", "FamilyCounseling", "GroupCounseling",
    "SessionCountAtExit", "PostExitCounselingPlan", "SessionsInPlan", "DestinationSafeClient", "DestinationSafeWorker", "PosAdultConnections",
    "PosPeerConnections", "PosCommunityConnections", "AftercareDate", "AftercareProvided", "EmailSocialMedia", "Telephone", "InPersonIndividual",
    "InPersonGroup", "CMExitReason", ...AUDIT_COLS,
  ],
  IncomeBenefits: [
    "IncomeBenefitsID", "EnrollmentID", "PersonalID", "InformationDate", "IncomeFromAnySource", "TotalMonthlyIncome", "Earned", "EarnedAmount",
    "Unemployment", "UnemploymentAmount", "SSI", "SSIAmount", "SSDI", "SSDIAmount", "VADisabilityService", "VADisabilityServiceAmount",
    "VADisabilityNonService", "VADisabilityNonServiceAmount", "PrivateDisability", "PrivateDisabilityAmount", "WorkersComp", "WorkersCompAmount",
    "TANF", "TANFAmount", "GA", "GAAmount", "SocSecRetirement", "SocSecRetirementAmount", "Pension", "PensionAmount", "ChildSupport",
    "ChildSupportAmount", "Alimony", "AlimonyAmount", "OtherIncomeSource", "OtherIncomeAmount", "OtherIncomeSourceIdentify", "BenefitsFromAnySource",
    "SNAP", "WIC", "TANFChildCare", "TANFTransportation", "OtherTANF", "OtherBenefitsSource", "OtherBenefitsSourceIdentify", "InsuranceFromAnySource",
    "Medicaid", "NoMedicaidReason", "Medicare", "NoMedicareReason", "SCHIP", "NoSCHIPReason", "VHAServices", "NoVHAReason", "EmployerProvided",
    "NoEmployerProvidedReason", "COBRA", "NoCOBRAReason", "PrivatePay", "NoPrivatePayReason", "StateHealthIns", "NoStateHealthInsReason",
    "IndianHealthServices", "NoIndianHealthServicesReason", "OtherInsurance", "OtherInsuranceIdentify", "ADAP", "NoADAPReason", "RyanWhiteMedDent",
    "NoRyanWhiteReason", "ConnectionWithSOAR", "DataCollectionStage", ...AUDIT_COLS,
  ],
  HealthAndDV: [
    "HealthAndDVID", "EnrollmentID", "PersonalID", "InformationDate", "DomesticViolenceSurvivor", "WhenOccurred", "CurrentlyFleeing",
    "GeneralHealthStatus", "DentalHealthStatus", "MentalHealthStatus", "PregnancyStatus", "DueDate", "DataCollectionStage", ...AUDIT_COLS,
  ],
  EmploymentEducation: [
    "EmploymentEducationID", "EnrollmentID", "PersonalID", "InformationDate", "LastGradeCompleted", "SchoolStatus", "Employed", "EmploymentType",
    "NotEmployedReason", "DataCollectionStage", ...AUDIT_COLS,
  ],
  Disabilities: [
    "DisabilitiesID", "EnrollmentID", "PersonalID", "InformationDate", "DisabilityType", "DisabilityResponse", "IndefiniteAndImpairs",
    "TCellCountAvailable", "TCellCount", "TCellSource", "ViralLoadAvailable", "ViralLoad", "ViralLoadSource", "AntiRetroviral", "DataCollectionStage",
    ...AUDIT_COLS,
  ],
  Services: [
    "ServicesID", "EnrollmentID", "PersonalID", "DateProvided", "RecordType", "TypeProvided", "OtherTypeProvided", "MovingOnOtherType",
    "SubTypeProvided", "FAAmount", "FAStartDate", "FAEndDate", "ReferralOutcome", ...AUDIT_COLS,
  ],
  CurrentLivingSituation: [
    "CurrentLivingSitID", "EnrollmentID", "PersonalID", "InformationDate", "CurrentLivingSituation", "CLSSubsidyType", "VerifiedBy",
    "LeaveSituation14Days", "SubsequentResidence", "ResourcesToObtain", "LeaseOwn60Day", "MovedTwoOrMore", "LocationDetails", ...AUDIT_COLS,
  ],
  Assessment: [
    "AssessmentID", "EnrollmentID", "PersonalID", "AssessmentDate", "AssessmentLocation", "AssessmentType", "AssessmentLevel", "PrioritizationStatus",
    ...AUDIT_COLS,
  ],
  AssessmentQuestions: [
    "AssessmentQuestionID", "AssessmentID", "EnrollmentID", "PersonalID", "AssessmentQuestionGroup", "AssessmentQuestionOrder", "AssessmentQuestion",
    "AssessmentAnswer", ...AUDIT_COLS,
  ],
  AssessmentResults: ["AssessmentResultID", "AssessmentID", "EnrollmentID", "PersonalID", "AssessmentResultType", "AssessmentResult", ...AUDIT_COLS],
  Event: [
    "EventID", "EnrollmentID", "PersonalID", "EventDate", "Event", "ProbSolDivRRResult", "ReferralCaseManageAfter", "LocationCrisisOrPHHousing",
    "ReferralResult", "ResultDate", ...AUDIT_COLS,
  ],
  YouthEducationStatus: [
    "YouthEducationStatusID", "EnrollmentID", "PersonalID", "InformationDate", "CurrentSchoolAttend", "MostRecentEdStatus", "CurrentEdStatus",
    "DataCollectionStage", ...AUDIT_COLS,
  ],
} as const satisfies Record<string, readonly string[]>;

export type HmisFile = keyof typeof HMIS_COLUMNS;
type Cell = string | number | null | undefined;
type Row = Record<string, Cell>;

// ── Who and where (Lantern's, for every export) ──────────────────────────────

/** Every Lantern building is in New York City's Continuum of Care. */
const COC_CODE = "NY-600";
const ORGANIZATION = { id: "LCS", name: "Lantern Community Services" };
const SYSTEM_USER = "LF-SYSTEM";
/** The hmis-assessment basic form (PlanStreet's HMIS assessment, rebuilt): answers are HUD codes. */
export const HMIS_ASSESSMENT_SLUG = "hmis-assessment";
/** How far an assessment's information date may sit outside its enrollment's dates and still belong to it. */
const LINK_DAYS = 30;

// ── HUD codes for what client information keeps as words ─────────────────────

const UNKNOWN: Record<string, number> = { "Client doesn't know": 8, "Client prefers not to answer": 9, "Data not collected": 99 };
const NAME_DQ: Record<string, number> = { "Full name reported": 1, "Partial, street name, or code name reported": 2, ...UNKNOWN };
const SSN_DQ: Record<string, number> = { "Full SSN reported": 1, "Approximate or partial SSN reported": 2, ...UNKNOWN };
const DOB_DQ: Record<string, number> = { "Full DOB reported": 1, "Approximate or partial DOB reported": 2, ...UNKNOWN };
const SEX: Record<string, number> = { Female: 0, Male: 1, ...UNKNOWN };
const YES_NO_UNKNOWN: Record<string, number> = { No: 0, Yes: 1, ...UNKNOWN };
const RACE: [string, string][] = [
  ["American Indian, Alaska Native, or Indigenous", "AmIndAKNative"],
  ["Asian or Asian American", "Asian"],
  ["Black, African American, or African", "BlackAfAmerican"],
  ["Hispanic/Latina/e/o", "HispanicLatinao"],
  ["Middle Eastern or North African", "MidEastNAfrican"],
  ["Native Hawaiian or Pacific Islander", "NativeHIPacific"],
  ["White", "White"],
];
const THEATERS: [string, string][] = [
  ["World War II", "WorldWarII"],
  ["Korean War", "KoreanWar"],
  ["Vietnam War", "VietnamWar"],
  ["Persian Gulf War (Operation Desert Storm)", "DesertStorm"],
  ["Afghanistan (Operation Enduring Freedom)", "AfghanistanOEF"],
  ["Iraq (Operation Iraqi Freedom)", "IraqOIF"],
  ["Iraq (Operation New Dawn)", "IraqOND"],
  ["Other peace-keeping operations or military interventions", "OtherTheater"],
];
const BRANCH: Record<string, number> = { Army: 1, "Air Force": 2, Navy: 3, Marines: 4, "Coast Guard": 6, "Space Force": 7, ...UNKNOWN };
const DISCHARGE: Record<string, number> = {
  Honorable: 1,
  "General under honorable conditions": 2,
  "Under other than honorable conditions (OTH)": 4,
  Uncharacterized: 5,
  "Bad conduct": 6,
  Dishonorable: 7,
  ...UNKNOWN,
};
const RELATION: Record<string, number> = {
  [HEAD]: 1,
  "Head of household's child": 2,
  "Head of household's spouse or partner": 3,
  "Head of household's other relation member": 4,
  "Other: non-relation member": 5,
};

/**
 * FY2024 folded the "rental by client, with … subsidy" destinations and living
 * situations into 435 plus a subsidy type. PlanStreet's lists (and the
 * hmis-assessment form's) still offer them one by one, under the subsidy's code.
 */
const SUBSIDY_OF: Record<number, number> = { 419: 419, 428: 428, 431: 431, 433: 433, 434: 434, 439: 439, 435: 420 };
function situation(code: number | null): { code: number | null; subsidy: number | null } {
  if (code === null) return { code: null, subsidy: null };
  return code in SUBSIDY_OF ? { code: 435, subsidy: SUBSIDY_OF[code] } : { code, subsidy: null };
}

/** residency.ts EXIT_DESTINATIONS (the words a move-out records) → HUD destination codes. */
const DESTINATION_OF_WORDS: Record<string, number> = {
  "Place not meant for habitation (e.g., a vehicle, an abandoned building, bus/train/subway station/airport or anywhere outside)": 116,
  "Emergency shelter, including hotel or motel paid for with emergency shelter voucher, Host Home shelter": 101,
  "Safe Haven": 118,
  "Foster care home or foster care group home": 215,
  "Hospital or other residential non-psychiatric medical facility": 206,
  "Jail, prison or juvenile detention facility": 207,
  "Long-term care facility or nursing home": 225,
  "Psychiatric hospital or other psychiatric facility": 204,
  "Substance abuse treatment facility or detox center": 205,
  "Transitional housing for homeless persons (including homeless youth)": 302,
  "Residential project or halfway house with no homeless criteria": 329,
  "Hotel or motel paid for without emergency shelter voucher": 314,
  "Host Home (non-crisis)": 332,
  "Staying or living with family, temporary tenure (e.g., room, apartment, or house)": 312,
  "Staying or living with friends, temporary tenure (e.g., room, apartment, or house)": 313,
  "Moved from one HOPWA funded project to HOPWA TH": 327,
  "Staying or living with family, permanent tenure": 422,
  "Staying or living with friends, permanent tenure": 423,
  "Moved from one HOPWA funded project to HOPWA PH": 426,
  "Rental by client, no ongoing housing subsidy": 410,
  "Rental by client, with ongoing housing subsidy": 435,
  "Rental by client, with HCV voucher (tenant or project based)": 433,
  "Rental by client in a public housing unit": 434,
  "Rental by client, with VASH housing subsidy": 419,
  "Rental by client, with GPD TIP housing subsidy": 428,
  "Rental by client, with RRH or equivalent subsidy": 431,
  "Owned by client, with ongoing housing subsidy": 421,
  "Owned by client, no ongoing housing subsidy": 411,
  "Permanent housing (other than RRH) for formerly homeless persons": 439,
  Deceased: 24,
  Other: 17,
  "Client doesn't know": 8,
  "Client prefers not to answer": 9,
  "No exit interview completed": 30,
  "Data not collected": 99,
  "Worker unable to determine": 37,
};

/** The form's length_of_stay (1–6) → HUD's LengthOfStay. */
const LENGTH_OF_STAY: Record<number, number> = { 1: 10, 2: 11, 3: 2, 4: 3, 5: 4, 6: 5 };
const UNKNOWN_CODES = new Set([8, 9, 99]);

/** The assessment's income sources: [answer key, HUD column, HUD amount column]. */
const INCOME: [string, string, string][] = [
  ["earned", "Earned", "EarnedAmount"],
  ["unemployment", "Unemployment", "UnemploymentAmount"],
  ["ssi", "SSI", "SSIAmount"],
  ["ssdi", "SSDI", "SSDIAmount"],
  ["va_disability_service", "VADisabilityService", "VADisabilityServiceAmount"],
  ["va_disability_non_service", "VADisabilityNonService", "VADisabilityNonServiceAmount"],
  ["private_disability", "PrivateDisability", "PrivateDisabilityAmount"],
  ["workers_comp", "WorkersComp", "WorkersCompAmount"],
  ["tanf", "TANF", "TANFAmount"],
  ["ga", "GA", "GAAmount"],
  ["soc_sec_retirement", "SocSecRetirement", "SocSecRetirementAmount"],
  ["pension", "Pension", "PensionAmount"],
  ["child_support", "ChildSupport", "ChildSupportAmount"],
  ["alimony", "Alimony", "AlimonyAmount"],
  ["other_income", "OtherIncomeSource", "OtherIncomeAmount"],
];
const BENEFITS: [string, string][] = [
  ["snap", "SNAP"],
  ["wic", "WIC"],
  ["tanf_child_care", "TANFChildCare"],
  ["tanf_transportation", "TANFTransportation"],
  ["other_tanf", "OtherTANF"],
  ["other_benefits", "OtherBenefitsSource"],
];
const INSURANCE: [string, string][] = [
  ["medicaid", "Medicaid"],
  ["medicare", "Medicare"],
  ["schip", "SCHIP"],
  ["vha_services", "VHAServices"],
  ["employer_provided", "EmployerProvided"],
  ["cobra", "COBRA"],
  ["private_pay", "PrivatePay"],
  ["state_health_ins", "StateHealthIns"],
  ["indian_health_services", "IndianHealthServices"],
  ["other_insurance", "OtherInsurance"],
];
/** [HUD DisabilityType, answer key, "long-continued and indefinite" key (where HUD asks it)]. */
const DISABILITIES: [number, string, string | null][] = [
  [5, "physical_disability", "physical_disability_long"],
  [6, "developmental_disability", null],
  [7, "chronic_health", "chronic_health_long"],
  [8, "hiv_aids", null],
  [9, "mental_health", "mental_health_long"],
  [10, "substance_use", "substance_use_long"],
];

// ── Small helpers ────────────────────────────────────────────────────────────

const NY_TIME = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
/** "YYYY-MM-DD HH:MM:SS", New York time: the spec's timestamp. */
function stamp(d: Date): string {
  const p = Object.fromEntries(NY_TIME.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const asDate = (v: unknown): string | null => (typeof v === "string" && DATE_RE.test(v) ? v : null);

/** An answer kept as a HUD code ("1", 1) → the number, else null. */
function code(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d{1,4}$/.test(v.trim())) return Number(v.trim());
  return null;
}
function money(v: unknown): string | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n.toFixed(2) : null;
}
/** Text cut to the spec's length for the column. */
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
/** Ids are at most 32 characters in the spec; ours are cuids (25), but just in case. */
const id32 = (raw: string) => (raw.length <= 32 ? raw : crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32));
const shortHash = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12).toUpperCase();
/** "Amber Hall - HASA-CoC Single Adults (85)" and "Amber Hall - HASA/CoC Single Adults" compare equal. */
const programKey = (s: string) => s.replace(/\s*\(\d+\)\s*$/, "").toLowerCase().replace(/[^a-z0-9]/g, "");

function splitName(name: string): [string, string] {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? [parts.slice(0, -1).join(" "), parts[parts.length - 1]] : [parts[0] ?? "", ""];
}

/** "1385 Fulton Avenue, Bronx, NY 10456" → its parts; anything else stays whole in Address1. */
function addressParts(raw: string | null) {
  if (!raw?.trim()) return { Address1: null, City: null, State: null, ZIP: null };
  const m = /^(.*?),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\s*$/.exec(raw.trim());
  if (!m) return { Address1: text(raw, 100), City: null, State: null, ZIP: null };
  return { Address1: text(m[1], 100), City: text(m[2], 50), State: m[3], ZIP: m[4] };
}

function csvCell(v: Cell): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A file's text: the header, then each row in the spec's column order. A key the spec doesn't have is a mistake here, not data to drop. */
export function toCsv(file: HmisFile, rows: Row[]): string {
  const cols = HMIS_COLUMNS[file] as readonly string[];
  const known = new Set(cols);
  const lines = [cols.join(",")];
  for (const r of rows) {
    for (const k of Object.keys(r)) if (!known.has(k)) throw new Error(`${file}.csv has no column ${k}.`);
    lines.push(cols.map((c) => csvCell(r[c])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

// ── Building it ──────────────────────────────────────────────────────────────

export interface HmisExportOptions {
  /** Supportive sites in the person's scope. */
  sites: Pick<Site, "id" | "code" | "name">[];
  from: string;
  to: string;
  /** Whole SSNs in Client.csv: only when the person has clients.ssn (the route checks). */
  includeSsn: boolean;
  /** Who's exporting: Export.csv's contact. */
  contact: { name: string; email: string | null };
  now?: Date;
}

interface Project {
  id: string;
  name: string;
  siteId: string;
  /** null for a building's catch-all project. */
  program: string | null;
}

interface Enrollment {
  id: string;
  tenantId: string;
  siteId: string;
  project: Project;
  stays: Stay[];
  entry: string;
  exit: string | null;
}

interface Assessment {
  id: string;
  tenantId: string;
  info: string;
  stage: number | null;
  programId: string | null;
  v: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  createdById: string | null;
}

/** The files, as text, keyed "Client.csv". */
export async function hmisCsvFiles(opts: HmisExportOptions): Promise<{ files: Map<string, string>; counts: Record<string, number>; exportId: string }> {
  const now = opts.now ?? new Date();
  const exportId = `LF${stamp(now).replace(/\D/g, "")}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  const siteIds = opts.sites.map((s) => s.id);
  const sites = await prisma.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, code: true, name: true, address: true, createdAt: true, updatedAt: true } });
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const fromD = day(opts.from);
  const toD = day(opts.to);

  // Every stay at these sites, ever: a transfer chain or a household's head may
  // reach back before the range. Asked by site, not by person, because SQL
  // Server takes at most 2,100 parameters and a whole-organisation export names
  // about that many people.
  const allStays = (
    await prisma.stay.findMany({ where: { siteId: { in: siteIds } }, orderBy: [{ moveInDate: "asc" }, { createdAt: "asc" }] })
  ).filter((s) => s.endKind !== "removed");
  const tenantIds = [...new Set(allStays.filter((s) => s.moveInDate <= toD && (!s.moveOutDate || s.moveOutDate >= fromD)).map((s) => s.tenantId))];
  const livedHere = { stays: { some: { siteId: { in: siteIds }, moveInDate: { lte: toD }, OR: [{ moveOutDate: null }, { moveOutDate: { gte: fromD } }] } } };
  const [tenants, profiles] = await Promise.all([
    prisma.tenant.findMany({ where: livedHere }),
    prisma.tenantProfile.findMany({ where: { tenant: livedHere } }),
  ]);
  const tenantById = new Map(tenants.map((t) => [t.id, t]));
  const profileById = new Map(profiles.map((p) => [p.tenantId, p]));

  // Projects: PlanStreet's ProgramIDs from the assessment form's program list.
  const form = await prisma.builtForm.findUnique({ where: { slug: HMIS_ASSESSMENT_SLUG } });
  const doc = form ? liveDoc(form) : null;
  const programIdOf = new Map<string, string>();
  for (const c of doc?.fields.find((f) => f.id === "program_id")?.choices ?? []) programIdOf.set(programKey(c.label), String(c.value));
  const siteProgram = new Map(programs().map((p) => [p.value, p.site]));
  const projects = new Map<string, Project>();
  function projectFor(stay: Stay): Project {
    const site = siteById.get(stay.siteId)!;
    // The program they moved in under; else their client information's, when it's one of this building's.
    const own = profileById.get(stay.tenantId)?.program ?? null;
    const program = stay.program || (own && siteProgram.get(own) === site.code ? own : null);
    const id = program ? id32(programIdOf.get(programKey(program)) ?? `LF-${shortHash(program)}`) : id32(`LF-site-${site.code}`);
    if (!projects.has(id)) projects.set(id, { id, name: program ?? site.name, siteId: site.id, program });
    return projects.get(id)!;
  }

  // Enrollments: a person's stays in order, a transfer within the same project joined to the stay before it.
  const enrollments: Enrollment[] = [];
  const staysByTenant = new Map<string, Stay[]>();
  for (const s of allStays) staysByTenant.set(s.tenantId, [...(staysByTenant.get(s.tenantId) ?? []), s]);
  const enrollmentOfStay = new Map<string, Enrollment>();
  for (const list of staysByTenant.values()) {
    let cur: Enrollment | null = null;
    for (const s of list) {
      const project = projectFor(s);
      const joins =
        cur &&
        cur.project.id === project.id &&
        cur.stays[cur.stays.length - 1].endKind === "transferred" &&
        s.startKind === "transferred" &&
        cur.exit === ymd(s.moveInDate);
      if (joins && cur) {
        cur.stays.push(s);
        cur.exit = s.moveOutDate ? ymd(s.moveOutDate) : null;
      } else {
        cur = { id: id32(s.id), tenantId: s.tenantId, siteId: s.siteId, project, stays: [s], entry: ymd(s.moveInDate), exit: s.moveOutDate ? ymd(s.moveOutDate) : null };
        enrollments.push(cur);
      }
      enrollmentOfStay.set(s.id, cur);
    }
  }
  const inRange = enrollments.filter((e) => tenantById.has(e.tenantId) && e.entry <= opts.to && (e.exit === null || e.exit >= opts.from));

  /** The head's enrollment that was going on the day this one began. */
  function householdOf(e: Enrollment): { id: string; relation: number | null } {
    const first = e.stays[0];
    if (!first.householdHeadId) return { id: e.id, relation: 1 };
    const headStay = (staysByTenant.get(first.householdHeadId) ?? []).find(
      (s) => s.unitId === first.unitId && ymd(s.moveInDate) <= e.entry && (!s.moveOutDate || ymd(s.moveOutDate) >= e.entry)
    );
    const head = headStay ? enrollmentOfStay.get(headStay.id) : null;
    return { id: head?.id ?? e.id, relation: first.householdRelation ? RELATION[first.householdRelation] ?? 99 : 99 };
  }

  // The HMIS assessments of these people, each with the enrollment it belongs to.
  const assessments: Assessment[] = [];
  if (form) {
    const residentField = doc?.fields.find((f) => f.type === "resident")?.id ?? "client";
    const rows = await prisma.formEntry.findMany({
      where: { formId: form.id, status: "active", OR: [{ siteId: { in: siteIds } }, { siteId: null }] },
      select: { id: true, data: true, tenantId: true, createdAt: true, updatedAt: true, createdById: true },
    });
    const wanted = new Set(tenantIds);
    for (const r of rows) {
      let v: Record<string, unknown>;
      try {
        v = JSON.parse(r.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const who = (v[residentField] as { id?: unknown } | undefined)?.id;
      const tenantId = typeof who === "string" ? who : r.tenantId;
      const info = asDate(v.information_date);
      if (!tenantId || !wanted.has(tenantId) || !info || info > opts.to) continue;
      assessments.push({
        id: r.id,
        tenantId,
        info,
        stage: code(v.data_collection_stage),
        programId: typeof v.program_id === "string" ? v.program_id : null,
        v,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        createdById: r.createdById,
      });
    }
  }
  const byEnrollment = new Map<string, Assessment[]>();
  const enrollmentOf = new Map<string, Enrollment>();
  const today = todayNY();
  const inRangeOf = new Map<string, Enrollment[]>();
  for (const e of inRange) inRangeOf.set(e.tenantId, [...(inRangeOf.get(e.tenantId) ?? []), e]);
  for (const a of assessments) {
    let best: { e: Enrollment; gap: number; sameProject: boolean } | null = null;
    for (const e of inRangeOf.get(a.tenantId) ?? []) {
      const end = e.exit ?? today;
      const gap = a.info < e.entry ? daysBetween(a.info, e.entry) : a.info > end ? daysBetween(end, a.info) : 0;
      const sameProject = a.programId !== null && a.programId === e.project.id;
      if (gap > LINK_DAYS) continue;
      if (!best || gap < best.gap || (gap === best.gap && sameProject && !best.sameProject)) best = { e, gap, sameProject };
    }
    if (!best) continue;
    enrollmentOf.set(a.id, best.e);
    byEnrollment.set(best.e.id, [...(byEnrollment.get(best.e.id) ?? []), a]);
  }
  for (const list of byEnrollment.values()) list.sort((x, y) => x.info.localeCompare(y.info) || x.createdAt.getTime() - y.createdAt.getTime());

  // ── Rows ──
  const users = new Set<string>();
  const userOf = (id: string | null | undefined) => {
    if (id) users.add(id);
    return id ? id32(id) : SYSTEM_USER;
  };
  const audit = (created: Date, updated: Date, userId: string | null | undefined) => ({
    DateCreated: stamp(created),
    DateUpdated: stamp(updated),
    UserID: userOf(userId),
    DateDeleted: null,
    ExportID: exportId,
  });

  const enrollmentRows: Row[] = [];
  const exitRows: Row[] = [];
  const clientIds = new Set<string>();
  for (const e of inRange) {
    clientIds.add(e.tenantId);
    const first = e.stays[0];
    const last = e.stays[e.stays.length - 1];
    const list = byEnrollment.get(e.id) ?? [];
    const start = list.find((a) => a.stage === 1) ?? null;
    const latest = list[list.length - 1] ?? null;
    const hh = householdOf(e);
    const lived = situation(code(start?.v.living_situation));
    const los = code(start?.v.length_of_stay);
    const losHud = los === null ? null : LENGTH_OF_STAY[los] ?? (UNKNOWN_CODES.has(los) ? los : null);
    const homeless = lived.code !== null && lived.code >= 100 && lived.code < 200;
    const months = code(start?.v.months_homeless_3yrs);
    const disabling = code(start?.v.disabling_condition) ?? code(latest?.v.disabling_condition);
    enrollmentRows.push({
      EnrollmentID: e.id,
      PersonalID: id32(e.tenantId),
      ProjectID: e.project.id,
      EntryDate: e.entry,
      HouseholdID: hh.id,
      RelationshipToHoH: hh.relation,
      EnrollmentCoC: hh.relation === 1 ? COC_CODE : null,
      LivingSituation: start ? lived.code ?? 99 : 99,
      RentalSubsidyType: lived.subsidy,
      LengthOfStay: start && lived.code !== null && !UNKNOWN_CODES.has(lived.code) ? losHud ?? 99 : null,
      LOSUnderThreshold: losUnderThreshold(lived.code, losHud, code(start?.v.foster_care_under_90_days)),
      DateToStreetESSH: homeless ? asDate(start?.v.date_homelessness_started) : null,
      TimesHomelessPastThreeYears: homeless ? code(start?.v.times_homeless_3yrs) : null,
      MonthsHomelessPastThreeYears: homeless && months !== null ? (months >= 1 && months <= 13 ? 100 + months : UNKNOWN_CODES.has(months) ? months : null) : null,
      DisablingCondition: disabling ?? 99,
      MoveInDate: e.entry,
      ...audit(first.createdAt, last.updatedAt, first.createdById),
    });

    if (e.exit && e.exit <= opts.to) {
      const exitA = [...list].reverse().find((a) => a.stage === 3) ?? null;
      let dest = situation(code(exitA?.v.destination));
      if (dest.code === null) {
        if (last.endKind === "transferred") dest = { code: 435, subsidy: 439 };
        else if (last.exitDestination && DESTINATION_OF_WORDS[last.exitDestination] !== undefined) dest = situation(DESTINATION_OF_WORDS[last.exitDestination]);
        else dest = { code: 99, subsidy: null };
      }
      exitRows.push({
        ExitID: id32(last.id),
        EnrollmentID: e.id,
        PersonalID: id32(e.tenantId),
        ExitDate: e.exit,
        Destination: dest.code,
        DestinationSubsidyType: dest.subsidy,
        OtherDestination: dest.code === 17 ? text(last.endReason, 50) : null,
        ...audit(last.updatedAt, last.updatedAt, last.endedById ?? last.createdById),
      });
    }
  }

  const clientRows: Row[] = [];
  for (const id of clientIds) {
    const t = tenantById.get(id)!;
    const p = profileById.get(id) ?? null;
    clientRows.push(clientRow(t, p, opts.includeSsn, audit(t.createdAt, latestOf(t.updatedAt, p?.updatedAt), p?.updatedById ?? t.createdById)));
  }

  const incomeRows: Row[] = [];
  const dvRows: Row[] = [];
  const disabilityRows: Row[] = [];
  for (const a of assessments) {
    const e = enrollmentOf.get(a.id);
    if (!e) continue;
    const base = { EnrollmentID: e.id, PersonalID: id32(a.tenantId), InformationDate: a.info, DataCollectionStage: a.stage };
    const meta = audit(a.createdAt, a.updatedAt, a.createdById);
    incomeRows.push({ IncomeBenefitsID: id32(a.id), ...base, ...incomeColumns(a.v), ...meta });
    const dv = code(a.v.dv_survivor);
    dvRows.push({
      HealthAndDVID: id32(a.id),
      ...base,
      DomesticViolenceSurvivor: dv ?? 99,
      WhenOccurred: dv === 1 ? code(a.v.dv_when) ?? 99 : null,
      CurrentlyFleeing: dv === 1 ? code(a.v.dv_fleeing) ?? 99 : null,
      ...meta,
    });
    for (const [type, key, longKey] of DISABILITIES) {
      const answer = code(a.v[key]);
      disabilityRows.push({
        DisabilitiesID: `${id32(a.id).slice(0, 28)}-${type}`,
        ...base,
        DisabilityType: type,
        DisabilityResponse: answer ?? 99,
        IndefiniteAndImpairs: longKey && answer !== null && answer > 0 && !UNKNOWN_CODES.has(answer) ? code(a.v[longKey]) ?? 99 : null,
        ...meta,
      });
    }
  }

  // Projects, their funders and CoC rows: the ones the enrollments use.
  const used = [...new Set(inRange.map((e) => e.project.id))].map((id) => projects.get(id)!).sort((x, y) => x.name.localeCompare(y.name));
  const firstMoveIn = new Map<string, string>();
  for (const e of enrollments) {
    const was = firstMoveIn.get(e.project.id);
    if (!was || e.entry < was) firstMoveIn.set(e.project.id, e.entry);
  }
  const projectRows: Row[] = [];
  const funderRows: Row[] = [];
  const cocRows: Row[] = [];
  for (const p of used) {
    const site = siteById.get(p.siteId)!;
    const meta = audit(site.createdAt, site.updatedAt, null);
    const startDate = firstMoveIn.get(p.id) ?? ymd(site.createdAt);
    projectRows.push({
      ProjectID: p.id,
      OrganizationID: ORGANIZATION.id,
      ProjectName: text(p.name, 200),
      ProjectCommonName: text(site.name, 200),
      OperatingStartDate: startDate,
      ContinuumProject: 1,
      ProjectType: 3,
      HousingType: 1,
      TargetPopulation: 4,
      HOPWAMedAssistedLivingFac: 2,
      ...meta,
    });
    // "Amber Hall - HASA/CoC Single Adults" → "HASA/CoC Single Adults"; a building's catch-all project has none.
    const funding = p.program ? p.program.split(/\s+-\s+/).slice(1).join(" - ") || p.program : null;
    const coc = Boolean(funding && /\bCoC\b/i.test(funding));
    funderRows.push({
      FunderID: id32(`${p.id}-F`),
      ProjectID: p.id,
      Funder: coc ? 2 : 46,
      OtherFunder: coc ? null : text(funding ?? "Not recorded in Lantern Forms", 100),
      StartDate: startDate,
      ...meta,
    });
    cocRows.push({ ProjectCoCID: id32(`${p.id}-C`), ProjectID: p.id, CoCCode: COC_CODE, ...addressParts(site.address), GeographyType: 1, ...meta });
  }

  const people = users.size ? await prisma.user.findMany({ where: { id: { in: [...users] } }, select: { id: true, name: true, email: true, createdAt: true, updatedAt: true } }) : [];
  const found = new Set(people.map((u) => u.id));
  const userRows: Row[] = [
    { UserID: SYSTEM_USER, UserFirstName: "Lantern Forms", UserLastName: "(system)", DateCreated: stamp(now), DateUpdated: stamp(now), ExportID: exportId },
    ...people.map((u) => {
      const [first, last] = splitName(u.name);
      return { UserID: id32(u.id), UserFirstName: text(first, 50), UserLastName: text(last, 50), UserEmail: text(u.email, 320), DateCreated: stamp(u.createdAt), DateUpdated: stamp(u.updatedAt), ExportID: exportId };
    }),
    // Someone whose account is gone: still named, so their rows' UserID points somewhere.
    ...[...users].filter((u) => !found.has(u)).map((u) => ({ UserID: id32(u), UserFirstName: "Removed", UserLastName: "account", DateCreated: stamp(now), DateUpdated: stamp(now), ExportID: exportId })),
  ];

  const [contactFirst, contactLast] = splitName(opts.contact.name);
  let host = appBaseUrl;
  try {
    host = new URL(appBaseUrl).host;
  } catch {
    // Not a URL: the setting as written still tells installations apart.
  }
  const rows: Partial<Record<HmisFile, Row[]>> = {
    Export: [
      {
        ExportID: exportId,
        SourceType: 2,
        SourceID: COC_CODE,
        SourceName: ORGANIZATION.name,
        SourceContactFirst: text(contactFirst, 50),
        SourceContactLast: text(contactLast, 50),
        SourceContactEmail: text(opts.contact.email, 320),
        ExportDate: stamp(now),
        ExportStartDate: opts.from,
        ExportEndDate: opts.to,
        SoftwareName: "Lantern Forms",
        SoftwareVersion: text(env.devlog.appVersion, 50),
        CSVVersion: HMIS_CSV_VERSION,
        ExportPeriodType: 3,
        ExportDirective: 2,
        HashStatus: 1,
        ImplementationID: text(host, 200),
      },
    ],
    Organization: [{ OrganizationID: ORGANIZATION.id, OrganizationName: ORGANIZATION.name, VictimServiceProvider: 0, ...audit(now, now, null) }],
    User: userRows,
    Project: projectRows,
    Funder: funderRows,
    ProjectCoC: cocRows,
    Client: clientRows,
    Enrollment: enrollmentRows,
    Exit: exitRows,
    IncomeBenefits: incomeRows,
    HealthAndDV: dvRows,
    Disabilities: disabilityRows,
  };
  const files = new Map<string, string>();
  for (const file of Object.keys(HMIS_COLUMNS) as HmisFile[]) files.set(`${file}.csv`, toCsv(file, rows[file] ?? []));
  const counts = Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v?.length ?? 0]));
  return { files, counts, exportId };
}

/** The zip a person downloads. */
export async function buildHmisExport(opts: HmisExportOptions) {
  const { files, counts, exportId } = await hmisCsvFiles(opts);
  const zip = makeZip([...files].map(([name, data]) => ({ name, data })), opts.now);
  return { zip, counts, exportId, filename: `hmis-csv-${opts.from}-to-${opts.to}.zip` };
}

// ── One row's parts ──────────────────────────────────────────────────────────

function daysBetween(a: string, b: string) {
  return Math.round((day(b).getTime() - day(a).getTime()) / 86_400_000);
}

function latestOf(a: Date, b: Date | undefined) {
  return b && b > a ? b : a;
}

/**
 * Was the stay before project start short enough to keep the person's
 * homelessness going? Institutional situations (200s): under 90 days; other
 * places (300s, 400s): under 7 nights. HUD doesn't ask it after a homeless one.
 */
function losUnderThreshold(situation: number | null, los: number | null, fosterUnder90: number | null): number | null {
  if (situation === null || UNKNOWN_CODES.has(situation) || situation < 200) return null;
  if (situation === 215 && (fosterUnder90 === 0 || fosterUnder90 === 1)) return fosterUnder90;
  if (los === null || UNKNOWN_CODES.has(los)) return null;
  const short = situation < 300 ? [10, 11, 2, 3] : [10, 11];
  return short.includes(los) ? 1 : 0;
}

function clientRow(t: Tenant, p: TenantProfile | null, includeSsn: boolean, meta: Row): Row {
  const v = valuesOf(p);
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : null);
  const list = (k: string) => (Array.isArray(v[k]) ? (v[k] as unknown[]).map(String) : []);
  const races = list("raceEthnicity");
  const raceCols = Object.fromEntries(RACE.map(([words, col]) => [col, races.includes(words) ? 1 : 0]));
  const anyRace = RACE.some(([words]) => races.includes(words));
  const raceUnknown = races.map((r) => UNKNOWN[r]).find((n) => n !== undefined);
  const veteran = YES_NO_UNKNOWN[str("veteranStatus") ?? ""] ?? 99;
  const theaters = list("theatersOfOperation");
  const year = (k: string) => (typeof v[k] === "number" ? (v[k] as number) : null);
  const dob = str("dateOfBirth");
  const ssn = p?.ssn ?? null;
  const dq = (table: Record<string, number>, k: string, have: boolean) => table[str(k) ?? ""] ?? (have ? 1 : 99);
  return {
    PersonalID: id32(t.id),
    FirstName: text(t.firstName, 50),
    MiddleName: text(str("middleName"), 50),
    LastName: text(t.lastName, 50),
    NameSuffix: text(str("nameSuffix"), 50),
    NameDataQuality: NAME_DQ[str("nameDataQuality") ?? ""] ?? 99,
    SSN: includeSsn && ssn ? ssn : null,
    SSNDataQuality: dq(SSN_DQ, "ssnDataQuality", Boolean(ssn)),
    DOB: dob,
    DOBDataQuality: dq(DOB_DQ, "dobDataQuality", Boolean(dob)),
    Sex: SEX[str("sex") ?? ""] ?? 99,
    ...raceCols,
    RaceNone: anyRace ? null : raceUnknown ?? 99,
    AdditionalRaceEthnicity: text(str("raceEthnicityDetail"), 100),
    VeteranStatus: veteran,
    // Veterans only (FY2026: null for everyone else).
    ...(veteran === 1
      ? {
          YearEnteredService: year("militaryEntryYear"),
          YearSeparated: year("militarySeparationYear"),
          ...Object.fromEntries(THEATERS.map(([words, col]) => [col, theaters.includes(words) ? 1 : 0])),
          MilitaryBranch: BRANCH[str("militaryBranch") ?? ""] ?? 99,
          DischargeStatus: DISCHARGE[str("dischargeStatus") ?? ""] ?? 99,
        }
      : {}),
    ...meta,
  };
}

/** Income, non-cash benefits and health insurance from one assessment. Sources are 0 when the "any" answer is No, blank when it's unknown. */
function incomeColumns(v: Record<string, unknown>): Row {
  const out: Row = {};
  const any = code(v.income_any);
  out.IncomeFromAnySource = any ?? 99;
  let total = 0;
  for (const [key, col, amountCol] of INCOME) {
    const yes = code(v[key]);
    out[col] = any === 1 ? yes ?? 0 : any === 0 ? 0 : null;
    const amount = any === 1 && yes === 1 ? money(v[`${key}_amount`]) : null;
    out[amountCol] = amount;
    if (amount) total += Number(amount);
  }
  out.TotalMonthlyIncome = any === 1 ? money(v.total_monthly_income) ?? total.toFixed(2) : null;
  const benefits = code(v.benefits_any);
  out.BenefitsFromAnySource = benefits ?? 99;
  for (const [key, col] of BENEFITS) out[col] = benefits === 1 ? code(v[key]) ?? 0 : benefits === 0 ? 0 : null;
  const insured = code(v.insurance_any);
  out.InsuranceFromAnySource = insured ?? 99;
  for (const [key, col] of INSURANCE) out[col] = insured === 1 ? code(v[key]) ?? 0 : insured === 0 ? 0 : null;
  return out;
}
