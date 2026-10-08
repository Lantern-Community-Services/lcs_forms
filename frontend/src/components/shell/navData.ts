import { useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useForms, useSites } from "@/lib/queries";
import { canOpenForm, formIcon, formLinkIcon } from "@/lib/formIcons";
import type { FormCategory, FormLink } from "@/lib/types";

/**
 * What the app's navigation shows, shared by the desktop sidebar and the
 * touch dock and launcher so they can never disagree about which forms exist.
 */

/** People waiting in the review queue across every site the user can see. */
export function useReviewCount(): number {
  const { can } = useAuth();
  const rosterUser = can("roster.view");
  const { data } = useSites(false, rosterUser);
  return rosterUser ? (data ?? []).reduce((n, s) => n + s.attentionCount, 0) : 0;
}

/** The Roster's catalog URL. It sits in the top group of the nav (Home, Roster, Calendar), not among the forms. */
export const ROSTER_URL = "/roster";

export interface NavCategory {
  category: FormCategory;
  Icon: React.ElementType;
  /** Only the forms this person may open. */
  forms: FormLink[];
}

export interface NavForm {
  form: FormLink;
  category: FormCategory;
  Icon: React.ElementType;
}

export function useNavCatalog(): { categories: NavCategory[]; pinned: NavForm[] } {
  const { can } = useAuth();
  const { data: catalog } = useForms();
  // Categories with nothing this person may open are left out entirely. The
  // Roster is left out of the lists too: it has its own place beside Home and
  // Calendar, so showing it again as a form would only repeat it.
  const categories = (catalog?.categories ?? [])
    .map((category) => ({
      category,
      Icon: formIcon(category.icon),
      forms: category.forms.filter((f) => f.url !== ROSTER_URL && canOpenForm(f.url, can)),
    }))
    .filter((c) => c.forms.length > 0);
  const byId = new Map<string, NavForm>(
    categories.flatMap((c) => c.forms.map((form): [string, NavForm] => [form.id, { form, category: c.category, Icon: formLinkIcon(form, c.category.icon || "folder") }]))
  );
  // Pinned forms, in the order they were pinned. The API still calls them favorites.
  const pinned = (catalog?.favorites ?? []).map((id) => byId.get(id)).filter((f): f is NavForm => Boolean(f));
  return { categories, pinned };
}

export const isRosterPath = (pathname: string) => pathname.startsWith("/roster") || pathname.startsWith("/tenants");

/** Inside a form rather than on the catalog or an admin screen: the Roster, built forms and code forms. */
export const isFormPath = (pathname: string) =>
  pathname.startsWith("/f/") || pathname.startsWith("/apps/") || isRosterPath(pathname);

/**
 * Whether a catalog URL is the screen on show. A form stays lit on its own tabs
 * (/apps/hot-foods/entries), and the Roster on every roster tab and resident page.
 */
export function useIsLit(): (url: string) => boolean {
  const { pathname } = useLocation();
  return (url) => pathname === url || pathname.startsWith(`${url}/`) || (url === "/roster" && isRosterPath(pathname));
}

/** A form's name without the words every form shares, for places with room for a word or two. */
export function shortFormName(title: string): string {
  const short = title.replace(/\s*\([^)]*\)/g, "").replace(/\s+form$/i, "").trim();
  return short || title;
}

/** Forms matching a search, by title, keywords, description or category name. */
export function searchForms(categories: NavCategory[], q: string): NavForm[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return categories.flatMap((c) =>
    c.forms
      .filter((f) => {
        const hay = `${f.title} ${f.keywords ?? ""} ${f.description ?? ""} ${c.category.name}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .map((form) => ({ form, category: c.category, Icon: formLinkIcon(form, c.category.icon || "folder") }))
  );
}
