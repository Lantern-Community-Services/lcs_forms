import { categoryColor, tint } from "@/lib/calendar";
import type { CalendarCategory } from "@/lib/types";

export interface EventColor {
  solid: string;
  tint: string;
  name: string | null;
}

/** Each category's color by id. An event with no category (or a deleted one) is gray. */
export type ColorOf = Map<string, EventColor>;

export function colorMap(categories: CalendarCategory[] | undefined): ColorOf {
  return new Map((categories ?? []).map((c) => [c.id, { solid: categoryColor(c.colorSlot), tint: tint(categoryColor(c.colorSlot)), name: c.name }]));
}

const NONE: EventColor = { solid: categoryColor(null), tint: tint(categoryColor(null)), name: null };

export const colorOf = (colors: ColorOf, categoryId: string | null) => (categoryId && colors.get(categoryId)) || NONE;
