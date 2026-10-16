import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler, HttpError } from "../http.js";
import { requireApiScope, type CurrentUser } from "../auth/middleware.js";
import { audit, type Actor } from "../services/audit.js";
import type { ApiScope, ResolvedKey } from "../services/apiKeys.js";
import { callRoute, callRouteOk, type RouteCall, type RouteResult } from "./callRoute.js";
import { principalFor } from "./principal.js";

/**
 * Operations: one definition, two doors.
 *
 * Each operation is registered as an MCP tool (forms/mcp.ts) and as a REST
 * route under /api/v1 (routes/publicApi.ts), with the same name, input schema,
 * scope and checks, so an integration and an AI client can always do the same
 * things.
 *
 *   as: "key"      the key acts as itself (the original scopes: forms:build,
 *                  entries:read …), exactly like the MCP tools before this.
 *   as: "creator"  the key acts on behalf of the admin who made it, bounded by
 *                  what they can do now (ops/principal.ts). These operations
 *                  mostly run the site's own route handler (ctx.route), so the
 *                  screen's checks, audit events and webhooks apply as they are.
 *
 * Operations that remove or overwrite data, or change who can do what, are
 * `confirm`: they refuse to run without confirm: true. Ones whose route doesn't
 * write its own audit event say what to record in `audit`.
 */
export type OpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type OpAnnotations = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };

export interface OpContext {
  key: ResolvedKey;
  /** The person the key acts as (as: "creator"); undefined for as: "key". */
  user?: CurrentUser;
  actor: Actor;
  via: "MCP" | "API";
  /** Run a site route as the key's person; a 4xx/5xx answer is thrown. */
  route(router: Router, call: RouteCall): Promise<any>;
  /** Same, but hands back the status too (for routes whose 409/422 is an answer, not a failure). */
  routeRaw(router: Router, call: RouteCall): Promise<RouteResult>;
}

export interface AuditNote {
  action: string;
  summary: string;
  siteId?: string | null;
  tenantId?: string | null;
  changes?: unknown;
}

export interface Op<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  scope: ApiScope;
  as: "key" | "creator";
  /** Path under /api/v1. Its :params are filled from the input of the same name. */
  http: { method: OpMethod; path: string };
  shape: S;
  /** Needs confirm: true (always, or when this says so for the given input). */
  confirm?: boolean | ((args: z.infer<z.ZodObject<S>>) => boolean);
  /** An audit event to record after it succeeds, for routes that don't write one. */
  audit?: (args: z.infer<z.ZodObject<S>>, result: any) => AuditNote | null;
  annotations?: OpAnnotations;
  run(ctx: OpContext, args: z.infer<z.ZodObject<S>>): Promise<unknown>;
}

export function defineOp<S extends z.ZodRawShape>(op: Op<S>): Op<S> {
  return op;
}

// ── Input helpers that read the same from JSON (MCP) and a query string (GET) ──

/** A whole number; "25" from a query string is 25. */
export const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

/** A boolean; "true"/"1" and "false"/"0" from a query string count. */
export const flag = () =>
  z.preprocess((v) => (v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : v), z.boolean());

const CONFIRM = flag().optional().describe("Must be true. Check with the person you're working for first: this removes, overwrites or changes access.");

/** The input schema as published: confirm-gated operations take `confirm`. */
export function shapeOf(op: Op<any>): z.ZodRawShape {
  return op.confirm ? { ...op.shape, confirm: CONFIRM } : op.shape;
}

export function describeOp(op: Op<any>): string {
  const who = op.as === "creator" ? ", acting as the admin who made the key (never more than they can do in the site)" : "";
  const confirm = op.confirm ? (typeof op.confirm === "function" ? " Some changes need confirm: true." : " Needs confirm: true.") : "";
  return `${op.description}${confirm}\n[scope ${op.scope}${who} · REST ${op.http.method} /api/v1${op.http.path}]`;
}

/** Run an operation for a key: scope, who it acts as, confirm, audit. Input is already parsed. */
export async function runOp(op: Op<any>, key: ResolvedKey, args: Record<string, unknown>, via: "MCP" | "API"): Promise<unknown> {
  if (!key.scopes.includes(op.scope)) {
    throw new HttpError(403, `This API key lacks the ${op.scope} scope. An admin can add it in Admin → API keys.`);
  }
  const user = op.as === "creator" ? await principalFor(key, op.scope) : undefined;
  const needsConfirm = typeof op.confirm === "function" ? op.confirm(args) : Boolean(op.confirm);
  if (needsConfirm && args.confirm !== true) {
    throw new HttpError(400, `${op.name} removes, overwrites or changes access to something. Check with the person you're working for, then call it again with confirm: true.`);
  }
  const actor: Actor = user ? { id: user.userId, name: user.name } : { id: null, name: `API key: ${key.name} (${via})` };
  const as = () => {
    if (!user) throw new HttpError(500, `${op.name} has no person to act as.`);
    return { user, apiKey: key };
  };
  const ctx: OpContext = {
    key,
    user,
    actor,
    via,
    route: (router, call) => callRouteOk(router, call, as()),
    routeRaw: (router, call) => callRoute(router, call, as()),
  };
  // confirm is for this gate only; the route never sees it.
  const { confirm: _confirm, ...input } = args;
  const result = await op.run(ctx, input);
  const note = op.audit?.(input, result);
  if (note) await audit({ actor, ...note });
  return result;
}

/** Mount every operation on the public API router. */
export function mountOps(router: Router, ops: Op<any>[]) {
  for (const op of ops) {
    const schema = z.object(shapeOf(op));
    const handler = asyncHandler(async (req: Request, res) => {
      const bodyIn = op.http.method === "GET" ? {} : req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const args = schema.parse({ ...req.query, ...bodyIn, ...req.params });
      res.json(await runOp(op, req.apiKey!, args, "API"));
    });
    const method = op.http.method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
    router[method](op.http.path, requireApiScope(op.scope), handler);
  }
}
