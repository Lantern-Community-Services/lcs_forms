import { defineServer, UserError, type Ctx } from "@lcs/server";
import { DEFAULT_LIMITS, ruleProblems, rulesFor, type Limits, type Served } from "../lib/rules";
import { DEFAULT_MEAL_TYPES, type Item, type MealEntry, type MealType, type Report, type Today } from "../lib/types";

/**
 * Hot Foods on the server. beforeCreate is the final word on every entry: the
 * signature is there, the meals exist, and the per-meal-type limits and
 * shelter cooldown hold — or the person gave a reason. The actions feed the
 * Record screen (today's counts, who comes most often) and Reports.
 */

const READERS = new Set(["main_office", "site_admin", "site_manager", "developer", "admin"]);
const REGULARS_DAYS = 30;
/** Fields Record and Reports need — never the signature (tens of KB each). */
const LIGHT = ["items", "mealCount", "tenantName", "unit"];

function limits(ctx: Ctx): Limits {
  const doc = ctx.db.collections.get<Partial<Limits>>("settings", "limits");
  return { ...DEFAULT_LIMITS, ...(doc?.data ?? {}) };
}

/** Meal types, seeded with the WordPress set the first time the form is used. */
function mealTypes(ctx: Ctx): Item[] {
  let docs = ctx.db.collections.list<MealType>("mealTypes");
  if (!docs.length) {
    DEFAULT_MEAL_TYPES.forEach((m, i) => ctx.db.collections.put("mealTypes", `meal-${i + 1}`, m));
    docs = ctx.db.collections.list<MealType>("mealTypes");
  }
  return docs.map((d) => ({ id: d.id, ...d.data })).sort((a, b) => a.sortOrder - b.sortOrder);
}

/** itemId → timestamps, one per meal, for a list of entries. */
function servedFrom(entries: { occurredAt: string; data: Pick<MealEntry, "items"> }[]): Served {
  const out: Served = {};
  for (const e of entries) {
    const t = Date.parse(e.occurredAt);
    for (const line of e.data.items ?? []) (out[line.itemId] ??= []).push(...Array<number>(line.quantity).fill(t));
  }
  return out;
}

function canRead(ctx: Ctx) {
  return Boolean(ctx.user && (READERS.has(ctx.user.roleKey) || ctx.user.permissions.includes("forms.manage")));
}

