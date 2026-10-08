import { PrismaClient } from "@prisma/client";

/**
 * Shared Prisma client singleton. Queries are emitted as events (not printed)
 * so the dev log can time them (services/devlog.ts).
 */
export const prisma = new PrismaClient({
  log:
    process.env.NODE_ENV === "production"
      ? [{ emit: "event", level: "query" }, { emit: "stdout", level: "error" }]
      : [{ emit: "event", level: "query" }, { emit: "stdout", level: "error" }, { emit: "stdout", level: "warn" }],
});
