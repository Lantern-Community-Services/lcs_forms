import { cn } from "@/lib/utils";

/**
 * A pill that filters what's shown — a form category, "Including deactivated".
 * Pressed reads as the nav's selected state; in a `chiprow` a row of them
 * scrolls sideways on a phone.
 */
export function Chip({ active, onClick, className, children }: { active: boolean; onClick: () => void; className?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex min-h-[36px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border px-3 text-[12.5px] transition-colors md:min-h-[32px]",
        active ? "border-navy bg-navsel font-bold text-accent dark:text-white" : "border-hairline bg-surface font-medium text-ink hover:bg-navsel/60",
        className
      )}
    >
      {children}
    </button>
  );
}
