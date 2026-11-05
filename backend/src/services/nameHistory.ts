import type { Tenant } from "@prisma/client";
import { prisma } from "../prisma.js";

/**
 * A resident's past names, from the roster's audit log. Every edit's audit
 * event keeps { field: [before, after] } (routes/tenants.ts PATCH), so walking
 * the name changes back from the current name gives each name they had, when
 * it changed and who changed it. Nothing is lost when the 40-event History
 * card scrolls past an old rename.
 *
 * Tenant.formerNames keeps the same names (a JSON array) so the roster's
 * search, on the server and in an iPad's offline copy, finds someone by an old name.
 */

type Name = Pick<Tenant, "firstName" | "lastName" | "preferredName">;
const NAME_FIELDS = ["firstName", "lastName", "preferredName"] as const;

/** Audit events whose changes touch a name field (their JSON keys all end in Name"). */
const NAME_CHANGE_WHERE = { action: "tenant.updated", changes: { contains: 'Name"' } } as const;

/** "Inez Ortiz (“Nez”)": the full name, with the preferred name if there is one. */
export function fullName(n: Name): string {
  const base = [n.firstName, n.lastName].filter(Boolean).join(" ").trim();
  return n.preferredName?.trim() ? `${base} (“${n.preferredName.trim()}”)` : base;
}

export interface NameChange {
  at: Date;
  by: string;
  from: string;
  to: string;
}

/** Each name change, newest first: the name before and after, worked back from the name they have now. */
async function walk(t: Name & { id: string }) {
  const events = await prisma.auditEvent.findMany({
    where: { tenantId: t.id, ...NAME_CHANGE_WHERE },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, actorName: true, changes: true },
  });
  let after: Name = { firstName: t.firstName, lastName: t.lastName, preferredName: t.preferredName };
  const out: { at: Date; by: string; before: Name; after: Name }[] = [];
  for (const e of events) {
    let all: Record<string, unknown> = {};
    try {
      all = e.changes ? (JSON.parse(e.changes) as Record<string, unknown>) : {};
    } catch {
      continue;
    }
    const touched = NAME_FIELDS.filter((f) => Array.isArray(all[f]));
    if (!touched.length) continue;
    const before: Name = { ...after };
    for (const f of touched) {
      const was = (all[f] as [unknown, unknown])[0];
      if (f === "preferredName") before.preferredName = (was as string | null) ?? null;
      else before[f] = String(was ?? "");
    }
    out.push({ at: e.createdAt, by: e.actorName, before, after });
    after = before;
  }
  return out;
}

/** Their name changes for the resident's page, newest first. */
export async function nameHistory(t: Name & { id: string }): Promise<NameChange[]> {
  return (await walk(t)).map((c) => ({ at: c.at, by: c.by, from: fullName(c.before), to: fullName(c.after) }));
}

/** The names to find someone by: each earlier full name and preferred name, never their current ones. */
export function formerNamesAfter(existing: string[], before: Name, current: Name): string[] {
  const own = (n: Name) => [[n.firstName, n.lastName].filter(Boolean).join(" ").trim(), n.preferredName?.trim() ?? ""].filter(Boolean);
  const now = new Set(own(current).map((s) => s.toLowerCase()));
  const seen = new Set<string>();
  return [...existing, ...own(before)].filter((n) => {
    const k = n.toLowerCase();
    if (now.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function parseFormerNames(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Fill Tenant.formerNames for residents renamed before the column existed,
 * from their audit history. Runs once per boot, only for residents with a
 * rename and no formerNames yet, so it's a no-op after the first run.
 */
export async function backfillFormerNames(): Promise<number> {
  const rows = await prisma.auditEvent.findMany({
    where: { ...NAME_CHANGE_WHERE, tenantId: { not: null }, tenant: { formerNames: null } },
    select: { tenantId: true },
    distinct: ["tenantId"],
  });
  let n = 0;
  for (const { tenantId } of rows) {
    const t = tenantId ? await prisma.tenant.findUnique({ where: { id: tenantId } }) : null;
    if (!t) continue;
    let names: string[] = [];
    for (const c of await walk(t)) names = formerNamesAfter(names, c.before, t);
    await prisma.tenant.update({ where: { id: t.id }, data: { formerNames: JSON.stringify(names) } });
    n++;
  }
  return n;
}
