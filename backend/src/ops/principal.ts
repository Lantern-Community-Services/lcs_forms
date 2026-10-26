import { HttpError } from "../http.js";
import { currentUserById, type CurrentUser } from "../auth/middleware.js";
import type { ApiScope, ResolvedKey } from "../services/apiKeys.js";
import type { PermissionKey } from "../services/permissions.js";

/**
 * Who a delegated API key acts as.
 *
 * A delegated scope lets a key (and the MCP server behind it) do what the site's
 * own screens do. It acts on behalf of the admin who made the key
 * (ApiKey.createdById), and never with more than that person can do right now:
 *
 *   permissions = the creator's current permissions ∩ what the scope grants
 *   sites       = the creator's sites ∩ the key's site (when it's pinned to one)
 *
 * Both are re-read on every call, so deactivating or demoting the creator, or
 * taking a site away from them, takes it from their keys on the next request.
 * admins.manage is never granted: no key makes, changes or removes an Admin.
 *
 * A key pinned to one site gets only the site-bounded half of a scope (Site
 * Admin's users.manageSite rather than Admin's users.manage, say), and none of
 * the org-wide scopes (settings, import, dev log), because an Admin's version of
 * those reaches every site whatever the pin says.
 */
interface Grant {
  /** Granted to a key that isn't pinned to a site. */
  all: PermissionKey[];
  /** Granted to a key pinned to one site. Empty = the scope doesn't work pinned. */
  pinned: PermissionKey[];
}

export const SCOPE_GRANTS: Partial<Record<ApiScope, Grant>> = {
  // roster:read and entries:read stay key-only for their original endpoints;
  // here they cover the delegated read operations (resident detail, review
  // queue, attendance, code-form entry history).
  "roster:read": { all: ["roster.view"], pinned: ["roster.view"] },
  "entries:read": { all: ["entries.view"], pinned: ["entries.view"] },
  "roster:write": { all: ["roster.view", "roster.edit"], pinned: ["roster.view", "roster.edit"] },
  "roster:archive": { all: ["roster.view", "roster.archive", "roster.restore"], pinned: ["roster.view", "roster.archive", "roster.restore"] },
  "roster:import": { all: ["sites.manage"], pinned: [] },
  "audit:read": { all: ["roster.view", "audit.view"], pinned: ["roster.view", "audit.view"] },
  "sites:manage": { all: ["sites.manage", "sites.manageRules"], pinned: ["sites.manageRules"] },
  "people:manage": { all: ["users.manage", "users.manageSite", "people.records"], pinned: ["users.manageSite"] },
  // Everyone signed in reads the calendar: the scope needs only an active creator.
  "calendar:read": { all: [], pinned: [] },
  "calendar:write": { all: ["calendar.manage", "calendar.edit"], pinned: ["calendar.edit"] },
  "settings:manage": { all: ["settings.manage"], pinned: [] },
  "entries:manage": { all: ["entries.view", "entries.void", "forms.manage"], pinned: ["entries.view", "entries.void", "forms.manage"] },
  "devlog:read": { all: ["devlog.view"], pinned: [] },
};

export function isDelegatedScope(scope: ApiScope): boolean {
  return scope in SCOPE_GRANTS;
}

/**
 * The person a key acts as for one scope, worked out from its creator as they
 * are now. Pure, so the rules can be checked without a database (scripts/ops-smoke.ts).
 */
export function delegatedUser(creator: CurrentUser, key: Pick<ResolvedKey, "name" | "siteId">, scope: ApiScope): CurrentUser {
  const grant = SCOPE_GRANTS[scope];
  if (!grant) throw new HttpError(500, `${scope} isn't a delegated scope.`);
  const pinned = Boolean(key.siteId);
  if (pinned && grant.all.length && !grant.pinned.length) {
    throw new HttpError(403, `${scope} reaches every site, so it doesn't work on a key limited to one site. Make a key without a site.`);
  }
  const offered = pinned ? grant.pinned : grant.all;
  const permissions = creator.permissions.filter((p) => offered.includes(p) && p !== "admins.manage");
  if (offered.length && !permissions.length) {
    throw new HttpError(403, `${scope} needs ${offered.join(" or ")}, and ${creator.name}, who made this key, doesn't have that now.`);
  }
  let siteIds = creator.siteIds;
  if (key.siteId) siteIds = siteIds === null || siteIds.includes(key.siteId) ? [key.siteId] : [];
  return {
    ...creator,
    // What the audit trail, entry notes and "voided by" show.
    name: `${creator.name} (API key: ${key.name})`,
    permissions,
    siteIds,
  };
}

/** delegatedUser() for a real key: loads its creator, refusing a key nobody active stands behind. */
export async function principalFor(key: ResolvedKey, scope: ApiScope): Promise<CurrentUser> {
  if (!key.createdById) {
    throw new HttpError(403, `${scope} acts on behalf of the admin who made the key, and this key has no record of who that was. Make a new key in Admin → API keys.`);
  }
  const creator = await currentUserById(key.createdById);
  if (!creator) throw new HttpError(403, `The person who made this API key no longer has an active account, so its ${scope} scope is off. Make a new key.`);
  return delegatedUser(creator, key, scope);
}
