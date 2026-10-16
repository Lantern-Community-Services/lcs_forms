import "./env.js";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
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

/**
 * Each query as a SQL dependency in Application Insights (src/telemetry.ts),
 * only when that's on. Prisma's own tracing doesn't work with the OpenTelemetry
 * SDK the Azure Monitor distro uses, so the middleware times each call itself,
 * inside the request that made it. It records the model and operation, never
 * the arguments or an error's message: those quote the values being written.
 */
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim()) {
  const url = process.env.DATABASE_URL ?? "";
  const server = /^sqlserver:\/\/([^:;]+)/i.exec(url)?.[1];
  const database = /;database=([^;]+)/i.exec(url)?.[1];
  const tracer = trace.getTracer("lcs-forms-prisma");
  prisma.$use((params, next) => {
    const operation = `${params.model ?? "$raw"}.${params.action}`;
    return tracer.startActiveSpan(
      operation,
      {
        kind: SpanKind.CLIENT,
        attributes: { "db.system": "mssql", "db.operation": operation, "db.name": database, "net.peer.name": server },
      },
      async (span) => {
        try {
          return await next(params);
        } catch (err) {
          const code = (err as { code?: unknown }).code;
          span.setStatus({ code: SpanStatusCode.ERROR, message: typeof code === "string" ? code : (err as Error).name });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  });
}
