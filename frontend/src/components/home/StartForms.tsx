import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, ExternalLink, LayoutGrid } from "lucide-react";
import { AttentionIcon } from "@/components/home/panels";
import { useAuth } from "@/lib/auth";
import { canOpenForm, formIcon, formLinkIcon, isInternalForm } from "@/lib/formIcons";
import type { FormCategory, FormLink, HomeData, HomeRecentForm } from "@/lib/types";
import { cn } from "@/lib/utils";

type Entry = { form: FormLink; category: FormCategory };

export interface StartItem {
  key: string;
  title: string;
  url: string;
  icon: ReturnType<typeof formIcon>;
  /** "Pinned", or when it was last used. */
  meta: string;
}

/**
 * The forms someone is most likely to start next: their pinned forms first, then
 * the ones they've used lately (that aren't pinned), then the forms suggested for
 * their groups, role and sites (Home's shortcuts), up to `limit`.
 */
export function useStartForms(favorites: Entry[], recent: HomeRecentForm[] | undefined, categories: FormCategory[], limit: number, suggested?: string[]): StartItem[] {
  const { can } = useAuth();
  const items: StartItem[] = [];
  const seen = new Set<string>();
  for (const { form, category } of favorites) {
    if (items.length >= limit || seen.has(form.url) || !canOpenForm(form.url, can)) continue;
    seen.add(form.url);
    items.push({ key: form.id, title: form.title, url: form.url, icon: formLinkIcon(form, category.icon), meta: "Pinned" });
  }
  const byUrl = new Map(categories.flatMap((c) => c.forms.map((f) => [f.url, { f, c }] as const)));
  for (const r of recent ?? []) {
    if (items.length >= limit || seen.has(r.href)) continue;
    seen.add(r.href);
    const card = byUrl.get(r.href);
    items.push({ key: r.id, title: card?.f.title ?? r.title, url: r.href, icon: card ? formLinkIcon(card.f, card.c.icon) : formIcon("clipboard"), meta: usedWhen(r.lastAt) });
  }
  const byId = new Map(categories.flatMap((c) => c.forms.map((f) => [f.id, { f, c }] as const)));
  for (const id of suggested ?? []) {
    const card = byId.get(id);
    if (items.length >= limit || !card || seen.has(card.f.url) || !canOpenForm(card.f.url, can)) continue;
    seen.add(card.f.url);
    items.push({ key: card.f.id, title: card.f.title, url: card.f.url, icon: formLinkIcon(card.f, card.c.icon), meta: card.c.name });
  }
  return items;
}

function usedWhen(iso: string) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? "Used today" : days === 1 ? "Used yesterday" : days < 7 ? `Used ${days} days ago` : "Used lately";
}

function FormLinkWrap({ url, className, children }: { url: string; className?: string; children: React.ReactNode }) {
  return isInternalForm(url) ? (
    <Link to={url} className={className}>{children}</Link>
  ) : (
    <a href={url} target="_blank" rel="noopener noreferrer" className={className}>{children}</a>
  );
}

/**
 * "Start a form": big tiles for the forms above, then a tile for the full list.
 * With nothing pinned or used yet, it says how to get them here.
 */
export function StartFormTiles({ items, allFormsCount, columns = "grid-cols-2", className }: {
  items: StartItem[];
  allFormsCount: number;
  columns?: string;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-3", columns, className)}>
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <FormLinkWrap
            key={it.key}
            url={it.url}
            className="enter-up flex min-h-[96px] min-w-0 flex-col justify-between gap-3 rounded-card border border-hairline bg-surface p-3.5 shadow-card hover:border-strongline"
          >
            <span className="flex items-start justify-between gap-2">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-navsel text-accent dark:text-white">
                <Icon className="h-5 w-5" aria-hidden />
              </span>
              {!isInternalForm(it.url) && <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted" aria-label="opens in a new tab" />}
            </span>
            <span className="min-w-0">
              <span className="line-clamp-2 block text-body-lg font-bold leading-snug text-ink">{it.title}</span>
              <span className="block truncate text-caption text-muted">{it.meta}</span>
            </span>
          </FormLinkWrap>
        );
      })}
      {items.length ? (
        <Link
          to="/forms"
          className="enter-up flex min-h-[96px] min-w-0 flex-col justify-between gap-3 rounded-card border border-dashed border-strongline p-3.5 hover:bg-rowhover"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-subtle text-accent dark:text-white">
            <LayoutGrid className="h-5 w-5" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block text-body-lg font-bold leading-snug text-ink">All {allFormsCount} forms</span>
            <span className="block truncate text-caption text-muted">By category</span>
          </span>
        </Link>
      ) : (
        // Nothing pinned, used or suggested yet: one full-width card that says how forms get here.
        <Link to="/forms" className="enter-up col-span-full flex min-h-[72px] min-w-0 items-center gap-3 rounded-card border border-hairline bg-subtle/60 px-3.5 py-3 hover:bg-rowhover">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-subtle text-accent dark:text-white">
            <LayoutGrid className="h-5 w-5" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-body-lg font-bold leading-snug text-ink">All {allFormsCount} forms</span>
            <span className="block text-caption text-muted">Pin the ones you use most and they'll wait for you here.</span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        </Link>
      )}
    </div>
  );
}

/**
 * Phone Home's "Needs you today": the first few things that need the person,
 * each its own row, with the rest one tap away (replaces the folded banner).
 */
export function NeedsYouToday({ home, first = 3 }: { home?: HomeData; first?: number }) {
  const [all, setAll] = useState(false);
  const items = home?.attention ?? [];
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, first);
  const warn = items.some((a) => a.tone === "warn");
  return (
    <section id="attention" data-tour="home-attention" className="enter-up">
      <h2 className="mb-2 flex items-center gap-2 font-heading text-body-lg font-extrabold text-ink">
        Needs you today
        <span className={cn("rounded-pill px-2 text-micro font-bold", warn ? "bg-status-amberBg text-status-amberText" : "bg-subtle2 text-muted")}>{items.length}</span>
      </h2>
      <ul className={cn("overflow-hidden rounded-card border bg-surface", warn ? "border-status-amberDot/50" : "border-hairline")}>
        {shown.map((a) => (
          <li key={a.id} className="border-b border-hairline/70 last:border-b-0">
            <Link to={a.href} className="flex min-h-[60px] items-center gap-3 px-3.5 py-2.5 active:bg-rowhover">
              <AttentionIcon item={a} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 block text-body font-bold text-ink">{a.short?.title ?? a.title}</span>
                <span className="block truncate text-label text-muted">{a.short?.detail ?? a.detail}</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
            </Link>
          </li>
        ))}
        {items.length > first && (
          <li>
            <button type="button" onClick={() => setAll((v) => !v)} aria-expanded={all} className="flex min-h-[48px] w-full items-center justify-between px-3.5 text-body font-bold text-accent dark:text-white">
              {all ? "Show fewer" : `See all ${items.length}`}
              <ChevronDown className={cn("h-4 w-4 transition-transform", all && "rotate-180")} aria-hidden />
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}
