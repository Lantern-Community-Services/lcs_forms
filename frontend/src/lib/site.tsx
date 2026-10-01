import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Check, ChevronDown, MapPin } from "lucide-react";
import { useSites } from "./queries";
import { readStoredJson, writeStorage } from "./storage";
import { useIsPhone } from "./useMediaQuery";
import { cn } from "./utils";
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { CountBadge } from "@/components/ui/badge";
import { SearchInput } from "@/components/ui/input";
import type { Site } from "./types";

const KEY = "ln.sites";

function remembered(): string[] | null {
  const parsed = readStoredJson(KEY);
  return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : null;
}

/**
 * Which of my sites a screen is showing.
 *
 * The options are only the sites this person is assigned to (every site for an
 * admin) — the API enforces the same, this just never offers the rest. An empty
 * selection means "All my sites", which is the default.
 *
 * The choice lives in the URL (?site=amber-hall,rockaway-terrace) so a link
 * opens the same view, and is remembered per device so the Roster, Review,
 * Dashboard and Activity screens all open on the same selection.
 */
export function useSiteSelection() {
  const { data, isLoading } = useSites();
  const [params, setParams] = useSearchParams();
  const sites = data ?? [];

  const fromUrl = params.get("site");
  const codes = selectedCodes(fromUrl !== null ? fromUrl.split(",").filter(Boolean) : remembered() ?? [], sites);
  const key = codes.join(",");

  // If storage refuses, the URL still carries the choice.
  useEffect(() => {
    if (sites.length) writeStorage(KEY, JSON.stringify(key ? key.split(",") : []));
  }, [key, sites.length]);

  function setCodes(next: string[]) {
    const p = new URLSearchParams(params);
    const normalised = next.length === sites.length ? [] : next;
    p.set("site", normalised.join(","));
    setParams(p, { replace: true });
  }

  const selected = codes.length ? sites.filter((s) => codes.includes(s.code)) : sites;
  return {
    /** Empty = All my sites. */
    codes,
    setCodes,
    /** The sites in view — every assigned site when the selection is All. */
    selected,
    /** Every site this person may choose from. */
    sites,
    isAll: codes.length === 0,
    /** For API calls: undefined means all of my sites. */
    param: key || undefined,
    isLoading,
  };
}

/** Drop anything not (or no longer) assigned. Selecting every site is the same as All (empty). */
function selectedCodes(raw: string[], sites: Site[]) {
  const valid = new Set(sites.map((s) => s.code));
  const codes = sites.length ? raw.filter((c) => valid.has(c)) : raw;
  return sites.length && codes.length === sites.length ? [] : codes;
}

/**
 * The `site` parameter the roster and Hot Foods screens would send on this
 * device with no ?site= in the URL (undefined = all my sites), for reading
 * them ahead of time (lib/snapshot.ts).
 */
export function rememberedSiteParam(sites: Site[]): string | undefined {
  return selectedCodes(remembered() ?? [], sites).join(",") || undefined;
}

export function selectionLabel(codes: string[], sites: Site[]) {
  if (codes.length === 0) return sites.length === 1 ? sites[0].name : "All my sites";
  if (codes.length === 1) return sites.find((s) => s.code === codes[0])?.name ?? "1 site";
  return `${codes.length} sites`;
}

/**
 * Pick All, one site, or any combination. A popover on desktop, a bottom sheet
 * on a phone. Tapping a row toggles it (from All, it selects just that site).
 * Hidden entirely for someone assigned to a single site — there's nothing to pick.
 */
