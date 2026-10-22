import { z } from "zod";
import { prisma } from "../prisma.js";
import { appBaseUrl } from "../env.js";
import { HttpError } from "../http.js";
import type { CurrentUser } from "../auth/middleware.js";
import type { ResolvedGrant } from "../oauth/provider.js";
import type { ResolvedKey } from "../services/apiKeys.js";
import type { ToolRegistrar } from "../forms/mcp.js";
import { formsRouter } from "../routes/forms.js";
import { fillRouter } from "../routes/fill.js";
import { appsRouter } from "../routes/apps.js";
import { sitesRouter } from "../routes/sites.js";
import { callRouteOk, type RouteCall } from "./callRoute.js";
import { OPS } from "./index.js";
import { SCOPE_GRANTS } from "./principal.js";
import { flag, int, type Op, type OpContext } from "./registry.js";

/**
 * The tools Claude gets when someone connects it to the site (oauth/): read
 * only, acting as that person and never with more than they have.
 *
 * Every tool runs a route the site's own screens use, as the person (ops/
 * callRoute.ts), so their role, sites, each form's entry roles and site
 * limits all apply exactly as on screen. Of the shared operations (ops/) it
 * offers the read-only ones that run as a person; the ones that act as an API
 * key itself (list_forms, list_entries… in ops/forms.ts) read past those
 * limits, so person versions of them are defined here instead.
 */

const enc = (v: string) => encodeURIComponent(v);
const slug = z.string().describe("The form's slug: its URL name, from list_forms.");

/** Stands in for an API key in the shared operation context; nothing here reads it. */
function connectionKey(user: CurrentUser, grant: ResolvedGrant): ResolvedKey {
  return { id: grant.id, name: grant.clientName, scopes: [], siteId: null, createdById: user.userId };
}

/** A shared operation this person can use: read only, run as a person, and their role has what it needs. */
function personCanUse(op: Op<any>, user: CurrentUser): boolean {
  if (op.as !== "creator" || !op.annotations?.readOnlyHint) return false;
  const grant = SCOPE_GRANTS[op.scope];
  if (!grant) return false;
  return grant.all.length === 0 || grant.all.some((p) => user.permissions.includes(p));
}

/** Run a shared operation as the person themself (no key scope or creator to look up). */
async function runAsPerson(op: Op<any>, user: CurrentUser, grant: ResolvedGrant, args: Record<string, unknown>) {
  const as = { user, apiKey: connectionKey(user, grant) };
  const ctx: OpContext = {
    key: as.apiKey,
    user,
    actor: { id: user.userId, name: user.name },
    via: "MCP",
    route: (router, call) => callRouteOk(router, call, as),
    routeRaw: () => Promise.reject(new HttpError(500, `${op.name} isn't available to Claude connections.`)),
  };
  return op.run(ctx, args);
}

/** A form's fields, short: enough to read its entries. */
function fieldList(doc: unknown) {
  const fields = (doc as { fields?: { id: string; type: string; label?: string; choices?: { label: string; value: string }[] }[] } | null)?.fields ?? [];
  return fields
    .filter((f) => !["page", "section", "html"].includes(f.type))
    .map((f) => ({ id: f.id, type: f.type, label: f.label, ...(f.choices ? { choices: f.choices.map((c) => `${c.value}=${c.label}`) } : {}) }));
}

type CatalogForm = { title: string; description: string | null; url: string; badge: string | null };

