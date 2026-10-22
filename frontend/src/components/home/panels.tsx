import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, PencilLine, Users } from "lucide-react";
import { formIcon } from "@/lib/formIcons";
import type { HomeActivityItem, HomeAppTile, HomeAttentionItem, HomeData } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The Forms home's panels: what needs the person, what happened lately, code
 * forms' stat tiles. The phone layout (screens/Forms) places them itself; on
 * tablet and desktop they are widgets on the person's dashboard (./dashboard).
 */

const ATTENTION_ICON = { roster: Users, draft: PencilLine } as const;

export function AttentionIcon({ item, size = "md" }: { item: HomeAttentionItem; size?: "sm" | "md" }) {
  const Icon = item.kind === "app" ? formIcon(item.icon ?? "clipboard") : ATTENTION_ICON[item.kind] ?? AlertTriangle;
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

export function PanelHeader({ title, count, children }: { title: string; count?: number; children?: React.ReactNode }) {
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

export function PanelNote({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-6 text-center text-[13px] text-muted xl:px-5">{children}</p>;
}

export function AttentionPanel({ home, loading, failed, compact = false, className }: {
  home?: HomeData;
  loading: boolean;
  failed: boolean;
  /** Narrow (a third of the row): the tablet's linked rows at every width. */
  compact?: boolean;
  className?: string;
}) {
  const items = home?.attention ?? [];
  return (
    <section id="attention" data-tour="home-attention" className={cn("enter-up flex min-w-0 flex-col rounded-card border border-hairline bg-surface shadow-card", className)}>
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
              <Link to={a.href} className={cn("flex items-center gap-3 px-4 py-2.5 hover:bg-rowhover", !compact && "xl:hidden")}>
                <AttentionIcon item={a} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-bold text-ink">{a.title}</span>
                  <span className="block truncate text-[12px] text-muted">{a.detail}</span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              </Link>
              <div className={cn("hidden items-center gap-3.5 px-5 py-4", !compact && "xl:flex")}>
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

export function dayLabel(d: Date) {
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(new Date()) - start(d)) / 86400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("") || "?";
}

export function ActivityPanel({ home, loading, failed, limit, wideLimit, className }: {
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

/** Stat tiles from code forms (form.json "home"), each opening its form. */
export function AppTiles({ tiles, className }: { tiles: HomeAppTile[]; className?: string }) {
  if (!tiles.length) return null;
  return (
    <div className={cn("grid grid-cols-2 gap-3 md:grid-cols-3 xl:gap-4", className)}>
      {tiles.map((t) => {
        const Icon = formIcon(t.icon ?? "clipboard");
        return (
          <Link key={t.id} to={t.href} className="enter-up flex min-w-0 flex-col gap-1 rounded-card border border-hairline bg-surface px-4 py-3.5 shadow-card hover:border-strongline xl:px-5 xl:py-4">
            <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-semibold text-muted">
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate">{t.formTitle}</span>
            </span>
            <span className="truncate text-[13px] font-semibold text-ink">{t.label}</span>
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="text-[24px] font-heading font-extrabold leading-tight text-ink xl:text-[28px]">{t.value}</span>
              {t.hint && <span className="truncate text-[12.5px] text-muted">{t.hint}</span>}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

/** Phone: the attention list folded into one banner that opens in place. */
export function PhoneAttention({ home }: { home?: HomeData }) {
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
