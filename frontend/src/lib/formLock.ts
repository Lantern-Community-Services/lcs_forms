import { useSyncExternalStore } from "react";

/**
 * Locking the device to one form, for handing it to a resident.
 *
 * Staff open a form, tap "Lock for resident" and choose a code. Until someone
 * enters that code, the app shows only that form: no sidebar, dock or launcher,
 * no admin links or other tabs, and any way out of the form (a link, the back
 * button) lands back on it. A code form can still move between its own pages.
 *
 * The lock is kept on the device (localStorage), so closing and reopening the
 * home-screen app, or reloading, doesn't undo it. It belongs to the person who
 * set it: someone else signing in on the device isn't locked. The code is kept
 * hashed, never as typed.
 */
export type FormLock = {
  /** Where the form lives: "/f/<slug>" or "/apps/<slug>". Anything under it stays open. */
  base: string;
  title: string;
  userId: string;
  hash: string;
  salt: string;
  at: string;
};

const KEY = "lcs-form-lock";
/** Wrong codes in a row before the pad waits. */
export const MAX_TRIES = 5;
export const WAIT_MS = 30_000;

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

async function hashCode(code: string, salt: string): Promise<string> {
  const text = `${salt}:${code}`;
  // crypto.subtle is only there on https and localhost; a LAN http dev address falls back.
  if (crypto.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `fnv:${(h >>> 0).toString(16)}`;
}

/** The form a pathname belongs to, when it's one that can be locked. */
export function lockBase(pathname: string): string | null {
  const m = /^\/(f|apps)\/([^/]+)/.exec(pathname);
  return m ? `/${m[1]}/${m[2]}` : null;
}

export function inLock(lock: FormLock, pathname: string) {
  if (lock.base.startsWith("/f/")) return pathname === lock.base;
  return pathname === lock.base || pathname.startsWith(`${lock.base}/`);
}

export async function lockForm(opts: { base: string; title: string; userId: string; code: string }) {
  const salt = Math.random().toString(36).slice(2, 10);
  emit({ base: opts.base, title: opts.title, userId: opts.userId, salt, hash: await hashCode(opts.code, salt), at: new Date().toISOString() });
}

/** Unlocks when the code is right. */
export async function unlockForm(code: string): Promise<boolean> {
  if (!current) return true;
  if ((await hashCode(code, current.salt)) !== current.hash) return false;
  emit(null);
  return true;
}

/** Signing out ends the lock: the next person signs in to an ordinary app. */
export function clearFormLock() {
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
