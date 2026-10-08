import type { Request } from "express";
import { Prisma, type Tenant } from "@prisma/client";
import { prisma } from "../prisma.js";
import { attentionHours } from "./settings.js";
import { cutoff, serializeTenant, type TenantDTO } from "./roster.js";
import { sitesInScope, type ScopedSite } from "./siteScope.js";

export type RosterStatus = "active" | "attention" | "archived";

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
export const ROSTER_CAP = 5000;

/**
 * The columns a roster list needs — everything but staff notes, which only the
 * resident's own page shows (and which no export includes).
 *
 * Read with a raw query rather than `prisma.tenant.findMany`: Prisma's per-row
 * conversion of DateTime columns cost ~25ms per column across ~1,900 rows, so
 * the whole-organisation roster took ~410ms through the client and ~120ms as
 * plain SQL (SQL Server / Azure SQL).
 */
const LIST_COLUMNS = Prisma.raw(
  [
    "id", "siteId", "unit", "firstName", "lastName", "preferredName", "status",
    "moveInDate", "moveOutDate", "externalId", "lastActivityAt", "lastActivitySource",
    "lastKeptAt", "attentionClockAt", "archivedAt", "archiveReason", "version",
    "createdAt", "updatedAt",
  ].join(", ")
);

/** SQL Server's row limit: OFFSET … FETCH, after the ORDER BY. */
const limitClause = (n: number) => Prisma.sql`OFFSET 0 ROWS FETCH NEXT ${n} ROWS ONLY`;

/** `contains`, as a LIKE pattern with the user's own % and _ taken literally. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * The roster as a screen (or an export) sees it: the caller's selected sites,
 * one status tab, an optional search. Shared by the list endpoint and every
 * export format so a download always matches what was on screen.
 */
export async function loadRoster(
  req: Request,
  opts: { site?: unknown; status?: unknown; q?: unknown }
): Promise<{ sites: ScopedSite[]; status: RosterStatus; q: string; items: TenantDTO[]; hours: number; truncated: boolean }> {
  const sites = await sitesInScope(req, opts.site);
  const status: RosterStatus = opts.status === "archived" || opts.status === "attention" ? opts.status : "active";
  const q = typeof opts.q === "string" ? opts.q.trim() : "";
  const hours = await attentionHours();
  if (sites.length === 0) return { sites, status, q, items: [], hours, truncated: false };

  const conditions: Prisma.Sql[] = [
    Prisma.sql`siteId IN (${Prisma.join(sites.map((s) => s.id))})`,
    Prisma.sql`status = ${status === "archived" ? "archived" : "active"}`,
  ];
  if (status === "attention") {
    // Per-site thresholds, so one clause per site.
    conditions.push(
      Prisma.sql`(${Prisma.join(
        sites.map((s) => Prisma.sql`(siteId = ${s.id} AND attentionClockAt < ${cutoff(s.attentionHours ?? hours)})`),
        " OR "
      )})`
    );
  }
  if (q) {
    const like = likePattern(q);
    const byName = [
      Prisma.sql`firstName LIKE ${like} ESCAPE '\\'`,
      Prisma.sql`lastName LIKE ${like} ESCAPE '\\'`,
      Prisma.sql`preferredName LIKE ${like} ESCAPE '\\'`,
      Prisma.sql`unit LIKE ${like} ESCAPE '\\'`,
    ];
    // With several sites in view, typing a site's name finds its residents.
    const siteMatches = sites.length > 1 ? sites.filter((s) => s.name.toLowerCase().includes(q.toLowerCase())) : [];
    if (siteMatches.length) byName.push(Prisma.sql`siteId IN (${Prisma.join(siteMatches.map((s) => s.id))})`);
    conditions.push(Prisma.sql`(${Prisma.join(byName, " OR ")})`);
  }

  const order = status === "archived" ? Prisma.sql`ORDER BY archivedAt DESC` : Prisma.sql`ORDER BY id`;
  const rows = await prisma.$queryRaw<Tenant[]>`
    SELECT ${LIST_COLUMNS} FROM Tenant
    WHERE ${Prisma.join(conditions, " AND ")}
    ${order} ${limitClause(ROSTER_CAP)}`;

  // Site names come from the list already loaded for scoping — no join needed.
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const items = rows.map((t) => serializeTenant({ ...t, version: Number(t.version), site: siteById.get(t.siteId) }, hours));
  if (status !== "archived") {
    items.sort(
      (a, b) =>
        collator.compare(a.site?.name ?? "", b.site?.name ?? "") ||
        collator.compare(a.unit ?? "~", b.unit ?? "~") ||
        collator.compare(a.displayName, b.displayName)
    );
  }
  return { sites, status, q, items, hours, truncated: rows.length === ROSTER_CAP };
}
