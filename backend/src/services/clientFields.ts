import { z } from "zod";

/**
 * Client information: what PlanStreet keeps on a case (its Case Detail page and
 * intake form), field for field, so its records can be brought over and staff
 * see the same questions. One list drives everything — the API validates
 * against it, the resident page draws its sections from it (GET
 * /api/tenants/meta/client-fields), and the MCP tools describe it.
 *
 * Values are stored as the option text staff see (not codes), so an export
 * reads the way the screen does. HMIS codes, where a field has one, are a
 * mapping for the HMIS export, not what is stored.
 *
 * A field with `column` lives in its own TenantProfile column (it is looked up
 * by, or needs special care, like the SSN); every other one is a key in
 * TenantProfile.data. Adding a field here needs no migration.
 */

export type ClientFieldType =
  | "text"
  | "textarea"
  | "date"
  | "select"
  | "multi"
  | "year"
  | "phone"
  | "email"
  /** Nine digits; shown as its last four unless the viewer has clients.ssn. */
  | "ssn"
  /** A staff member (User id) who works at the resident's site. */
  | "staff"
  /** One of programs(): building – funder – population. */
  | "program"
  /** A list of people: name, relationship, phone, email. */
  | "contacts";

export type ClientColumn = "dateOfBirth" | "ssn" | "program" | "caseLeadId";

export interface ClientField {
  key: string;
  label: string;
  type: ClientFieldType;
  options?: readonly string[];
  hint?: string;
  /** Shown (and kept) only while another field holds one of these values. */
  showIf?: { key: string; in: readonly string[] };
  /** Takes a whole row on wide screens. */
  wide?: boolean;
  /** program fields: offer every building's programs, not just the resident's own. */
  allSites?: boolean;
  column?: ClientColumn;
}

export interface ClientSection {
  key: string;
  title: string;
  description?: string;
  fields: ClientField[];
}

// ── Option lists ────────────────────────────────────────────────────────

const YES_NO = ["Yes", "No"] as const;
const HUD_UNKNOWN = ["Client doesn't know", "Client prefers not to answer", "Data not collected"] as const;

/**
 * Programs: each building's funded programs, as PlanStreet names them (its
 * "Program Name" and intake "Referral Program" lists, 2026-11-18), without the
 * unit counts it puts in brackets. `site` is the Lantern Forms site code.
 * PlanStreet calls Huntersmoon Hall "HMH Hall" in some lists.
 */
export type Program = { value: string; site: string };

