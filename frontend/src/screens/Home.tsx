import { useMemo } from "react";
import { HomeDashboard } from "@/components/home/dashboard/HomeDashboard";
import { ActivityPanel, AppTiles } from "@/components/home/panels";
import { NeedsYouToday, StartFormTiles, useStartForms } from "@/components/home/StartForms";
import { Page } from "@/components/shell/AppShell";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import { SearchInput } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";
import { useHome, useHomeApps } from "@/lib/queries";
import type { HomeData } from "@/lib/types";
import { PhoneForms, useCatalogBrowser } from "./Forms";

/**
 * Home: the day's work, not the forms. What needs the person, what's coming
 * up, what happened lately and their notifications; the forms have their own
 * page (screens/Forms).
 *
 * - tablet and desktop: the person's own dashboard of widgets, starting on a
 *   simple default (components/home/dashboard);
 * - phone: "Needs you today" (the first few, the rest a tap away), "Start a
 *   form" (pinned, then recently used), then the forms by category, since a
 *   phone has no sidebar to reach the Forms page from, then activity.
 */
export function HomePage() {
  const { user } = useAuth();
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
  const catalog = useCatalogBrowser();
  // Three, plus the "All forms" tile: two rows of two on a phone.
  const startItems = useStartForms(catalog.favoriteForms, home.data?.recentForms, catalog.categories, 3, home.data?.shortcutForms);

  const first = user?.name.split(" ")[0];
  const greeting = `${greetingWord()}${first ? `, ${first}` : ""}`;
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const sites = home.data?.stats.sites;
  const subtitle = [today, sites && sites.length > 0 && sites.length <= 3 ? sites.join(", ") : sites && sites.length > 3 ? `${sites.length} sites` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex min-h-full flex-col">
      {/* ── Phone ─────────────────────────────────────────────────────── */}
      <PhoneHeader title={greeting} subtitle={subtitle} enter>
        <div data-tour="home-search" className="enter-up mt-3">
          <SearchInput value={catalog.q} onChange={(e) => catalog.setQ(e.target.value)} placeholder="Find a form" aria-label="Find a form" />
        </div>
      </PhoneHeader>

      <div className="flex flex-col gap-5 px-4 py-4 md:hidden">
        {!catalog.searching && !catalog.pick && (
          <>
            {/* What needs the person, then the forms they're most likely to start. */}
            <NeedsYouToday home={home.data} />
            <section className="enter-up" data-tour="home-start">
              <h2 className="mb-2 font-heading text-body-lg font-extrabold text-ink">Start a form</h2>
              <StartFormTiles items={startItems} allFormsCount={catalog.totalForms} />
            </section>
            <AppTiles tiles={appTiles} />
          </>
        )}
        <PhoneForms c={catalog} hidePinned after={<ActivityPanel home={home.data} loading={home.isLoading} failed={home.isError} limit={4} className="mt-1" />} />
      </div>

      {/* ── Tablet and desktop ────────────────────────────────────────── */}
      <Page className="hidden w-full md:block">
        {/* The person's own dashboard: which widgets, in what order, how wide (see HomeDashboard). */}
        <HomeDashboard
          heading={
            <>
              <h1 className="text-title font-heading font-extrabold text-ink xl:text-display">{greeting}</h1>
              <p className="mt-1 text-body text-muted">{subtitle}</p>
            </>
          }
          ctx={{
            home: home.data,
            homeLoading: home.isLoading,
            homeFailed: home.isError,
            appTiles,
            appTilesLoading: homeApps.isLoading,
            categories: catalog.categories,
            favoriteForms: catalog.favoriteForms,
            totalForms: catalog.totalForms,
          }}
        />
      </Page>
    </div>
  );
}

function greetingWord() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}
