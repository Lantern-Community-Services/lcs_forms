import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { env } from "./env.js";
import { prisma } from "./prisma.js";
import { clientIp, compressJson, errorHandler, requestId } from "./http.js";
import { loadUser, requireAuth } from "./auth/middleware.js";
import { authRouter } from "./routes/auth.js";
import { tenantsRouter } from "./routes/tenants.js";
import { attendanceRouter } from "./routes/attendance.js";
import { sitesRouter } from "./routes/sites.js";
import { activityRouter } from "./routes/activity.js";
import { usersRouter } from "./routes/users.js";
import { adminRouter } from "./routes/admin.js";
import { publicApiRouter } from "./routes/publicApi.js";
import { formsRouter } from "./routes/forms.js";
import { builderRouter } from "./routes/builder.js";
import { fillRouter } from "./routes/fill.js";
import { handleMcp } from "./forms/mcp.js";
import { appsRouter } from "./routes/apps.js";
import { homeRouter } from "./routes/home.js";
import { calendarRouter } from "./routes/calendar.js";

/** Runaway-loop backstop for the sign-in round trip — generous on purpose. */
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: "draft-7", legacyHeaders: false });

/** Public API: bounds a misbehaving integration, not normal WordPress traffic. */
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: "draft-7", legacyHeaders: false });

/** Built-form submissions and uploads: generous for a busy site, a wall for a script hammering a public form. */
const submitLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false });

/** File uploads carry their own raw body (routes/fill.ts); the JSON parser must leave them alone. */
const isUpload = (path: string) => /^\/api\/f\/[^/]+\/files$/.test(path);

/** A database check that's slow counts as down: the health probe mustn't hang. */
async function databaseUp(timeoutMs = 3000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      prisma.$queryRaw`SELECT 1`.then(() => true),
      new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs))),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function createApp() {
  const app = express();
  // Behind App Service the client's address is in X-Forwarded-For, so the rate
  // limiters (and an entry's recorded IP) need to know how many proxies to look
  // past: TRUST_PROXY, 1 by default (see env.ts).
  app.set("trust proxy", env.trustProxy);
  app.use(requestId);
  app.use(clientIp);
  // Health. App Service restarts a container whose health check fails, so the
  // probes answer 200 while the process is up, whatever the database is doing:
  // a moment without Azure SQL shouldn't become a restart loop.
  //   /api/health/live   the process answers (no database call)
  //   /api/health        200, with whether the database answered
  //   /api/health/ready  503 while the database doesn't answer (for a deploy check, not a restart probe)
  app.get("/api/health/live", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/api/health", async (_req, res) => {
    res.json({ ok: true, database: (await databaseUp()) ? "up" : "unreachable" });
  });
  app.get("/api/health/ready", async (_req, res) => {
    const up = await databaseUp();
    res.status(up ? 200 : 503).json({ ok: up, database: up ? "up" : "unreachable" });
  });

  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(compressJson);
  app.use(cookieParser());
  app.use(loadUser);
  // A session may contain many PNG signatures. Accept the larger body only
  // for an authenticated attendance write; all other JSON keeps the 1 MB cap.
  app.post("/api/attendance", requireAuth, express.json({ limit: "20mb" }));
  // A built form's entry can hold signatures and custom-code data; the MCP
  // server receives whole form documents.
  app.post("/api/f/:slug/submit", submitLimiter, express.json({ limit: "5mb" }));
  app.post("/api/f/:slug/files", submitLimiter);
  app.use(["/api/builder", "/mcp", "/api/mcp", "/api/apps"], express.json({ limit: "5mb" }));
  const json = express.json({ limit: "1mb" });
  app.use((req, res, next) => (isUpload(req.path) ? next() : json(req, res, next)));

  app.use("/api/auth/microsoft", authLimiter);
  app.use("/api/auth", authRouter);
  app.use("/api/forms", formsRouter);
  app.use("/api/home", homeRouter);
  app.use("/api/calendar", calendarRouter);
  app.use("/api/tenants", tenantsRouter);
  app.use("/api/attendance", attendanceRouter);
  app.use("/api/sites", sitesRouter);
  app.use("/api/activity", activityRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/v1", apiLimiter, publicApiRouter);
  app.use("/api/builder", builderRouter);
  app.use("/api/f", fillRouter);
  app.use("/api/apps", appsRouter);
  // MCP server for building forms with an LLM (API key, scope forms:build).
  app.all(["/mcp", "/api/mcp"], apiLimiter, (req, res, next) => {
    handleMcp(req, res).catch(next);
  });

  app.use(errorHandler);
  return app;
}
