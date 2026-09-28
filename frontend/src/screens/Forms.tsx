import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ExternalLink, Lock, Star } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import { Tag } from "@/components/ui/badge";
import { Chip } from "@/components/ui/chip";
import { SearchInput } from "@/components/ui/input";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { useAuth } from "@/lib/auth";
import { canOpenForm, formIcon, formLinkIcon, formNeeds, isInternalForm } from "@/lib/formIcons";
import { formsApi, useForms } from "@/lib/queries";
import type { FormCatalog, FormCategory, FormLink } from "@/lib/types";
import { useSearchParam } from "@/lib/useSearchParam";
import { cn, errorMessage } from "@/lib/utils";

/**
 * The home screen: every form Lantern staff fill out, grouped the way the
 * WordPress site groups them. Most cards still open the WordPress form in a new
 * tab; a form rebuilt inside this app (the roster, so far) opens here instead.
 */
export function FormsPage() {
  const { user, can } = useAuth();
  const { data, isLoading, isError } = useForms();
  const [q, setQ] = useState("");
  // In the URL (?category=…) so the collapsed sidebar's category icons can link
  // straight to one group.
  const [asked, setOnly] = useSearchParam("category");
  const toggleFavorite = useFavoriteToggle();
  const searchRef = useRef<HTMLInputElement>(null);
  const first = user?.name.split(" ")[0];

  // "/" jumps to search on a keyboard, the way most search-first pages do.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const categories = data?.categories ?? [];
  const favorites = useMemo(() => new Set(data?.favorites ?? []), [data]);
  // A category that no longer exists (an old link) means "all", not an empty page.
  const only = asked && categories.some((c) => c.id === asked) ? asked : null;
  const shown = useMemo(() => filterCatalog(categories, q, only), [categories, q, only]);
  const favoriteForms = useMemo(() => {
    const byId = new Map(categories.flatMap((c) => c.forms.map((f) => [f.id, { form: f, category: c }] as const)));
    return (data?.favorites ?? []).map((id) => byId.get(id)).filter((x): x is { form: FormLink; category: FormCategory } => Boolean(x));
  }, [categories, data]);
  const searching = q.trim() !== "";
  const total = shown.reduce((n, c) => n + c.forms.length, 0);

  const search = <SearchInput ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search forms" aria-label="Search forms" />;

  const chips = categories.length > 1 && (
    <div className="chiprow -mx-4 flex gap-1.5 px-4 md:mx-0 md:flex-wrap md:px-0">
      <Chip active={only === null} onClick={() => setOnly(null)}>All forms</Chip>
      {categories.map((c) => {
        const Icon = formIcon(c.icon);
        return (
          <Chip key={c.id} active={only === c.id} onClick={() => setOnly(only === c.id ? null : c.id)}>
            <Icon className="h-3.5 w-3.5" /> {c.name}
          </Chip>
        );
      })}
    </div>
  );

  return (
    <div className="flex min-h-full flex-col">
      <PhoneHeader title="Forms" subtitle={first ? `Hi ${first}. Pick a form to get started.` : undefined}>
        <div className="mt-3 flex flex-col gap-2.5">
          {search}
          {chips}
        </div>
      </PhoneHeader>

      <Page className="w-full">
        <div className="hidden md:block">
          <PageHeader
            title="Forms"
            subtitle={first ? `Hi ${first}. Everything you fill out at Lantern, in one place.` : "Everything you fill out at Lantern, in one place."}
            actions={<div className="w-[300px]">{search}</div>}
          />
          <div className="mb-6">{chips}</div>
        </div>

        {isLoading ? (
          <LoadingState />
        ) : isError ? (
          <EmptyState title="The forms didn't load" hint="Check your connection and refresh the page. If it keeps happening, contact the IT Team." />
        ) : categories.length === 0 ? (
          <EmptyState title="No forms yet" hint={can("forms.manage") ? "Add some in Admin → Forms catalog." : "An administrator hasn't set up the forms yet."} />
        ) : (
          <>
            {!searching && only === null && favoriteForms.length > 0 && (
              <Section title="Your favorites" icon={Star}>
                {favoriteForms.map(({ form, category }) => (
                  <FormCard key={form.id} form={form} category={category} favorite onToggleFavorite={() => toggleFavorite(form, true)} />
                ))}
              </Section>
            )}

            {searching && (
              <p className="mb-3 text-[13px] text-muted" aria-live="polite">
                {total === 0 ? "No forms match" : `${total} ${total === 1 ? "form matches" : "forms match"}`} “{q.trim()}”
              </p>
            )}
            {searching && total === 0 && (
              <EmptyState title="Nothing matches that" hint="Try a different word, or clear the search to see every form." />
            )}

            {shown.map((c) => (
              <Section key={c.id} title={c.name} icon={formIcon(c.icon)}>
                {c.forms.map((f) => (
                  <FormCard key={f.id} form={f} category={c} favorite={favorites.has(f.id)} onToggleFavorite={() => toggleFavorite(f, favorites.has(f.id))} />
                ))}
              </Section>
            ))}

            <p className="mt-2 text-center text-micro text-muted">
              Forms marked <ExternalLink className="inline h-3 w-3 align-[-1px]" /> open in a new tab. Most are still on the old forms site while they're rebuilt here.
            </p>
          </>
        )}
      </Page>
    </div>
  );
}

