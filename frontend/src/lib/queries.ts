import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useAuth } from "./auth";
import { loadTenants } from "./rosterStore";
import type {
  ApiKeyRow, AttendanceDetail, CalendarCategory, CalendarEventInput, CalendarOccurrence, CalendarScope, CalendarSeries, OutlookPrefs, OutlookPrefsInput, AttendanceEvent, AuditEvent, DashboardData, FormCatalog, HomeAppCards, HomeData,
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
  const qc = useQueryClient();
  const { user } = useAuth();
  const key = qk.tenants(site ?? "all", status);
  return useQuery({
    queryKey: key,
    queryFn: () =>
      // The active roster comes from the device's own copy (lib/rosterStore.ts):
      // instant, and offline. A refetch (after an edit, or on focus) pulls the
      // changes first. Archived is rarely opened and isn't kept.
      status === "active"
        ? loadTenants(site, { fresh: qc.getQueryData(key) !== undefined, userId: user?.id })
        : api.get<{ items: Tenant[]; attentionHours: number; truncated: boolean }>(`/tenants?${new URLSearchParams({ ...(site ? { site } : {}), status })}`),
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

/** Code forms' own cards on the Forms home; separate so a slow form can't hold up the rest. */
export function useHomeApps() {
  return useQuery({
    queryKey: ["home", "apps"],
    queryFn: () => api.get<HomeAppCards>("/home/apps"),
    staleTime: 60_000,
    retry: false,
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

// ── Calendar ─────────────────────────────────────────────────────────────

/** `site`: comma list of site codes, or undefined for all of my sites. `from`/`to`: inclusive days. */
export function calendarPath(from: string, to: string, site: string | undefined) {
  return `/calendar?${new URLSearchParams({ from, to, ...(site ? { site } : {}) })}`;
}

export function useCalendar(from: string, to: string, site: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["calendar", "range", from, to, site ?? "all"],
    queryFn: () => api.get<{ from: string; to: string; items: CalendarOccurrence[] }>(calendarPath(from, to, site)),
    enabled,
    // Moving to the next month keeps this one on screen until that one arrives.
    placeholderData: (prev) => prev,
  });
}

export function useCalendarCategories() {
  return useQuery({ queryKey: ["calendar", "categories"], queryFn: () => api.get<CalendarCategory[]>("/calendar/categories"), staleTime: 5 * 60_000 });
}

/** This person's "Add to my Outlook" choices. */
export function useOutlookPrefs() {
  return useQuery({ queryKey: ["calendar", "outlook"], queryFn: () => api.get<OutlookPrefs>("/calendar/outlook/me"), staleTime: 5 * 60_000 });
}

export function useCalendarSeries(id: string | undefined) {
  return useQuery({ queryKey: ["calendar", "series", id ?? ""], queryFn: () => api.get<CalendarSeries>(`/calendar/events/${id}`), enabled: Boolean(id) });
}

export const calendarApi = {
  create: (event: CalendarEventInput) => api.post<{ id: string }>("/calendar/events", event),
  update: (id: string, body: { scope: CalendarScope; date?: string; event: CalendarEventInput }) => api.patch<{ id: string }>(`/calendar/events/${id}`, body),
  remove: (id: string, scope: CalendarScope, date?: string) =>
    api.delete<{ ok: true }>(`/calendar/events/${id}?${new URLSearchParams({ scope, ...(date ? { date } : {}) })}`),
  restore: (id: string, date: string) => api.post<{ ok: true }>(`/calendar/events/${id}/restore`, { date }),
  createCategory: (body: { name: string; colorSlot: number }) => api.post<CalendarCategory>("/calendar/categories", body),
  updateCategory: (id: string, body: { name?: string; colorSlot?: number }) => api.patch<CalendarCategory>(`/calendar/categories/${id}`, body),
  removeCategory: (id: string) => api.delete<{ ok: true }>(`/calendar/categories/${id}`),
  reorderCategories: (ids: string[]) => api.put<{ ok: true }>("/calendar/categories/order", { ids }),
  saveOutlook: (body: OutlookPrefsInput) => api.put<{ ok: true }>("/calendar/outlook/me", body),
};

/** Every calendar write refreshes the whole family: the months on screen, the series, the categories' counts. */
export function useCalendarMutation<TVars, TResult>(fn: (vars: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ["calendar"] }) });
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
