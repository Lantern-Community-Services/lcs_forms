import { useMemo } from "react";
import { Bell, BookOpen, CalendarDays, CircleHelp, Contact, Home, LayoutGrid, Settings, UserRound, type LucideIcon } from "lucide-react";
import { ARTICLES, allowed } from "@/lib/help/content";
import { ADMIN_AREA, useAuth } from "@/lib/auth";
import { useTenants } from "@/lib/queries";
import type { Tenant } from "@/lib/types";
import { searchForms, type NavCategory, type NavForm } from "./navData";

/**
 * The one search on a desktop (the sidebar's, Ctrl K): screens, forms and
 * residents in one list, so there's a single place to look for anything.
 * Screens' own filters (the Forms page, the roster) only narrow what's already
 * on that screen.
 *
 * Residents come from the same roster copy the Roster screen reads, which the
 * server only fills with the person's own sites, so nobody can find a resident
 * they couldn't already open.
 */
export interface PageHit {
  to: string;
  label: string;
  Icon: LucideIcon;
  /** Extra words that should find it ("settings" finds Profile). */
  words: string;
}

export interface SearchHits {
  pages: PageHit[];
  forms: NavForm[];
  residents: Tenant[];
  /** How many residents matched before the list was cut short. */
  residentTotal: number;
  /** The first hit, for Enter. */
  first: { to: string; external?: boolean } | null;
}

const RESIDENT_LIMIT = 6;
const matches = (hay: string, words: string[]) => words.every((w) => hay.includes(w));

export function useGlobalSearch(q: string, categories: NavCategory[]): SearchHits {
  const { can } = useAuth();
  const words = useMemo(() => q.trim().toLowerCase().split(/\s+/).filter(Boolean), [q]);
  const rosterUser = can("roster.view");
  // Only fetched once someone is actually looking for a resident.
  const { data: tenants } = useTenants(undefined, "active", rosterUser && words.join("").length >= 2);

  const pageList = useMemo(() => {
    const list: PageHit[] = [
      { to: "/home", label: "Home", Icon: Home, words: "dashboard start tasks attention" },
      { to: "/forms", label: "Forms", Icon: LayoutGrid, words: "all forms catalog browse" },
      { to: "/calendar", label: "Calendar", Icon: CalendarDays, words: "events schedule request" },
      { to: "/notifications", label: "Notifications", Icon: Bell, words: "alerts bell messages" },
      { to: "/profile", label: "Profile & settings", Icon: UserRound, words: "account preferences theme tour tutorial" },
      { to: "/help", label: "Help", Icon: CircleHelp, words: "help guide how to what can i do where support question" },
      // Each help article you can read, so "share link" or "follow-up" finds how to do it.
      ...ARTICLES.filter((a) => allowed(a.needs, can)).map((a) => ({ to: `/help/${a.id}`, label: `Help: ${a.title}`, Icon: BookOpen, words: `${a.summary} ${a.words ?? ""}` })),
    ];
    if (rosterUser) list.splice(2, 0, { to: "/roster", label: "Roster", Icon: Contact, words: "residents tenants review attendance" });
    if (ADMIN_AREA.some(can)) list.push({ to: "/admin", label: "Admin", Icon: Settings, words: "settings people roles sites" });
    return list;
  }, [can, rosterUser]);

  return useMemo(() => {
    if (!words.length) return { pages: [], forms: [], residents: [], residentTotal: 0, first: null };
    const pages = pageList.filter((p) => matches(`${p.label} ${p.words}`.toLowerCase(), words));
    const forms = searchForms(categories, q);
    const roster: Tenant[] = Array.isArray(tenants) ? tenants : (tenants?.items ?? []);
    const allResidents = rosterUser
      ? roster.filter((t) => matches(`${t.displayName} ${t.firstName} ${t.lastName} ${t.preferredName ?? ""} ${t.unit ?? ""} ${t.site?.name ?? ""}`.toLowerCase(), words))
      : [];
    const residents = allResidents.slice(0, RESIDENT_LIMIT);
    const firstForm = forms[0]?.form;
    const first = pages[0]
      ? { to: pages[0].to }
      : firstForm
        ? { to: firstForm.url, external: !firstForm.url.startsWith("/") }
        : residents[0]
          ? { to: `/tenants/${residents[0].id}` }
          : null;
    return { pages, forms, residents, residentTotal: allResidents.length, first };
  }, [words, q, pageList, categories, tenants, rosterUser]);
}