export function SitePicker({
  codes,
  onChange,
  className,
}: {
  codes: string[];
  onChange: (codes: string[]) => void;
  className?: string;
}) {
  const { data: sites } = useSites();
  const phone = useIsPhone();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const wrap = useRef<HTMLDivElement>(null);

  // Close the desktop popover on an outside click or Escape.
  useEffect(() => {
    if (!open || phone) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, phone]);

  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const list = sites ?? [];
  const shown = useMemo(
    () => (q ? list.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()) || s.code.includes(q.toLowerCase())) : list),
    [list, q]
  );
  if (list.length <= 1) return null;

  const all = codes.length === 0;
  const toggle = (code: string) => {
    // From All, tapping a site means "just this one" — starting from every box
    // ticked and unticking twenty is not what anybody wants.
    if (all) return onChange([code]);
    const next = codes.includes(code) ? codes.filter((c) => c !== code) : [...codes, code];
    onChange(next.length === 0 || next.length === list.length ? [] : next);
  };

  const attention = (all ? list : list.filter((s) => codes.includes(s.code))).reduce((n, s) => n + s.attentionCount, 0);

  const trigger = (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      aria-haspopup="listbox"
      aria-expanded={open}
      className="flex min-h-[44px] w-full items-center gap-2 rounded-input border border-hairline bg-surface px-3 text-left text-[14px] font-semibold text-ink hover:border-strongline focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy md:min-h-9"
    >
      <MapPin className="h-4 w-4 shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate">{selectionLabel(codes, list)}</span>
      {attention > 0 && <CountBadge count={attention} className="shrink-0" />}
      <ChevronDown className="h-4 w-4 shrink-0 text-muted" />
    </button>
  );

  const body = (
    <>
      {list.length > 8 && (
        <SearchInput
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find a site"
          aria-label="Find a site"
          autoFocus={!phone}
          wrapperClassName="mb-2"
          className="min-h-[40px] md:min-h-9"
        />
      )}
      <div role="listbox" aria-multiselectable="true" aria-label="Sites">
        {!q && (
          <Row checked={all} label="All my sites" meta={`${list.length} sites`} onClick={() => onChange([])} strong />
        )}
        {shown.map((s) => (
          <Row
            key={s.code}
            checked={all || codes.includes(s.code)}
            dim={all}
            label={s.name}
            meta={`${s.activeCount}`}
            badge={s.attentionCount || undefined}
            onClick={() => toggle(s.code)}
          />
        ))}
        {shown.length === 0 && <p className="px-2 py-3 text-[13px] text-muted">No site matches “{q}”.</p>}
      </div>
    </>
  );

  if (phone) {
    return (
      <div className={cn("min-w-0", className)}>
        {trigger}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent aria-describedby={undefined}>
            <SheetHeader title="Sites" />
            <SheetBody className="px-2">{body}</SheetBody>
            <SheetFooter>
              <Button variant="secondary" onClick={() => onChange([])} className="min-h-[48px] flex-1">All my sites</Button>
              <Button onClick={() => setOpen(false)} className="min-h-[48px] flex-1">Done</Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  return (
    <div ref={wrap} className={cn("relative min-w-0", className)}>
      {trigger}
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[300px] rounded-panel border border-hairline bg-surface p-2 shadow-panel">
          <div className="max-h-[360px] overflow-y-auto scroll-thin">{body}</div>
        </div>
      )}
    </div>
  );
}

function Row({
  checked, dim, label, meta, badge, strong, onClick,
}: {
  checked: boolean;
  dim?: boolean;
  label: string;
  meta?: string;
  badge?: number;
  strong?: boolean;
  onClick: () => void;
}) {
  return (
    <div className="group flex items-center rounded-input hover:bg-rowhover">
      <button
        type="button"
        role="option"
        aria-selected={checked}
        onClick={onClick}
        className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2.5 px-2 text-left md:min-h-[36px]"
      >
        <span
          className={cn(
            "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] border",
            checked ? (dim ? "border-navy/50 bg-navy/50" : "border-navy bg-navy") : "border-strongline"
          )}
        >
          {checked && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-[13.5px] text-ink", strong && "font-bold")}>{label}</span>
        {badge !== undefined && <CountBadge count={badge} className="shrink-0 py-0" />}
        {meta && <span className="shrink-0 text-micro tabular text-muted">{meta}</span>}
      </button>
    </div>
  );
}
