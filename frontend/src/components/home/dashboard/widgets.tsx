import { Link } from "react-router-dom";
import {
  AlertTriangle,
  Bell,
  CalendarDays,
  ClipboardCheck,
  Code2,
  ExternalLink,
  FilePlus2,
  History,
  Inbox,
  LayoutGrid,
  ListChecks,
  Pin,
  Send,
  Sparkles,
  UserRound,
  Users,
  UsersRound,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { ActivityPanel, AppTiles, AttentionPanel, PanelHeader, PanelNote, dayLabel } from "@/components/home/panels";
import { Tag } from "@/components/ui/badge";
import { useAuth } from "@/lib/auth";
import { formatTime, nyNowMinutes, nyToday, relativeDayName, shortDay } from "@/lib/calendar";
import { canOpenForm, formIcon, formLinkIcon, isInternalForm } from "@/lib/formIcons";
import { useNotificationList, useUnreadNotifications } from "@/lib/notifications";
import { useCalendar, useCalendarCategories, useDashboard } from "@/lib/queries";
import { addDays } from "@/lib/recurrence";
import { useSiteSelection } from "@/lib/site";
import type { CalendarOccurrence, FormCategory, FormLink, HomeAppTile, HomeData, PermissionKey } from "@/lib/types";
import { cn } from "@/lib/utils";
import { colorMap, colorOf } from "@/screens/calendar/colors";
import { SIZES, type WidgetId, type WidgetSize } from "./layout";

/**
 * Everything a home dashboard widget can show. Each definition carries its own
 * metadata (palette title, description, icon), the widths it offers, who may
 * have it, and how it draws, so adding a widget is one entry here (plus its id
 * in layout.ts).
 *
 * Widgets that need data of their own (the calendar, notifications, the roster
 * by site) fetch it inside their component, so nothing is requested for a
 * widget that isn't on the dashboard (or open in the palette's preview).
 */

export type FormEntry = { form: FormLink; category: FormCategory };

/** What Home already has loaded, handed to every widget. */
export interface WidgetCtx {
  home?: HomeData;
  homeLoading: boolean;
  homeFailed: boolean;
  appTiles: HomeAppTile[];
  appTilesLoading: boolean;
  categories: FormCategory[];
  favoriteForms: FormEntry[];
  totalForms: number;
}

type Can = (p: PermissionKey) => boolean;

export interface WidgetDef {
  id: WidgetId;
  title: string;
  description: string;
  icon: LucideIcon;
  /** Offered widths; the first is what it's added at. */
  sizes: WidgetSize[];
  /** Left out of the palette (and dropped from a saved layout) when false. */
  allowed?: (can: Can) => boolean;
  /** A count: as tall as itself, not stretched to the tallest widget in its row. */
  compact?: boolean;
  /** Nothing to show right now: skipped outside the editor, so it leaves no gap. */
  isEmpty?: (ctx: WidgetCtx) => boolean;
  render: (ctx: WidgetCtx, size: WidgetSize) => React.ReactNode;
}

const STAT: WidgetSize[] = ["small", "medium"];
const roster = (can: Can) => can("roster.view");

export const WIDGETS: WidgetDef[] = [
  {
    id: "stat_attention",
    title: "Attention count",
    description: "How many things need you, and how many are urgent.",
    icon: AlertTriangle,
    sizes: STAT,
    compact: true,
    render: ({ home }) => {
      const s = home?.stats;
      return (
        <StatTile
          label="Needs your attention"
          value={s ? String(s.attention) : "–"}
          note={s && s.urgent > 0 ? <Tag className="text-[12px]">{s.urgent} urgent</Tag> : "items"}
          href="#attention"
        />
      );
    },
  },
  {
    id: "stat_submissions",
    title: "Your submissions",
    description: "Forms you've sent in the last 7 days.",
    icon: Send,
    sizes: STAT,
    compact: true,
    render: ({ home }) => <StatTile label="Your submissions" value={home ? String(home.stats.submissionsWeek) : "–"} note="last 7 days" />,
  },
  {
    id: "stat_residents",
    title: "Residents",
    description: "Active residents across your sites.",
    icon: UsersRound,
    sizes: STAT,
    compact: true,
    allowed: roster,
    render: ({ home }) => {
      const s = home?.stats;
      return (
        <StatTile
          label="Residents at your sites"
          value={s?.residents != null ? String(s.residents) : "–"}
          note={`across ${s?.sites?.length ?? 0} ${s?.sites?.length === 1 ? "site" : "sites"}`}
          href="/roster"
        />
      );
    },
  },
  {
    id: "stat_forms",
    title: "Forms count",
    description: "How many forms you can open from the catalog.",
    icon: LayoutGrid,
    sizes: STAT,
    compact: true,
    render: ({ totalForms }) => <StatTile label="Forms you can open" value={String(totalForms)} note="in the catalog" href="#forms" />,
  },
  {
    id: "stat_unread",
    title: "Unread notifications",
    description: "Notifications you haven't opened yet.",
    icon: Bell,
    sizes: STAT,
    compact: true,
    render: () => <UnreadStat />,
  },
  {
    id: "stat_today",
    title: "Events today",
    description: "How many calendar events are on today.",
    icon: CalendarDays,
    sizes: STAT,
    compact: true,
    render: () => <TodayStat />,
  },
  {
    id: "form_stats",
    title: "Form stats",
    description: "Counts that code forms post to the home screen.",
    icon: Sparkles,
    sizes: ["full", "large", "medium"],
    isEmpty: ({ appTiles, appTilesLoading }) => !appTilesLoading && appTiles.length === 0,
    render: ({ appTiles }) =>
      appTiles.length ? (
        <AppTiles tiles={appTiles} />
      ) : (
        <WidgetCard title="Form stats" icon={Sparkles}>
          <PanelNote>No form posts counts here yet. When one does, they show up in this spot.</PanelNote>
        </WidgetCard>
      ),
  },
  {
    id: "attention",
    title: "Needs your attention",
    description: "Residents due a check-in, drafts to finish, anything a form flags for you.",
    icon: ListChecks,
    sizes: SIZES,
    render: ({ home, homeLoading, homeFailed }, size) => (
      <AttentionPanel home={home} loading={homeLoading} failed={homeFailed} compact={size === "small"} className="h-full" />
    ),
  },
  {
    id: "activity",
    title: "Recent activity",
    description: "What happened lately: your own, or your sites' if you manage them.",
    icon: History,
    sizes: SIZES,
    render: ({ home, homeLoading, homeFailed }, size) => (
      <ActivityPanel home={home} loading={homeLoading} failed={homeFailed} limit={3} wideLimit={size === "small" ? 4 : size === "medium" ? 6 : 8} className="h-full" />
    ),
  },
  {
    id: "pinned",
    title: "Pinned forms",
    description: "One-tap buttons for the forms you've pinned.",
    icon: Pin,
    sizes: SIZES,
    render: (ctx, size) => <PinnedWidget favorites={ctx.favoriteForms} size={size} />,
  },
  {
    id: "recent_forms",
    title: "Recently used",
    description: "The forms you've submitted lately, to fill in again.",
    icon: Zap,
    sizes: SIZES,
    render: (ctx, size) => <RecentFormsWidget ctx={ctx} size={size} />,
  },
  {
    id: "calendar",
    title: "Upcoming events",
    description: "The next two weeks on the calendar, for your sites.",
    icon: CalendarDays,
    sizes: SIZES,
    render: (_ctx, size) => <CalendarWidget size={size} />,
  },
  {
    id: "notifications",
    title: "Notifications",
    description: "Your unread notifications.",
    icon: Inbox,
    sizes: SIZES,
    render: (_ctx, size) => <NotificationsWidget size={size} />,
  },
  {
    id: "roster_sites",
    title: "Roster by site",
    description: "Residents and check-ins due at each of your sites.",
    icon: Users,
    sizes: SIZES,
    allowed: roster,
    render: (_ctx, size) => <RosterSitesWidget size={size} />,
  },
  {
    id: "quick_actions",
    title: "Shortcuts",
    description: "Filled in for you: your groups' forms, what your role uses at your sites, and your role's screens.",
    icon: ClipboardCheck,
    sizes: SIZES,
    render: (ctx, size) => <QuickActionsWidget ctx={ctx} size={size} />,
  },
];

export const WIDGET_BY_ID = new Map(WIDGETS.map((w) => [w.id, w]));

/** How many rows a list widget shows at each width. */
const ROWS: Record<WidgetSize, number> = { small: 3, medium: 5, large: 6, full: 6 };

// ── Shared pieces ────────────────────────────────────────────────────────

function WidgetCard({ title, icon: Icon, count, link, children, className }: {
  title: string;
  icon?: LucideIcon;
  count?: number;
  link?: { to: string; label: string };
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("enter-up flex h-full min-w-0 flex-col rounded-card border border-hairline bg-surface shadow-card", className)}>
      <PanelHeader title={title} count={count}>
        {link ? (
          <Link to={link.to} className="shrink-0 text-[12.5px] font-bold text-accent hover:underline dark:text-white">
            {link.label}
          </Link>
        ) : Icon ? (
          <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        ) : null}
      </PanelHeader>
      {children}
    </section>
  );
}

