import { useQuery } from "@tanstack/react-query";
import { api, API_BASE, ApiError } from "./api";
import type { FieldTypeInfo, FormDoc, Values } from "./formEngine";

/** Built forms: the admin builder's reads and writes, and filling in / reading entries. */

export type FormStatus = "draft" | "published" | "closed" | "archived";

export interface BuiltFormSummary {
  id: string;
  slug: string;
  title: string;
  status: FormStatus;
  liveVersion: number;
  revision: number;
  unpublishedChanges: boolean;
  fieldCount: number;
  access: "signed_in" | "roles" | "public";
  icon: string | null;
  entryCount: number;
  lastEntryAt: string | null;
  catalogLinkId: string | null;
  createdByName: string;
  updatedByName: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BuiltFormDetail {
  id: string;
  slug: string;
  title: string;
  status: FormStatus;
  revision: number;
  liveVersion: number;
  unpublishedChanges: boolean;
  draft: FormDoc;
  live: FormDoc | null;
  catalogLinkId: string | null;
  createdByName: string;
  updatedByName: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BuilderReference {
  fieldTypes: FieldTypeInfo[];
  expressionFunctions: string[];
  codeBlockApi: string;
  roles: { key: string; name: string }[];
  mailConfigured: boolean;
  blank: FormDoc;
}

export interface DocProblem {
  path: string;
  message: string;
}

export interface ImportResult {
  created: { id: string; slug: string; title: string; entries: number }[];
  warnings: string[];
  failed: { title: string; problems: DocProblem[] }[];
}

export interface FillData {
  form: { id: string; slug: string; title: string; status: FormStatus; version: number; isDraft: boolean };
  doc: FormDoc;
  closed: string | null;
  user: { name: string; email: string } | null;
  canReadEntries: boolean;
  isAdmin: boolean;
}

export interface EntryRow {
  id: string;
  formVersion: number;
  values: Values;
  site: { name: string; code: string } | null;
  source: string;
  status: "active" | "voided";
  starred: boolean;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  updatedByName: string | null;
  voidedAt: string | null;
  voidedByName: string | null;
  voidReason: string | null;
  noteCount?: number;
}

export interface EntryList {
  form: { id: string; slug: string; title: string; status: FormStatus; version: number };
  doc: FormDoc;
  total: number;
  items: EntryRow[];
  canVoid: boolean;
  isAdmin: boolean;
}

export interface EntryNote {
  id: string;
  kind: "note" | "system";
  authorName: string;
  body: string;
  createdAt: string;
}

export interface EntryDetail {
  form: { id: string; slug: string; title: string };
  doc: FormDoc;
  entry: EntryRow;
  notes: EntryNote[];
  newerId: string | null;
  olderId: string | null;
  canVoid: boolean;
  isAdmin: boolean;
}

export const builderKeys = {
  all: ["builder"] as const,
  list: (archived: boolean) => ["builder", "list", archived] as const,
  form: (id: string) => ["builder", "form", id] as const,
  versions: (id: string) => ["builder", "versions", id] as const,
  reference: ["builder", "reference"] as const,
  fill: (slug: string) => ["fill", slug] as const,
  entries: (slug: string, qs: string) => ["fill", slug, "entries", qs] as const,
  entry: (slug: string, id: string) => ["fill", slug, "entry", id] as const,
};

export function useBuiltForms(archived = false) {
  return useQuery({ queryKey: builderKeys.list(archived), queryFn: () => api.get<BuiltFormSummary[]>(`/builder/forms${archived ? "?archived=1" : ""}`) });
}

export function useBuiltForm(id: string | undefined) {
  return useQuery({ queryKey: builderKeys.form(id ?? ""), queryFn: () => api.get<BuiltFormDetail>(`/builder/forms/${id}`), enabled: Boolean(id), refetchOnWindowFocus: false });
}

export function useBuilderReference() {
  return useQuery({ queryKey: builderKeys.reference, queryFn: () => api.get<BuilderReference>("/builder/reference"), staleTime: 5 * 60_000 });
}

export function useFormVersions(id: string, enabled: boolean) {
  return useQuery({
    queryKey: builderKeys.versions(id),
    queryFn: () => api.get<{ version: number; note: string | null; publishedByName: string; createdAt: string }[]>(`/builder/forms/${id}/versions`),
    enabled,
  });
}

export function useFillForm(slug: string | undefined) {
  return useQuery({
    queryKey: builderKeys.fill(slug ?? ""),
    queryFn: () => api.get<FillData>(`/f/${slug}`),
    enabled: Boolean(slug),
    retry: (n, err) => !(err instanceof ApiError && [401, 403, 404].includes(err.status)) && n < 1,
    refetchOnWindowFocus: false,
  });
}

export function useEntries(slug: string, qs: string) {
  return useQuery({
    queryKey: builderKeys.entries(slug, qs),
    queryFn: () => api.get<EntryList>(`/f/${slug}/entries?${qs}`),
    placeholderData: (prev) => prev,
  });
}

export function useEntry(slug: string, id: string) {
  return useQuery({ queryKey: builderKeys.entry(slug, id), queryFn: () => api.get<EntryDetail>(`/f/${slug}/entries/${id}`) });
}

export const builderApi = {
  create: (body: { title?: string; doc?: FormDoc; slug?: string }) => api.post<BuiltFormDetail>("/builder/forms", body),
  save: (id: string, body: { doc: FormDoc; revision: number; slug?: string }) => api.put<BuiltFormDetail>(`/builder/forms/${id}`, body),
  validate: (doc: unknown) => api.post<{ ok: boolean; problems: DocProblem[]; doc: FormDoc | null }>("/builder/validate", { doc }),
  publish: (id: string, note?: string) => api.post<BuiltFormDetail>(`/builder/forms/${id}/publish`, { note }),
  setStatus: (id: string, status: FormStatus) => api.post<BuiltFormDetail>(`/builder/forms/${id}/status`, { status }),
  duplicate: (id: string) => api.post<BuiltFormDetail>(`/builder/forms/${id}/duplicate`),
  remove: (id: string, withEntries = false) => api.delete(`/builder/forms/${id}`, { withEntries }),
  setCatalog: (id: string, categoryId: string | null) => api.put<BuiltFormDetail>(`/builder/forms/${id}/catalog`, { categoryId }),
  versionDoc: (id: string, v: number) => api.get<FormDoc>(`/builder/forms/${id}/versions/${v}`),
  restoreVersion: (id: string, v: number) => api.post<BuiltFormDetail>(`/builder/forms/${id}/versions/${v}/restore`),
  import: (payload: unknown, opts: { withEntries?: boolean; publish?: boolean } = {}) => api.post<ImportResult>("/builder/import", { payload, ...opts }),
  /** Download forms as an .lcsform.json bundle. */
  exportFile: async (ids: string[], opts: { entries?: boolean } = {}) => {
    const qs = new URLSearchParams({ ids: ids.join(","), ...(opts.entries ? { entries: "1" } : {}) });
    await downloadGet(`/builder/export?${qs}`, "forms.lcsform.json");
  },
};

export const fillApi = {
  submit: (slug: string, body: { values: Values; siteCode?: string | null; clientId: string; codeErrors?: Record<string, string>; website_hp?: string }) =>
    api.post<{ id: string; duplicate: boolean; values: Values }>(`/f/${slug}/submit`, body),
  upload: async (slug: string, fieldId: string, file: File) => {
    const res = await fetch(`${API_BASE}/f/${slug}/files?field=${encodeURIComponent(fieldId)}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
      body: file,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, body?.error ?? res.statusText, body?.details);
    return body as { id: string; name: string; size: number; mime: string };
  },
  fileUrl: (slug: string, fileId: string) => `${API_BASE}/f/${slug}/files/${fileId}`,
  updateEntry: (slug: string, id: string, values: Values) => api.patch(`/f/${slug}/entries/${id}`, { values }),
  void: (slug: string, id: string, reason: string) => api.post(`/f/${slug}/entries/${id}/void`, { reason }),
  restore: (slug: string, id: string) => api.post(`/f/${slug}/entries/${id}/void`, { restore: true }),
  star: (slug: string, id: string, starred: boolean) => api.post(`/f/${slug}/entries/${id}/star`, { starred }),
  note: (slug: string, id: string, body: string) => api.post<EntryNote>(`/f/${slug}/entries/${id}/notes`, { body }),
  remove: (slug: string, id: string) => api.delete(`/f/${slug}/entries/${id}`),
  exportFile: (slug: string, qs: string, format: "csv" | "xlsx") => downloadGet(`/f/${slug}/entries-export?${qs}&format=${format}`, `${slug}-entries.${format}`),
};

async function downloadGet(path: string, fallbackName: string) {
  const res = await fetch(`${API_BASE}${path}`, { credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body?.error ?? res.statusText);
  }
  const blob = await res.blob();
  const match = /filename="?([^"]+)"?/.exec(res.headers.get("content-disposition") ?? "");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = match?.[1] ?? fallbackName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Problems from a 422 DocError. */
export function docProblems(err: unknown): DocProblem[] {
  if (err instanceof ApiError && err.details && typeof err.details === "object" && "problems" in err.details) {
    return (err.details as { problems: DocProblem[] }).problems;
  }
  return [];
}

/** Field errors from a 422 submission. */
export function submitErrors(err: unknown): Record<string, string> {
  if (err instanceof ApiError && err.details && typeof err.details === "object" && "errors" in err.details) {
    return (err.details as { errors: Record<string, string> }).errors;
  }
  return {};
}

export const formPath = (slug: string, access?: string) => `/${access === "public" ? "p" : "f"}/${slug}`;