/** Where a catalog card leads: a basic form or a code form on this site (with data to read), or another page. */
function kindOf(url: string): { kind: "basic" | "code" | "link"; slug?: string } {
  const m = /^\/(f|p|apps)\/([^/?#]+)/.exec(url);
  if (!m) return { kind: "link" };
  return { kind: m[1] === "apps" ? "code" : "basic", slug: decodeURIComponent(m[2]) };
}

/** Defined below for people; a shared operation of the same name (list_sites needs sites.manage) gives way. */
const OWN_TOOLS = ["whoami", "list_sites", "list_forms", "get_form", "list_entries", "get_entry", "list_code_entries", "get_code_entry"];

export const PERSON_INSTRUCTIONS = (user: CurrentUser) =>
  `You are connected to Lantern Forms (${appBaseUrl}), Lantern Community Services' forms and roster site, as ${user.name} (${user.roleName}). ` +
  "You can read, not change: what you see is exactly what they can see on the site — their forms, the entries they're allowed to read, residents and attendance at their sites, and the calendar. " +
  "Start with whoami and list_forms. Basic forms: get_form for the fields, then list_entries (paged: take/skip). Code forms (custom apps like Hot Foods or incident reports): list_code_entries. " +
  "For a report, page through every entry in the date range before counting, say which dates, sites and filters you used, and don't paste residents' personal details where a count or a name will do. " +
  "If something they ask for is refused, they don't have access to it on the site either; say so rather than guessing.";

export function registerPersonTools(tool: ToolRegistrar, user: CurrentUser, grant: ResolvedGrant) {
  const as = { user, apiKey: connectionKey(user, grant) };
  const route = (router: Parameters<typeof callRouteOk>[0], call: RouteCall) => callRouteOk(router, call, as);
  const ro = { readOnlyHint: true };

  tool(
    "whoami",
    "Who you're connected as: their name, role, sites and what you can do. Start here.",
    {},
    async () => {
      const sites = await prisma.site.findMany({
        where: { active: true, ...(user.siteIds ? { id: { in: user.siteIds } } : {}) },
        orderBy: { name: "asc" },
        select: { code: true, name: true },
      });
      return {
        person: { name: user.name, email: user.email, role: user.roleName },
        sites: user.siteIds === null ? { all: true, list: sites } : sites,
        access: "Read only. Everything is limited to what this person can see on the site.",
        connection: { client: grant.clientName, scope: grant.scope },
        tools: [...OWN_TOOLS, ...OPS.filter((op) => personCanUse(op, user) && !OWN_TOOLS.includes(op.name)).map((op) => op.name)],
      };
    },
    ro
  );

  tool(
    "list_sites",
    "The sites this person works at (every site for an Admin or Main Office), with active resident and attention counts.",
    {},
    async () => route(sitesRouter, { method: "GET", path: "/" }),
    ro
  );

  tool(
    "list_forms",
    "The forms on this person's Forms screen, by category. kind basic = a form built here (get_form, list_entries); code = a custom app (list_code_entries); link = a page elsewhere, with no data here.",
    {},
    async () => {
      const out = (await route(formsRouter, { method: "GET", path: "/" })) as { categories: { name: string; forms: CatalogForm[] }[] };
      return out.categories.map((c) => ({
        category: c.name,
        forms: c.forms.map((f) => ({ title: f.title, ...kindOf(f.url), description: f.description ?? undefined, badge: f.badge ?? undefined, url: f.url.startsWith("/") ? `${appBaseUrl}${f.url}` : f.url })),
      }));
    },
    ro
  );

  tool(
    "get_form",
    "A basic form: its title, status, fields (id, type, label, choices) and whether this person can read its entries.",
    { form: slug },
    async ({ form }) => {
      const out = (await route(fillRouter, { method: "GET", path: `/${enc(form)}` })) as { form: unknown; doc: { title?: string; description?: string }; closed: unknown; canReadEntries: boolean };
      return { form: out.form, description: out.doc?.description, fields: fieldList(out.doc), closed: out.closed || undefined, canReadEntries: out.canReadEntries };
    },
    ro
  );

  tool(
    "list_entries",
    "A basic form's entries this person can read, newest first: 50 by default, up to 200 a page (page on with skip). Filter by date (from/to, YYYY-MM-DD), site code, status, or text (q). total is the count across all pages.",
    {
      form: slug,
      from: z.string().optional().describe("YYYY-MM-DD"),
      to: z.string().optional().describe("YYYY-MM-DD"),
      site: z.string().optional().describe("Site code"),
      q: z.string().max(120).optional(),
      status: z.enum(["active", "voided", "all"]).optional(),
      take: int(1, 200).optional(),
      skip: int(0, 1_000_000).optional(),
    },
    async (a) => {
      const out = (await route(fillRouter, {
        method: "GET",
        path: `/${enc(a.form)}/entries`,
        query: { from: a.from, to: a.to, site: a.site, q: a.q, status: a.status, take: a.take?.toString(), skip: a.skip?.toString() },
      })) as { form: unknown; doc: unknown; total: number; items: unknown[] };
      return { form: out.form, total: out.total, skip: a.skip ?? 0, fields: fieldList(out.doc), items: out.items };
    },
    ro
  );

  tool(
    "get_entry",
    "One entry of a basic form: every answer, its notes and history.",
    { form: slug, id: z.string() },
    async ({ form, id }) => route(fillRouter, { method: "GET", path: `/${enc(form)}/entries/${enc(id)}` }),
    ro
  );

  tool(
    "list_code_entries",
    "A code form's (custom app's) entries this person can read, newest first: 100 by default, up to 2000 (page on with offset). Filter by date (from/to), site code(s), resident (tenantId), status or text. fields picks which data keys to return (default all). Some code forms only show a person their own entries: pass mine: true.",
    {
      form: slug,
      from: z.string().optional().describe("YYYY-MM-DD"),
      to: z.string().optional().describe("YYYY-MM-DD"),
      site: z.string().optional().describe("Site code (comma-separate several)"),
      tenantId: z.string().optional(),
      status: z.enum(["active", "voided", "all"]).optional(),
      search: z.string().max(120).optional(),
      mine: flag().optional(),
      fields: z.array(z.string()).max(50).optional(),
      order: z.enum(["newest", "oldest"]).optional(),
      limit: int(1, 2000).optional(),
      offset: int(0, 1_000_000).optional(),
    },
    async (a) =>
      route(appsRouter, {
        method: "GET",
        path: `/${enc(a.form)}/entries`,
        query: {
          from: a.from,
          to: a.to,
          site: a.site,
          tenantId: a.tenantId,
          status: a.status,
          search: a.search,
          mine: a.mine ? "1" : undefined,
          fields: a.fields?.join(","),
          order: a.order,
          limit: a.limit?.toString(),
          offset: a.offset?.toString(),
        },
      }),
    ro
  );

  tool(
    "get_code_entry",
    "One entry of a code form.",
    { form: slug, id: z.string() },
    async ({ form, id }) => route(appsRouter, { method: "GET", path: `/${enc(form)}/entries/${enc(id)}` }),
    ro
  );

  // The shared read operations — residents, attendance, sites, calendar, audit… — that this person's role allows.
  for (const op of OPS) {
    if (!personCanUse(op, user) || OWN_TOOLS.includes(op.name)) continue;
    const description = op.description.replace(/\bthe key\b/g, "you").replace(/\bThe key\b/g, "You");
    tool(op.name, description, op.shape, (args) => runAsPerson(op, user, grant, args as Record<string, unknown>), op.annotations);
  }
}
