import { useSyncExternalStore } from "react";

/**
 * Locking the device to one form, for handing it to a resident.
 *
 * Staff open a form and tap "Lock for resident". Until someone taps Unlock,
 * the app shows only that form: no sidebar, dock or launcher,
 * no admin links or other tabs, and any way out of the form (a link, the back
 * button) lands back on it. A code form can still move between its own pages.
 *
 * The lock is kept on the device (localStorage), so closing and reopening the
 * home-screen app, or reloading, doesn't undo it. It belongs to the person who
 * set it: someone else signing in on the device isn't locked.
 */
export type FormLock = {
  /** Where the form lives: "/f/<slug>" or "/apps/<slug>". Anything under it stays open. */
  base: string;
  title: string;
  userId: string;
  at: string;
};

const KEY = "lcs-form-lock";

let current: FormLock | null = read();
const listeners = new Set<() => void>();

function read(): FormLock | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as FormLock) : null;
  } catch {
    return null;
  }
}

function emit(next: FormLock | null) {
  current = next;
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch {
    // storage blocked: the lock still holds until the app is reloaded
  }
  listeners.forEach((l) => l());
}

// Another tab locking or unlocking.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) {
      current = read();
      listeners.forEach((l) => l());
    }
  });
}

export function inLock(lock: FormLock, pathname: string) {
  if (lock.base.startsWith("/f/")) return pathname === lock.base;
  return pathname === lock.base || pathname.startsWith(`${lock.base}/`);
}

export function lockForm(opts: { base: string; title: string; userId: string }) {
  emit({ ...opts, at: new Date().toISOString() });
}

export function unlockForm() {
  if (current) emit(null);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The lock that applies to this person on this device, if any. */
export function useFormLock(userId: string | null | undefined): FormLock | null {
  const lock = useSyncExternalStore(subscribe, () => current);
  return lock && userId && lock.userId === userId ? lock : null;
}
