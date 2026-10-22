import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ChevronLeft, ChevronRight, ExternalLink, LayoutGrid, Lock, Pin } from "lucide-react";
import { HomeDashboard } from "@/components/home/dashboard/HomeDashboard";
import type { WidgetSize } from "@/components/home/dashboard/layout";
import { ActivityPanel, AppTiles, PhoneAttention } from "@/components/home/panels";
import { Page } from "@/components/shell/AppShell";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import { Tag } from "@/components/ui/badge";
import { SearchInput } from "@/components/ui/input";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { useAuth } from "@/lib/auth";
import { canOpenForm, formIcon, formLinkIcon, formNeeds, isInternalForm } from "@/lib/formIcons";
import { formsApi, sampleKey, useForms, useHome, useHomeApps } from "@/lib/queries";
import { isSample } from "@/lib/tour/sampleData";
import { useTourSample } from "@/lib/tour/store";
import type { FormCatalog, FormCategory, FormLink, HomeData } from "@/lib/types";
import { useSearchParam } from "@/lib/useSearchParam";
import { cn, errorMessage } from "@/lib/utils";

/**
 * The home screen: a dashboard on top (what needs you, what happened lately)
 * and every form Lantern staff fill out underneath.
 *
 * Two layouts, one set of state:
 * - tablet and desktop: the person's own dashboard of widgets (see
 *   components/home/dashboard). One of them, near the top by default, is All forms: a
 *   two-pane browser with groups down the left (All forms, Pinned, each
 *   category) and that group's cards on the right;
 * - phone: one attention banner, pinned forms, and category tiles that open a
 *   list, so the forms are reachable without scrolling past the dashboard.
 *
 * The chosen group lives in the URL (?category=<id>, "pinned" or "all") so
 * the sidebar can link straight to one.
 */
const FAVORITES = "pinned";
const ALL = "all";

/** A category id, FAVORITES, ALL, or null = nothing picked yet. */
type Selection = string | null;

