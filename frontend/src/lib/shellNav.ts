import { useSyncExternalStore } from "react";

/**
 * How the open screen wants the sidebar, when it has a preference. Code forms
 * set this from their page's form.json "nav"; everything else leaves it null
 * and gets the default (fold to icons in a portrait-shaped window inside a form).
 * Only the desktop sidebar folds: phones and tablets get the dock instead.
 *   auto   — the default rule
 *   tablet — now the same as auto (it folded the sidebar on tablets, which no longer have one)
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
