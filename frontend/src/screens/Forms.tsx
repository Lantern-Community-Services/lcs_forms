import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, LayoutGrid, Lock, PencilLine, Pin, Users } from "lucide-react";
import { Page } from "@/components/shell/AppShell";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import { Tag } from "@/components/ui/badge";
import { SearchInput } from "@/components/ui/input";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { useAuth } from "@/lib/auth";
import { canOpenForm, formIcon, formLinkIcon, formNeeds, isInternalForm } from "@/lib/formIcons";
import { formsApi, useForms, useHome } from "@/lib/queries";
import type { FormCatalog, FormCategory, FormLink, HomeActivityItem, HomeAttentionItem, HomeData } from "@/lib/types";
import { useSearchParam } from "@/lib/useSearchParam";
import { cn, errorMessage } from "@/lib/utils";

/**
 * The home screen: a dashboard on top (what needs you, what happened lately)
 * and every form Lantern staff fill out underneath.
 *
 * Two layouts, one set of state:
 * - tablet and desktop: attention beside activity (desktop adds a row of
 *   counts above), then a two-pane browser: groups down the left (All forms,
 *   Pinned, each category), that group's cards on the right;
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
  const home = useHome();
  const [q, setQ] = useState("");
  const [askedRaw, setPick] = useSearchParam("category");
  // "favorites" was this group's name before it became Pinned; old links still land on it.
  const asked = askedRaw === "favorites" ? FAVORITES : askedRaw;
  const toggleFavorite = useFavoriteToggle();
  const searchRef = useRef<HTMLInputElement>(null);
  const phoneSearchRef = useRef<HTMLInputElement>(null);
  const first = user?.name.split(" ")[0];

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

  return (
    <div className="flex min-h-full flex-col">
      {/* ── Phone ─────────────────────────────────────────────────────── */}
      <PhoneHeader title={greeting} subtitle={today} enter>
        <div className="enter-up mt-3">
          <SearchInput ref={phoneSearchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all forms" aria-label="Search forms" />
        </div>
      </PhoneHeader>

      <div className="flex flex-col gap-4 px-4 py-4 md:hidden">
        <PhoneAttention home={home.data} />
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
              <section>
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
        <div className="enter-up mb-5 flex flex-wrap items-center justify-between gap-4 xl:mb-6">
          <div className="min-w-0">
            <h1 className="text-[23px] font-heading font-extrabold text-ink xl:text-[26px]">{greeting}</h1>
            <p className="mt-1 text-[13.5px] text-muted">{subtitle}</p>
          </div>
          <div className="w-[300px] xl:w-[380px]">
            <SearchInput ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all forms" aria-label="Search forms" />
          </div>
        </div>

        <StatStrip home={home.data} totalForms={totalForms} />

        <div className="mb-7 grid gap-3.5 md:grid-cols-2 xl:grid-cols-[7fr_5fr] xl:gap-5">
          <AttentionPanel home={home.data} loading={home.isLoading} failed={home.isError} />
          <ActivityPanel home={home.data} loading={home.isLoading} failed={home.isError} limit={3} wideLimit={6} />
        </div>

        <section id="forms" aria-labelledby="all-forms">
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
  const key = ["forms", "visible"];

  return async (form: FormLink, isFavorite: boolean) => {
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
function FormsBrowser({ categories, pick, onPick, favoriteCount, totalForms, entries, searching, q, cardProps }: {
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
              <ul className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3 xl:gap-3.5">
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

// ── Dashboard panels ─────────────────────────────────────────────────────

const ATTENTION_ICON = { roster: Users, hotfoods: AlertTriangle, draft: PencilLine } as const;

function AttentionIcon({ item, size = "md" }: { item: HomeAttentionItem; size?: "sm" | "md" }) {
  const Icon = ATTENTION_ICON[item.kind] ?? AlertTriangle;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center",
        size === "md" ? "h-10 w-10 rounded-[10px]" : "h-[34px] w-[34px] rounded-[9px]",
        item.tone === "warn" ? "bg-status-amberBg text-status-amberText" : "bg-navsel text-accent dark:text-white"
      )}
    >
      <Icon className={size === "md" ? "h-[19px] w-[19px]" : "h-[17px] w-[17px]"} />
    </span>
  );
}

function PanelHeader({ title, count, children }: { title: string; count?: number; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-[52px] items-center justify-between gap-3 border-b border-hairline px-4 py-2.5 xl:px-5">
      <h2 className="flex items-center gap-2 text-[15px] font-heading font-extrabold text-ink xl:text-[16px]">
        {title}
        {count !== undefined && count > 0 && <span className="rounded-pill bg-navy px-2 py-px text-[11.5px] font-bold text-white">{count}</span>}
      </h2>
      {children}
    </div>
  );
}

function PanelNote({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-6 text-center text-[13px] text-muted xl:px-5">{children}</p>;
}

function AttentionPanel({ home, loading, failed }: { home?: HomeData; loading: boolean; failed: boolean }) {
  const items = home?.attention ?? [];
  return (
    <section id="attention" className="enter-up flex min-w-0 flex-col rounded-card border border-hairline bg-surface shadow-card">
      <PanelHeader title="Needs your attention" count={items.length} />
      {loading ? (
        <PanelNote>Checking…</PanelNote>
      ) : failed ? (
        <PanelNote>This didn't load. Refresh the page to try again.</PanelNote>
      ) : items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-5 py-7 text-center">
          <CheckCircle2 className="h-6 w-6 text-status-greenDot" />
          <p className="text-[14px] font-bold text-ink">You're all caught up</p>
          <p className="text-[12.5px] text-muted">Anything that needs you will show up here.</p>
        </div>
      ) : (
        <ul>
          {items.map((a, i) => (
            <li key={a.id} className={cn("border-b border-hairline/70 last:border-b-0", i >= 3 && "hidden xl:block")}>
              {/* Tablet: the whole row is the link. Desktop: a row with its own button. */}
              <Link to={a.href} className="flex items-center gap-3 px-4 py-2.5 hover:bg-rowhover xl:hidden">
                <AttentionIcon item={a} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-bold text-ink">{a.title}</span>
                  <span className="block truncate text-[12px] text-muted">{a.detail}</span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              </Link>
              <div className="hidden items-center gap-3.5 px-5 py-4 xl:flex">
                <AttentionIcon item={a} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14.5px] font-bold text-ink">{a.title}</span>
                  <span className="mt-0.5 block text-[13px] text-muted">{a.detail}</span>
                </span>
                <Link
                  to={a.href}
                  className={cn(
                    "inline-flex h-9 shrink-0 items-center rounded-input px-4 text-[13px] font-bold",
                    i === 0 ? "bg-navy text-white hover:bg-navy-700" : "bg-subtle text-accent hover:bg-subtle2 dark:text-white"
                  )}
                >
                  {a.action}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function dayLabel(d: Date) {
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(new Date()) - start(d)) / 86400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("") || "?";
}

function ActivityPanel({ home, loading, failed, limit, wideLimit, className }: {
  home?: HomeData;
  loading: boolean;
  failed: boolean;
  /** Rows shown below xl. */
  limit: number;
  /** Rows shown at xl and up (defaults to `limit`). */
  wideLimit?: number;
  className?: string;
}) {
  const [justMe, setJustMe] = useState(false);
  const all = home?.activity ?? [];
  // Without roster access everything listed is already yours, so the toggle would do nothing.
  const canFilter = Boolean(home?.stats.sites?.length) && all.some((a) => !a.mine);
  const items = (justMe ? all.filter((a) => a.mine) : all).slice(0, Math.max(limit, wideLimit ?? limit));

  let lastDay = "";
  return (
    <section className={cn("enter-up flex min-w-0 flex-col rounded-card border border-hairline bg-surface shadow-card", className)}>
      <PanelHeader title="Recent activity">
        {canFilter && (
          <div className="flex rounded-input bg-subtle p-[3px]" role="group" aria-label="Whose activity">
            {[false, true].map((mine) => (
              <button
                key={String(mine)}
                type="button"
                aria-pressed={justMe === mine}
                onClick={() => setJustMe(mine)}
                className={cn(
                  "h-8 rounded-[5px] px-3 text-[12.5px]",
                  justMe === mine ? "bg-surface font-bold text-ink shadow-card" : "font-semibold text-muted hover:text-ink"
                )}
              >
                {mine ? "Just me" : "My sites"}
              </button>
            ))}
          </div>
        )}
      </PanelHeader>
      {loading ? (
        <PanelNote>Loading…</PanelNote>
      ) : failed ? (
        <PanelNote>This didn't load. Refresh the page to try again.</PanelNote>
      ) : items.length === 0 ? (
        <PanelNote>Nothing yet. Forms you submit will show up here.</PanelNote>
      ) : (
        <ul className="py-1">
          {items.map((a, i) => {
            const at = new Date(a.at);
            const day = dayLabel(at);
            const showDay = day !== lastDay;
            lastDay = day;
            const wideOnly = i >= limit;
            return (
              <li key={a.id} className={cn(wideOnly && "hidden xl:block")}>
                {showDay && <p className="px-4 pb-1 pt-2.5 text-micro font-bold uppercase tracking-[0.08em] text-muted xl:px-5">{day}</p>}
                <ActivityRow item={a} at={at} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ActivityRow({ item, at }: { item: HomeActivityItem; at: Date }) {
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const body = (
    <>
      <span
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
          item.mine ? "bg-navy text-white" : "bg-navsel text-accent dark:text-white"
        )}
        aria-hidden
      >
        {initials(item.actorName)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] text-ink">
          {item.verb} <b className="font-bold">{item.subject}</b>
        </span>
        <span className="block truncate text-[12px] text-muted">{[item.detail, time].filter(Boolean).join(" · ")}</span>
      </span>
    </>
  );
  const cls = "flex items-center gap-3 px-4 py-2 xl:px-5";
  return item.href ? (
    <Link to={item.href} className={cn(cls, "hover:bg-rowhover")}>{body}</Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function StatStrip({ home, totalForms }: { home?: HomeData; totalForms: number }) {
  const s = home?.stats;
  const tiles: { label: string; value: string; note: React.ReactNode; href?: string }[] = [
    {
      label: "Needs your attention",
      value: s ? String(s.attention) : "–",
      note: s && s.urgent > 0 ? <Tag className="text-[12px]">{s.urgent} urgent</Tag> : "items",
      href: "#attention",
    },
    { label: "Your submissions", value: s ? String(s.submissionsWeek) : "–", note: "last 7 days" },
    s?.residents !== null && s?.residents !== undefined
      ? { label: "Residents at your sites", value: String(s.residents), note: `across ${s.sites?.length ?? 0} ${s.sites?.length === 1 ? "site" : "sites"}`, href: "/roster" }
      : { label: "Forms you can open", value: String(totalForms), note: "in the catalog", href: "#forms" },
  ];
  return (
    <div className="mb-5 hidden grid-cols-3 gap-4 xl:grid">
      {tiles.map((t) => {
        const body = (
          <>
            <span className="text-[13px] font-semibold text-muted">{t.label}</span>
            <span className="flex items-baseline gap-2.5">
              <span className="text-[28px] font-heading font-extrabold leading-tight text-ink">{t.value}</span>
              <span className="text-[13px] text-muted">{t.note}</span>
            </span>
          </>
        );
        const cls = "enter-up flex flex-col gap-1 rounded-card border border-hairline bg-surface px-5 py-4 shadow-card";
        return t.href?.startsWith("/") ? (
          <Link key={t.label} to={t.href} className={cn(cls, "hover:border-strongline")}>{body}</Link>
        ) : t.href ? (
          <a key={t.label} href={t.href} className={cn(cls, "hover:border-strongline")}>{body}</a>
        ) : (
          <div key={t.label} className={cls}>{body}</div>
        );
      })}
    </div>
  );
}

/** Phone: the attention list folded into one banner that opens in place. */
function PhoneAttention({ home }: { home?: HomeData }) {
  const [open, setOpen] = useState(false);
  const items = home?.attention ?? [];
  if (!items.length) return null;
  const warn = items.some((a) => a.tone === "warn");
  return (
    <section className={cn("enter-up overflow-hidden rounded-card border bg-surface", warn ? "border-status-amberDot/50" : "border-hairline")}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-3 px-3.5 py-3 text-left">
        <AttentionIcon item={items[0]} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block text-[14.5px] font-bold text-ink">
            {items.length === 1 ? "1 thing needs your attention" : `${items.length} things need your attention`}
          </span>
          <span className="block truncate text-[12.5px] text-muted">
            {items[0].title}
            {items.length > 1 ? `, and ${items.length - 1} more` : ""}
          </span>
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <ul className="border-t border-hairline">
          {items.map((a) => (
            <li key={a.id} className="border-b border-hairline/70 last:border-b-0">
              <Link to={a.href} className="flex items-center gap-3 px-3.5 py-3 active:bg-rowhover">
                <AttentionIcon item={a} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-bold text-ink">{a.title}</span>
                  <span className="block text-[12.5px] text-muted">{a.detail}</span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
