import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { env } from "./env.js";
import { prisma } from "./prisma.js";
import { compressJson, errorHandler, requestId } from "./http.js";
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
import { hotFoodsRouter } from "./routes/hotFoods.js";
import { builderRouter } from "./routes/builder.js";
import { fillRouter } from "./routes/fill.js";
import { handleMcp } from "./forms/mcp.js";
import { appsRouter } from "./routes/apps.js";
import { homeRouter } from "./routes/home.js";

/** Runaway-loop backstop for the sign-in round trip — generous on purpose. */
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: "draft-7", legacyHeaders: false });

/** Public API: bounds a misbehaving integration, not normal WordPress traffic. */
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: "draft-7", legacyHeaders: false });

/** Built-form submissions and uploads: generous for a busy site, a wall for a script hammering a public form. */
const submitLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false });

/** File uploads carry their own raw body (routes/fill.ts); the JSON parser must leave them alone. */
const isUpload = (path: string) => /^\/api\/f\/[^/]+\/files$/.test(path);

export function createApp() {
  const app = express();
  // Behind App Service / a reverse proxy, uncomment so limiters key on the real IP.
  // app.set("trust proxy", 1);
  app.use(requestId);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(compressJson);
  app.use(cookieParser());
  app.use(loadUser);
  // A session may contain many PNG signatures. Accept the larger body only
  // for an authenticated attendance write; all other JSON keeps the 1 MB cap.
  app.post("/api/attendance", requireAuth, express.json({ limit: "20mb" }));
  // One Hot Foods entry carries one signature PNG (capped at 400 KB in the route).
  app.post("/api/hot-foods", requireAuth, express.json({ limit: "2mb" }));
  // A built form's entry can hold signatures and custom-code data; the MCP
  // server receives whole form documents.
  app.post("/api/f/:slug/submit", submitLimiter, express.json({ limit: "5mb" }));
  app.post("/api/f/:slug/files", submitLimiter);
  app.use(["/api/builder", "/mcp", "/api/mcp", "/api/apps"], express.json({ limit: "5mb" }));
  const json = express.json({ limit: "1mb" });
  app.use((req, res, next) => (isUpload(req.path) ? next() : json(req, res, next)));

  app.get("/api/health", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ ok: true, database: "up" });
    } catch (err) {
      res.status(503).json({ ok: false, database: "unreachable", error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.use("/api/auth/microsoft", authLimiter);
  app.use("/api/auth", authRouter);
  app.use("/api/forms", formsRouter);
  app.use("/api/home", homeRouter);
  app.use("/api/hot-foods", hotFoodsRouter);
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
