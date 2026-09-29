import { useSyncExternalStore } from "react";

/**
 * How the open screen wants the sidebar, when it has a preference. Code forms
 * set this from their page's form.json "nav"; everything else leaves it null
 * and gets the default (fold to icons on a portrait iPad inside a form).
 *   auto   — the default rule
 *   tablet — fold on any tablet, portrait or landscape
 *   always — fold on every screen wide enough to show the sidebar
 *   never  — leave it as the person set it
 */
export type NavMode = "auto" | "tablet" | "always" | "never";

let mode: NavMode | null = null;
const listeners = new Set<() => void>();

export function setNavMode(next: NavMode | null) {
  if (next === mode) return;
  mode = next;
  listeners.forEach((l) => l());
}

export function useNavMode(): NavMode | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => mode
  );
}