function StatTile({ label, value, note, href }: { label: string; value: string; note: React.ReactNode; href?: string }) {
  const body = (
    <>
      <span className="text-[13px] font-semibold text-muted">{label}</span>
      <span className="flex items-baseline gap-2.5">
        <span className="text-[28px] font-heading font-extrabold leading-tight text-ink">{value}</span>
        <span className="text-[13px] text-muted">{note}</span>
      </span>
    </>
  );
  const cls = "enter-up flex h-full flex-col justify-center gap-1 rounded-card border border-hairline bg-surface px-5 py-4 shadow-card";
  return href?.startsWith("/") ? (
    <Link to={href} className={cn(cls, "hover:border-strongline")}>{body}</Link>
  ) : href ? (
    <a href={href} className={cn(cls, "hover:border-strongline")}>{body}</a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** A catalog form as a link: in-app forms route here, everything else opens a new tab. */
function FormLinkWrap({ url, className, children }: { url: string; className?: string; children: React.ReactNode }) {
  return isInternalForm(url) ? (
    <Link to={url} className={className}>{children}</Link>
  ) : (
    <a href={url} target="_blank" rel="noopener noreferrer" className={className}>{children}</a>
  );
}

function when(iso: string) {
  const d = new Date(iso);
  return `${dayLabel(d)}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

// ── Stats with data of their own ─────────────────────────────────────────

function UnreadStat() {
  const { data } = useUnreadNotifications();
  const note = !data?.unread ? "all read" : data.urgent ? `${data.urgent} urgent` : "to read";
  return <StatTile label="Unread notifications" value={data ? String(data.unread) : "–"} note={note} href={data?.urgent ? "/notifications?show=urgent" : "/notifications"} />;
}

function useUpcoming(days: number) {
  const { param } = useSiteSelection();
  const today = nyToday();
  const q = useCalendar(today, addDays(today, days - 1), param);
  const now = nyNowMinutes();
  // Today's events that have already ended aren't "upcoming".
  const items = (q.data?.items ?? [])
    .filter((o) => !(o.endDate === today && !o.allDay && o.endTime && toMinutes(o.endTime) < now) && o.endDate >= today)
    .sort((a, b) => (a.startDate === b.startDate ? (a.allDay ? -1 : b.allDay ? 1 : (a.startTime ?? "").localeCompare(b.startTime ?? "")) : a.startDate.localeCompare(b.startDate)));
  return { ...q, items, today };
}

const toMinutes = (t: string) => +t.slice(0, 2) * 60 + +t.slice(3, 5);

function TodayStat() {
  const { items, isLoading, today } = useUpcoming(1);
  const n = items.filter((o) => o.startDate <= today).length;
  const next = items.find((o) => !o.allDay && o.startTime);
  return (
    <StatTile
      label="Events today"
      value={isLoading ? "–" : String(n)}
      note={next?.startTime ? `next at ${formatTime(next.startTime)}` : "on the calendar"}
      href="/calendar?view=day"
    />
  );
}

// ── List widgets ─────────────────────────────────────────────────────────

const PIN_COLS: Record<WidgetSize, string> = {
  small: "grid-cols-1",
  medium: "grid-cols-2",
  large: "grid-cols-2 xl:grid-cols-3",
  full: "grid-cols-3 xl:grid-cols-4",
};

function PinnedWidget({ favorites, size }: { favorites: FormEntry[]; size: WidgetSize }) {
  const { can } = useAuth();
  const shown = favorites.filter((e) => canOpenForm(e.form.url, can));
  return (
    <WidgetCard title="Pinned forms" count={shown.length} icon={Pin}>
      {shown.length === 0 ? (
        <PanelNote>Nothing pinned yet. Tap the pin on any form below to keep it here.</PanelNote>
      ) : (
        <ul className={cn("grid gap-2 p-3 xl:p-4", PIN_COLS[size])}>
          {shown.map(({ form, category }) => {
            const Icon = formLinkIcon(form, category.icon);
            return (
              <li key={form.id} className="min-w-0">
                <FormLinkWrap
                  url={form.url}
                  className="flex min-h-[52px] items-center gap-2.5 rounded-input border border-hairline px-2.5 py-2 hover:border-strongline hover:bg-rowhover"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] bg-navsel text-accent dark:text-white">
                    <Icon className="h-[18px] w-[18px]" />
                  </span>
                  <span className="min-w-0 flex-1 text-[13.5px] font-bold leading-snug text-ink">{form.title}</span>
                  {!isInternalForm(form.url) && <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted" aria-label="opens in a new tab" />}
                </FormLinkWrap>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetCard>
  );
}

function RecentFormsWidget({ ctx, size }: { ctx: WidgetCtx; size: WidgetSize }) {
  const recent = (ctx.home?.recentForms ?? []).slice(0, ROWS[size]);
  // The catalog card for the same form, for its icon; a form that isn't in the catalog gets the generic one.
  const byUrl = new Map(ctx.categories.flatMap((c) => c.forms.map((f) => [f.url, { f, c }] as const)));
  return (
    <WidgetCard title="Recently used" icon={Zap}>
      {ctx.homeLoading ? (
        <PanelNote>Loading…</PanelNote>
      ) : recent.length === 0 ? (
        <PanelNote>Forms you submit will show up here, ready to fill in again.</PanelNote>
      ) : (
        <ul className="py-1">
          {recent.map((r) => {
            const card = byUrl.get(r.href);
            const Icon = card ? formLinkIcon(card.f, card.c.icon) : formIcon("clipboard");
            return (
              <li key={r.id}>
                <Link to={r.href} className="flex items-center gap-3 px-4 py-2 hover:bg-rowhover xl:px-5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-navsel text-accent dark:text-white">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-bold text-ink">{r.title}</span>
                    <span className="block truncate text-[12px] text-muted">
                      {when(r.lastAt)}
                      {r.uses > 1 ? ` · ${r.uses} times lately` : ""}
                    </span>
                  </span>
                  <FilePlus2 className="h-4 w-4 shrink-0 text-muted" aria-label="Fill in again" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetCard>
  );
}

function CalendarWidget({ size }: { size: WidgetSize }) {
  const { items, isLoading, isError, today } = useUpcoming(14);
  const { data: categories } = useCalendarCategories();
  const colors = colorMap(categories);
  const shown = items.slice(0, ROWS[size] + 1);
  return (
    <WidgetCard title="Upcoming events" link={{ to: "/calendar", label: "Calendar" }}>
      {isLoading ? (
        <PanelNote>Loading…</PanelNote>
      ) : isError ? (
        <PanelNote>The calendar didn't load. Refresh the page to try again.</PanelNote>
      ) : shown.length === 0 ? (
        <PanelNote>Nothing on the calendar for the next two weeks.</PanelNote>
      ) : (
        <ul className="py-1">
          {shown.map((o) => (
            <li key={o.key}>
              <EventRow o={o} today={today} color={colorOf(colors, o.categoryId).solid} />
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  );
}

function EventRow({ o, today, color }: { o: CalendarOccurrence; today: string; color: string }) {
  const day = o.startDate < today ? today : o.startDate;
  const dayName = relativeDayName(day, today) ?? shortDay(day);
  const time = o.allDay ? "All day" : o.startTime ? formatTime(o.startTime) : "";
  return (
    <Link to={`/calendar?view=day&date=${day}`} className="flex items-center gap-3 px-4 py-2 hover:bg-rowhover xl:px-5">
      <span className="h-9 w-1 shrink-0 rounded-pill" style={{ background: color }} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 truncate text-[13.5px] font-bold text-ink">
          <span className="truncate">{o.title}</span>
          {o.pending && <Tag className="shrink-0">Pending</Tag>}
        </span>
        <span className="block truncate text-[12px] text-muted">{[`${dayName}${time ? ` · ${time}` : ""}`, o.location].filter(Boolean).join(" · ")}</span>
      </span>
    </Link>
  );
}

function NotificationsWidget({ size }: { size: WidgetSize }) {
  const { data, isLoading, isError } = useNotificationList("unread");
  // Urgent first, then newest.
  const all = data?.pages[0]?.items ?? [];
  const items = [...all.filter((n) => n.urgent), ...all.filter((n) => !n.urgent)].slice(0, ROWS[size]);
  const unread = data?.pages[0]?.unread ?? 0;
  return (
    <WidgetCard title="Notifications" count={unread} link={{ to: "/notifications", label: "See all" }}>
      {isLoading ? (
        <PanelNote>Loading…</PanelNote>
      ) : isError ? (
        <PanelNote>This didn't load. Refresh the page to try again.</PanelNote>
      ) : items.length === 0 ? (
        <PanelNote>No unread notifications.</PanelNote>
      ) : (
        <ul className="py-1">
          {items.map((n) => (
            <li key={n.id}>
              <Link to={`/notifications/${n.id}`} className="flex items-start gap-3 px-4 py-2 hover:bg-rowhover xl:px-5">
                <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", n.urgent ? "bg-status-redDot" : "bg-accent")} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-bold text-ink">
                    {n.urgent && <span className="mr-1 text-status-redText">Urgent:</span>}
                    {n.title}
                  </span>
                  <span className="block truncate text-[12px] text-muted">{[n.sourceLabel, when(n.createdAt)].filter(Boolean).join(" · ")}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  );
}

function RosterSitesWidget({ size }: { size: WidgetSize }) {
  const { data, isLoading, isError } = useDashboard();
  const sites = [...(data?.sites ?? [])].sort((a, b) => b.attentionCount - a.attentionCount || b.activeCount - a.activeCount);
  const shown = sites.slice(0, ROWS[size] + 2);
  return (
    <WidgetCard title="Roster by site" link={{ to: "/roster/overview", label: "Overview" }}>
      {isLoading ? (
        <PanelNote>Loading…</PanelNote>
      ) : isError ? (
        <PanelNote>The roster didn't load. Refresh the page to try again.</PanelNote>
      ) : shown.length === 0 ? (
        <PanelNote>No sites to show.</PanelNote>
      ) : (
        <>
          <ul className="py-1">
            {shown.map((s) => {
              const share = s.activeCount ? Math.min(1, s.attentionCount / s.activeCount) : 0;
              return (
                <li key={s.id}>
                  <Link
                    to={s.attentionCount ? `/roster/review?site=${encodeURIComponent(s.code)}` : `/roster?site=${encodeURIComponent(s.code)}`}
                    className="flex items-center gap-3 px-4 py-2 hover:bg-rowhover xl:px-5"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[13.5px] font-bold text-ink">{s.name}</span>
                        <span className="shrink-0 text-[12px] text-muted">
                          {s.activeCount} {s.activeCount === 1 ? "resident" : "residents"}
                        </span>
                      </span>
                      <span className="mt-1.5 flex items-center gap-2">
                        <span className="h-1.5 flex-1 overflow-hidden rounded-pill bg-subtle">
                          <span className="block h-full rounded-pill bg-status-amberDot" style={{ width: `${share * 100}%` }} />
                        </span>
                        <span className={cn("w-[72px] shrink-0 text-right text-[11.5px] font-semibold", s.attentionCount ? "text-status-amberText" : "text-muted")}>
                          {s.attentionCount ? `${s.attentionCount} to check` : "all seen"}
                        </span>
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {sites.length > shown.length && <p className="px-4 pb-3 text-[12px] text-muted xl:px-5">and {sites.length - shown.length} more sites</p>}
        </>
      )}
    </WidgetCard>
  );
}

const SHORTCUT_COLS: Record<WidgetSize, string> = {
  small: "grid-cols-1 xl:grid-cols-2",
  medium: "grid-cols-2",
  large: "grid-cols-2 xl:grid-cols-3",
  full: "grid-cols-3 xl:grid-cols-5",
};

/** How many shortcuts each width shows: a full row or two of its grid. */
const SHORTCUT_COUNT: Record<WidgetSize, number> = { small: 4, medium: 6, large: 9, full: 10 };

type Shortcut = { to: string; label: string; icon: React.ElementType; external?: boolean };

/**
 * Shortcuts, filled in for the person rather than picked: the forms their
 * groups were given and the ones their role uses most at their sites (the
 * server's shortcutForms), then each of their sites' rosters when they have a
 * few, then the screens their role works in. Pinned forms are left out: they
 * have their own widget and the nav.
 */
function QuickActionsWidget({ ctx, size }: { ctx: WidgetCtx; size: WidgetSize }) {
  const { can } = useAuth();
  const byId = new Map(ctx.categories.flatMap((c) => c.forms.map((f) => [f.id, { f, c }] as const)));
  const pinned = new Set(ctx.favoriteForms.map((e) => e.form.id));
  const forms: Shortcut[] = (ctx.home?.shortcutForms ?? [])
    .map((id) => byId.get(id))
    .filter((x): x is NonNullable<typeof x> => Boolean(x) && !pinned.has(x!.f.id) && canOpenForm(x!.f.url, can))
    .map(({ f, c }) => ({ to: f.url, label: f.title, icon: formLinkIcon(f, c.icon), external: !isInternalForm(f.url) }));
  const sites = ctx.home?.rosterSites ?? [];
  // A site's roster is worth a shortcut when there are only a few; an Admin's twenty aren't.
  const siteLinks: Shortcut[] = sites.length > 1 && sites.length <= 3 ? sites.map((s) => ({ to: `/roster?site=${encodeURIComponent(s.code)}`, label: `${s.name} roster`, icon: Users })) : [];
  const screens: (Shortcut & { show: boolean })[] = [
    { to: "/roster/review", label: "Review residents", icon: ListChecks, show: can("roster.archive") },
    { to: "/roster/attendance", label: "Attendance", icon: ClipboardCheck, show: can("roster.edit") },
    { to: "/roster", label: "Roster", icon: Users, show: can("roster.view") && siteLinks.length === 0 },
    { to: "/admin/people", label: can("users.manage") ? "People" : "Site settings", icon: UserRound, show: can("users.manage") || can("users.manageSite") },
    { to: "/admin/builder", label: "Build a form", icon: FilePlus2, show: can("forms.manage") },
    { to: "/admin/apps", label: "Code forms", icon: Code2, show: can("apps.develop") },
    { to: "/calendar", label: "Calendar", icon: CalendarDays, show: true },
    { to: "/notifications", label: "Notifications", icon: Bell, show: true },
  ];
  const shown = [...forms, ...siteLinks, ...screens.filter((s) => s.show)].slice(0, SHORTCUT_COUNT[size]);
  const className = "flex min-h-[44px] items-center gap-2.5 rounded-input bg-subtle px-3 text-[13px] font-bold text-ink hover:bg-subtle2";
  return (
    <WidgetCard title="Shortcuts" icon={Zap}>
      <ul className={cn("grid gap-2 p-3 xl:p-4", SHORTCUT_COLS[size])}>
        {shown.map((a) => {
          const body = (
            <>
              <a.icon className="h-4 w-4 shrink-0 text-accent dark:text-white" />
              <span className="min-w-0 flex-1 truncate">{a.label}</span>
              {a.external && <ExternalLink className="h-3 w-3 shrink-0 opacity-50" aria-hidden />}
            </>
          );
          return (
            <li key={a.to}>
              {a.external ? (
                <a href={a.to} target="_blank" rel="noopener noreferrer" title={`${a.label} (opens in a new tab)`} className={className}>{body}</a>
              ) : (
                <Link to={a.to} title={a.label} className={className}>{body}</Link>
              )}
            </li>
          );
        })}
      </ul>
    </WidgetCard>
  );
}
