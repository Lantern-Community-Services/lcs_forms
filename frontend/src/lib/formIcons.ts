import { createElement, useEffect, useState } from "react";
import {
  Banknote, Boxes, Briefcase, Bus, Calendar, CalendarPlus, Camera, ClipboardList, Contact, File, Folder, Gift, HardHat, Heart,
  History, House, Inbox, Laptop, LifeBuoy, Lock, MessageSquare, Monitor, Newspaper, Package, PartyPopper, PiggyBank, Receipt,
  SearchCheck, Shield, ShoppingBasket, ShoppingCart, Soup, Ticket, TrainFront, TriangleAlert, UserPlus, Users, Utensils, Wallet,
  type LucideIcon,
} from "lucide-react";
import type { PermissionKey } from "./types";

/**
 * Icons a form category or a form can wear: all of Lucide (lucide.dev, free,
 * ISC licence) bar brand logos, about 1,500. They are generated into
 * formIconSet.ts by scripts/gen-form-icons.mjs, together with the backend's
 * list of accepted keys (backend/src/forms/iconKeys.ts). Keys are stored in the
 * database, so one that has shipped is never renamed or dropped.
 *
 * The full set is big, so it loads on demand. The 39 icons the app started
 * with (CORE_ICONS) are always on hand: they cover the sidebar and the Forms
 * screen on first paint, and an icon outside them draws as a blank square of
 * the same size for the instant its chunk takes to arrive.
 */
export interface FormIconDef {
  key: string;
  label: string;
  /** Lowercase words the picker's search also matches. */
  tags: string;
  Icon: LucideIcon;
}

export type FormIconKey = string;

/** The original keys. Must stay in step with LEGACY in scripts/gen-form-icons.mjs. */
const CORE_ICONS: Record<string, LucideIcon> = Object.assign(Object.create(null) as Record<string, LucideIcon>, {
  folder: Folder, utensils: Utensils, users: Users, bus: Bus, wallet: Wallet, shield: Shield, briefcase: Briefcase, monitor: Monitor,
  home: House, heart: Heart, calendar: Calendar, clipboard: ClipboardList, package: Package, file: File, basket: ShoppingBasket,
  soup: Soup, cart: ShoppingCart, boxes: Boxes, contact: Contact, camera: Camera, gift: Gift, inspect: SearchCheck, party: PartyPopper,
  "calendar-plus": CalendarPlus, train: TrainFront, ticket: Ticket, banknote: Banknote, "piggy-bank": PiggyBank, receipt: Receipt,
  lock: Lock, alert: TriangleAlert, newspaper: Newspaper, "user-plus": UserPlus, "hard-hat": HardHat, message: MessageSquare,
  laptop: Laptop, help: LifeBuoy, history: History, inbox: Inbox,
});

let loading: Promise<readonly FormIconDef[]> | null = null;
let loaded: readonly FormIconDef[] | null = null;
const byKey = new Map<string, FormIconDef>();

/** Fetches the full icon set once; every caller shares the one request. */
export function loadFormIconSet(): Promise<readonly FormIconDef[]> {
  loading ??= import("./formIconSet").then((m) => {
    loaded = m.FORM_ICON_LIST;
    for (const i of loaded) byKey.set(i.key, i);
    return loaded;
  });
  // A failed fetch (offline, first run) is tried again the next time something asks.
  loading.catch(() => (loading = null));
  return loading;
}

/** The full icon set for the picker: null until it has loaded. */
export function useFormIconSet(): readonly FormIconDef[] | null {
  const [list, setList] = useState(loaded);
  useEffect(() => {
    if (!list) loadFormIconSet().then(setList, () => {});
  }, [list]);
  return list;
}

/** One component per key, so a card keeps the same element type across renders. */
const lazyIcons = new Map<string, LucideIcon>();
function lazyIcon(key: string): LucideIcon {
  let Lazy = lazyIcons.get(key);
  if (!Lazy) {
    const Component = (props: React.ComponentProps<LucideIcon>) => {
      const [def, setDef] = useState(() => byKey.get(key));
      useEffect(() => {
        // Not in the set at all (an old or mistyped key): the folder, as ever.
        if (!def) loadFormIconSet().then(() => setDef(byKey.get(key) ?? { key, label: "Folder", tags: "", Icon: Folder }), () => {});
      }, [def]);
      return def ? createElement(def.Icon, props) : createElement("svg", { className: props.className, "aria-hidden": true });
    };
    // Called like any Lucide icon (<Icon className=… />), which is all of it that callers use.
    Lazy = Component as unknown as LucideIcon;
    lazyIcons.set(key, Lazy);
  }
  return Lazy;
}

export function formIcon(key: string): LucideIcon {
  return CORE_ICONS[key] ?? (key ? lazyIcon(key) : Folder);
}

/**
 * Icons whose name or tags contain every word of `query`. Whole-word matches
 * come first ("house" finds the house before "warehouse"), then names starting
 * with the word, then anything containing it.
 */
export function searchFormIcons(list: readonly FormIconDef[], query: string): readonly FormIconDef[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  const scored: [number, FormIconDef][] = [];
  for (const icon of list) {
    const label = icon.label.toLowerCase();
    const hay = `${icon.key} ${label} ${icon.tags}`;
    if (!words.every((w) => hay.includes(w))) continue;
    const whole = new Set(hay.split(/[\s-]+/));
    const labelWords = label.split(/\s+/);
    const tier = words.every((w) => whole.has(w)) ? 0 : words.every((w) => labelWords.some((l) => l.startsWith(w))) ? 1 : 2;
    scored.push([tier, icon]);
  }
  // Array.sort is stable, so within a tier the original icons come first, then A to Z.
  return scored.sort((a, b) => a[0] - b[0]).map(([, i]) => i);
}

/** A form's own icon, or its category's when it has none. */
export function formLinkIcon(form: { icon?: string | null }, categoryIcon: string) {
  return formIcon(form.icon || categoryIcon);
}

/** A form built into this app ("/roster") rather than a link out to WordPress. */
export function isInternalForm(url: string) {
  return url.startsWith("/") && !url.startsWith("//");
}

/**
 * App paths a catalog entry can point at that need more than a session. The
 * Forms screen shows such a card locked, and the sidebar leaves it out, rather
 * than offering a link that just bounces the person back to Forms.
 */
const ROSTER_HINT = "You need roster access for this. Ask an administrator to give you a roster role.";
const INTERNAL_NEEDS: { prefix: string; anyOf: PermissionKey[]; hint: string }[] = [
  { prefix: "/roster", anyOf: ["roster.view"], hint: ROSTER_HINT },
  { prefix: "/tenants", anyOf: ["roster.view"], hint: ROSTER_HINT },
  // Recording needs roster.edit; Main Office can still read entries and reports.
  { prefix: "/forms/hot-foods", anyOf: ["roster.edit", "entries.view"], hint: "You need a site role to record Hot Foods. Ask an administrator." },
];

export function formNeeds(url: string) {
  if (!isInternalForm(url)) return undefined;
  return INTERNAL_NEEDS.find((n) => url.startsWith(n.prefix));
}

/** Can this person open the form at `url`? */
export function canOpenForm(url: string, can: (p: PermissionKey) => boolean) {
  const needs = formNeeds(url);
  return !needs || needs.anyOf.some(can);
}