const REAL_PROGRAMS: readonly Program[] = [
  { site: "amber-hall", value: "Amber Hall - HASA/CoC Single Adults" },
  { site: "audubon-hall", value: "Audubon Hall - HASA/CoC Single Adults" },
  { site: "cedar-hall", value: "Cedars Hall - DOHMH/CoC Families" },
  { site: "cedar-hall", value: "Cedars Hall - DOHMH Families" },
  { site: "cedar-hall", value: "Cedars Hall - Community Families" },
  { site: "clover-hall", value: "Clover Hall - HASA/CoC Single Adults" },
  { site: "euclid-glenmore", value: "Euclid Glenmore - DOHMH 15/15 Single Adults" },
  { site: "euclid-glenmore", value: "Euclid Glenmore - Community Single Adults" },
  { site: "hunterfly-trace", value: "Hunterfly Trace - DOHMH/CoC Single Adults" },
  { site: "hunterfly-trace", value: "Hunterfly Trace - HRA Community Single Adults" },
  { site: "huntersmoon-hall", value: "Huntersmoon Hall - DOHMH/CoC Single Adults" },
  { site: "huntersmoon-hall", value: "Huntersmoon Hall - DOHMH/Mod SRO Single Adults" },
  { site: "huntersmoon-hall", value: "Huntersmoon Hall - HASA/CoC Single Adults" },
  { site: "huntersmoon-hall", value: "Huntersmoon Hall - HASA/Mod SRO Single Adults" },
  { site: "huntersmoon-hall", value: "Huntersmoon Hall - HRA Community Single Adults" },
  { site: "huntersmoon-hall", value: "Huntersmoon Hall - HRA Gen Pop Single Adult" },
  { site: "jasper-hall", value: "Jasper Hall - CoC Community Single Adult" },
  { site: "jasper-hall", value: "Jasper Hall - DOHMH Young Adults" },
  { site: "jasper-hall", value: "Jasper Hall - DOHMH/CoC Families" },
  { site: "jasper-hall", value: "Jasper Hall - Community Single Adults" },
  { site: "leeward-hall", value: "Leeward Hall - HASA Single Adult" },
  { site: "leeward-hall", value: "Leeward Hall - HASA Families" },
  { site: "lindenguild-hall", value: "Lindenguild Hall - DOHMH/CoC Single Adults" },
  { site: "lindenguild-hall", value: "Lindenguild Hall - Community Families" },
  { site: "prospero-hall", value: "Prospero Hall - DOHMH/PBV Single Adults" },
  { site: "prospero-hall", value: "Prospero Hall - Community Single Adults" },
  { site: "rustin-house", value: "Rustin House - DOHMH HSN/CoC Single Adults" },
  { site: "rustin-house", value: "Rustin House - DOHMH Pop A/CoC Single Adults" },
  { site: "rustin-house", value: "Rustin House - HRA Community Single Adults" },
  { site: "rustin-house", value: "Rustin House - HRA Gen Pop Single Adults" },
  { site: "rustin-house", value: "Rustin House - Pop A/CoC Single Adults" },
  { site: "savanna-hall", value: "Savanna Hall - OMH Single Adults" },
  { site: "savanna-hall", value: "Savanna Hall - OMH Young Adults" },
  { site: "savanna-hall", value: "Savanna Hall - Community Single Adults" },
  { site: "schafer-hall", value: "Schafer Hall - HRA/CoC Single Adults" },
  { site: "schafer-hall", value: "Schafer Hall - NYSSHP Young Adults" },
  { site: "schafer-hall", value: "Schafer Hall/Bailey House - CoC Families" },
  { site: "schafer-hall", value: "Schafer Hall/Bailey House - Families" },
  { site: "silverleaf-hall", value: "Silverleaf Hall - NYSSHP Families" },
  { site: "silverleaf-hall", value: "Silverleaf Hall - NYSSHP Supplemental Families" },
  { site: "stardom-hall", value: "Stardom Hall - CoC Gen Pop" },
  { site: "stardom-hall", value: "Stardom Hall - HASA/CoC Single Adults" },
  { site: "vicinitas-hall", value: "Vicinitas Hall - DOHMH/PBV Young Adults" },
  { site: "vicinitas-hall", value: "Vicinitas Hall - Pop I/PBV Young Adults" },
];
let PROGRAMS_NOW: readonly Program[] = REAL_PROGRAMS;
let PROGRAM_VALUES = new Set(PROGRAMS_NOW.map((p) => p.value));

/** The programs in use: the real ones, or a test site's made-up ones (services/testData.ts). */
export function programs(): readonly Program[] {
  return PROGRAMS_NOW;
}

/** Test sites only (services/testData.ts): made-up programs for made-up sites; null goes back to the real ones. */
export function setTestPrograms(list: readonly Program[] | null) {
  PROGRAMS_NOW = list?.length ? list : REAL_PROGRAMS;
  PROGRAM_VALUES = new Set(PROGRAMS_NOW.map((p) => p.value));
}

/** For forwarding addresses (services/residency.ts move-outs). */
export const US_STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "District of Columbia", "Florida",
  "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland",
  "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire",
  "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania",
  "Puerto Rico", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia",
  "Washington", "West Virginia", "Wisconsin", "Wyoming",
] as const;

/** PlanStreet's move-out reasons (services/residency.ts). */
export const MOVE_OUT_REASONS = [
  "Abandonment", "Deceased", "Detox/Rehab", "Eviction", "External Permanent Supportive Housing Transfer",
  "Internal Permanent Supportive Housing Transfer", "Hospital", "Independent Housing", "Jail/Prison",
  "Living with Family/Friends/Partner", "Nursing Home", "Shelter",
] as const;

// ── Sections ────────────────────────────────────────────────────────────