export function FormsPage() {
  const { user, can } = useAuth();
  const { data, isLoading, isError } = useForms();
  const homeOnly = useHome();
  const homeApps = useHomeApps();
  // Code forms' attention items join the list; their tiles get a row of their own.
  const home = useMemo(() => {
    if (!homeOnly.data || !homeApps.data?.attention.length) return homeOnly;
    const attention = [...homeOnly.data.attention, ...homeApps.data.attention];
    const data: HomeData = { ...homeOnly.data, attention, stats: { ...homeOnly.data.stats, attention: attention.length, urgent: attention.filter((a) => a.tone === "warn").length } };
    return { ...homeOnly, data };
  }, [homeOnly, homeApps.data]);
  const appTiles = homeApps.data?.tiles ?? [];
  const [q, setQ] = useState("");
  const [askedRaw, setPick] = useSearchParam("category");
  // "favorites" was this group's name before it became Pinned; old links still land on it.
  const asked = askedRaw === "favorites" ? FAVORITES : askedRaw;
  const toggleFavorite = useFavoriteToggle();
  const searchRef = useRef<HTMLInputElement>(null);
  const phoneSearchRef = useRef<HTMLInputElement>(null);
  const first = user?.name.split(" ")[0];

  // The welcome tour has its search typed in here; its sample forms leave with it, and so does the search.
  const sample = useTourSample();
  useEffect(() => {
    if (!sample) setQ("");
  }, [sample]);

  // "/" jumps to whichever search box is on screen.
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

  const categories = useMemo(() => data?.categories ?? [], [data]);
  const favorites = useMemo(() => new Set(data?.favorites ?? []), [data]);
  // A category that no longer exists (an old link) means "nothing picked", not an empty page.
  const pick: Selection = asked === FAVORITES || asked === ALL || (asked && categories.some((c) => c.id === asked)) ? asked : null;
  // Tablet and desktop always show something in the browser's right pane.
  const browsePick = pick ?? (favorites.size ? FAVORITES : ALL);
  const searching = q.trim() !== "";
  const totalForms = categories.reduce((n, c) => n + c.forms.length, 0);

  const favoriteForms = useMemo(() => {
    const byId = new Map(categories.flatMap((c) => c.forms.map((f) => [f.id, { form: f, category: c }] as const)));
    return (data?.favorites ?? []).map((id) => byId.get(id)).filter((x): x is Entry => Boolean(x));
  }, [categories, data]);

  /** Everything matching the search (and, when one is picked, the category or favorites). */
  const matching = useMemo(() => filterCatalog(categories, q, pick, favorites), [categories, q, pick, favorites]);
  const matchingFlat = useMemo(() => matching.flatMap((c) => c.forms.map((form) => ({ form, category: c }))), [matching]);
  const searchResults = useMemo(
    () => (searching ? filterCatalog(categories, q, null, favorites).flatMap((c) => c.forms.map((form) => ({ form, category: c }))) : []),
    [categories, q, searching, favorites]
  );

  const star = (form: FormLink) => toggleFavorite(form, favorites.has(form.id));
  const cardProps = (e: Entry) => ({ form: e.form, category: e.category, favorite: favorites.has(e.form.id), onToggleFavorite: () => star(e.form) });

  const greeting = `${greetingWord()}${first ? `, ${first}` : ""}`;
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const sites = home.data?.stats.sites;
  const subtitle = [today, sites && sites.length > 0 && sites.length <= 3 ? sites.join(", ") : sites && sites.length > 3 ? `${sites.length} sites` : null]
    .filter(Boolean)
    .join(" · ");

  const formsBody = isLoading ? (
    <LoadingState />
  ) : isError ? (
    <EmptyState title="The forms didn't load" hint="Check your connection and refresh the page. If it keeps happening, contact the IT Team." />
  ) : categories.length === 0 ? (
    <EmptyState title="No forms yet" hint={can("forms.manage") ? "Add some in Admin → Forms catalog." : "An administrator hasn't set up the forms yet."} />
  ) : null;

  /** The "All forms" widget: every form, groups down the left (see FormsBrowser). */
  const renderForms = (size: WidgetSize) => (
    <section id="forms" aria-labelledby="all-forms" data-tour="home-forms">
      <div className="enter-up mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="all-forms" className="text-[18px] font-heading font-extrabold text-ink xl:text-[21px]">All forms</h2>
          <p className="mt-0.5 text-[13px] text-muted" aria-live="polite">
            {searching
              ? `${searchResults.length === 0 ? "No forms match" : `${searchResults.length} of ${totalForms} forms match`} “${q.trim()}”`
              : `${totalForms} forms · pin one to keep it close at hand`}
          </p>
        </div>
      </div>

      {formsBody ?? (
        // Groups on the left, that group's cards on the right. Nothing
        // picked yet: Favorites when there are some, otherwise everything.
        <FormsBrowser
          size={size}
          categories={categories}
          pick={browsePick}
          onPick={setPick}
          favoriteCount={favorites.size}
          totalForms={totalForms}
          entries={searching ? searchResults : matchingFlatFor(categories, browsePick, favorites)}
          searching={searching}
          q={q.trim()}
          cardProps={cardProps}
        />
      )}
    </section>
  );

  return (
    <div className="flex min-h-full flex-col">
      {/* ── Phone ─────────────────────────────────────────────────────── */}
      <PhoneHeader title={greeting} subtitle={today} enter>
        <div data-tour="home-search" className="enter-up mt-3">
          <SearchInput ref={phoneSearchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all forms" aria-label="Search forms" />
        </div>
      </PhoneHeader>

      <div className="flex flex-col gap-4 px-4 py-4 md:hidden">
        <PhoneAttention home={home.data} />
        <AppTiles tiles={appTiles} />
        {formsBody ?? (
          searching || pick ? (
            <PhoneFormList
              title={searching ? "Results" : pick === FAVORITES ? "Pinned" : pick === ALL ? "All forms" : categories.find((c) => c.id === pick)?.name ?? ""}
              entries={searching ? searchResults : matchingFlat}
              favorites={favorites}
              onBack={() => {
                setQ("");
                setPick(null);
              }}
            />
          ) : (
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
                  {categories.map((c) => {
                    const Icon = formIcon(c.icon);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setPick(c.id)}
                        className="enter-up flex min-h-[96px] flex-col items-start gap-2.5 rounded-card border border-hairline bg-surface p-3 text-left active:bg-rowhover"
                      >
                        <span className="flex h-9 w-9 items-center justify-center rounded-input bg-navy text-white">
                          <Icon className="h-[18px] w-[18px]" />
                        </span>
                        <span>
                          <span className="block text-[14px] font-bold leading-snug text-ink">{c.name}</span>
                          <span className="block text-[12px] text-muted">{c.forms.length} {c.forms.length === 1 ? "form" : "forms"}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
              <ActivityPanel home={home.data} loading={home.isLoading} failed={home.isError} limit={4} className="mt-1" />
            </>
          )
        )}
      </div>

      {/* ── Tablet and desktop ────────────────────────────────────────── */}
      <Page className="hidden w-full md:block">
        {/* The person's own dashboard: which widgets, in what order, how wide (see HomeDashboard). */}
        <HomeDashboard
          heading={
            <>
              <h1 className="text-[23px] font-heading font-extrabold text-ink xl:text-[26px]">{greeting}</h1>
              <p className="mt-1 text-[13.5px] text-muted">{subtitle}</p>
            </>
          }
          search={
            <div data-tour="home-search" className="w-[300px] xl:w-[380px]">
              <SearchInput ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all forms" aria-label="Search forms" />
            </div>
          }
          ctx={{ home: home.data, homeLoading: home.isLoading, homeFailed: home.isError, appTiles, appTilesLoading: homeApps.isLoading, categories, favoriteForms, totalForms, renderForms, searching }}
        />
      </Page>
    </div>
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

function matchingFlatFor(categories: FormCategory[], pick: Selection, favorites: Set<string>): Entry[] {
  return filterCatalog(categories, "", pick, favorites).flatMap((c) => c.forms.map((form) => ({ form, category: c })));
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

/**
 * Tablet and desktop: the groups down the left (All forms, Pinned, then each
 * category), that group's cards on the right. Searching replaces the right
 * pane with matches from every group.
 */
function FormsBrowser({ size, categories, pick, onPick, favoriteCount, totalForms, entries, searching, q, cardProps }: {
  /** The widget's width: two thirds of a desktop row fits two columns of cards, the whole row three. */
  size: WidgetSize;
  categories: FormCategory[];
  pick: string;
  onPick: (id: string | null) => void;
  favoriteCount: number;
  totalForms: number;
  entries: Entry[];
  searching: boolean;
  q: string;
  cardProps: (e: Entry) => Entry & { favorite: boolean; onToggleFavorite: () => void };
}) {
  const current = categories.find((c) => c.id === pick);
  const title = searching ? `Results for “${q}”` : pick === FAVORITES ? "Pinned" : pick === ALL ? "All forms" : current?.name ?? "";
  // Mixed groups: say which group each card is from.
  const mixed = searching || pick === ALL || pick === FAVORITES;
  const item = (id: string, label: string, Icon: typeof Pin, n: number) => {
    const on = !searching && pick === id;
    return (
      <button
        key={id}
        type="button"
        onClick={() => onPick(id)}
        aria-pressed={on}
        className={cn(
          "enter-up flex min-h-[46px] items-center gap-2.5 rounded-input px-2.5 text-left text-[13.5px]",
          on ? "bg-navy font-bold text-white" : "font-semibold text-ink hover:bg-rowhover"
        )}
      >
        <Icon className={cn("h-[17px] w-[17px] shrink-0", on ? "text-white" : "text-muted")} />
        <span className="min-w-0 flex-1 leading-snug">{label}</span>
        <span className={cn("text-[12px]", on ? "text-white/75" : "text-muted")}>{n}</span>
      </button>
    );
  };

  return (
    // The frame is as tall as the group list needs, so every group is in view;
    // the forms scroll inside their own pane beside it (absolutely placed, so a
    // long list can't stretch the frame).
    <div className="enter-up flex min-h-[420px] overflow-hidden rounded-[14px] border border-hairline bg-surface">
      <nav aria-label="Form groups" className="flex w-[212px] shrink-0 flex-col gap-0.5 border-r border-hairline bg-sidebar p-2 xl:w-[250px] xl:p-2.5">
        {item(ALL, "All forms", LayoutGrid, totalForms)}
        {item(FAVORITES, "Pinned", Pin, favoriteCount)}
        {categories.map((c) => item(c.id, c.name, formIcon(c.icon), c.forms.length))}
      </nav>
      <div className="relative min-w-0 flex-1">
        <div className="absolute inset-0 flex flex-col px-4 pt-4 xl:px-6 xl:pt-5">
          <div className="enter-up mb-3 flex flex-none items-baseline gap-2.5 xl:mb-4">
            <h3 className="text-[16px] font-heading font-extrabold text-ink xl:text-[19px]">{title}</h3>
            <span className="text-[13px] text-muted">{entries.length} {entries.length === 1 ? "form" : "forms"}</span>
          </div>
          {/* Keyed by group so picking another one starts the list back at the top
              and replays the arrival; typing in the search keeps the list, and
              only the matches that are new animate. */}
          <div key={searching ? "search" : pick} className="-mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-4 scroll-thin xl:pb-5">
            {entries.length === 0 ? (
              <NoMatch searching={searching} favorites={pick === FAVORITES} />
            ) : (
              <ul className={cn("grid gap-3 lg:grid-cols-2 xl:gap-3.5", size === "full" && "xl:grid-cols-3")}>
                {entries.map((e) => (
                  <FormCard key={e.form.id} {...cardProps(e)} showCategory={mixed} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
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
