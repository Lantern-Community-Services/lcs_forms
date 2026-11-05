import crypto from "node:crypto";
import type { Router } from "express";
import { HttpError } from "../http.js";
import type { CurrentUser } from "../auth/middleware.js";
import type { ResolvedKey } from "../services/apiKeys.js";

export interface RouteCall {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path inside the router, e.g. "/:id/archive" filled in: "/abc123/archive". */
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
}

/** Where the MCP or API request that started this call came from (audit.ts fromRequest). */
export interface CallFrom {
  ip?: string | null;
  userAgent?: string | null;
}

export interface RouteResult {
  status: number;
  body: unknown;
}

/**
 * Run one of the site's own route handlers in-process, as `user`.
 *
 * Delegated operations (ops/) go through the very handler the screen uses, so
 * an API key or the MCP server passes the same permission and site checks,
 * optimistic locks, audit events and webhooks as a person tapping the button.
 * Nothing about what a route allows is copied, so nothing can drift.
 *
 * The request is a plain object carrying just what the routers read (method,
 * url, query, body, user); the response collects the status and the JSON body.
 * A thrown error (HttpError, ZodError) is rethrown to the caller unchanged.
 * Nothing here is logged: the bodies can hold resident details.
 */
export function callRoute(router: Router, call: RouteCall, as: { user: CurrentUser; apiKey?: ResolvedKey; from?: CallFrom }): Promise<RouteResult> {
  const query = Object.fromEntries(Object.entries(call.query ?? {}).filter(([, v]) => v !== undefined && v !== "")) as Record<string, string>;
  const qs = new URLSearchParams(query).toString();
  const url = call.path + (qs ? `?${qs}` : "");
  return new Promise<RouteResult>((resolve, reject) => {
    const headers: Record<string, string> = { "content-type": "application/json", ...(as.from?.userAgent ? { "user-agent": as.from.userAgent } : {}) };
    const req = {
      method: call.method,
      url,
      originalUrl: url,
      baseUrl: "",
      path: call.path,
      query,
      params: {},
      body: call.body ?? {},
      // Tells any body parser inside a router that the body is already parsed.
      _body: true,
      headers,
      cookies: {},
      // The MCP or API caller's own address, so the audit log says where a change came from.
      ip: as.from?.ip ?? "internal",
      id: `op-${crypto.randomUUID().slice(0, 8)}`,
      user: as.user,
      apiKey: as.apiKey,
      get: (name: string) => headers[name.toLowerCase()],
      header: (name: string) => headers[name.toLowerCase()],
    };
    let done = false;
    const finish = (body: unknown) => {
      if (done) return;
      done = true;
      resolve({ status: res.statusCode, body });
    };
    const resHeaders: Record<string, unknown> = {};
    const res = {
      statusCode: 200,
      headersSent: false,
      locals: {},
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      sendStatus(code: number) {
        res.statusCode = code;
        finish(null);
        return res;
      },
      set(field: string | Record<string, unknown>, value?: unknown) {
        if (typeof field === "string") resHeaders[field.toLowerCase()] = value;
        else for (const [k, v] of Object.entries(field)) resHeaders[k.toLowerCase()] = v;
        return res;
      },
      setHeader(field: string, value: unknown) {
        resHeaders[field.toLowerCase()] = value;
        return res;
      },
      header(field: string, value: unknown) {
        return res.set(field, value);
      },
      get: (field: string) => resHeaders[field.toLowerCase()],
      getHeader: (field: string) => resHeaders[field.toLowerCase()],
      vary: () => res,
      type: () => res,
      attachment: () => res,
      json: (body: unknown) => (finish(body), res),
      send: (body: unknown) => (finish(Buffer.isBuffer(body) ? { bytes: body.length } : body), res),
      end: (body?: unknown) => (finish(body ?? null), res),
      on: () => res,
      once: () => res,
    };
    try {
      (router as unknown as (req: unknown, res: unknown, next: (err?: unknown) => void) => void)(req, res, (err?: unknown) => {
        if (done) return;
        done = true;
        reject(err ?? new HttpError(404, `No route for ${call.method} ${call.path}.`));
      });
    } catch (err) {
      reject(err);
    }
  });
}

/** callRoute(), treating a 4xx/5xx answer as an error with the route's own message. */
export async function callRouteOk(router: Router, call: RouteCall, as: { user: CurrentUser; apiKey?: ResolvedKey; from?: CallFrom }): Promise<unknown> {
  const out = await callRoute(router, call, as);
  if (out.status >= 400) {
    const b = out.body as { error?: string; details?: unknown } | null;
    throw new HttpError(out.status, b?.error ?? `The request failed (${out.status}).`, b?.details);
  }
  return out.body;
}
