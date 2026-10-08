import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { SearchInput } from "@/components/ui/input";
import { formIcon, searchFormIcons, useFormIconSet } from "@/lib/formIcons";

/** Icons drawn before "Show more", so ~1,500 buttons never mount at once. */
const PAGE = 120;

/**
 * Pick an icon from all of Lucide: a search box over its names and tags
 * ("food", "money", "house") above a scrolling grid. With `inherit` (a form),
 * the first cell is the category's icon, drawn dashed, which saves as null.
 */
export function IconPicker({ value, onChange, inherit: Inherit }: {
  value: string | null;
  onChange: (icon: string | null) => void;
  inherit?: React.ElementType;
}) {
  const set = useFormIconSet();
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const results = useMemo(() => (set ? searchFormIcons(set, q) : []), [set, q]);
  const picked = value ? set?.find((i) => i.key === value) : undefined;
  const Picked = value ? formIcon(value) : undefined;
  const searching = q.trim() !== "";

  const cell = (on: boolean) =>
    cn("flex h-10 items-center justify-center rounded-input border transition-colors", on ? "border-navy bg-navsel text-accent dark:text-white" : "border-hairline text-muted hover:bg-rowhover hover:text-ink");

  return (
    <div className="space-y-2">
      <SearchInput
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setShown(PAGE);
        }}
        placeholder={set ? `Search ${set.length.toLocaleString()} icons: food, money, house…` : "Search icons…"}
        aria-label="Search icons"
      />
      <p className="flex min-h-[20px] items-center gap-1.5 text-[12px] text-muted" aria-live="polite">
        {!set ? "Loading icons…" : searching ? (results.length === 1 ? "1 icon" : `${results.length.toLocaleString()} icons`) : "Suggested first. Search to find more."}
        {Picked && (
          <>
            <span aria-hidden>·</span>
            <Picked className="h-3.5 w-3.5 text-ink" aria-hidden />
            <span className="font-semibold text-ink">{picked?.label ?? value}</span>
          </>
        )}
        {value === null && Inherit && (
          <>
            <span aria-hidden>·</span>
            <span className="font-semibold text-ink">the category's icon</span>
          </>
        )}
      </p>
      <div className="max-h-[260px] overflow-y-auto overscroll-contain rounded-input scroll-thin">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(40px,1fr))] gap-1.5">
          {Inherit && (
            <button type="button" title="Category's icon" aria-label="Category's icon" aria-pressed={value === null} onClick={() => onChange(null)} className={cn(cell(value === null), "border-dashed")}>
              <Inherit className="h-[18px] w-[18px] opacity-70" />
            </button>
          )}
          {results.slice(0, shown).map(({ key, label, Icon }) => (
            <button key={key} type="button" title={label} aria-label={label} aria-pressed={value === key} onClick={() => onChange(key)} className={cell(value === key)}>
              <Icon className="h-[18px] w-[18px]" />
            </button>
          ))}
        </div>
        {set && results.length === 0 && <p className="py-3 text-[13px] text-muted">No icons match. Try a shorter or simpler word.</p>}
        {results.length > shown && (
          <button type="button" onClick={() => setShown((n) => n + PAGE)} className="mt-2 w-full rounded-input border border-hairline py-2 text-[13px] font-semibold text-muted hover:bg-rowhover hover:text-ink">
            Show more ({(results.length - shown).toLocaleString()} left)
          </button>
        )}
      </div>
    </div>
  );
}
