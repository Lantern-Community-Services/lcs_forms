import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind.config.ts adds two font sizes. Untold, tailwind-merge reads
// `text-micro` as a colour and drops it whenever a text colour follows it.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: ["micro", "meta"] }] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** What to tell the person about a failure: the error's own message, or `fallback` for anything thrown that isn't an Error. */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** A copy of `set` with `value` flipped in or out — or put exactly where `on` says. */
export function toggled<T>(set: Set<T>, value: T, on = !set.has(value)): Set<T> {
  const next = new Set(set);
  if (on) next.add(value);
  else next.delete(value);
  return next;
}

// Built once. `toLocaleDateString(…, options)` constructs a fresh formatter on
// every call, which is expensive enough to matter when a roster renders a
// couple of thousand dates.
const DATE_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const DATETIME_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return DATE_FMT.format(d);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return DATETIME_FMT.format(d);
}

/** yyyy-mm-dd for an <input type="date">, read off the ISO string so no timezone shift. */
export function formatDateInput(value: string | Date | null | undefined): string {
  if (!value) return "";
  const iso = typeof value === "string" ? value : value.toISOString();
  return iso.slice(0, 10);
}

export function relativeTime(value: string | Date | null | undefined): string {
  if (!value) return "never";
  const d = typeof value === "string" ? new Date(value) : value;
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(d);
}

/** "3 days" / "52 hours" — how long someone has been quiet. */
export function quietFor(hours: number): string {
  if (hours < 72) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

/** Stable avatar tint for a resident, derived from their id. */
export function tintFor(id: string): string {
  const palette = ["#1d4ed8", "#7c3aed", "#be123c", "#c2410c", "#a16207", "#15803d", "#0f766e", "#6b4f3b", "#0e7490", "#6d2873"];
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}
