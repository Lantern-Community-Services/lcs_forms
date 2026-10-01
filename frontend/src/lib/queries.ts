import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type {
  ApiKeyRow, AttendanceDetail, AttendanceEvent, AuditEvent, DashboardData, FormCatalog, HomeData,HotFoodEntryDetail, HotFoodEntryRow, HotFoodConfig, HotFoodItem, HotFoodReport, HotFoodToday,
  ManagedUser, RoleSummary, Settings, Site, Tenant, TenantDetail, WebhookRow,
} from "./types";

/**
 * Every server read lives here so cache keys stay consistent. Roster writes
 * invalidate the whole ["roster"] family: a swipe changes the queue, the list,
 * the site counts and the dashboard at once, and refetching a few hundred rows
 * is cheaper than keeping four caches surgically in step.
 */
export const qk = {
  sites: (all = false) => ["roster", "sites", all] as const,
  tenants: (site: string, status: string) => ["roster", "tenants", site, status] as const,
  review: (site: string) => ["roster", "review", site] as const,
  tenant: (id: string) => ["roster", "tenant", id] as const,
  dashboard: (site: string) => ["roster", "dashboard", site] as const,
  audit: (site: string) => ["roster", "audit", site] as const,
  attendance: (site: string, q: string) => ["attendance", "list", site, q] as const,
  attendanceEntry: (id: string) => ["attendance", "detail", id] as const,
};

/** `?site=` for a selection: a comma list of codes, or nothing for all my sites. */
const siteQs = (site: string | undefined) => (site ? `site=${encodeURIComponent(site)}` : "");

export function useSites(all = false, enabled = true) {
  return useQuery({ queryKey: qk.sites(all), queryFn: () => api.get<Site[]>(`/sites${all ? "?all=1" : ""}`), enabled });
}

/** `site`: comma list of site codes, or undefined for all of my sites. */
export function useTenants(site: string | undefined, status: "active" | "archived" | "attention", enabled = true) {
  return useQuery({
    queryKey: qk.tenants(site ?? "all", status),
    queryFn: () =>
      api.get<{ items: Tenant[]; attentionHours: number; truncated: boolean }>(
        `/tenants?${new URLSearchParams({ ...(site ? { site } : {}), status })}`
      ),
    enabled,
    placeholderData: (prev) => prev,
  });
}

export function useReviewQueue(site: string | undefined) {
  return useQuery({
    queryKey: qk.review(site ?? "all"),
    queryFn: () => api.get<{ items: Tenant[]; attentionHours: number }>(`/tenants/review?${siteQs(site)}`),
  });
}

export function useTenant(id: string | undefined) {
  return useQuery({ queryKey: qk.tenant(id ?? ""), queryFn: () => api.get<TenantDetail>(`/tenants/${id}`), enabled: Boolean(id) });
}

export function useDashboard(site?: string) {
  return useQuery({
    queryKey: qk.dashboard(site ?? "all"),
    queryFn: () => api.get<DashboardData>(`/activity/dashboard?${siteQs(site)}`),
    placeholderData: (prev) => prev,
  });
}

export function useAudit(site: string | undefined) {
  return useQuery({
    queryKey: qk.audit(site ?? "all"),
    queryFn: () => api.get<{ items: AuditEvent[]; nextBefore: string | null }>(`/activity/audit?limit=100&${siteQs(site)}`),
    placeholderData: (prev) => prev,
  });
}

export function useArchiveReasons() {
  return useQuery({ queryKey: ["meta", "reasons"], queryFn: () => api.get<string[]>("/tenants/meta/archive-reasons"), staleTime: Infinity });
}

/** Wraps a roster write so every one invalidates the roster family on success. */
export function useRosterMutation<TVars, TResult = Tenant>(fn: (vars: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ["roster"] }) });
}

export const rosterApi = {
  create: (body: Record<string, unknown>) => api.post<Tenant>("/tenants", body),
  update: (id: string, body: Record<string, unknown>) => api.patch<Tenant>(`/tenants/${id}`, body),
  archive: (id: string, body: { reason: string; note?: string }) => api.post<Tenant>(`/tenants/${id}/archive`, body),
  restore: (id: string) => api.post<Tenant>(`/tenants/${id}/restore`),
  keep: (id: string) => api.post<Tenant>(`/tenants/${id}/keep`),
  undoKeep: (id: string) => api.post<Tenant>(`/tenants/${id}/undo-keep`),
};

