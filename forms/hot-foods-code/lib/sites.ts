import { useEffect, useMemo, useState } from "react";
import { device, type Site } from "@lcs/sdk";
import { distanceMeters, formatDistance } from "@lcs/ui";

/** Site pick-by-location, as the app's SiteLocator does it (the position never leaves the device's page). */

const DEFAULT_GEOFENCE = 200;
export type LocateStatus = "idle" | "locating" | "ok" | "unavailable";
export interface SiteDistance { site: Site; meters: number; inside: boolean }

const located = (s: Site): s is Site & { latitude: number; longitude: number } => s.latitude != null && s.longitude != null;

export function useNearbySite(sites: Site[] | undefined) {
  const enabled = (sites?.length ?? 0) > 1 && (sites ?? []).some(located);
  const [status, setStatus] = useState<LocateStatus>("idle");
  const [pos, setPos] = useState<{ latitude: number; longitude: number; accuracy: number } | null>(null);
  const locate = () => {
    setStatus("locating");
    void device.location({ timeoutMs: 12_000 }).then((p) => {
      setPos(p);
      setStatus(p ? "ok" : "unavailable");
    });
  };
  useEffect(() => {
    if (enabled && status === "idle") locate();
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  const ranked = useMemo<SiteDistance[] | null>(() => {
    if (!pos || !sites) return null;
    return sites
      .filter(located)
      .map((site) => {
        const meters = distanceMeters(pos, site);
        return { site, meters, inside: meters <= (site.geofenceMeters ?? DEFAULT_GEOFENCE) + Math.min(pos.accuracy, 100) };
      })
      .sort((a, b) => a.meters - b.meters);
  }, [pos, sites]);
  // Neighbouring sites can both be "inside"; the nearer one wins.
  const here = ranked?.find((r) => r.inside) ?? null;
  return { enabled, status, ranked, here, locate };
}

/** Options for the site <Select>: nearest first with a distance once the position is known. */
export function siteOptions(sites: Site[], ranked: SiteDistance[] | null) {
  if (!ranked) return sites.map((s) => ({ value: s.code, label: s.name }));
  const dist = new Map(ranked.map((r) => [r.site.code, r.meters]));
  return [...sites]
    .sort((a, b) => (dist.get(a.code) ?? Infinity) - (dist.get(b.code) ?? Infinity) || a.name.localeCompare(b.name))
    .map((s) => ({ value: s.code, label: dist.has(s.code) ? `${s.name} · ${formatDistance(dist.get(s.code)!)}` : s.name }));
}
