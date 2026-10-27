/**
 * How an entry was filled, as recorded with it (backend forms/fillMeta.ts):
 * the device, and the time from the first answer to submitting.
 */

export const deviceLabel = (k: string | null | undefined) => (k === "phone" ? "Phone" : k === "tablet" ? "Tablet" : k === "desktop" ? "Computer" : "—");

/** "45 s", "4 min 12 s", "1 h 5 min"; "—" when unknown. */
export function fillTimeText(seconds: number | null | undefined) {
  if (typeof seconds !== "number") return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
