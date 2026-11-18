import { Prisma, type Site, type Tenant, type TenantProfile } from "@prisma/client";
import { prisma } from "../prisma.js";
import { badRequest, HttpError } from "../http.js";
import {
  CLIENT_FIELDS,
  clientField,
  ClientFieldError,
  fieldApplies,
  maskSsn,
  parseClientValue,
  type ClientColumn,
  type ClientValue,
  type ClientValues,
} from "./clientFields.js";
import { displayName } from "./roster.js";

/**
 * Reading and saving a resident's client information (TenantProfile). The
 * routes (routes/tenants.ts) check the setting, the permission and the site;
 * this file knows the fields: what a value may be, which fields still apply,
 * who can be a case lead or a head of household, and what changed.
 */

type TenantWithSite = Tenant & { site: Pick<Site, "id" | "code" | "name"> };

/** Audit actions for client information. A resident's History shows them only to people with clients.view. */
export const PROFILE_AUDIT_ACTIONS = ["tenant.profile_updated", "tenant.ssn_viewed"] as const;

const COLUMN_OF: Record<string, ClientColumn> = Object.fromEntries(
  CLIENT_FIELDS.filter((f) => f.column).map((f) => [f.key, f.column!])
);

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Every value as one object, the way the fields name them. The SSN is never in it. */
export function valuesOf(p: TenantProfile | null): ClientValues {
  if (!p) return {};
  let data: ClientValues = {};
  try {
    const parsed = JSON.parse(p.data);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
  } catch {
    // A row that won't parse reads as empty rather than breaking the page.
  }
  const v: ClientValues = { ...data };
  if (p.dateOfBirth) v.dateOfBirth = ymd(p.dateOfBirth);
  if (p.program) v.program = p.program;
  if (p.caseLeadId) v.caseLead = p.caseLeadId;
  if (p.headOfHouseholdId) v.headOfHousehold = p.headOfHouseholdId;
  return v;
}

export function ageOn(dob: string | undefined | null, now = new Date()): number | null {
  if (!dob) return null;
  const [y, m, d] = dob.split("-").map(Number);
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age--;
  return age >= 0 && age < 130 ? age : null;
}

const PERSON_SELECT = { id: true, firstName: true, lastName: true, preferredName: true, unit: true, status: true, siteId: true } as const;
type PersonRow = Prisma.TenantGetPayload<{ select: typeof PERSON_SELECT }>;
const personView = (t: PersonRow) => ({ id: t.id, displayName: displayName(t), unit: t.unit, status: t.status });

