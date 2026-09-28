/**
 * localStorage that never throws.
 *
 * Private mode, a full quota or blocked site data all make it refuse, and
 * everything this app keeps there is a per-device convenience (the sites last
 * picked, a collapsed sidebar, the shift's meal). A refusal just means starting
 * from the default next time — never a reason to fail the screen.
 */

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** `null` removes the key. */
export function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Refused — see above.
  }
}

/** The parsed JSON under `key`, or null when it's missing or isn't JSON. Callers still check its shape. */
export function readStoredJson(key: string): unknown {
  const raw = readStorage(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
