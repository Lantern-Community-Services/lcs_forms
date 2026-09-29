/**
 * The Hot Foods rules — ONE copy, imported by both the Record page (to ask for
 * a reason before Save) and the server (server/index.ts beforeCreate, which has
 * the final word). Per meal type: `limit` meals a day, and at a shelter
 * `cooldownMinutes` between two meals of the same type.
 */

export interface Limits {
  supportiveLimit: number;
  shelterLimit: number;
  cooldownMinutes: number;
}

export const DEFAULT_LIMITS: Limits = { supportiveLimit: 1, shelterLimit: 3, cooldownMinutes: 60 };

export interface Rules {
  limit: number;
  cooldownMinutes: number;
}

/** Shelters turn over fast: more meals a day, with a cooldown. Everything else follows supportive housing. */
export function rulesFor(limits: Limits, siteType: string): Rules {
  return siteType === "shelter" ? { limit: limits.shelterLimit, cooldownMinutes: limits.cooldownMinutes } : { limit: limits.supportiveLimit, cooldownMinutes: 0 };
}

/** itemId → one timestamp (ms) per meal of that type today. */
export type Served = Record<string, number[]>;

export interface Problem {
  itemId: string;
  kind: "limit" | "cooldown";
  text: string;
}

export function ruleProblems(rules: Rules, served: Served | undefined, cart: Record<string, number>, items: { id: string; name: string }[], now = Date.now()): Problem[] {
  const window = rules.cooldownMinutes * 60_000;
  const out: Problem[] = [];
  for (const item of items) {
    const qty = cart[item.id] ?? 0;
    if (!qty) continue;
    const times = served?.[item.id] ?? [];
    if (times.length + qty > rules.limit) {
      out.push({ itemId: item.id, kind: "limit", text: `${item.name}: ${times.length} today already (limit ${rules.limit} a day)` });
      continue;
    }
    if (!window) continue;
    const wait = cooldownLeft(rules, times, now);
    if (wait > 0) out.push({ itemId: item.id, kind: "cooldown", text: `${item.name}: last one ${minutes(window - wait)} ago (${rules.cooldownMinutes}-minute cooldown)` });
    else if (qty > 1) out.push({ itemId: item.id, kind: "cooldown", text: `${item.name}: ${qty} at once (${rules.cooldownMinutes}-minute cooldown between meals)` });
  }
  return out;
}

/** Ms until the cooldown on this meal type ends; 0 = none running. */
export function cooldownLeft(rules: Rules, times: number[], now = Date.now()) {
  if (!rules.cooldownMinutes || times.length === 0) return 0;
  return Math.max(0, Math.max(...times) + rules.cooldownMinutes * 60_000 - now);
}

export const minutes = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim() : `${m} min`;
};

/** One-tap reasons for serving someone past the daily limit or inside the shelter cooldown. */
export const OVER_LIMIT_REASONS = ["Picking up for a household member", "Missed an earlier meal", "Extra meals available", "Approved by site manager"];

/** Used when an entry recorded offline turns out to break a rule by the time it uploads. */
export const OFFLINE_REVIEW = "Review: recorded offline, over the limit when it uploaded";