// ── Forms ────────────────────────────────────────────────────────────────

/** `editing`: the admin view — hidden forms and empty categories included. */
export function useForms(editing = false) {
  return useQuery({
    queryKey: ["forms", editing ? "all" : "visible"],
    queryFn: () => api.get<FormCatalog>(`/forms${editing ? "?all=1" : ""}`),
    // The catalog changes a few times a year; don't refetch it on every focus.
    staleTime: 5 * 60_000,
  });
}

/** The Forms home dashboard: attention items, recent activity, counts. */
export function useHome() {
  return useQuery({
    queryKey: ["home"],
    queryFn: () => api.get<HomeData>("/home"),
    staleTime: 60_000,
  });
}

export const formsApi = {
  favorite: (id: string) => api.put<{ ok: true }>(`/forms/${id}/favorite`),
  unfavorite: (id: string) => api.delete<{ ok: true }>(`/forms/${id}/favorite`),
  create: (body: Record<string, unknown>) => api.post("/forms", body),
  update: (id: string, body: Record<string, unknown>) => api.patch(`/forms/${id}`, body),
  remove: (id: string) => api.delete(`/forms/${id}`),
  reorder: (categoryId: string, ids: string[]) => api.post("/forms/reorder", { categoryId, ids }),
  createCategory: (body: { name: string; icon: string }) => api.post("/forms/categories", body),
  updateCategory: (id: string, body: { name?: string; icon?: string }) => api.patch(`/forms/categories/${id}`, body),
  removeCategory: (id: string) => api.delete(`/forms/categories/${id}`),
  reorderCategories: (ids: string[]) => api.post("/forms/categories/reorder", { ids }),
};

/** A form built in this app that a catalog card can open. */
export interface BuiltFormOption {
  id: string;
  kind: "basic" | "code";
  slug: string;
  title: string;
  status: string;
  live: boolean;
  catalogLinkId: string | null;
  url: string;
  icon: string | null;
  roles: string[];
  description: string | null;
}

export function useBuiltFormOptions(enabled = true) {
  return useQuery({ queryKey: ["forms", "built"], queryFn: () => api.get<BuiltFormOption[]>("/forms/built"), enabled });
}

// ── Attendance ───────────────────────────────────────────────────────────

/** `site`: comma list of site codes, or undefined for all of my sites. */
export function useAttendanceList(site: string | undefined, q: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: qk.attendance(site ?? "all", q),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.get<{ items: AttendanceEvent[]; nextBefore: string | null }>(
        `/attendance?${new URLSearchParams({ ...(site ? { site } : {}), ...(q ? { q } : {}), ...(pageParam ? { before: pageParam } : {}) })}`
      ),
    getNextPageParam: (lastPage) => lastPage.nextBefore,
    enabled,
  });
}

export function useAttendanceDetail(id: string | undefined) {
  return useQuery({ queryKey: qk.attendanceEntry(id ?? ""), queryFn: () => api.get<AttendanceDetail>(`/attendance/${id}`), enabled: Boolean(id) });
}

export const attendanceApi = {
  create: (body: Record<string, unknown>) => api.post<AttendanceDetail>("/attendance", body),
};

/** Wraps an attendance write so it invalidates the attendance list/detail family on success. */
export function useAttendanceMutation<TVars, TResult = AttendanceDetail>(fn: (vars: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ["attendance"] }) });
}

// ── Hot Foods ────────────────────────────────────────────────────────────

/** What the Entries list, the Reports tab and both exports are filtered by. */
export interface HotFoodView {
  /** Comma list of site codes, or undefined for all of my sites. */
  site?: string;
  /** Inclusive yyyy-mm-dd, New York days. */
  from: string;
  to: string;
  q?: string;
  status?: "active" | "void" | "all";
}

export function hotFoodParams(v: HotFoodView, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    ...(v.site ? { site: v.site } : {}),
    from: v.from,
    to: v.to,
    ...(v.q?.trim() ? { q: v.q.trim() } : {}),
    ...(v.status && v.status !== "active" ? { status: v.status } : {}),
    ...extra,
  });
}