export const CLIENT_SECTIONS: readonly ClientSection[] = [
  {
    key: "identity",
    title: "Identity",
    fields: [
      { key: "dateOfBirth", label: "Date of birth", type: "date", column: "dateOfBirth" },
      { key: "ssn", label: "Social Security Number", type: "ssn", column: "ssn", hint: "Shown as its last four digits. Only Admins can see the whole number, and each look is logged." },
      { key: "middleName", label: "Middle name", type: "text" },
      { key: "nameSuffix", label: "Suffix", type: "select", options: ["Jr.", "Sr.", "II", "III", "IV"] },
      { key: "nameDataQuality", label: "Name data quality", type: "select", options: ["Full name reported", "Partial, street name, or code name reported", ...HUD_UNKNOWN], hint: "HMIS: is the name above their full legal name?" },
      { key: "ssnDataQuality", label: "SSN data quality", type: "select", options: ["Full SSN reported", "Approximate or partial SSN reported", ...HUD_UNKNOWN] },
      { key: "dobDataQuality", label: "Date of birth data quality", type: "select", options: ["Full DOB reported", "Approximate or partial DOB reported", ...HUD_UNKNOWN] },
    ],
  },
  {
    key: "contact",
    title: "Contact",
    fields: [
      { key: "phone", label: "Mobile number", type: "phone" },
      { key: "email", label: "Email", type: "email" },
      { key: "emergencyContacts", label: "Emergency contacts", type: "contacts", wide: true },
    ],
  },
  {
    key: "demographics",
    title: "Demographics",
    description: "As the person describes themselves. Every question can be left blank.",
    fields: [
      { key: "sex", label: "Sex", type: "select", options: ["Female", "Male"] },
      { key: "genderIdentity", label: "Gender identity", type: "select", options: ["Agender", "Cisgender", "Transgender", "Non-Binary", "Culturally Specific Identity", "Other"] },
      { key: "genderIdentityOther", label: "Other gender identity", type: "text", showIf: { key: "genderIdentity", in: ["Other"] } },
      { key: "pronouns", label: "Pronouns", type: "select", options: ["He/Him/His", "She/Her/Hers", "They/Them/Theirs", "Other"] },
      { key: "pronounsOther", label: "Other pronouns", type: "text", showIf: { key: "pronouns", in: ["Other"] } },
      { key: "sexualOrientation", label: "Sexual orientation", type: "select", options: ["Heterosexual", "Gay", "Bisexual", "Questioning", "Other"] },
      { key: "sexualOrientationOther", label: "Other sexual orientation", type: "text", showIf: { key: "sexualOrientation", in: ["Other"] } },
      {
        key: "raceEthnicity",
        label: "Race and ethnicity",
        type: "multi",
        wide: true,
        hint: "Choose all that apply (HUD categories).",
        options: [
          "American Indian, Alaska Native, or Indigenous",
          "Asian or Asian American",
          "Black, African American, or African",
          "Hispanic/Latina/e/o",
          "Middle Eastern or North African",
          "Native Hawaiian or Pacific Islander",
          "White",
          ...HUD_UNKNOWN,
        ],
      },
      { key: "raceEthnicityDetail", label: "Additional race and ethnicity detail", type: "text", wide: true },
      { key: "preferredLanguage", label: "Preferred language", type: "select", options: ["English", "Spanish", "French", "Russian", "Chinese", "Arabic", "Other"] },
      { key: "preferredLanguageOther", label: "Other language", type: "text", showIf: { key: "preferredLanguage", in: ["Other"] } },
    ],
  },
  {
    key: "veteran",
    title: "Veteran status",
    fields: [
      { key: "veteranStatus", label: "Served in the US Armed Forces?", type: "select", options: ["No", "Yes", ...HUD_UNKNOWN] },
      { key: "militaryEntryYear", label: "Year entered service", type: "year", showIf: { key: "veteranStatus", in: ["Yes"] } },
      { key: "militarySeparationYear", label: "Year separated", type: "year", showIf: { key: "veteranStatus", in: ["Yes"] } },
      {
        key: "theatersOfOperation",
        label: "Served in",
        type: "multi",
        wide: true,
        showIf: { key: "veteranStatus", in: ["Yes"] },
        options: [
          "World War II", "Korean War", "Vietnam War", "Persian Gulf War (Operation Desert Storm)",
          "Afghanistan (Operation Enduring Freedom)", "Iraq (Operation Iraqi Freedom)", "Iraq (Operation New Dawn)",
          "Other peace-keeping operations or military interventions",
        ],
      },
      { key: "militaryBranch", label: "Branch", type: "select", showIf: { key: "veteranStatus", in: ["Yes"] }, options: ["Army", "Air Force", "Navy", "Marines", "Coast Guard", "Space Force", ...HUD_UNKNOWN] },
      {
        key: "dischargeStatus",
        label: "Discharge status",
        type: "select",
        showIf: { key: "veteranStatus", in: ["Yes"] },
        options: ["Honorable", "General under honorable conditions", "Bad conduct", "Dishonorable", "Under other than honorable conditions (OTH)", "Uncharacterized", ...HUD_UNKNOWN],
      },
    ],
  },
  {
    key: "program",
    title: "Program & funding",
    fields: [
      { key: "program", label: "Program", type: "program", column: "program", wide: true },
      { key: "caseLead", label: "Case lead", type: "staff", column: "caseLeadId" },
      {
        key: "population",
        label: "Population",
        type: "select",
        options: ["HASA", "HASA Families", "NY/NY III Pop A", "NY/NY III Pop C", "NY/NY III Pop D", "NY/NY III Pop G", "NY/NY III Pop H", "NY/NY III Pop I", "15/15", "SMI", "HSN II", "YA", "Community", "Gen Pop", "Gen Pop Families"],
      },
      { key: "unitType", label: "Unit type", type: "select", options: ["Studio", "1-Bedroom", "2-Bedrooms", "3-Bedrooms", "SRO"] },
      { key: "supportiveServicesFunder", label: "Supportive services funder", type: "multi", options: ["HASA", "DOHMH", "OMH", "HRA", "OTDA", "HUD", "Not Applicable"] },
      { key: "projectBasedRentalAssistance", label: "Project-based rental assistance", type: "multi", options: ["HPD CoC", "HPD 15/15", "HPD Mod SRO", "HPD Sec 8", "Not Applicable"] },
      { key: "tenantBasedRentalAssistance", label: "Tenant-based rental assistance", type: "select", options: ["CityFHEPS", "HPD HCV Sec 8", "NYCHA Sec 8", "Not Applicable"] },
    ],
  },
  {
    key: "referral",
    title: "Referral & intake",
    description: "How they came to the building. The move-in date and unit are in Details above.",
    fields: [
      { key: "referralDate", label: "Referral date", type: "date" },
      { key: "referralSource", label: "Referral source", type: "select", options: ["HASA", "DSS/HRA", "Property Management", "ACS", "HPD"] },
      { key: "referralProgram", label: "Referred to program", type: "program", allSites: true, wide: true },
      { key: "repeatReferral", label: "Repeat referral?", type: "select", options: YES_NO },
      { key: "eligible", label: "Eligible?", type: "select", options: YES_NO },
      {
        key: "intakeStatus",
        label: "Intake status",
        type: "select",
        showIf: { key: "eligible", in: ["Yes"] },
        options: ["Trying to Contact", "Unit Viewing Scheduled", "Accepted and Pending Documentation", "Accepted And Pending Funder Approval", "Move In Scheduled"],
      },
      { key: "unitViewingDate", label: "Unit viewing date", type: "date", showIf: { key: "intakeStatus", in: ["Unit Viewing Scheduled"] } },
      { key: "moveInScheduledDate", label: "Move-in scheduled for", type: "date", showIf: { key: "intakeStatus", in: ["Move In Scheduled"] } },
      { key: "contactAttempt1", label: "Contact attempt 1", type: "date" },
      { key: "contactAttempt2", label: "Contact attempt 2", type: "date" },
      { key: "contactAttempt3", label: "Contact attempt 3", type: "date" },
      { key: "contactAttempt4", label: "Contact attempt 4", type: "date" },
      { key: "intakeOutcome", label: "Outcome", type: "select", options: ["Moved In", "Ineligible", "Rejected", "Declined"] },
      {
        key: "ineligibleReason",
        label: "Ineligible because",
        type: "select",
        showIf: { key: "intakeOutcome", in: ["Ineligible"] },
        options: ["Not Chronically Homeless", "No Qualifying Disability", "Over Income", "Not A Permanent Resident", "Incorrect Household Composition", "Incorrect Population"],
      },
      { key: "rejectedReason", label: "Rejected because", type: "select", showIf: { key: "intakeOutcome", in: ["Rejected"] }, options: ["No Contact", "Incomplete Viewing", "Missing Documentation", "Accepted But Vacancy Filled"] },
      { key: "declinedReason", label: "Declined because", type: "select", showIf: { key: "intakeOutcome", in: ["Declined"] }, options: ["Unit Size", "Shared Bathrooms", "Supportive Housing", "Neighborhood", "Alternative Housing"] },
    ],
  },
];

