import { NavLink, Outlet } from "react-router-dom";
import { cn } from "@/lib/utils";
import { CountBadge } from "@/components/ui/badge";
import { useAuth } from "@/lib/auth";
import { useApiKeys, useForms, useSites, useUsers, useWebhooks } from "@/lib/queries";
import type { PermissionKey } from "@/lib/types";

/**
 * Admin's in-page rail, grouped so the main sidebar stays at five entries.
 * Phone: the rail becomes a band of pills that scrolls sideways.
 */
const GROUPS: { group: string; items: { to: string; label: string; key: string; needs: PermissionKey[] }[] }[] = [
  {
    group: "Forms",
    items: [
      { to: "/admin/forms", label: "Forms catalog", key: "forms", needs: ["forms.manage"] },
      { to: "/admin/hot-foods", label: "Hot Foods", key: "hotFoods", needs: ["forms.manage"] },
    ],
  },
  {
    group: "Organization",
    items: [
      { to: "/admin/sites", label: "Sites", key: "sites", needs: ["sites.manage"] },
      { to: "/admin/import", label: "Import tenant list", key: "import", needs: ["sites.manage"] },
    ],
  },
  {
    group: "People",
    items: [
      { to: "/admin/people", label: "People & roles", key: "people", needs: ["users.manage", "users.manageSite"] },
      { to: "/admin/sign-in", label: "Sign-in access", key: "signIn", needs: ["settings.manage"] },
    ],
  },
  {
    group: "Integrations",
    items: [
      { to: "/admin/api-keys", label: "API keys", key: "apiKeys", needs: ["integrations.manage"] },
      { to: "/admin/webhooks", label: "Webhooks", key: "webhooks", needs: ["integrations.manage"] },
      { to: "/admin/wordpress", label: "WordPress setup", key: "wordpress", needs: ["integrations.manage"] },
    ],
  },
  {
    group: "Roster",
    items: [{ to: "/admin/settings", label: "Roster rules", key: "settings", needs: ["settings.manage", "sites.manageRules"] }],
  },
];

export function ConfigLayout() {
  const { can } = useAuth();
  const { data: sites } = useSites(true, can("sites.manage"));
  const { data: forms } = useForms(true);
  const { data: users } = useUsers(can("users.manage") || can("users.manageSite"));
  const { data: keys } = useApiKeys(can("integrations.manage"));
  const { data: hooks } = useWebhooks(can("integrations.manage"));
  const counts: Record<string, number | undefined> = {
    forms: forms?.categories.reduce((n, c) => n + c.forms.length, 0),
    sites: sites?.length,
    people: users?.filter((u) => u.status !== "deactivated").length,
    apiKeys: keys?.filter((k) => !k.revokedAt).length,
    webhooks: hooks?.items.length,
  };
  const waiting = (users ?? []).filter((u) => u.status === "requested").length;

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <nav className="w-full shrink-0 border-b border-hairline bg-surface px-3 pb-2 pt-safe-top md:h-full md:w-[222px] md:overflow-y-auto md:scroll-thin md:flex md:flex-col md:border-b-0 md:border-r md:py-5">
        <p className="mb-2 px-2 text-micro font-bold uppercase tracking-[0.04em] text-muted">Admin</p>
        <div className="chiprow -mx-1 flex gap-1.5 px-1 md:mx-0 md:block md:overflow-visible md:px-0">
          {GROUPS.map((g) => {
            const items = g.items.filter((it) => it.needs.some(can));
            if (!items.length) return null;
            return (
              <div key={g.group} className="flex gap-1.5 md:mb-4 md:block">
                <p className="mb-1 hidden px-2 text-micro font-bold uppercase tracking-[0.04em] text-muted md:block">{g.group}</p>
                {items.map((it) => (
                  <NavLink
                    key={it.to}
                    to={it.to}
                    className={({ isActive }) =>
                      cn(
                        "flex min-h-[38px] shrink-0 items-center gap-2 rounded-pill border border-hairline px-3 text-left text-[12.5px] transition-colors md:w-full md:min-h-0 md:rounded-input md:border-0 md:px-2 md:py-[7px] md:text-[13px]",
                        isActive ? "border-navy bg-navsel font-bold text-accent dark:text-white" : "font-medium text-ink hover:bg-navsel/60"
                      )
                    }
                  >
                    <span className="min-w-0 flex-1 truncate">{it.label}</span>
                    {it.key === "people" && waiting > 0 && <CountBadge count={waiting} />}
                    {counts[it.key] !== undefined && <span className="tabular text-micro text-muted">{counts[it.key]}</span>}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </div>
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto scroll-thin [scrollbar-gutter:stable]">
        <Outlet />
      </div>
    </div>
  );
}
