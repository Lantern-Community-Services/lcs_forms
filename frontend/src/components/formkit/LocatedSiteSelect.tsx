import { useEffect, useMemo, useRef } from "react";
import { Loader2, LocateFixed, MapPin, MapPinOff } from "lucide-react";
import { Select } from "@/components/ui/select";
import { formatDistance, hasLocation, sitesByDistance, useCurrentPosition } from "@/lib/location";
import type { Site } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Nothing picked and not standing at a site: start on the nearest one this close, as the code forms do. */
const NEAREST_WITHIN = 5000;

/**
 * A basic form's site picker, matching the code forms' SitePicker
 * (@lcs/components/SitePicker): with one site it's filled in; with more, sites
 * are listed nearest first with their distance and the site you're standing at
 * is picked for you. The position stays on the device. It only fills an empty
 * picker, so an entry being edited or a restored draft keeps its site; when
 * you're at a different site than the one chosen, the pin offers to switch.
 * Picking by hand stops it changing anything on its own.
 */
export function LocatedSiteSelect({
  sites,
  value,
  onChange,
  disabled,
  loading,
  id,
  className,
}: {
  sites: Site[] | undefined;
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  loading?: boolean;
  id?: string;
  className?: string;
}) {
  const list = useMemo(() => sites ?? [], [sites]);
  const canLocate = !disabled && list.length > 1 && list.some(hasLocation);
  const { status, position, locate } = useCurrentPosition(canLocate);
  const chosenByHand = useRef(false);

  const ranked = useMemo(() => (canLocate && position ? sitesByDistance(list, position) : null), [canLocate, position, list]);
  // Neighbouring sites can both be "inside"; the nearer one wins.
  const here = ranked?.find((r) => r.inside) ?? null;
  const nearest = ranked?.[0] ?? null;

  // One site: it's that one.
  useEffect(() => {
    if (!value && list.length === 1) onChange(list[0].code);
  }, [sites]); // eslint-disable-line react-hooks/exhaustive-deps

  // Located: fill an empty picker with the site you're at, or else the nearest within 5 km.
  useEffect(() => {
    if (value || chosenByHand.current || disabled || !ranked) return;
    const pick = here ?? (nearest && nearest.meters <= NEAREST_WITHIN ? nearest : null);
    if (pick) onChange(pick.site.code);
  }, [ranked]); // eslint-disable-line react-hooks/exhaustive-deps

  const options = useMemo(() => {
    if (!ranked) return list.map((s) => ({ value: s.code, label: s.name }));
    const dist = new Map(ranked.map((r) => [r.site.code, r.meters]));
    return [...list]
      .sort((a, b) => (dist.get(a.code) ?? Infinity) - (dist.get(b.code) ?? Infinity) || a.name.localeCompare(b.name))
      .map((s) => ({ value: s.code, label: dist.has(s.code) ? `${s.name} · ${formatDistance(dist.get(s.code)!)}` : s.name }));
  }, [list, ranked]);

  const pick = (code: string) => {
    chosenByHand.current = true;
    onChange(code);
  };

  const locating = canLocate && status === "locating";
  const pinned = !!here && here.site.code === value;
  const off = canLocate && (status === "denied" || status === "unavailable");
  const elsewhere = canLocate && status === "ok" && !!here && here.site.code !== value;
  const icon = locating || pinned || off || elsewhere;
  const btn = "absolute inset-y-0 left-0 z-[1] flex w-10 items-center justify-center rounded-l-input";

  return (
    <div className="relative">
      <Select
        id={id}
        value={value}
        onChange={(e) => pick(e.target.value)}
        disabled={disabled || loading}
        placeholder={loading ? "Loading…" : !value && locating ? "Finding your location…" : "Pick a site…"}
        options={options}
        className={cn(className, icon && "!pl-10")}
      />
      {locating && (
        <span className={cn(btn, "pointer-events-none text-muted")} role="status" aria-label="Finding your location">
          <Loader2 className="h-[18px] w-[18px] animate-spin" />
        </span>
      )}
      {!locating && pinned && (
        <span className={cn(btn, "pointer-events-none text-status-greenText")} title="Picked from your location" aria-label="Picked from your location">
          <MapPin className="h-[18px] w-[18px]" />
        </span>
      )}
      {!locating && off && (
        <button type="button" onClick={locate} className={cn(btn, "text-muted hover:text-ink")} title="Location is off — tap to try again" aria-label="Location is off. Try again">
          <MapPinOff className="h-[18px] w-[18px]" />
        </button>
      )}
      {!locating && elsewhere && (
        <button
          type="button"
          onClick={() => pick(here!.site.code)}
          className={cn(btn, "text-accent hover:bg-rowhover dark:text-white")}
          title={`You seem to be at ${here!.site.name} — tap to switch`}
          aria-label={`You seem to be at ${here!.site.name}. Switch to it`}
        >
          <LocateFixed className="h-[18px] w-[18px]" />
        </button>
      )}
    </div>
  );
}
