import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, API_BASE, ApiError, NetworkError } from "./api";
import { shrinkPhotoFile } from "./upload";
import { isSample } from "./tour/sampleData";

/**
 * A resident's whole record (case management, with client information): the
 * timeline of everything about them and their documents (backend
 * routes/clientRecord.ts). Kept under ["roster", …] so a move or a checklist
 * tick, which refreshes the roster, refreshes these too.
 */

export type TimelineKind = "entry" | "moved_in" | "transferred" | "moved_out" | "removed" | "away" | "back" | "task_done" | "task_skipped" | "document";

export interface ClientDocument {
  id: string;
  kind: string;
  kindLabel: string;
  label: string | null;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
  createdByName: string;
}

export interface TimelineItem {
  key: string;
  kind: TimelineKind;
  at: string;
  /** Only the day is known: "YYYY-MM-DD". Null for form entries and documents (they have a time). */
  day: string | null;
  title: string;
  detail: string | null;
  by: string | null;
  site: string | null;
  entry?: {
    id: string;
    form: { id: string; slug: string; title: string; kind: "basic" | "code" };
    archived: boolean;
    followUp: { status: string; doneAt: string | null; doneByName: string | null } | null;
    signOff: { status: string; signed: string[] } | null;
    noteCount: number;
    link: string;
  };
  document?: ClientDocument;
}

export interface DocumentsResponse {
  items: ClientDocument[];
  canEdit: boolean;
  kinds: { key: string; label: string }[];
  accept: string;
  maxBytes: number;
}

export function useClientTimeline(tenantId: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ["roster", "timeline", tenantId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.get<{ items: TimelineItem[]; next: string | null }>(`/tenants/${tenantId}/timeline${pageParam ? `?${new URLSearchParams({ before: pageParam })}` : ""}`),
    getNextPageParam: (last) => last.next,
    enabled: enabled && !isSample(tenantId),
  });
}

export function useClientDocuments(tenantId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["roster", "documents", tenantId],
    queryFn: () => api.get<DocumentsResponse>(`/tenants/${tenantId}/documents`),
    enabled: enabled && !isSample(tenantId),
  });
}

/** Where a document opens (PDFs and photos in the browser) or, with download, is saved. Never kept on the device (public/sw.js). */
export function documentUrl(tenantId: string, docId: string, download = false) {
  return `${API_BASE}/tenants/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(docId)}${download ? "?download=1" : ""}`;
}

/**
 * Send one document. A photo is shrunk first, like every photo the app sends
 * (lib/upload.ts); the file goes whole, as the raw body, with what it is in
 * headers (up to 20 MB, under the web proxy's limit, so never in parts).
 */
export async function uploadDocument(tenantId: string, file: File, kind: string, label: string): Promise<ClientDocument> {
  const toSend = file.type.startsWith("image/") ? await shrinkPhotoFile(file) : file;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/tenants/${encodeURIComponent(tenantId)}/documents`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-File-Name": encodeURIComponent(toSend.name),
        "X-Document-Kind": encodeURIComponent(kind),
        "X-Document-Label": encodeURIComponent(label),
      },
      body: toSend,
    });
  } catch {
    throw new NetworkError();
  }
  if (!res.ok) {
    let payload: { error?: string; details?: unknown; requestId?: string } | undefined;
    try {
      payload = await res.json();
    } catch {
      // not JSON (a proxy's page)
    }
    throw new ApiError(res.status, payload?.error ?? (res.status === 413 ? "That file is too big." : res.statusText), payload?.details, payload?.requestId);
  }
  return (await res.json()) as ClientDocument;
}

export const documentsApi = {
  remove: (tenantId: string, docId: string) => api.delete<{ ok: true }>(`/tenants/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(docId)}`),
};

/** After a document is added or removed: the list and the timeline. */
export function useClientRecordRefresh(tenantId: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["roster", "documents", tenantId] }),
      qc.invalidateQueries({ queryKey: ["roster", "timeline", tenantId] }),
    ]);
}

/** "2.4 MB", "180 KB". */
export const fileSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
