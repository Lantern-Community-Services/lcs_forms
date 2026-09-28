import { cn } from "@/lib/utils";

export function Badge({ className, children, style }: { className?: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 rounded-pill px-2.5 py-0.5 text-micro font-semibold", className)}
      style={style}
    >
      {children}
    </span>
  );
}

// Colors resolve from CSS variables (see index.css) so badges recolor with the
// theme. Returned as `rgb(var(--…))` strings so they work in inline styles too.
const c = (name: string) => `rgb(var(${name}))`;

type Tone = "amber" | "blue" | "green" | "red" | "violet" | "neutral";

const TONES: Record<Tone, { bg: string; text: string; dot: string }> = {
  amber: { bg: c("--st-amber-bg"), text: c("--st-amber-text"), dot: c("--st-amber-dot") },
  blue: { bg: c("--st-blue-bg"), text: c("--st-blue-text"), dot: c("--st-blue-dot") },
  green: { bg: c("--st-green-bg"), text: c("--st-green-text"), dot: c("--st-green-dot") },
  red: { bg: c("--st-red-bg"), text: c("--st-red-text"), dot: c("--st-red-dot") },
  violet: { bg: c("--st-violet-bg"), text: c("--st-violet-text"), dot: c("--st-violet-dot") },
  neutral: { bg: c("--st-neutral-bg"), text: c("--st-neutral-text"), dot: c("--st-neutral-text") },
};

export function ToneBadge({ tone, children, dot = true, className }: { tone: Tone; children: React.ReactNode; dot?: boolean; className?: string }) {
  const m = TONES[tone];
  return (
    <Badge className={className} style={{ backgroundColor: m.bg, color: m.text }}>
      {dot && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: m.dot }} />}
      {children}
    </Badge>
  );
}

/** Roster status, including the derived "needs review" state. */
export function TenantStatusBadge({ status, needsAttention }: { status: "active" | "archived"; needsAttention?: boolean }) {
  if (status === "archived") return <ToneBadge tone="neutral">Removed</ToneBadge>;
  if (needsAttention) return <ToneBadge tone="amber">Needs review</ToneBadge>;
  return <ToneBadge tone="green">On roster</ToneBadge>;
}

export function RedBadge({ children }: { children: React.ReactNode }) {
  return <ToneBadge tone="red" dot={false}>{children}</ToneBadge>;
}

/**
 * The amber count of things waiting on someone: people to review, access
 * requests. Past `max` it reads "999+" so a runaway queue can't stretch a nav
 * row. Compact rows pass `py-0`.
 */
export function CountBadge({ count, max, className, label }: { count: number; max?: number; className?: string; /** Spoken instead of the bare number. */ label?: string }) {
  return (
    <span aria-label={label} className={cn("rounded-pill bg-status-amberBg px-1.5 py-0.5 text-micro font-bold tabular text-status-amberText", className)}>
      {max !== undefined && count > max ? `${max}+` : count}
    </span>
  );
}

const TAG_TONES = {
  amber: "bg-status-amberBg text-status-amberText",
  red: "bg-status-redBg text-status-redText",
  neutral: "bg-subtle text-muted",
  accent: "bg-navsel text-accent dark:text-white",
} as const;

/** A small label beside a title — "New", "Hidden", "Built in", "VOID". Smaller than ToneBadge, and no dot. */
export function Tag({ tone = "amber", className, title, children }: { tone?: keyof typeof TAG_TONES; className?: string; title?: string; children: React.ReactNode }) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 rounded-pill px-2 py-px text-[10.5px] font-bold", TAG_TONES[tone], className)}>
      {children}
    </span>
  );
}
