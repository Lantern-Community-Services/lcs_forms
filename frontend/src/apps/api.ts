import { useQuery } from "@tanstack/react-query";
import { api, API_BASE, ApiError } from "@/lib/api";

/** Code forms: the developer API (projects) and the runtime API the bridge calls. */

export interface FileProblem {
  file: string;
  line?: number;
  column?: number;
  message: string;
}

export interface Project {
  id: string;
  slug: string;
  title: string;
  kind: "code";
  status: "draft" | "published" | "closed" | "archived";
  revision: number;
  liveVersion: number;
  unpublishedChanges: boolean;
  files: Record<string, string>;
  catalogLinkId: string | null;
  createdByName: string;
  updatedByName: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProjectSummary = Omit<Project, "files"> & { icon: string | null; fileCount: number; entryCount: number };

export interface AppRuntime {
  form: { id: string; slug: string; title: string; status: string; version: number; draft: boolean };
  pages: { id: string; label: string; fullHeight: boolean; hidden: boolean; nav: "auto" | "tablet" | "always" | "never" }[];
  code: Record<string, string>;
  css: string;
  hash: string;
  user: { id: string; name: string; email: string; roleKey: string; roleName: string; permissions: string[]; siteIds: string[] | null };
  canEdit: boolean;
  /** form.json offline.actions: read-only actions whose last answer is kept for use with no connection. */
  offlineActions?: string[];
}

export const appKeys = {
  projects: (archived: boolean) => ["apps", "projects", archived] as const,
  project: (id: string) => ["apps", "project", id] as const,
  runtime: (slug: string, draft: boolean) => ["apps", "runtime", slug, draft] as const,
};

export function useProjects(archived = false) {
  return useQuery({ queryKey: appKeys.projects(archived), queryFn: () => api.get<ProjectSummary[]>(`/apps/projects${archived ? "?archived=1" : ""}`) });
}

export function useProject(id: string) {
  return useQuery({ queryKey: appKeys.project(id), queryFn: () => api.get<Project>(`/apps/projects/${id}`), refetchOnWindowFocus: false });
}

export function useAppRuntime(slug: string, draft: boolean, nonce = 0) {
  return useQuery({
    queryKey: [...appKeys.runtime(slug, draft), nonce],
    queryFn: () => api.get<AppRuntime>(`/apps/${slug}/runtime${draft ? "?draft=1" : ""}`),
    retry: (n, err) => !(err instanceof ApiError && [401, 403, 404, 422].includes(err.status)) && n < 1,
    refetchOnWindowFocus: false,
    staleTime: draft ? 0 : 60_000,
  });
}

export const projectsApi = {
  create: (body: { title?: string; files?: Record<string, string> }) => api.post<Project>("/apps/projects", body),
  save: (id: string, files: Record<string, string>, revision: number) => api.put<Project>(`/apps/projects/${id}`, { files, revision }),
  build: (id: string, files?: Record<string, string>) =>
    api.post<{ ok: true; warnings: FileProblem[]; hash: string } | { ok: false; problems: FileProblem[]; warnings: FileProblem[] }>(`/apps/projects/${id}/build`, files ? { files } : {}),
  publish: (id: string, note?: string) => api.post<Project>(`/apps/projects/${id}/publish`, { note }),
  setStatus: (id: string, status: string) => api.post<Project>(`/apps/projects/${id}/status`, { status }),
  duplicate: (id: string) => api.post<Project>(`/apps/projects/${id}/duplicate`),
  remove: (id: string, withEntries = false) => api.delete(`/apps/projects/${id}`, { withEntries }),
  setCatalog: (id: string, categoryId: string | null) => api.put<Project>(`/apps/projects/${id}/catalog`, { categoryId }),
  versions: (id: string) => api.get<{ version: number; note: string | null; publishedByName: string; createdAt: string }[]>(`/apps/projects/${id}/versions`),
  restore: (id: string, v: number) => api.post<Project>(`/apps/projects/${id}/versions/${v}/restore`),
  import: (payload: unknown, withEntries?: boolean) => api.post<{ id: string; slug: string; title: string; entries: number }>("/apps/import", { payload, withEntries }),
  guide: () => api.get<string>("/apps/guide"),
  exportFile: async (id: string, data: boolean) => {
    const res = await fetch(`${API_BASE}/apps/projects/${id}/export${data ? "?data=1" : ""}`, { credentials: "include" });
    if (!res.ok) throw new ApiError(res.status, "Export failed.");
    const blob = await res.blob();
    const name = /filename="?([^"]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "code-form.lcsapp.json";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
  },
};

