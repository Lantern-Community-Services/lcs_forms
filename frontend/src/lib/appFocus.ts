import { useSyncExternalStore } from "react";

/**
 * A code form's full-screen mode (SDK `app.focus(true)`): while a multi-step
 * report is being filled in on a phone or tablet, the shell hides the dock and
 * the form hides its tabs, so the report has the whole screen and its own close
 * and Next. AppHostPage turns it off whenever the form's page changes or closes.
 */
let focused = false;
const listeners = new Set<() => void>();

export function setAppFocus(on: boolean) {
  if (focused === on) return;
  focused = on;
  listeners.forEach((l) => l());
}

export function useAppFocus(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => focused,
    () => false
  );
}
