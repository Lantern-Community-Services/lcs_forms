import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { readStoredJson, writeStorage } from "@/lib/storage";
import type { TourEnd } from "./types";

/**
 * Which tours someone has finished or skipped (routes/tutorials.ts), so none
 * starts twice on any of their devices. Each record is also kept on the device
 * first: with no connection (offline mode) the PUT fails, and the tour mustn't
 * start again on the next screen. Records that didn't reach the server are
 * sent the next time the progress loads.
 */

export interface ProgressRow {
  key: string;
  version: number;
  status: TourEnd;
  step?: number | null;
  steps?: number | null;
}

export interface ProgressData {
  /** Admin → Sign-in access: whether the welcome tour starts by itself. */
  welcomeTour: boolean;
  items: ProgressRow[];
}

type LocalRow = ProgressRow & { unsynced?: boolean };

/** No account (a public form): this device only. */
const localKey = (userId: string | null) => `ln.tours.${userId ?? "public"}`;

function readLocal(userId: string | null): Record<string, LocalRow> {
  const raw = readStoredJson(localKey(userId));
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, LocalRow>) : {};
}

function writeLocal(userId: string | null, rows: Record<string, LocalRow>) {
  writeStorage(localKey(userId), Object.keys(rows).length ? JSON.stringify(rows) : null);
}

export const tutorialsKey = (userId: string | null) => ["tutorials", userId] as const;

export function useTutorialProgress(userId: string | null) {
  return useQuery({
    queryKey: tutorialsKey(userId),
    queryFn: async () => {
      const data = await api.get<ProgressData>("/tutorials");
      void sendUnsynced(userId, data);
      return data;
    },
    enabled: Boolean(userId),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/**
 * The version of `key` they finished or skipped, here or on any device: 0 for never.
 * The server's record decides. This device's own record counts only until it has
 * reached the server (offline), so a reset in People & roles takes effect on every
 * device. With no account (a public form) the device's record is all there is.
 */
export function seenVersion(data: ProgressData | undefined, userId: string | null, key: string): number {
  const server = data?.items.find((r) => r.key === key)?.version ?? 0;
  const mine = readLocal(userId)[key];
  const local = mine && (!userId || mine.unsynced) ? mine.version : 0;
  return Math.max(server, local);
}

export async function recordTour(qc: QueryClient, userId: string | null, row: ProgressRow) {
  const local = readLocal(userId);
  local[row.key] = { ...row, unsynced: Boolean(userId) };
  writeLocal(userId, local);
  if (!userId) return;
  qc.setQueryData<ProgressData>(tutorialsKey(userId), (d) => (d ? { ...d, items: [...d.items.filter((r) => r.key !== row.key), row] } : d));
  try {
    await api.put(`/tutorials/${encodeURIComponent(row.key)}`, { version: row.version, status: row.status, step: row.step ?? null, steps: row.steps ?? null });
    const now = readLocal(userId);
    if (now[row.key]) now[row.key].unsynced = false;
    writeLocal(userId, now);
  } catch {
    // Kept on the device; sendUnsynced tries again next time.
  }
}

async function sendUnsynced(userId: string | null, data: ProgressData) {
  if (!userId) return;
  const local = readLocal(userId);
  for (const row of Object.values(local)) {
    if (!row.unsynced) continue;
    const server = data.items.find((r) => r.key === row.key);
    if (server && server.version >= row.version) {
      row.unsynced = false;
      continue;
    }
    try {
      await api.put(`/tutorials/${encodeURIComponent(row.key)}`, { version: row.version, status: row.status, step: row.step ?? null, steps: row.steps ?? null });
      row.unsynced = false;
    } catch (e) {
      // Refused (a form deleted since): it never will be taken, so let it go. No connection: next time.
      if (e instanceof ApiError && e.status < 500) row.unsynced = false;
    }
  }
  writeLocal(userId, local);
}

/** Forget form tutorials (or everything), on the server and this device, so they start again. */
export async function resetTours(qc: QueryClient, userId: string, scope: "forms" | "all") {
  await api.delete(`/tutorials?scope=${scope}`);
  const local = readLocal(userId);
  for (const k of Object.keys(local)) if (scope === "all" || k.startsWith("form:")) delete local[k];
  writeLocal(userId, local);
  await qc.invalidateQueries({ queryKey: tutorialsKey(userId) });
}
