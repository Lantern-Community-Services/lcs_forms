import { prisma } from "../prisma.js";
import { badRequest } from "../http.js";
import { getSetting, setSetting } from "./settings.js";

/**
 * Where each site is. The starting data is Lantern Maps
 * (lantern-sitemap.netlify.app) as of 2026-09-25; after the first write the
 * locations belong to admins (Admin → Sites) and nothing here overwrites them.
 *
 * Matched to sites by code, then by name. Two buildings go by different names
 * on the map: Cedar Hall is City Cedars and Leeward Hall is Mi Casa (confirmed
 * by Collin, 2026-09-25).
 */
const SITE_MAP: { codes: string[]; name: string; address: string; lat: number; lng: number; shelter?: boolean }[] = [
  { codes: ["amber-hall"], name: "Amber Hall", address: "1385 Fulton Avenue, Bronx, NY 10456", lat: 40.834354, lng: -73.90226 },
  { codes: ["city-cedars", "cedar-hall"], name: "Cedar Hall", address: "745 Fox Street, Bronx, NY 10456", lat: 40.81538, lng: -73.898759 },
  { codes: ["hudson-bay"], name: "Hudson Bay", address: "1682 Stillwell Avenue, Bronx, NY 10461", lat: 40.855837, lng: -73.838736, shelter: true },
  { codes: ["jasper", "jasper-hall"], name: "Jasper Hall", address: "863 Melrose Avenue, Bronx, NY 10451", lat: 40.823902, lng: -73.91434 },
  { codes: ["mi-casa", "leeward-hall"], name: "Leeward Hall", address: "194 Brown Place, Bronx, NY 10454", lat: 40.806792, lng: -73.920645 },
  { codes: ["lindenguild", "lindenguild-hall"], name: "Lindenguild Hall", address: "3859 Third Avenue, Bronx, NY 10457", lat: 40.838556, lng: -73.90104 },
  { codes: ["silverleaf", "silverleaf-hall"], name: "Silverleaf Hall", address: "480 E 176th Street, Bronx, NY 10457", lat: 40.845825, lng: -73.89855 },
  { codes: ["vicinitas", "vicinitas-hall"], name: "Vicinitas Hall", address: "507 E 176th Street, Bronx, NY 10457", lat: 40.845535, lng: -73.897023 },
  { codes: ["audubon-hall"], name: "Audubon Hall", address: "440 West 163rd Street, New York, NY 10032", lat: 40.835911, lng: -73.938576 },
  { codes: ["huntersmoon", "huntersmoon-hall"], name: "Huntersmoon Hall", address: "2612 Broadway, New York, NY 10025", lat: 40.796168, lng: -73.970222 },
  { codes: ["prospero-hall"], name: "Prospero Hall", address: "100 E 118th Street, New York, NY 10035", lat: 40.800481, lng: -73.942196 },
  { codes: ["rustin-house"], name: "Rustin House", address: "319 W 94th Street, New York, NY 10025", lat: 40.794646, lng: -73.975245 },
  { codes: ["savanna-hall"], name: "Savanna Hall", address: "444 West 163rd Street, New York, NY 10032", lat: 40.835994, lng: -73.938865 },
  { codes: ["schafer-hall"], name: "Schafer Hall", address: "117 E 118th Street, New York, NY 10035", lat: 40.800371, lng: -73.941424 },
  { codes: ["stardom-hall"], name: "Stardom Hall", address: "330 W 51st Street, New York, NY 10019", lat: 40.763308, lng: -73.987117 },
  { codes: ["clover-hall"], name: "Clover Hall", address: "333 Kosciuszko Street, Brooklyn, NY 11221", lat: 40.692032, lng: -73.9413 },
  { codes: ["euclid-glenmore"], name: "Euclid-Glenmore", address: "437 Euclid Avenue, Brooklyn, NY 11208", lat: 40.676307, lng: -73.87192 },
  { codes: ["hunterfly-trace"], name: "Hunterfly Trace", address: "403 Howard Avenue, Brooklyn, NY 11233", lat: 40.674092, lng: -73.91938 },
  { codes: ["laurel-hall"], name: "Laurel Hall", address: "85-15 101st Avenue, Ozone Park, NY 11416", lat: 40.682282, lng: -73.853969, shelter: true },
  { codes: ["liberty-plaza"], name: "Liberty Plaza", address: "144-20 Liberty Avenue, Jamaica, NY 11435", lat: 40.692793, lng: -73.808036, shelter: true },
  { codes: ["rockaway-terrace"], name: "Rockaway Terrace", address: "4317 Rockaway Beach Blvd, Arverne, NY 11692", lat: 40.593412, lng: -73.775143, shelter: true },
];

/**
 * Default "at this site" radius. Big enough for a building plus indoor GPS
 * drift; where two sites sit next door to each other (Audubon/Savanna are 30 m
 * apart) the device picks whichever is nearer.
 */
export const DEFAULT_GEOFENCE_METERS = 200;

/** Fill in location, address and shelter type for sites that have none, once. Returns how many were filled. */
export async function ensureSiteLocations(): Promise<number> {
  if (await getSetting("siteLocationsSeeded")) return 0;
  const sites = await prisma.site.findMany();
  if (sites.length === 0) return 0; // Nothing imported yet — try again on a later boot.
  const norm = (s: string) => s.toLowerCase().replace(/\b(hall|house)\b/g, "").replace(/[^a-z0-9]/g, "");
  let n = 0;
  for (const site of sites) {
    if (site.latitude != null) continue;
    const m = SITE_MAP.find((x) => x.codes.includes(site.code)) ?? SITE_MAP.find((x) => norm(x.name) === norm(site.name));
    if (!m) continue;
    await prisma.site.update({
      where: { id: site.id },
      data: {
        latitude: m.lat,
        longitude: m.lng,
        address: site.address || m.address,
        ...(m.shelter && site.siteType === "supportive" ? { siteType: "shelter" } : {}),
      },
    });
    n++;
  }
  // Only once a known building was actually placed: a database holding just a
  // test site would otherwise mark this done before the real sites arrive.
  if (n > 0) await setSetting("siteLocationsSeeded", new Date().toISOString());
  return n;
}

/**
 * Address → coordinates via NYC Planning Labs GeoSearch (the city's own free
 * geocoder, no key, NYC addresses only). Only an admin's typed site address is
 * sent — never anyone's position.
 */
export async function geocode(address: string): Promise<{ latitude: number; longitude: number; label: string }> {
  const url = `https://geosearch.planninglabs.nyc/v2/search?${new URLSearchParams({ text: address, size: "1" })}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  } catch {
    throw badRequest("The address lookup didn't answer. Try again, or enter the coordinates by hand.");
  }
  if (!res.ok) throw badRequest("The address lookup failed. Enter the coordinates by hand.");
  const data = (await res.json()) as { features?: { geometry: { coordinates: [number, number] }; properties: { label?: string } }[] };
  const f = data.features?.[0];
  if (!f) throw badRequest("No match for that address. Check it, or enter the coordinates by hand.");
  const [longitude, latitude] = f.geometry.coordinates;
  return { latitude, longitude, label: f.properties.label ?? address };
}
