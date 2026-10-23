import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ChevronLeft, ChevronRight, ExternalLink, Lock, Pin } from "lucide-react";
import { Page } from "@/components/shell/AppShell";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import { Tag } from "@/components/ui/badge";
import { SearchInput } from "@/components/ui/input";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { useAuth } from "@/lib/auth";
import { canOpenForm, formIcon, formLinkIcon, formNeeds, isInternalForm } from "@/lib/formIcons";
import { formsApi, sampleKey, useForms } from "@/lib/queries";
import { isSample } from "@/lib/tour/sampleData";
import { useTourSample } from "@/lib/tour/store";
import type { FormCatalog, FormCategory, FormLink } from "@/lib/types";
import { useSearchParam } from "@/lib/useSearchParam";
import { cn, errorMessage } from "@/lib/utils";

/**
 * The Forms page: every form Lantern staff fill out, in one place to browse,
 * filter and pin. Home (screens/Home) is for the day's work; this is where the
 * forms live, and the sidebar's single Forms entry comes here.
 *
 * - tablet and desktop: pinned forms in a row, then a card per category with
 *   its description and its forms listed inside, so any form is one click
 *   away. A category's name opens its full page. The filter narrows the cards;
 * - phone: pinned forms, and category tiles that open a list.
 *
 * The chosen group lives in the URL (?category=<id>, "pinned" or "all") so
 * other screens can link straight to one. The phone's Home shows the same
 * tiles (PhoneForms), since a phone has no sidebar to reach this page from.
 */
const FAVORITES = "pinned";
const ALL = "all";

/** A category id, FAVORITES, ALL, or null = nothing picked yet. */
type Selection = string | null;

/** The catalog, the filter and the chosen group: everything the Forms page and the phone's Home share. */
export function useCatalogBrowser() {
  const { can } = useAuth();
  const { data, isLoading, isError } = useForms();
  const [q, setQ] = useState("");
  const [askedRaw, setPick] = useSearchParam("category");
  // "favorites" was this group's name before it became Pinned; old links still land on it.
  const asked = askedRaw === "favorites" ? FAVORITES : askedRaw;
  const toggleFavorite = useFavoriteToggle();

  // The welcome tour has its search typed in here; its sample forms leave with it, and so does the search.
  const sample = useTourSample();
  useEffect(() => {
    if (!sample) setQ("");
  }, [sample]);

  const categories = useMemo(() => data?.categories ?? [], [data]);
  const favorites = useMemo(() => new Set(data?.favorites ?? []), [data]);
  // A category that no longer exists (an old link) means "nothing picked", not an empty page.
  const pick: Selection = asked === FAVORITES || asked === ALL || (asked && categories.some((c) => c.id === asked)) ? asked : null;
  const searching = q.trim() !== "";
  const totalForms = categories.reduce((n, c) => n + c.forms.length, 0);

  const favoriteForms = useMemo(() => {
    const byId = new Map(categories.flatMap((c) => c.forms.map((f) => [f.id, { form: f, category: c }] as const)));
    return (data?.favorites ?? []).map((id) => byId.get(id)).filter((x): x is Entry => Boolean(x));
  }, [categories, data]);

  const matchingFlat = useMemo(
    () => filterCatalog(categories, q, pick, favorites).flatMap((c) => c.forms.map((form) => ({ form, category: c }))),
    [categories, q, pick, favorites]
  );
  const searchResults = useMemo(
    () => (searching ? filterCatalog(categories, q, null, favorites).flatMap((c) => c.forms.map((form) => ({ form, category: c }))) : []),
    [categories, q, searching, favorites]
  );

  const star = (form: FormLink) => toggleFavorite(form, favorites.has(form.id));
  const cardProps = (e: Entry) => ({ form: e.form, category: e.category, favorite: favorites.has(e.form.id), onToggleFavorite: () => star(e.form) });

  const empty = isLoading ? (
    <LoadingState />
  ) : isError ? (
    <EmptyState title="The forms didn't load" hint="Check your connection and refresh the page. If it keeps happening, contact the IT Team." />
  ) : categories.length === 0 ? (
    <EmptyState title="No forms yet" hint={can("forms.manage") ? "Add some in Admin → Forms catalog." : "An administrator hasn't set up the forms yet."} />
  ) : null;

  return { q, setQ, pick, setPick, searching, categories, favorites, favoriteForms, totalForms, matchingFlat, searchResults, cardProps, empty };
}