export default defineServer({
  beforeCreate(entry, ctx) {
    const data = entry.data as Partial<MealEntry> & { cart?: Record<string, number> };
    if (!entry.site) return { errors: { site: "Pick the site you're serving at." } };
    if (!entry.resident) return { errors: { tenantId: "Pick the resident." } };
    if (typeof data.signature !== "string" || !data.signature.startsWith("data:image/png;base64,")) return { errors: { signature: "The resident needs to sign." } };
    if (data.signature.length > 400_000) return { errors: { signature: "That signature image is too large." } };

    const items = mealTypes(ctx);
    const cart = data.cart ?? {};
    const lines = items.filter((i) => (cart[i.id] ?? 0) > 0).map((i) => ({ itemId: i.id, itemName: i.name, quantity: Math.min(20, Math.floor(cart[i.id])), slot: i.colorSlot }));
    if (!lines.length) return { errors: { cart: "Choose at least one meal." } };
    if (Object.keys(cart).some((id) => !items.some((i) => i.id === id))) return { errors: { cart: "One of those meal types doesn't exist any more. Reload and try again." } };

    // Their meals today at this site (New York day of when it was served).
    const day = ctx.time.dayOf(entry.occurredAt);
    const earlier = ctx.db.entries.find<MealEntry>({ tenantId: entry.resident.id, siteId: entry.site.id, from: day, to: day, fields: ["items"] });
    const rules = rulesFor(limits(ctx), entry.site.siteType);
    const problems = ruleProblems(rules, servedFrom(earlier), cart, items, Date.parse(entry.occurredAt));
    if (problems.length && !entry.override) return { needsOverride: problems.map((p) => p.text) };

    const saved: MealEntry = {
      items: lines,
      mealCount: lines.reduce((n, l) => n + l.quantity, 0),
      notes: typeof data.notes === "string" && data.notes.trim() ? data.notes.trim().slice(0, 500) : undefined,
      signature: data.signature,
      tenantName: entry.resident.name,
      unit: entry.resident.unit,
    };
    return { data: saved };
  },

  actions: {
    /** Meal types in order (shown ones only, unless { all: true }). Seeds the defaults the first time. */
    mealTypes(args: { all?: boolean } | null, ctx): Item[] {
      const list = mealTypes(ctx);
      return args?.all ? list : list.filter((m) => m.active);
    },

    /** Everything the Record screen needs for one site. */
    today({ site }: { site: string }, ctx): Today {
      const s = ctx.roster.site(site);
      if (!s) throw new UserError("You don't have access to that site.");
      mealTypes(ctx);
      const rules = rulesFor(limits(ctx), s.siteType);
      const todays = ctx.db.entries.find<MealEntry>({ siteId: s.id, from: ctx.today, to: ctx.today, fields: ["items"], limit: 5000 });
      const counts: Record<string, number> = {};
      const byTenant: Record<string, typeof todays> = {};
      for (const e of todays) {
        if (!e.tenantId) continue;
        counts[e.tenantId] = (counts[e.tenantId] ?? 0) + 1;
        (byTenant[e.tenantId] ??= []).push(e);
      }
      const meals = Object.fromEntries(Object.entries(byTenant).map(([t, list]) => [t, servedFrom(list)]));
      // Who comes most often: meals here over the 30 days before today (today is left
      // out so the order doesn't shift under staff mid-shift).
      const past = ctx.db.entries.find<MealEntry>({ siteId: s.id, from: ctx.time.addDays(ctx.today, -REGULARS_DAYS), to: ctx.time.addDays(ctx.today, -1), fields: ["mealCount"], limit: 5000 });
      const regulars: Record<string, number> = {};
      for (const e of past) if (e.tenantId) regulars[e.tenantId] = (regulars[e.tenantId] ?? 0) + (e.data.mealCount ?? 1);
      return { day: ctx.today, ...rules, isShelter: s.siteType === "shelter", counts, meals, regulars, regularsDays: REGULARS_DAYS };
    },

    /** The Reports tab, for any of the person's sites and a date range. */
    report({ from, to, sites }: { from: string; to: string; sites?: string[] }, ctx): Report {
      if (!canRead(ctx)) throw new UserError("Reports are for roles that can read Hot Foods entries.");
      const all = ctx.roster.sites();
      const chosen = sites?.length ? all.filter((s) => sites.includes(s.code)) : all;
      const ids = new Set(chosen.map((s) => s.id));
      const MAX = 20_000;
      const found = ctx.db.entries.find<MealEntry>({ from, to, fields: LIGHT, limit: MAX });
      const rows = found.filter((e) => e.siteId && ids.has(e.siteId));
      const voided = ctx.db.entries.find({ from, to, status: "voided", fields: [], limit: 5000 }).filter((e) => e.siteId && ids.has(e.siteId)).length;
      const items = mealTypes(ctx);
      const slotOf = new Map(items.map((i) => [i.id, i.colorSlot]));
      const nameOf = new Map(items.map((i) => [i.id, i.name]));

      const days: string[] = [];
      for (let d = from; d <= to && days.length < 400; d = ctx.time.addDays(d, 1)) days.push(d);
      const byDay = new Map(days.map((d) => [d, { day: d, entries: 0, meals: 0, parts: {} as Record<string, number> }]));
      const bySite = new Map(chosen.map((s) => [s.id, { code: s.code, name: s.name, siteType: s.siteType, entries: 0, meals: 0, residents: new Set<string>() }]));
      const byItem = new Map<string, { key: string; name: string; slot: number | null; quantity: number }>();
      const byStaff = new Map<string, number>();
      const heat = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
      const residents = new Set<string>();
      let meals = 0;
      let overrides = 0;

      for (const e of rows) {
        const { day, hour, weekday } = ctx.time.partsOf(e.occurredAt);
        const count = e.data.mealCount ?? 0;
        meals += count;
        if (e.overrideReason) overrides++;
        if (e.tenantId) residents.add(e.tenantId);
        // HeatGrid rows run Sunday to Saturday (partsOf counts from Monday); it shows meals, as the built-in report does.
        heat[(weekday + 1) % 7][hour] += count;
        byStaff.set(e.createdByName, (byStaff.get(e.createdByName) ?? 0) + 1);
        const d = byDay.get(day);
        if (d) {
          d.entries++;
          d.meals += count;
        }
        const site = e.siteId ? bySite.get(e.siteId) : undefined;
        if (site) {
          site.entries++;
          site.meals += count;
          if (e.tenantId) site.residents.add(e.tenantId);
        }
        for (const line of e.data.items ?? []) {
          if (d) d.parts[line.itemId] = (d.parts[line.itemId] ?? 0) + line.quantity;
          const it = byItem.get(line.itemId) ?? { key: line.itemId, name: nameOf.get(line.itemId) ?? line.itemName, slot: slotOf.has(line.itemId) ? slotOf.get(line.itemId)! : line.slot, quantity: 0 };
          it.quantity += line.quantity;
          byItem.set(line.itemId, it);
        }
      }
      const itemList = [...byItem.values()].sort((a, b) => b.quantity - a.quantity);
      return {
        from,
        to,
        sites: chosen.map((s) => ({ code: s.code, name: s.name, siteType: s.siteType })),
        totals: { entries: rows.length, meals, residents: residents.size, overrides, voided, days: days.length, avgMealsPerDay: meals / Math.max(1, days.length) },
        truncated: found.length === MAX,
        // Fixed color order, so a meal type keeps its color on every chart.
        series: [...itemList].sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99)).map((i) => ({ key: i.key, name: i.name, slot: i.slot })),
        byDay: [...byDay.values()],
        bySite: [...bySite.values()].map((s) => ({ ...s, residents: s.residents.size })).sort((a, b) => b.meals - a.meals),
        byItem: itemList,
        heat,
        byStaff: [...byStaff.entries()].map(([name, entries]) => ({ name, entries })).sort((a, b) => b.entries - a.entries),
      };
    },
  },
});
