import { prisma } from "../prisma.js";
import { currentUserById } from "../auth/middleware.js";
import type { ResolvedKey } from "../services/apiKeys.js";
import type { ToolRegistrar } from "../forms/mcp.js";
import { describeOp, runOp, shapeOf, type Op } from "./registry.js";
import { SCOPE_GRANTS, delegatedUser } from "./principal.js";
import { formOps } from "./forms.js";
import { rosterOps } from "./roster.js";
import { adminOps } from "./admin.js";
import { calendarOps } from "./calendar.js";
import { emailOps } from "./email.js";

const WHOAMI =
  "This API key: its name, scopes, site, who made it, and for each delegated scope the permissions and sites it acts with right now (or why it can't). Start here to see what you can do. Needs no scope.\n[REST GET /api/v1/me]";

/** What a key is and what each of its scopes lets it do right now (MCP whoami, GET /api/v1/me). */
export async function describeKey(key: ResolvedKey) {
  const creator = key.createdById ? await currentUserById(key.createdById) : null;
  const site = key.siteId ? await prisma.site.findUnique({ where: { id: key.siteId }, select: { code: true, name: true } }) : null;
  const delegated: Record<string, unknown> = {};
  for (const scope of key.scopes) {
    if (!SCOPE_GRANTS[scope]) continue;
    if (!creator) {
      delegated[scope] = { usable: false, why: key.createdById ? "The person who made this key no longer has an active account." : "This key has no record of who made it." };
      continue;
    }
    try {
      const u = delegatedUser(creator, key, scope);
      delegated[scope] = { usable: true, permissions: u.permissions, sites: u.siteIds === null ? "every site" : u.siteIds };
    } catch (err) {
      delegated[scope] = { usable: false, why: err instanceof Error ? err.message : String(err) };
    }
  }
  return {
    key: { name: key.name, scopes: key.scopes, site: site ?? null },
    actsOnBehalfOf: creator ? { name: creator.name, email: creator.email, role: creator.roleName } : null,
    delegated,
    operations: OPS.filter((op) => key.scopes.includes(op.scope)).map((op) => op.name),
  };
}

/** Every operation, MCP tool and /api/v1 route alike. More specific REST paths come first. */
export const OPS: Op<any>[] = [...formOps, ...rosterOps, ...adminOps, ...calendarOps, ...emailOps];

/** Register every operation (and whoami) as an MCP tool. */
export function registerOps(tool: ToolRegistrar, key: ResolvedKey) {
  tool("whoami", WHOAMI, {}, async () => describeKey(key), { readOnlyHint: true });
  for (const op of OPS) {
    tool(op.name, describeOp(op), shapeOf(op), (args) => runOp(op, key, args as Record<string, unknown>, "MCP"), op.annotations);
  }
}
