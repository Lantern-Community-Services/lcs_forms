/**
 * Opens an IndexedDB database, giving up after `timeoutMs`.
 *
 * Storage that never answers must not leave a screen on skeletons or a save on
 * a spinner: iOS Safari has had releases where `indexedDB.open` neither
 * succeeds nor fails until the app is relaunched, and a database delete stuck
 * behind another tab's connection queues every later open behind it. Callers
 * fall back (the roster loads from the server) or say the save failed. A
 * connection that only arrives after the timeout is closed straight away.
 */
export function openDatabase(
  name: string,
  version: number,
  upgrade: (db: IDBDatabase) => void,
  timeoutMs = 5000
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };
    const timer = setTimeout(() => settle(() => reject(new Error("This device's storage didn't answer."))), timeoutMs);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(name, version);
    } catch (e) {
      settle(() => reject(e));
      return;
    }
    req.onupgradeneeded = () => upgrade(req.result);
    req.onsuccess = () => {
      if (settled) req.result.close();
      else settle(() => resolve(req.result));
    };
    req.onerror = () => settle(() => reject(req.error ?? new Error("This device's storage failed.")));
    req.onblocked = () => settle(() => reject(new Error("Storage is blocked.")));
  });
}