/** What the resident page and the MCP tools get. */
export async function profileView(tenant: TenantWithSite, p: TenantProfile | null) {
  const values = valuesOf(p);
  const [lead, head, members, editor] = await Promise.all([
    p?.caseLeadId ? prisma.user.findUnique({ where: { id: p.caseLeadId }, select: { id: true, name: true, title: true, status: true } }) : null,
    p?.headOfHouseholdId ? prisma.tenant.findUnique({ where: { id: p.headOfHouseholdId }, select: PERSON_SELECT }) : null,
    prisma.tenantProfile.findMany({
      where: { headOfHouseholdId: tenant.id },
      include: { tenant: { select: PERSON_SELECT } },
      take: 50,
    }),
    p?.updatedById ? prisma.user.findUnique({ where: { id: p.updatedById }, select: { name: true } }) : null,
  ]);
  return {
    tenantId: tenant.id,
    /** 0 = nothing saved yet; a save presents it like a Tenant's version. */
    version: p?.version ?? 0,
    values,
    ssn: p?.ssn ? { last4: p.ssn.slice(-4), masked: maskSsn(p.ssn) } : null,
    age: ageOn(values.dateOfBirth as string | undefined),
    caseLead: lead ? { id: lead.id, name: lead.name, title: lead.title, active: lead.status === "active" } : p?.caseLeadId ? { id: p.caseLeadId, name: "Removed account", title: null, active: false } : null,
    headOfHousehold: head ? personView(head) : null,
    householdMembers: members
      .map((m) => ({ ...personView(m.tenant), relationship: (valuesOf(m).relationshipToHead as string | undefined) ?? null }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    updatedAt: p?.updatedAt ?? null,
    updatedBy: editor?.name ?? null,
  };
}

export type ProfileView = Awaited<ReturnType<typeof profileView>>;

/** Staff who can be a resident's case lead: active people approved for that site (not Arete). */
export async function caseLeadChoices(siteId: string) {
  return prisma.user.findMany({
    where: { status: "active", roleKey: { not: "arete_staff" }, sites: { some: { siteId, approved: true } } },
    select: { id: true, name: true, title: true },
    orderBy: { name: "asc" },
  });
}

function sameValue(a: ClientValue | undefined, b: ClientValue | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Save changes to someone's client information. `changes` holds only the
 * fields being changed (null or "" clears one). Fields that stop applying
 * (a "showIf" whose answer changed) are cleared too. Optimistic: `version`
 * must be the one read, 0 for someone with nothing saved yet; otherwise 409
 * with the current record.
 *
 * Returns the saved row and a diff for the audit log, or null when nothing
 * actually changed.
 */
export async function saveProfile(opts: {
  tenant: TenantWithSite;
  before: TenantProfile | null;
  version: number;
  changes: Record<string, unknown>;
  userId: string | null;
}): Promise<{ row: TenantProfile; changed: string[]; diff: Record<string, { from: unknown; to: unknown }> } | null> {
  const { tenant, before } = opts;
  if ((before?.version ?? 0) !== opts.version) throw conflict();

  const prev = valuesOf(before);
  const next: ClientValues = { ...prev };
  let ssn: string | null | undefined; // undefined = unchanged

  try {
    for (const [key, raw] of Object.entries(opts.changes)) {
      const field = clientField(key);
      if (!field) throw new ClientFieldError(`There is no client information field called "${key}".`);
      const value = parseClientValue(field, raw);
      if (field.type === "ssn") {
        ssn = value as string | null;
        continue;
      }
      if (value === null) delete next[key];
      else next[key] = value;
    }
  } catch (e) {
    if (e instanceof ClientFieldError) throw badRequest(e.message);
    throw e;
  }

  // Answers that no longer apply go, in field order so a chain clears through.
  for (let pass = 0; pass < 2; pass++) {
    for (const f of CLIENT_FIELDS) if (f.key in next && !fieldApplies(f, next)) delete next[f.key];
  }

  // Who they point at must make sense.
  if (next.caseLead !== undefined && next.caseLead !== prev.caseLead) {
    const lead = await prisma.user.findFirst({
      where: { id: String(next.caseLead), status: "active", sites: { some: { siteId: tenant.siteId, approved: true } } },
      select: { id: true },
    });
    if (!lead) throw badRequest(`Case lead: pick someone who works at ${tenant.site.name}.`);
  }
  if (next.headOfHousehold !== undefined && next.headOfHousehold !== prev.headOfHousehold) {
    const headId = String(next.headOfHousehold);
    if (headId === tenant.id) throw badRequest("Head of household: pick someone else, or choose \"Self (head of household)\".");
    const head = await prisma.tenant.findUnique({ where: { id: headId }, include: { profile: { select: { headOfHouseholdId: true } } } });
    if (!head || head.siteId !== tenant.siteId) throw badRequest(`Head of household: pick someone at ${tenant.site.name}.`);
    if (head.profile?.headOfHouseholdId) throw badRequest(`Head of household: ${displayName(head)} is a member of another household. Pick the head of that household.`);
  }
  // Becoming a member of a household: they can't still be someone's head.
  if (next.headOfHousehold && !prev.headOfHousehold) {
    const own = await prisma.tenantProfile.count({ where: { headOfHouseholdId: tenant.id } });
    if (own > 0) throw badRequest("They're the head of a household now. Point its members at the new head first.");
  }

  // What changed, for the audit log. The SSN is named, never written out.
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of CLIENT_FIELDS) {
    if (f.type === "ssn") continue;
    if (!sameValue(prev[f.key], next[f.key])) diff[f.key] = { from: prev[f.key] ?? null, to: next[f.key] ?? null };
  }
  if (ssn !== undefined && ssn !== (before?.ssn ?? null)) diff.ssn = { from: maskSsn(before?.ssn), to: maskSsn(ssn) };
  const changed = Object.keys(diff);
  if (changed.length === 0) return null;

  // Columns out, the rest into data.
  const data: ClientValues = {};
  for (const [k, v] of Object.entries(next)) if (!COLUMN_OF[k]) data[k] = v;
  const fields = {
    dateOfBirth: next.dateOfBirth ? new Date(`${next.dateOfBirth}T00:00:00Z`) : null,
    program: (next.program as string | undefined) ?? null,
    caseLeadId: (next.caseLead as string | undefined) ?? null,
    headOfHouseholdId: (next.headOfHousehold as string | undefined) ?? null,
    ...(ssn !== undefined ? { ssn } : {}),
    data: JSON.stringify(data),
    updatedById: opts.userId,
  };

  if (!before) {
    try {
      const row = await prisma.tenantProfile.create({ data: { tenantId: tenant.id, ...fields } });
      return { row, changed, diff };
    } catch (e) {
      // Someone else saved the first version a moment ago.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw conflict();
      throw e;
    }
  }
  const result = await prisma.tenantProfile.updateMany({
    where: { tenantId: tenant.id, version: opts.version },
    data: { ...fields, version: { increment: 1 } },
  });
  if (result.count === 0) throw conflict();
  return { row: await prisma.tenantProfile.findUniqueOrThrow({ where: { tenantId: tenant.id } }), changed, diff };
}

function conflict() {
  return new HttpError(409, "Someone else changed this client information while you were editing. Reload it and try again.");
}

/** "date of birth, program" — how an audit summary names the changed fields. */
export function fieldWords(keys: string[]): string {
  return keys.map((k) => (clientField(k)?.label ?? k).toLowerCase()).join(", ");
}
