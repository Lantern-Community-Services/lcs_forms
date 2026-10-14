import "./env.js";
import { PrismaClient } from "@prisma/client";

/**
 * The database address, with a connection pool sized for this app. Prisma's own
 * default is CPUs × 2 + 1 — 3 on a one-core App Service plan, where one slow
 * report holding a connection left the rest of the site waiting. An explicit
 * connection_limit in DATABASE_URL wins; DB_POOL changes the default.
 */
function databaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url || /[;?&]connection_limit=/i.test(url)) return url;
  const size = Math.max(1, Number(process.env.DB_POOL) || 10);
  return `${url.replace(/;+$/, "")};connection_limit=${size}`;
}

/**
 * Shared Prisma client singleton. Queries are emitted as events (not printed)
 * so the dev log can time them (services/devlog.ts).
 */
export const prisma = new PrismaClient({
  datasourceUrl: databaseUrl(),
  log:
    process.env.NODE_ENV === "production"
      ? [{ emit: "event", level: "query" }, { emit: "stdout", level: "error" }]
      : [{ emit: "event", level: "query" }, { emit: "stdout", level: "error" }, { emit: "stdout", level: "warn" }],
});
