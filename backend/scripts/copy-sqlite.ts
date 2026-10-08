import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import "../src/env.js"; // loads .env / .env.local
import { Prisma } from "@prisma/client";
import { prisma } from "../src/prisma.js";

/**
 * Copy a database from the SQLite days (backend/prisma/dev.db) into the SQL
 * Server database in DATABASE_URL, which must be migrated and empty:
 *
 *   npx prisma migrate deploy
 *   npm run db:copy-sqlite -- prisma/dev.db
 *
 * Every table is copied as it is, parents before children, except Outlook's
 * state: those ids pointed at the old app-level organizer mailbox, so every
 * event is marked to be sent afresh by the new, per-person sync and its old
 * copies and cancellations are left behind. Columns the SQLite file doesn't
 * have get their defaults; ones it has that SQL Server doesn't are dropped.
 *
 * Before writing anything, every string is checked against its column's size,
 * so a value that wouldn't fit is reported instead of failing half-way.
 * Files stay in the database; `npm run files:to-blob` moves them afterwards.
 */

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error("Usage: npm run db:copy-sqlite -- <path to the SQLite .db file>");
  process.exit(1);
}

/** Tables whose rows only meant something to the old Outlook sync. */
const SKIP = new Set(["CalendarCopy", "CalendarOutlookTrash"]);

type Model = Prisma.DMMF.Model;
type Field = Prisma.DMMF.Field;

const models = Prisma.dmmf.datamodel.models as Model[];
const tableOf = (m: Model) => m.dbName ?? m.name;
const delegate = (m: Model) => (prisma as unknown as Record<string, { createMany(a: { data: unknown[] }): Promise<unknown>; count(): Promise<number> }>)[m.name[0].toLowerCase() + m.name.slice(1)];

/** Parents first: a model comes after every model its foreign keys point at. */
function inOrder(): Model[] {
  const byName = new Map(models.map((m) => [m.name, m]));
  const out: Model[] = [];
  const seen = new Set<string>();
  const visit = (m: Model) => {
    if (seen.has(m.name)) return;
    seen.add(m.name);
    for (const f of m.fields) if (f.kind === "object" && f.relationFromFields?.length && f.type !== m.name) visit(byName.get(f.type)!);
    out.push(m);
  };
  models.forEach(visit);
  return out;
}

function convert(f: Field, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (f.type) {
    case "DateTime":
      return new Date(typeof v === "number" || typeof v === "bigint" ? Number(v) : /^\d+$/.test(String(v)) ? Number(v) : String(v));
    case "Boolean":
      return Boolean(Number(v));
    case "Int":
    case "Float":
      return Number(v);
    case "Bytes":
      return Buffer.from(v as Uint8Array);
    default:
      return v;
  }
}

/** NVarChar(n) → n; Max or anything else → no limit. */
function sizeOf(f: Field): number | null {
  const native = (f as Field & { nativeType?: [string, string[]] | null }).nativeType;
  if (!native || native[0] !== "NVarChar") return null;
  const n = Number(native[1]?.[0]);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const src = new DatabaseSync(file, { readOnly: true });
  const tables = new Set((src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));

  for (const m of models) {
    if ((await delegate(m).count()) > 0) {
      console.error(`The SQL Server database already has ${m.name} rows. Copy into an empty, migrated database.`);
      process.exit(1);
    }
  }

  // Read and convert everything first, and check it fits.
  const plan: { model: Model; rows: Record<string, unknown>[] }[] = [];
  const tooLong: string[] = [];
  for (const m of inOrder()) {
    if (SKIP.has(m.name) || !tables.has(tableOf(m))) continue;
    const have = new Set((src.prepare(`PRAGMA table_info("${tableOf(m)}")`).all() as { name: string }[]).map((c) => c.name));
    const scalars = m.fields.filter((f) => f.kind === "scalar" && have.has(f.dbName ?? f.name));
    const rows = (src.prepare(`SELECT * FROM "${tableOf(m)}"`).all() as Record<string, unknown>[]).map((raw) => {
      const row: Record<string, unknown> = {};
      for (const f of scalars) {
        const v = convert(f, raw[f.dbName ?? f.name]);
        const max = sizeOf(f);
        if (max && typeof v === "string" && v.length > max) tooLong.push(`${m.name}.${f.name} (${v.length} > ${max}) in row ${String(raw.id ?? JSON.stringify(raw).slice(0, 60))}`);
        if (v !== null || !f.isRequired) row[f.name] = v;
      }
      if (m.name === "CalendarEvent") {
        // Sent again by the per-person sync (services/outlookSync.ts).
        Object.assign(row, { outlookEventId: null, outlookOrganizerId: null, teamsJoinUrl: null, outlookHash: null, outlookError: null, outlookDirty: true });
      }
      return row;
    });
    plan.push({ model: m, rows });
  }
  if (tooLong.length) {
    console.error(`These values don't fit their SQL Server columns; nothing was copied:\n  ${tooLong.join("\n  ")}`);
    process.exit(1);
  }

  for (const { model, rows } of plan) {
    if (!rows.length) continue;
    // SQL Server takes at most 2,100 parameters in one statement.
    const per = Math.max(1, Math.floor(2000 / Math.max(1, Object.keys(rows[0]).length)));
    for (let i = 0; i < rows.length; i += per) await delegate(model).createMany({ data: rows.slice(i, i + per) });
    console.log(`  ${model.name}: ${rows.length}`);
  }
  console.log("Done. Outlook: every event will be sent again by whoever last changed it, once they've signed in with Microsoft.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
