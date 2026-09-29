/** Shapes shared by the pages and the server. */

/** A kind of meal ("Individual Meals"), in the mealTypes collection. Hidden rather than deleted once used. */
export interface MealType {
  name: string;
  imageUrl?: string | null;
  active: boolean;
  sortOrder: number;
  /** Report color: a slot 0-7 of the chart palette, fixed per meal type. null = "Other" gray. */
  colorSlot: number | null;
}

export interface Item extends MealType {
  id: string;
}

/** What one entry's data holds. Names and colors are snapshots, so renaming a meal type keeps history honest. */
export interface MealEntry {
  items: { itemId: string; itemName: string; quantity: number; slot: number | null }[];
  mealCount: number;
  notes?: string;
  /** PNG data URL of the resident's signature. */
  signature: string;
  tenantName: string;
  unit: string | null;
}

/** actions.call("today", { site }) */
export interface Today {
  limit: number;
  cooldownMinutes: number;
  isShelter: boolean;
  /** tenantId → entries today at this site. */
  counts: Record<string, number>;
  /** tenantId → itemId → one timestamp (ms) per meal of that type today. */
  meals: Record<string, Record<string, number[]>>;
  /** tenantId → meals at this site over the regularsDays days before today. */
  regulars: Record<string, number>;
  regularsDays: number;
}

/** actions.call("report", { from, to, sites }) */
export interface Report {
  from: string;
  to: string;
  sites: { code: string; name: string; siteType: string }[];
  totals: { entries: number; meals: number; residents: number; overrides: number; voided: number; days: number; avgMealsPerDay: number };
  series: { key: string; name: string; slot: number | null }[];
  byDay: { day: string; entries: number; meals: number; parts: Record<string, number> }[];
  bySite: { code: string; name: string; siteType: string; entries: number; meals: number; residents: number }[];
  byItem: { key: string; name: string; slot: number | null; quantity: number }[];
  heat: number[][];
  byStaff: { name: string; entries: number }[];
  /** More entries than one report reads (20,000): pick a shorter range. */
  truncated?: boolean;
}

export const DEFAULT_MEAL_TYPES: MealType[] = [
  { name: "Individual Meals", imageUrl: "https://forms.lanterncommunity.org/wp-content/uploads/FoodItems/TogoContainer.webp", active: true, sortOrder: 0, colorSlot: 0 },
  { name: "Holiday Meals", imageUrl: "https://forms.lanterncommunity.org/wp-content/uploads/FoodItems/HolidayItem.jpg", active: true, sortOrder: 1, colorSlot: 3 },
  { name: "Family Style Meal", imageUrl: "https://forms.lanterncommunity.org/wp-content/uploads/FoodItems/FamilyDinner.webp", active: true, sortOrder: 2, colorSlot: 1 },
  { name: "Special Event Meal", imageUrl: "https://forms.lanterncommunity.org/wp-content/uploads/FoodItems/Special.jpg", active: true, sortOrder: 3, colorSlot: 2 },
  { name: "Holiday Treats", imageUrl: "https://forms.lanterncommunity.org/wp-content/uploads/FoodItems/cover-collection-holidays.png", active: true, sortOrder: 4, colorSlot: 4 },
];
