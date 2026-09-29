/** New York calendar helpers — Lantern's sites are in New York, the server may not be. */
export const TZ = "America/New_York";

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

export function dayOf(d: Date | string): string {
  return dayFmt.format(typeof d === "string" ? new Date(d) : d);
}

export const today = () => dayOf(new Date());

/** Offset of New York from UTC at a moment, in ms. */
function nyOffset(at: Date) {
  const ny = new Date(at.toLocaleString("en-US", { timeZone: TZ }));
  const utc = new Date(at.toLocaleString("en-US", { timeZone: "UTC" }));
  return utc.getTime() - ny.getTime();
}

export function startOfDay(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`"${day}" isn't a YYYY-MM-DD day.`);
  const noon = new Date(`${day}T12:00:00Z`);
  return new Date(Date.parse(`${day}T00:00:00Z`) + nyOffset(noon));
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** A "from" bound: a day means its start; an ISO time is taken as is. */
export function lowerBound(v: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? startOfDay(v) : new Date(v);
}

/** A "to" bound: a day includes the whole day. */
export function upperBound(v: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? startOfDay(addDays(v, 1)) : new Date(v);
}

const partFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23", weekday: "short" });
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** New York day, hour and weekday (0 = Monday) of a moment. */
export function partsOf(iso: string) {
  const d = new Date(iso);
  const parts = partFmt.formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const weekday = WEEKDAYS.indexOf(parts.find((p) => p.type === "weekday")?.value ?? "Mon");
  return { day: dayOf(d), hour, weekday };
}