export type CatalogBrowser = ReturnType<typeof useCatalogBrowser>;

export function FormsPage() {
  const c = useCatalogBrowser();
  const { q, setQ, searching, searchResults, totalForms } = c;
  const searchRef = useRef<HTMLInputElement>(null);
  const phoneSearchRef = useRef<HTMLInputElement>(null);

  // "/" jumps to whichever filter box is on screen.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      e.preventDefault();
      const visible = [searchRef.current, phoneSearchRef.current].find((el) => el && el.offsetParent !== null);
      visible?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const summary = searching
    ? `${searchResults.length === 0 ? "No forms match" : `${searchResults.length} of ${totalForms} forms match`} “${q.trim()}”`
    : `${totalForms} ${totalForms === 1 ? "form" : "forms"} · pin the ones you use most and they stay in the sidebar`;

  return (
    <div className="flex min-h-full flex-col">
      {/* ── Phone ─────────────────────────────────────────────────────── */}
      <PhoneHeader title="Forms" subtitle={`${totalForms} ${totalForms === 1 ? "form" : "forms"}`} enter>
        <div data-tour="forms-search" className="enter-up mt-3">
          <SearchInput ref={phoneSearchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter forms" aria-label="Filter forms" />
        </div>
      </PhoneHeader>
      <div className="flex flex-col gap-4 px-4 py-4 md:hidden">
        <PhoneForms c={c} />
      </div>

      {/* ── Tablet and desktop ────────────────────────────────────────── */}
      <Page className="hidden w-full !pt-0 md:block">
        <section aria-labelledby="forms-title">
          {/* Stays put while the page scrolls under it, so the filter is always in reach. */}
          {/* z-20: above the cards' pin buttons (z-10), which otherwise drew over it while scrolling. */}
          <div className="sticky top-0 z-20 -mx-7 mb-2 border-b border-hairline bg-surface/95 px-7 pb-3 pt-7 backdrop-blur">
            <div className="enter-up flex flex-wrap items-end justify-between gap-4">
              <div className="min-w-0">
                <h1 id="forms-title" className="text-[23px] font-heading font-extrabold text-ink xl:text-[26px]">Forms</h1>
                <p className="mt-1 text-[13.5px] text-muted" aria-live="polite">{summary}</p>
              </div>
              <div data-tour="forms-search" className="w-[300px] xl:w-[380px]">
                <SearchInput ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter forms" aria-label="Filter forms" />
              </div>
            </div>
          </div>
          <div data-tour="forms-browser">
            {c.empty ?? <CategorySections c={c} />}
          </div>
        </section>
      </Page>
    </div>
  );
}

/**
 * The phone's forms: pinned ones in a row, then a tile per category that opens
 * its list (or the filter's matches). Used by the Forms page and the phone's Home.
 */
export function PhoneForms({ c, after }: { c: CatalogBrowser; after?: React.ReactNode }) {
  const { setQ, pick, setPick, searching, searchResults, matchingFlat, categories, favorites, favoriteForms, totalForms } = c;
  if (c.empty) return <>{c.empty}</>;
  if (searching || pick) {
    return (
      <PhoneFormList
        title={searching ? "Results" : pick === FAVORITES ? "Pinned" : pick === ALL ? "All forms" : categories.find((x) => x.id === pick)?.name ?? ""}
        entries={searching ? searchResults : matchingFlat}
        favorites={favorites}
        onBack={() => {
          setQ("");
          setPick(null);
        }}
      />
    );
  }
  return (
    <>
      {favoriteForms.length > 0 && (
        <section className="enter-up">
          <h2 className="mb-2 flex items-center gap-1.5 text-[15px] font-heading font-extrabold text-ink">
            <Pin className="h-4 w-4 fill-status-amberDot text-status-amberDot" /> Pinned
          </h2>
          <div className="chiprow -mx-4 flex gap-2 overflow-x-auto px-4">
            {favoriteForms.map((e) => {
              const Icon = formLinkIcon(e.form, e.category.icon);
              return (
                <FormLinkWrap key={e.form.id} form={e.form} className="flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-pill border border-hairline bg-surface pl-1.5 pr-3.5 text-[13.5px] font-bold text-ink">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-navsel text-accent dark:text-white">
                    <Icon className="h-4 w-4" />
                  </span>
                  {e.form.title}
                </FormLinkWrap>
              );
            })}
          </div>
        </section>
      )}
      <section data-tour="home-forms">
        <div className="enter-up mb-2 flex items-baseline justify-between">
          <h2 className="text-[15px] font-heading font-extrabold text-ink">All forms</h2>
          <span className="text-[12.5px] text-muted">{totalForms} forms</span>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          {categories.map((cat) => {
            const Icon = formIcon(cat.icon);
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => setPick(cat.id)}
                className="enter-up flex min-h-[96px] flex-col items-start gap-2.5 rounded-card border border-hairline bg-surface p-3 text-left active:bg-rowhover"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-input bg-navy text-white">
                  <Icon className="h-[18px] w-[18px]" />
                </span>
                <span>
                  <span className="block text-[14px] font-bold leading-snug text-ink">{cat.name}</span>
                  <span className="block text-[12px] text-muted">{cat.forms.length} {cat.forms.length === 1 ? "form" : "forms"}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
      {after}
    </>
  );
}

type Entry = { form: FormLink; category: FormCategory };

function greetingWord() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

/**
 * Every word typed must appear somewhere in the form's title, description,
 * keywords or its category's name, so "petty report" finds the Petty Cash
 * Report Form and "tenant updater" finds the roster.
 */
function filterCatalog(categories: FormCategory[], q: string, pick: Selection, favorites: Set<string>): FormCategory[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return categories
    .filter((c) => pick === null || pick === ALL || pick === FAVORITES || c.id === pick)
    .map((c) => ({
      ...c,
      forms: c.forms.filter((f) => {
        if (pick === FAVORITES && !favorites.has(f.id)) return false;
        if (!words.length) return true;
        const hay = [f.title, f.description, f.keywords, f.badge, c.name].filter(Boolean).join(" ").toLowerCase();
        return words.every((w) => hay.includes(w));
      }),
    }))
    .filter((c) => c.forms.length > 0);
}

/**
 * Pin / unpin, optimistically: the pin fills the instant it's tapped and
 * springs back, with a toast, only if the server refuses.
 */
function useFavoriteToggle() {
  const qc = useQueryClient();
  const toast = useToast();
  return async (form: FormLink, isFavorite: boolean) => {
    // The welcome tour's sample forms keep their pins in their own cache (formsApi doesn't send them).
    const key = isSample(form.id) ? sampleKey("forms") : ["forms", "visible"];
    const before = qc.getQueryData<FormCatalog>(key);
    if (before) {
      qc.setQueryData<FormCatalog>(key, {
        ...before,
        favorites: isFavorite ? before.favorites.filter((id) => id !== form.id) : [...before.favorites, form.id],
      });
    }
    try {
      await (isFavorite ? formsApi.unfavorite(form.id) : formsApi.favorite(form.id));
    } catch (e) {
      if (before) qc.setQueryData(key, before);
      toast(errorMessage(e, "Couldn't save that pin."), "error");
    }
  };
}

/** Where a link out goes, in words staff recognise. */
function whereLabel(url: string) {
  try {
    const host = new URL(url).hostname;
    if (host === "forms.lanterncommunity.org") return "Old forms site";
    if (host.endsWith("sharepoint.com")) return "SharePoint";
    if (host.endsWith("zendesk.com")) return "Zendesk";
    return host.replace(/^www\./, "");
  } catch {
    return "Opens in a new tab";
  }
}

/** A catalog form as a link: in-app forms route here, everything else opens a new tab. */
function FormLinkWrap({ form, className, children }: { form: FormLink; className?: string; children: React.ReactNode }) {
  return isInternalForm(form.url) ? (
    <Link to={form.url} className={className}>{children}</Link>
  ) : (
    <a href={form.url} target="_blank" rel="noopener noreferrer" className={className}>{children}</a>
  );
}

function StarButton({ form, favorite, onToggle, className }: { form: FormLink; favorite: boolean; onToggle: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={favorite}
      data-tour="pin"
      aria-label={favorite ? `Unpin ${form.title}` : `Pin ${form.title}`}
      title={favorite ? "Unpin" : "Pin"}
      className={cn("relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-input text-muted hover:bg-subtle hover:text-ink", className)}
    >
      <Pin className={cn("h-[18px] w-[18px]", favorite && "fill-status-amberDot text-status-amberDot")} />
    </button>
  );
}

/**
 * A form as a card: icon, star, title, description, and where it opens. The
 * title is the link and stretches over the whole card; the star sits above it.
 */
function FormCard({ form, category, favorite, onToggleFavorite, showCategory = false }: Entry & { favorite: boolean; onToggleFavorite: () => void; showCategory?: boolean }) {
  const { can } = useAuth();
  const internal = isInternalForm(form.url);
  const locked = !canOpenForm(form.url, can);
  const Icon = formLinkIcon(form, category.icon);
  const title = (
    <>
      {form.title}
      {form.badge && <Tag tone={form.badge.toLowerCase() === "new" ? "accent" : "amber"}>{form.badge}</Tag>}
    </>
  );
  const titleClass = "flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] font-bold leading-snug after:absolute after:inset-0 after:rounded-card";

  return (
    <li
      className={cn(
        "enter-up group relative flex min-h-[172px] flex-col gap-3 rounded-card border border-hairline bg-surface p-4 shadow-card transition-[border-color,box-shadow]",
        !locked && "hover:border-strongline hover:shadow-[0_6px_18px_rgba(35,42,58,0.08)]"
      )}
    >
      <div className="flex items-start justify-between">
        <span className={cn("flex h-11 w-11 items-center justify-center rounded-[11px]", locked ? "bg-subtle text-muted" : "bg-navsel text-accent dark:text-white")}>
          {locked ? <Lock className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
        </span>
        <StarButton form={form} favorite={favorite} onToggle={onToggleFavorite} className="-mr-2 -mt-2" />
      </div>
      <div className="min-w-0">
        {locked ? (
          <span className={cn(titleClass, "text-muted after:hidden")} aria-disabled>{title}</span>
        ) : internal ? (
          <Link to={form.url} className={cn(titleClass, "text-ink")}>{title}</Link>
        ) : (
          <a href={form.url} target="_blank" rel="noopener noreferrer" className={cn(titleClass, "text-ink")}>{title}</a>
        )}
        <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-muted">{locked ? formNeeds(form.url)?.hint : form.description}</p>
      </div>
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-hairline pt-2.5 text-[12.5px] font-semibold">
        {locked ? (
          <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-muted"><Lock className="h-3.5 w-3.5" /> Needs access</span>
        ) : internal ? (
          <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-accent dark:text-white">
            Opens here <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-muted">
            {whereLabel(form.url)} <ExternalLink className="h-3.5 w-3.5" aria-label="opens in a new tab" />
          </span>
        )}
        {showCategory && <span className="min-w-0 truncate font-medium text-muted">{category.name}</span>}
      </div>
    </li>
  );
}

function NoMatch({ searching, favorites }: { searching: boolean; favorites: boolean }) {
  return (
    <div className="enter-up rounded-card border border-dashed border-strongline bg-surface px-6 py-10 text-center">
      <p className="text-[15px] font-bold text-ink">{searching ? "No forms match that" : favorites ? "Nothing pinned yet" : "Nothing here"}</p>
      <p className="mt-1 text-[13px] text-muted">
        {searching ? "Try another word, or ask the help desk if a form is missing." : "Tap the star on any form to keep it here."}
      </p>
    </div>
  );
}

const sectionId = (id: string) => `forms-${id}`;

/**
 * Tablet and desktop. Nothing picked: pinned forms, then a card per category
 * with its forms listed inside. Opening one (?category=<id>, so it can be
 * linked to and Back works) shows its forms as full cards with their
 * descriptions. Typing in the filter narrows every card at once.
 */
function CategorySections({ c }: { c: CatalogBrowser }) {
  const { q, setQ, pick, setPick, searching, categories, favorites, favoriteForms, cardProps } = c;
  const shown = useMemo(() => filterCatalog(categories, q, null, favorites), [categories, q, favorites]);
  const grid = "grid gap-3 lg:grid-cols-2 xl:grid-cols-3 xl:gap-3.5";

  const heading = (id: string, label: React.ReactNode, n: number) => (
    <div className="mb-3 flex items-baseline gap-2.5">
      <h2 id={`${sectionId(id)}-title`} className="flex items-center gap-2 text-[17px] font-heading font-extrabold text-ink xl:text-[19px]">{label}</h2>
      <span className="text-[13px] text-muted">{n} {n === 1 ? "form" : "forms"}</span>
    </div>
  );
  const cards = (entries: Entry[], showCategory = false) => (
    <ul className={grid}>
      {entries.map((e) => (
        <FormCard key={e.form.id} {...cardProps(e)} showCategory={showCategory} />
      ))}
    </ul>
  );

  // One category (or Pinned, or every form) open.
  if (pick && !searching) {
    const cat = categories.find((x) => x.id === pick);
    const Icon = cat ? formIcon(cat.icon) : Pin;
    const entries: Entry[] =
      pick === FAVORITES ? favoriteForms : pick === ALL ? categories.flatMap((x) => x.forms.map((form) => ({ form, category: x }))) : (cat?.forms ?? []).map((form) => ({ form, category: cat! }));
    const title = pick === FAVORITES ? "Pinned" : pick === ALL ? "All forms" : cat?.name ?? "";
    return (
      <div className="py-4">
        <button
          type="button"
          onClick={() => {
            setQ("");
            setPick(null);
          }}
          className="enter-up -ml-2 mb-2 inline-flex min-h-[40px] items-center gap-1 rounded-input px-2 text-[13.5px] font-bold text-accent hover:bg-rowhover dark:text-white"
        >
          <ChevronLeft className="h-[18px] w-[18px]" /> All categories
        </button>
        <section aria-labelledby={`${sectionId(pick)}-title`} className="enter-up">
          {heading(pick, <><Icon className={cn("h-[18px] w-[18px]", pick === FAVORITES ? "fill-status-amberDot text-status-amberDot" : "text-muted")} /> {title}</>, entries.length)}
          {entries.length === 0 ? <NoMatch searching={false} favorites={pick === FAVORITES} /> : cards(entries, pick === FAVORITES || pick === ALL)}
        </section>
      </div>
    );
  }

  // Nothing picked, or filtering: pinned forms in a row, then a card per
  // category with its forms listed inside (the filter narrows the rows, and a
  // card with nothing left drops out).
  if (searching && shown.length === 0) return <NoMatch searching favorites={false} />;
  return (
    <div className="flex flex-col gap-6 py-4">
      {!searching && favoriteForms.length > 0 && (
        <section aria-labelledby={`${sectionId(FAVORITES)}-title`} className="enter-up">
          <h2 id={`${sectionId(FAVORITES)}-title`} className="mb-2 flex items-center gap-1.5 text-[14px] font-heading font-extrabold text-ink">
            <Pin className="h-4 w-4 fill-status-amberDot text-status-amberDot" /> Pinned
          </h2>
          <div className="flex flex-wrap gap-2">
            {favoriteForms.map((e) => {
              const Icon = formLinkIcon(e.form, e.category.icon);
              return (
                <FormLinkWrap key={e.form.id} form={e.form} className="flex h-10 items-center gap-2 rounded-pill border border-hairline bg-surface pl-1.5 pr-3.5 text-[13.5px] font-bold text-ink hover:border-strongline hover:bg-rowhover">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-navsel text-accent dark:text-white">
                    <Icon className="h-[15px] w-[15px]" />
                  </span>
                  {e.form.title}
                </FormLinkWrap>
              );
            })}
          </div>
        </section>
      )}
      {/* Cards in a row share a height (stretch), so the grid stays even however many forms each holds. */}
      <ul className="grid gap-3.5 lg:grid-cols-2 xl:grid-cols-3 xl:gap-4">
        {shown.map((cat) => (
          <li key={cat.id} className="flex">
            <CategoryCard category={cat} favorites={favorites} onToggleFavorite={(f) => cardProps({ form: f, category: cat }).onToggleFavorite()} limit={searching ? null : CARD_ROWS} onOpen={() => setPick(cat.id)} />
          </li>
        ))}
      </ul>
      {!searching && (
        <button type="button" onClick={() => setPick(ALL)} className="enter-up self-start text-[13px] font-semibold text-accent hover:underline dark:text-white">
          See every form with its description
        </button>
      )}
    </div>
  );
}

/** Forms listed in a category card; past this it offers "View more". */
const CARD_ROWS = 5;

/**
 * A category as a card: its icon, name and description, and its forms as
 * rows to open in one click (each with its pin). The name, and "View more"
 * when there are more than fit, open the category's full page.
 */
function CategoryCard({ category, favorites, onToggleFavorite, limit, onOpen }: {
  category: FormCategory;
  favorites: Set<string>;
  onToggleFavorite: (form: FormLink) => void;
  /** Rows to show; null = every one (while filtering). */
  limit: number | null;
  onOpen: () => void;
}) {
  const { can } = useAuth();
  const Icon = formIcon(category.icon);
  const n = category.forms.length;
  const rows = limit === null ? category.forms : category.forms.slice(0, limit);
  return (
    <section aria-labelledby={`${sectionId(category.id)}-title`} className="enter-up flex w-full flex-col rounded-card border border-hairline bg-surface shadow-card">
      <button type="button" onClick={onOpen} className="group flex items-start gap-3 rounded-t-card border-b border-hairline px-4 pb-3 pt-4 text-left hover:bg-rowhover">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-navy text-white">
          <Icon className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span id={`${sectionId(category.id)}-title`} className="text-[15px] font-bold leading-snug text-ink">{category.name}</span>
            <span className="text-[12px] text-muted">{n} {n === 1 ? "form" : "forms"}</span>
          </span>
          {/* Always two lines' room, so the headers line up across a row. */}
          <span className="mt-0.5 line-clamp-2 block min-h-[2.75em] text-[12.5px] leading-snug text-muted">{category.description}</span>
        </span>
        <ChevronRight className="mt-2.5 h-4 w-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" aria-hidden />
      </button>
      <ul className="flex-1 py-1">
        {rows.map((form) => {
          const locked = !canOpenForm(form.url, can);
          const internal = isInternalForm(form.url);
          const RowIcon = formLinkIcon(form, category.icon);
          const body = (
            <>
              <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-input", locked ? "bg-subtle text-muted" : "bg-navsel text-accent dark:text-white")}>
                {locked ? <Lock className="h-4 w-4" /> : <RowIcon className="h-4 w-4" />}
              </span>
              <span className={cn("min-w-0 flex-1 truncate text-[13.5px] font-semibold", locked ? "text-muted" : "text-ink")}>
                {form.title}
                {form.badge && <Tag tone={form.badge.toLowerCase() === "new" ? "accent" : "amber"} className="ml-1.5">{form.badge}</Tag>}
              </span>
              {!locked && !internal && <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted" aria-label="opens in a new tab" />}
            </>
          );
          const rowClass = "flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-3";
          return (
            <li key={form.id} className="group/row flex items-center gap-1 pr-2 hover:bg-rowhover">
              {locked ? (
                <div className={rowClass} aria-disabled title={formNeeds(form.url)?.hint}>{body}</div>
              ) : (
                <FormLinkWrap form={form} className={rowClass}>{body}</FormLinkWrap>
              )}
              <StarButton
                form={form}
                favorite={favorites.has(form.id)}
                onToggle={() => onToggleFavorite(form)}
                className={cn("h-8 w-8", !favorites.has(form.id) && "opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100")}
              />
            </li>
          );
        })}
      </ul>
      {limit !== null && n > limit && (
        <button type="button" onClick={onOpen} className="flex items-center justify-between gap-2 rounded-b-card border-t border-hairline px-4 py-2.5 text-left text-[13px] font-semibold text-accent hover:bg-rowhover dark:text-white">
          View {n - limit} more <span className="text-muted">({n} in all)</span>
          <ChevronRight className="ml-auto h-4 w-4" aria-hidden />
        </button>
      )}
    </section>
  );
}

function PhoneFormList({ title, entries, favorites, onBack }: { title: string; entries: Entry[]; favorites: Set<string>; onBack: () => void }) {
  const { can } = useAuth();
  return (
    <section className="flex flex-col gap-2.5">
      <button type="button" onClick={onBack} className="enter-up -ml-2 inline-flex min-h-[44px] items-center gap-1 self-start px-2 text-[14px] font-bold text-accent dark:text-white">
        <ChevronLeft className="h-[18px] w-[18px]" /> All forms
      </button>
      <div className="enter-up flex items-baseline gap-2">
        <h2 className="text-[19px] font-heading font-extrabold text-ink">{title}</h2>
        <span className="text-[13px] text-muted">{entries.length} {entries.length === 1 ? "form" : "forms"}</span>
      </div>
      {entries.length === 0 ? (
        <NoMatch searching={title === "Results"} favorites={title === "Pinned"} />
      ) : (
        <ul className="overflow-hidden rounded-card border border-hairline bg-surface">
          {entries.map(({ form, category }) => {
            const locked = !canOpenForm(form.url, can);
            const internal = isInternalForm(form.url);
            const Icon = formLinkIcon(form, category.icon);
            const body = (
              <>
                <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-input", locked ? "bg-subtle text-muted" : "bg-navsel text-accent dark:text-white")}>
                  {locked ? <Lock className="h-[18px] w-[18px]" /> : <Icon className="h-[18px] w-[18px]" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn("flex flex-wrap items-center gap-1.5 text-[14.5px] font-bold leading-snug", locked ? "text-muted" : "text-ink")}>
                    {form.title}
                    {form.badge && <Tag tone={form.badge.toLowerCase() === "new" ? "accent" : "amber"}>{form.badge}</Tag>}
                    {favorites.has(form.id) && <Pin className="h-3 w-3 fill-status-amberDot text-status-amberDot" aria-label="Pinned" />}
                  </span>
                  <span className="mt-0.5 block text-[12.5px] leading-snug text-muted">{locked ? formNeeds(form.url)?.hint : form.description}</span>
                </span>
                {!locked &&
                  (internal ? (
                    <ChevronRight className="h-4 w-4 shrink-0 text-accent dark:text-white" aria-hidden />
                  ) : (
                    <ExternalLink className="h-4 w-4 shrink-0 text-muted" aria-label="Opens in a new tab" />
                  ))}
              </>
            );
            const rowClass = "flex items-center gap-3 px-3.5 py-3";
            return (
              <li key={form.id} className="enter-up border-b border-hairline last:border-b-0">
                {locked ? (
                  <div className={rowClass} aria-disabled>{body}</div>
                ) : (
                  <FormLinkWrap form={form} className={cn(rowClass, "active:bg-rowhover")}>{body}</FormLinkWrap>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="enter-up flex items-center gap-1.5 text-[12px] text-muted">
        <ExternalLink className="h-3 w-3" /> Opens the old forms site in a new tab
      </p>
    </section>
  );
}