const q = (draft: boolean, extra?: Record<string, string>) => {
  const p = new URLSearchParams(extra);
  if (draft) p.set("draft", "1");
  const s = p.toString();
  return s ? `?${s}` : "";
};

export type CreateOutcome =
  | { status: "saved"; entry: unknown; logs?: string[] }
  | { status: "needs_override"; problems: string[]; logs?: string[] }
  | { status: "invalid"; errors: Record<string, string>; message: string; logs?: string[] };

/** POST an entry; 409 / 422 answers are outcomes, not errors. */
export async function submitAppEntry(slug: string, draft: boolean, entry: Record<string, unknown>): Promise<CreateOutcome> {
  const res = await fetch(`${API_BASE}/apps/${slug}/entries${q(draft)}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 201 || res.status === 409 || (res.status === 422 && body.status === "invalid")) return body as CreateOutcome;
  throw new ApiError(res.status, body?.error ?? res.statusText, body?.details, body?.requestId);
}

export const runtimeApi = {
  entries: (slug: string, draft: boolean, query: Record<string, unknown>) => {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") params[k] = Array.isArray(v) ? v.join(",") : String(v);
    return api.get<{ items: unknown[]; total: number }>(`/apps/${slug}/entries${q(draft, params)}`);
  },
  entry: (slug: string, draft: boolean, id: string) => api.get(`/apps/${slug}/entries/${id}${q(draft)}`),
  update: async (slug: string, draft: boolean, id: string, body: { data: unknown; reason?: string | null }) => {
    const res = await fetch(`${API_BASE}/apps/${slug}/entries/${encodeURIComponent(id)}${q(draft)}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    // 422 with a status is the server's rules saying no: an outcome, not an error.
    if (res.ok || (res.status === 422 && out.status === "invalid")) return out as { status: "saved" | "invalid"; logs?: string[] };
    throw new ApiError(res.status, out?.error ?? res.statusText, out?.details, out?.requestId);
  },
  history: (slug: string, draft: boolean, id: string) => api.get(`/apps/${slug}/entries/${encodeURIComponent(id)}/history${q(draft)}`),
  /** Upload a photo or file; the server answers with its FileRef. */
  upload: async (slug: string, draft: boolean, file: { name: string; mime: string; label?: string; data: Blob }) => {
    const res = await fetch(`${API_BASE}/apps/${slug}/files${q(draft)}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-File-Name": encodeURIComponent(file.name),
        "X-File-Type": encodeURIComponent(file.mime),
        "X-File-Label": encodeURIComponent(file.label ?? ""),
      },
      body: file.data,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, out?.error ?? res.statusText, out?.details, out?.requestId);
    return out as { fileId: string; name: string; mime: string; size: number };
  },
  file: async (slug: string, draft: boolean, fileId: string) => {
    const res = await fetch(`${API_BASE}/apps/${slug}/files/${encodeURIComponent(fileId)}${q(draft)}`, { credentials: "include" });
    if (!res.ok) {
      const out = await res.json().catch(() => ({}));
      throw new ApiError(res.status, out?.error ?? res.statusText);
    }
    return res.blob();
  },
  void: (slug: string, draft: boolean, id: string, reason: string) => api.post(`/apps/${slug}/entries/${id}/void${q(draft)}`, { reason }),
  restore: (slug: string, draft: boolean, id: string) => api.post(`/apps/${slug}/entries/${id}/restore${q(draft)}`),
  collection: (slug: string, draft: boolean, name: string) => api.get(`/apps/${slug}/collections/${encodeURIComponent(name)}${q(draft)}`),
  doc: (slug: string, draft: boolean, name: string, id: string) => api.get(`/apps/${slug}/collections/${encodeURIComponent(name)}/${encodeURIComponent(id)}${q(draft)}`),
  put: (slug: string, draft: boolean, name: string, id: string | null, data: unknown) =>
    api.put(`/apps/${slug}/collections/${encodeURIComponent(name)}${id ? `/${encodeURIComponent(id)}` : ""}${q(draft)}`, { data }),
  remove: (slug: string, draft: boolean, name: string, id: string) => api.delete(`/apps/${slug}/collections/${encodeURIComponent(name)}/${encodeURIComponent(id)}${q(draft)}`),
  action: async (slug: string, draft: boolean, name: string, args: unknown) => {
    const res = await fetch(`${API_BASE}/apps/${slug}/actions/${encodeURIComponent(name)}${q(draft)}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new ApiError(res.status, body?.error ?? res.statusText, body?.stack), { logs: body?.logs as string[] | undefined });
    return body as { value: unknown; logs?: string[] };
  },
};
