import { useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/toast";
import { useAuth } from "@/lib/auth";
import { formsApi, sampleKey, useForms, useSites } from "@/lib/queries";
import { canOpenForm, formIcon, formLinkIcon } from "@/lib/formIcons";
import { isSample } from "@/lib/tour/sampleData";
import type { FormCatalog, FormCategory, FormLink } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

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

/** The most pinned forms the sidebar and the tablet dock show; the rest stay on the Forms page's Pinned row. */
export const MAX_NAV_PINS = 5;

/**
 * Pin / unpin, optimistically: the pin fills the instant it's tapped and
 * springs back, with a toast, only if the server refuses. Resolves false when
 * the pin wasn't taken (so the button can shake), true otherwise. Shared by
 * the Forms page and the launcher.
 */
export function usePinToggle() {
  const qc = useQueryClient();
  const toast = useToast();
  return async (form: FormLink, isPinned: boolean): Promise<boolean> => {
    // The welcome tour's sample forms keep their pins in their own cache (formsApi doesn't send them).
    const key = isSample(form.id) ? sampleKey("forms") : ["forms", "visible"];
    const before = qc.getQueryData<FormCatalog>(key);
    if (!isPinned && before && before.favorites.length >= MAX_NAV_PINS) {
      toast(`You can pin up to ${MAX_NAV_PINS} forms. Unpin one to make room.`, "error");
      return false;
    }
    if (before) {
      qc.setQueryData<FormCatalog>(key, {
        ...before,
        favorites: isPinned ? before.favorites.filter((id) => id !== form.id) : [...before.favorites, form.id],
      });
    }
    try {
      await (isPinned ? formsApi.unfavorite(form.id) : formsApi.favorite(form.id));
      return true;
    } catch (e) {
      if (before) qc.setQueryData(key, before);
      toast(errorMessage(e, "Couldn't save that pin."), "error");
      return false;
    }
  };
}

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
