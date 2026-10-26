import type { Site, Tenant } from "@prisma/client";
import { prisma } from "../prisma.js";
import { attentionHours } from "./settings.js";

/**
 * Roster rules that more than one route needs: how a person is named, how the
 * attention clock is kept, and what a tenant looks like on the wire.
 */

export function displayName(t: Pick<Tenant, "firstName" | "lastName" | "preferredName">): string {
  const first = t.preferredName?.trim() || t.firstName;
  return [first, t.lastName].filter(Boolean).join(" ").trim();
}

/** The attention clock is the latest of the three "they're still here" signals. */
export function clockFrom(t: {
  createdAt: Date;
  lastActivityAt?: Date | null;
  lastKeptAt?: Date | null;
}): Date {
  const times = [t.createdAt, t.lastActivityAt, t.lastKeptAt].filter(Boolean) as Date[];
  return new Date(Math.max(...times.map((d) => d.getTime())));
}

/** Threshold in hours for a site: its own override, else the org default. */
export async function thresholdFor(site: Pick<Site, "attentionHours"> | null, orgDefault?: number) {
  return site?.attentionHours ?? orgDefault ?? (await attentionHours());
}

/** Cut-off instant: anyone whose clock is before this needs attention. */
export function cutoff(hours: number, now = new Date()) {
  return new Date(now.getTime() - hours * 3600_000);
}

export function serializeTenant(
  t: Tenant & { site?: Pick<Site, "id" | "code" | "name" | "attentionHours"> | null },
  hours: number
) {
  const clock = t.attentionClockAt;
  const hoursQuiet = Math.max(0, (Date.now() - clock.getTime()) / 3600_000);
  return {
    id: t.id,
    siteId: t.siteId,
    site: t.site ? { id: t.site.id, code: t.site.code, name: t.site.name } : undefined,
    unit: t.unit,
    firstName: t.firstName,
    lastName: t.lastName,
    preferredName: t.preferredName,
    displayName: displayName(t),
    status: t.status,
    moveInDate: t.moveInDate,
    moveOutDate: t.moveOutDate,
    notes: t.notes,
    externalId: t.externalId,
    highAcuity: Boolean(t.highAcuity),
    lastActivityAt: t.lastActivityAt,
    lastActivitySource: t.lastActivitySource,
    lastKeptAt: t.lastKeptAt,
    attentionClockAt: clock,
    hoursQuiet: Math.round(hoursQuiet),
    needsAttention: t.status === "active" && hoursQuiet >= (t.site?.attentionHours ?? hours),
    archivedAt: t.archivedAt,
    archiveReason: t.archiveReason,
    version: t.version,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

export type TenantDTO = ReturnType<typeof serializeTenant>;

/** The shape integrations see — no notes, nothing staff-internal. */
export function publicTenant(t: Tenant & { site?: Pick<Site, "code"> | null }) {
  return {
    id: t.id,
    site: t.site?.code,
    unit: t.unit,
    firstName: t.firstName,
    lastName: t.lastName,
    preferredName: t.preferredName,
    displayName: displayName(t),
    status: t.status,
    moveInDate: t.moveInDate,
    lastActivityAt: t.lastActivityAt,
    updatedAt: t.updatedAt,
  };
}

/**
 * Record that a tenant was referenced somewhere. Idempotent on
 * (source, externalRef, tenant) so a retried form webhook counts once.
 * Returns false when it was a duplicate.
 */
export async function recordActivity(opts: {
  tenantId: string;
  source: string;
  label?: string | null;
  externalRef?: string | null;
  occurredAt?: Date;
  recordedBy?: string | null;
}): Promise<boolean> {
  const occurredAt = opts.occurredAt ?? new Date();
  if (opts.externalRef) {
    const dup = await prisma.tenantActivity.findFirst({
      where: { source: opts.source, externalRef: opts.externalRef, tenantId: opts.tenantId },
      select: { id: true },
    });
    if (dup) return false;
  }
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: opts.tenantId } });
  const newest = !tenant.lastActivityAt || occurredAt > tenant.lastActivityAt;
  await prisma.$transaction([
    prisma.tenantActivity.create({
      data: {
        tenantId: opts.tenantId,
        source: opts.source,
        label: opts.label ?? null,
        externalRef: opts.externalRef ?? null,
        occurredAt,
        recordedBy: opts.recordedBy ?? null,
      },
    }),
    // Activity doesn't bump `version`: it isn't an edit, and bumping would make
    // a staff member's open edit form conflict every time a form came in.
    ...(newest
      ? [
          prisma.tenant.update({
            where: { id: opts.tenantId },
            data: {
              lastActivityAt: occurredAt,
              lastActivitySource: opts.label ?? opts.source,
              attentionClockAt: clockFrom({ ...tenant, lastActivityAt: occurredAt }),
            },
          }),
        ]
      : []),
  ]);
  return true;
}
