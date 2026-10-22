import { readStoredJson, writeStorage } from "@/lib/storage";

/**
 * A home dashboard layout: an ordered list of widgets, each with a width. The
 * order is the position — widgets flow into the grid left to right, top to
 * bottom — and height follows the content.
 *
 * Kept per person and per device (localStorage), like the invoices site's: an
 * iPad and a desktop have different room, so each keeps its own arrangement.
 * Nothing saved yet means a blank dashboard — just All forms (BLANK) — that
 * offers the presets below (the welcome tour walks people through picking one).
 */

/**
 * Stored in saved layouts: never rename one. A widget's title can change
 * freely; its id can't.
 */
export type WidgetId =
  | "stat_attention"
  | "stat_submissions"
  | "stat_residents"
  | "stat_forms"
  | "stat_unread"
  | "stat_today"
  | "form_stats"
  | "attention"
  | "activity"
  | "pinned"
  | "recent_forms"
  | "calendar"
  | "notifications"
  | "roster_sites"
  | "quick_actions"
  | "all_forms";

/**
 * Widths. The grid is 6 columns on a tablet and 12 on a desktop:
 * small = a third of the row (both), medium = half (both),
 * large = two thirds on a desktop / the whole row on a tablet, full = the whole row.
 */
export type WidgetSize = "small" | "medium" | "large" | "full";
export const SIZES: WidgetSize[] = ["small", "medium", "large", "full"];

export const SIZE_LABEL: Record<WidgetSize, { short: string; long: string }> = {
  small: { short: "S", long: "Small: a third of the row" },
  medium: { short: "M", long: "Medium: half the row" },
  large: { short: "L", long: "Large: two thirds of the row (the whole row on a tablet)" },
  full: { short: "Full", long: "The whole row" },
};

/** Literal class names, so Tailwind sees them. */
export const SIZE_SPAN: Record<WidgetSize, string> = {
  small: "col-span-2 xl:col-span-4",
  medium: "col-span-3 xl:col-span-6",
  large: "col-span-6 xl:col-span-8",
  full: "col-span-6 xl:col-span-12",
};

export interface LayoutItem {
  id: WidgetId;
  size: WidgetSize;
}

const VERSION = 1;
const key = (userId: string) => `ln.home.dashboard.${userId}`;

/**
 * The saved layout, cleaned up: unknown or no-longer-allowed widgets, repeats
 * and sizes a widget doesn't offer are dropped. Null when nothing is saved (or
 * what's there isn't a layout), so the caller uses the default.
 */
export function loadLayout(userId: string, allowed: (id: WidgetId) => WidgetSize[] | null): LayoutItem[] | null {
  const raw = readStoredJson(key(userId));
  if (!raw || typeof raw !== "object" || (raw as { version?: unknown }).version !== VERSION) return null;
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  return clean(items, allowed);
}

export function saveLayout(userId: string, items: LayoutItem[]) {
  writeStorage(key(userId), JSON.stringify({ version: VERSION, items }));
}

export function clean(items: unknown[], allowed: (id: WidgetId) => WidgetSize[] | null): LayoutItem[] {
  const seen = new Set<string>();
  const out: LayoutItem[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const { id, size } = it as { id?: unknown; size?: unknown };
    if (typeof id !== "string" || seen.has(id)) continue;
    const sizes = allowed(id as WidgetId);
    if (!sizes) continue;
    seen.add(id);
    out.push({ id: id as WidgetId, size: sizes.includes(size as WidgetSize) ? (size as WidgetSize) : sizes[0] });
  }
  return out;
}

export function sameLayout(a: LayoutItem[], b: LayoutItem[]) {
  return a.length === b.length && a.every((x, i) => x.id === b[i].id && x.size === b[i].size);
}

/** Moves `id` to sit at `index` of the list without it. */
export function moveTo(items: LayoutItem[], id: WidgetId, index: number): LayoutItem[] {
  const from = items.findIndex((x) => x.id === id);
  if (from < 0) return items;
  const rest = items.filter((x) => x.id !== id);
  const at = Math.max(0, Math.min(index, rest.length));
  if (at === from) return items;
  return [...rest.slice(0, at), items[from], ...rest.slice(at)];
}

export interface Preset {
  id: string;
  title: string;
  description: string;
  /** Widgets the person can't have are skipped when it's applied. */
  items: LayoutItem[];
}

const L = (id: WidgetId, size: WidgetSize): LayoutItem => ({ id, size });

/** A blank dashboard: nothing chosen yet, so just the forms (the page offers the presets above them). */
export const BLANK: LayoutItem[] = [{ id: "all_forms", size: "full" }];

/**
 * The Standard layout: the page as it was before it could be customized —
 * counts, then the forms, then attention beside activity. A tablet leaves
 * the counts out so the forms are the first thing on screen.
 *
 * Every preset puts All forms near the top, just under its counts (code
 * forms' tiles count as counts).
 */
export function defaultLayout(desktop: boolean, roster: boolean): LayoutItem[] {
  return [
    ...(desktop ? [L("stat_attention", "small"), L("stat_submissions", "small"), L(roster ? "stat_residents" : "stat_forms", "small")] : []),
    L("form_stats", "full"),
    L("all_forms", "full"),
    L("attention", "medium"),
    L("activity", "medium"),
  ];
}

export function presets(desktop: boolean, roster: boolean): Preset[] {
  return [
    {
      id: "standard",
      title: "Standard",
      description: "Counts, your forms, what needs you and recent activity.",
      items: defaultLayout(desktop, roster),
    },
    {
      id: "quick",
      title: "Quick launch",
      description: "Your forms up top, with pinned and recent ones beside.",
      items: [L("all_forms", "large"), L("pinned", "small"), L("recent_forms", "medium"), L("quick_actions", "medium"), L("attention", "full")],
    },
    {
      id: "site",
      title: "Site lead",
      description: "Residents, check-ins due and the week ahead.",
      items: [
        L("stat_residents", "small"),
        L("stat_attention", "small"),
        L("stat_today", "small"),
        L("all_forms", "full"),
        L("roster_sites", "large"),
        L("attention", "small"),
        L("calendar", "medium"),
        L("activity", "medium"),
      ],
    },
    {
      id: "everything",
      title: "Everything",
      description: "Every count and list, for a big screen.",
      items: [
        L("stat_attention", "small"),
        L("stat_unread", "small"),
        L("stat_submissions", "small"),
        L("form_stats", "full"),
        L("all_forms", "full"),
        L("attention", "medium"),
        L("notifications", "medium"),
        L("pinned", "large"),
        L("quick_actions", "small"),
        L("calendar", "medium"),
        L("activity", "medium"),
        L("recent_forms", "medium"),
        L("roster_sites", "medium"),
      ],
    },
  ];
}