export const CLIENT_FIELDS: readonly ClientField[] = CLIENT_SECTIONS.flatMap((s) => s.fields);
const BY_KEY = new Map(CLIENT_FIELDS.map((f) => [f.key, f]));

export function clientField(key: string): ClientField | undefined {
  return BY_KEY.get(key);
}

/** What the browser needs to draw the sections. */
export function clientFieldsView() {
  return { sections: CLIENT_SECTIONS, programs: programs() };
}

// ── Values ──────────────────────────────────────────────────────────────

export type ContactRow = { name: string; relationship?: string; phone?: string; email?: string };
export type ClientValue = string | string[] | number | ContactRow[];
export type ClientValues = Record<string, ClientValue>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const contactRow = z.object({
  name: z.string({ required_error: "each contact needs a name" }).trim().min(1, "each contact needs a name").max(120),
  relationship: z.string().trim().max(80).optional(),
  phone: z.string().trim().max(40).optional(),
  email: z.union([z.literal(""), z.string().trim().email("An emergency contact's email doesn't look right").max(200)]).optional(),
});

export class ClientFieldError extends Error {}

/**
 * Check one field's new value. Returns the value to store, or null to clear
 * it. Throws ClientFieldError with a message for the person.
 */
export function parseClientValue(field: ClientField, raw: unknown): ClientValue | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const bad = (why: string) => new ClientFieldError(`${field.label}: ${why}`);
  switch (field.type) {
    case "text":
    case "textarea": {
      if (typeof raw !== "string") throw bad("expected text.");
      const v = raw.trim();
      if (v.length > (field.type === "text" ? 500 : 4000)) throw bad("too long.");
      return v || null;
    }
    case "date": {
      if (typeof raw !== "string" || !DATE_RE.test(raw) || Number.isNaN(new Date(`${raw}T00:00:00Z`).getTime())) throw bad("expected a date (YYYY-MM-DD).");
      const year = Number(raw.slice(0, 4));
      if (year < 1900 || year > new Date().getFullYear() + 5) throw bad("that date is out of range.");
      return raw;
    }
    case "select": {
      if (typeof raw !== "string" || !field.options?.includes(raw)) throw bad(`"${String(raw)}" isn't one of the choices.`);
      return raw;
    }
    case "multi": {
      if (!Array.isArray(raw)) throw bad("expected a list.");
      const picked = [...new Set(raw.map(String))];
      const wrong = picked.find((v) => !field.options?.includes(v));
      if (wrong) throw bad(`"${wrong}" isn't one of the choices.`);
      return picked.length ? picked : null;
    }
    case "year": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isInteger(n) || n < 1900 || n > new Date().getFullYear()) throw bad("expected a year.");
      return n;
    }
    case "phone": {
      const v = String(raw).trim();
      if (v.length > 40 || !/^[\d\s()+.\-x]+$/i.test(v) || (v.match(/\d/g)?.length ?? 0) < 7) throw bad("that doesn't look like a phone number.");
      return v;
    }
    case "email": {
      const r = z.string().trim().email().max(200).safeParse(raw);
      if (!r.success) throw bad("that doesn't look like an email address.");
      return r.data;
    }
    case "ssn": {
      const digits = String(raw).replace(/\D/g, "");
      if (digits.length !== 9) throw bad("needs nine digits.");
      if (/^(000|666|9)/.test(digits) || digits.slice(3, 5) === "00" || digits.slice(5) === "0000") throw bad("that isn't a valid number.");
      return digits;
    }
    case "staff": {
      if (typeof raw !== "string" || raw.length > 64) throw bad("pick someone from the list.");
      return raw;
    }
    case "program": {
      if (typeof raw !== "string" || !PROGRAM_VALUES.has(raw)) throw bad(`"${String(raw)}" isn't a program.`);
      return raw;
    }
    case "contacts": {
      const r = z.array(contactRow).max(10, "at most ten contacts").safeParse(raw);
      if (!r.success) throw bad(r.error.issues[0]?.message ?? "check the contacts.");
      const rows = r.data.map((c) => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== "" && v !== undefined)) as ContactRow);
      return rows.length ? rows : null;
    }
  }
}

/**
 * Whether a field applies, given the other values: a showIf whose controlling
 * field doesn't hold one of its values hides it, and a hidden field isn't kept.
 */
export function fieldApplies(field: ClientField, values: ClientValues): boolean {
  if (!field.showIf) return true;
  const v = values[field.showIf.key];
  return typeof v === "string" && field.showIf.in.includes(v);
}

/** "•••-••-1234" */
export function maskSsn(ssn: string | null | undefined): string | null {
  return ssn ? `•••-••-${ssn.slice(-4)}` : null;
}

/** "123-45-6789" */
export function formatSsn(ssn: string): string {
  return `${ssn.slice(0, 3)}-${ssn.slice(3, 5)}-${ssn.slice(5)}`;
}