export function useHotFoodItems(all = false) {
  return useQuery({ queryKey: ["hotfoods", "items", all], queryFn: () => api.get<HotFoodItem[]>(`/hot-foods/items${all ? "?all=1" : ""}`), staleTime: 5 * 60_000 });
}

export function useHotFoodToday(site: string | undefined) {
  return useQuery({
    queryKey: ["hotfoods", "today", site ?? ""],
    queryFn: () => api.get<HotFoodToday>(`/hot-foods/today?site=${encodeURIComponent(site!)}`),
    enabled: Boolean(site),
    // Two staff serving the same line see each other's entries within the minute.
    refetchInterval: 60_000,
  });
}

export function useHotFoodEntries(v: HotFoodView, enabled = true) {
  return useInfiniteQuery({
    queryKey: ["hotfoods", "entries", v],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.get<{ items: HotFoodEntryRow[]; nextBefore: string | null; total: number }>(`/hot-foods?${hotFoodParams(v, pageParam ? { before: pageParam } : {})}`),
    getNextPageParam: (last) => last.nextBefore,
    enabled,
  });
}

export function useHotFoodEntry(id: string | undefined) {
  return useQuery({ queryKey: ["hotfoods", "entry", id ?? ""], queryFn: () => api.get<HotFoodEntryDetail>(`/hot-foods/${id}`), enabled: Boolean(id) });
}

export function useHotFoodReport(v: HotFoodView, enabled = true) {
  return useQuery({
    queryKey: ["hotfoods", "report", v],
    queryFn: () => api.get<HotFoodReport>(`/hot-foods/report?${hotFoodParams(v)}`),
    enabled,
    placeholderData: (prev) => prev,
  });
}

export const hotFoodsApi = {
  create: (body: Record<string, unknown>) => api.post<{ id: string; tenantName: string; mealCount: number; todayCount: number; limit: number }>("/hot-foods", body),
  void: (id: string, reason: string) => api.post<HotFoodEntryDetail>(`/hot-foods/${id}/void`, { reason }),
  createItem: (body: { name: string; imageUrl?: string }) => api.post<HotFoodItem>("/hot-foods/items", body),
  updateItem: (id: string, body: Partial<Pick<HotFoodItem, "name" | "active" | "colorSlot">> & { imageUrl?: string }) => api.patch<HotFoodItem>(`/hot-foods/items/${id}`, body),
  reorderItems: (ids: string[]) => api.post("/hot-foods/items/reorder", { ids }),
  updateConfig: (body: Partial<Pick<HotFoodConfig, "supportiveLimit" | "shelterLimit" | "cooldownMinutes">>) => api.patch<HotFoodConfig>("/hot-foods/config", body),
};

export function useHotFoodConfig(enabled = true) {
  return useQuery({ queryKey: ["hotfoods", "config"], queryFn: () => api.get<HotFoodConfig>("/hot-foods/config"), enabled });
}

/** Every Hot Foods write invalidates the whole family: today's counts, lists and reports. */
export function useHotFoodsMutation<TVars, TResult>(fn: (vars: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ["hotfoods"] }) });
}

// ── Admin ────────────────────────────────────────────────────────────────

export function useUsers(enabled = true) {
  return useQuery({ queryKey: ["admin", "users"], queryFn: () => api.get<ManagedUser[]>("/users"), enabled });
}
export function useRoles() {
  return useQuery({ queryKey: ["meta", "roles"], queryFn: () => api.get<(RoleSummary & { permissions: string[]; assignable: boolean })[]>("/auth/roles") });
}
export function useSettings(enabled = true) {
  return useQuery({ queryKey: ["admin", "settings"], queryFn: () => api.get<Settings>("/admin/settings"), enabled });
}
export function useApiKeys(enabled = true) {
  return useQuery({ queryKey: ["admin", "api-keys"], queryFn: () => api.get<ApiKeyRow[]>("/admin/api-keys"), enabled });
}
export function useWebhooks(enabled = true) {
  return useQuery({ queryKey: ["admin", "webhooks"], queryFn: () => api.get<{ events: string[]; items: WebhookRow[] }>("/admin/webhooks"), enabled });
}