/**
 * Every word typed must appear somewhere in the form's title, description,
 * keywords or its category's name, so "petty report" finds the Petty Cash
 * Report Form and "tenant updater" finds the roster.
 */
function filterCatalog(categories: FormCategory[], q: string, only: string | null): FormCategory[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return categories
    .filter((c) => only === null || c.id === only)
    .map((c) => ({
      ...c,
      forms: words.length
        ? c.forms.filter((f) => {
            const hay = [f.title, f.description, f.keywords, f.badge, c.name].filter(Boolean).join(" ").toLowerCase();
            return words.every((w) => hay.includes(w));
          })
        : c.forms,
    }))
    .filter((c) => c.forms.length > 0);
}

/**
 * Star / unstar, optimistically: the star fills the instant it's tapped and
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
      toast(errorMessage(e, "Couldn't save that favorite."), "error");
    }
  };
}

function FormCard({ form, category, favorite, onToggleFavorite }: {
  form: FormLink;
  category: FormCategory;
  favorite: boolean;
  onToggleFavorite: () => void;
}) {
  const { can } = useAuth();
  const internal = isInternalForm(form.url);
  const locked = !canOpenForm(form.url, can);
  const Icon = formLinkIcon(form, category.icon);

  const body = (
    <>
      <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-input", locked ? "bg-subtle text-muted" : "bg-navsel text-accent dark:text-white")}>
        {locked ? <Lock className="h-[18px] w-[18px]" /> : <Icon className="h-[18px] w-[18px]" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn("text-[14.5px] font-bold leading-snug", locked ? "text-muted" : "text-ink")}>{form.title}</span>
          {form.badge && <Tag>{form.badge}</Tag>}
        </span>
        {locked ? (
          <span className="mt-0.5 block text-[12.5px] leading-snug text-muted">{formNeeds(form.url)?.hint}</span>
        ) : (
          form.description && <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug text-muted">{form.description}</span>
        )}
      </span>
      {!locked && (internal ? (
        <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" aria-hidden />
      ) : (
        <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-label="Opens in a new tab" />
      ))}
    </>
  );

  const linkClass = "flex min-h-[76px] min-w-0 flex-1 items-start gap-3 py-3.5 pl-4 pr-1";

  return (
    <li className={cn("group flex rounded-card border border-hairline bg-surface shadow-card transition-colors", !locked && "hover:border-strongline hover:bg-rowhover")}>
      {locked ? (
        <div className={linkClass} aria-disabled>{body}</div>
      ) : internal ? (
        <Link to={form.url} className={linkClass}>{body}</Link>
      ) : (
        <a href={form.url} target="_blank" rel="noopener noreferrer" className={linkClass}>{body}</a>
      )}
      <button
        type="button"
        onClick={onToggleFavorite}
        aria-pressed={favorite}
        aria-label={favorite ? `Remove ${form.title} from favorites` : `Add ${form.title} to favorites`}
        title={favorite ? "Remove from favorites" : "Add to favorites"}
        className="flex w-11 shrink-0 items-start justify-center pt-3.5 text-muted hover:text-ink"
      >
        <Star className={cn("h-[18px] w-[18px]", favorite && "fill-status-amberDot text-status-amberDot")} />
      </button>
    </li>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon: typeof Star; children: React.ReactNode }) {
  return (
    <section className="page-list-item-enter mb-6">
      <h2 className="mb-2.5 flex items-center gap-2 text-[15px] font-heading font-extrabold text-ink">
        <Icon className="h-4 w-4 text-muted" /> {title}
      </h2>
      <ul className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">{children}</ul>
    </section>
  );
}
