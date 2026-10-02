import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync as execFileSync } from "node:child_process";

/**
 * Regenerate database/azure-sql-schema.sql — the T-SQL DDL for Azure SQL,
 * produced from the same prisma/schema.prisma the prototype runs on SQLite.
 *
 *   npm run sql:azure
 *
 * The file is a reference / DBA hand-off. When actually moving to Azure SQL,
 * switch the provider in schema.prisma and use `prisma migrate deploy`.
 */
/**
 * SQLite has no string lengths, so Prisma would emit NVARCHAR(1000) for every
 * String on SQL Server — and a composite index of those overruns SQL Server's
 * 1,700-byte key limit. Size them here instead: ids 40, free text MAX,
 * everything else 255.
 */
const LONG = new Set(["notes", "changes", "summary", "lastError", "error", "address", "url", "description", "signature", "overrideReason", "voidReason", "imageUrl", "recurrence"]);
function sized(line: string): string {
  const m = line.match(/^(\s+)(\w+)(\s+)String(\??)(.*)$/);
  if (!m || line.includes("@db.")) return line;
  const [, indent, name, gap, opt, rest] = m;
  const type = name === "id" || /Id$/.test(name) || name === "hash" ? "NVarChar(64)" : LONG.has(name) ? "NVarChar(Max)" : "NVarChar(255)";
  return `${indent}${name}${gap}String${opt} @db.${type}${rest}`;
}
const schema = fs
  .readFileSync("prisma/schema.prisma", "utf8")
  .replace('provider = "sqlite"', 'provider = "sqlserver"')
  .split(/\r?\n/)
  .map(sized)
  .join("\n");
const tmp = path.join(os.tmpdir(), `forms-sqlserver-${Date.now()}.prisma`);
fs.writeFileSync(tmp, schema);
const bin = path.resolve("node_modules/.bin", process.platform === "win32" ? "prisma.cmd" : "prisma");
const sql = execFileSync(`"${bin}" migrate diff --from-empty --to-schema-datamodel "${tmp}" --script`, {
  encoding: "utf8",
  shell: true,
});
fs.rmSync(tmp);
const out = path.resolve("../database/azure-sql-schema.sql");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `-- Lantern Forms — Azure SQL (SQL Server) schema.\n-- Generated from backend/prisma/schema.prisma by \`npm run sql:azure\`. Do not edit by hand.\n\n${sql}`);
console.log(`Wrote ${out}`);
