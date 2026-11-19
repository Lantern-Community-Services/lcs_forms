import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useCaseManagement } from "./auth";
import type { Site, SiteRef } from "./types";

/**
 * Units, moving in and out, being away, the move-in checklist (backend
 * routes/residency.ts). Case management only, at supportive sites.
 */

export interface Occupant {
  id: string;
  displayName: string;
  head: boolean;
  relation: string | null;
  away: boolean;
  highAcuity: boolean;
}

export interface UnitRow {
  id: string;
  siteId: string;
  label: string;
  unitType: string | null;
  program: string | null;
  notes: string | null;
  active: boolean;
  vacant: boolean;
  vacantSince: string | null;
  occupants: Occupant[];
}

export interface UnitsResponse {
  sites: (SiteRef & { siteType: string; households: boolean; unitCount: number })[];
  units: UnitRow[];
}

export interface ResidencyMeta {
  relations: string[];
  head: string;
  moveOutReasons: string[];
  internalTransfer: string;
  awayReasons: string[];
  exitDestinations: string[];
  unitTypes: string[];
  states: string[];
  programs: { value: string; site: string }[];
  schedule: { key: string; label: string; afterMoveIn?: number; every?: "month" | "year"; afterMoveOut?: number }[];
}

export interface StayRow {
  id: string;
  siteId: string;
  siteName: string;
  unitId: string | null;
  unitLabel: string | null;
  program: string | null;
  startKind: "moved_in" | "transferred";
  moveInDate: string;
  moveOutDate: string | null;
  endKind: "moved_out" | "transferred" | "removed" | null;
  endReason: string | null;
  exitDestination: string | null;
  forwardingAddress: Record<string, string> | null;
  endNote: string | null;
  householdRelation: string | null;
  days: number;
}

export interface AbsenceRow {
  id: string;
  lastSeen: string;
  reason: string;
  detail: string | null;
  expectedReturn: string | null;
  returnedOn: string | null;
  outcome: "returned" | "moved_out" | null;
  days: number;
}

export interface TaskRow {
  id: string;
  tenantId: string;
  siteId: string;
  key: string;
  label: string;
  forms: string[];
  dueOn: string;
  status: "open" | "done" | "skipped" | "cancelled";
  overdueDays: number | null;
  doneOn: string | null;
  doneByName: string | null;
  note: string | null;
  entryRef: string | null;
  resident?: { id: string; displayName: string; unit: string | null; status: string };
  caseLead?: { id: string; name: string } | null;
}

export type ResidencyView =
  | { on: false; tasks: TaskRow[]; can: ResidencyCan }
  | {
      on: true;
      households: boolean;
      movedIn: boolean;
      unit: { id: string; label: string; unitType: string | null; program: string | null } | null;
      household: Occupant[];
      away: AbsenceRow | null;
      stays: StayRow[];
      absences: AbsenceRow[];
      tasks: TaskRow[];
      can: ResidencyCan;
    };
export interface ResidencyCan {
  move: boolean;
  moveOut: boolean;
  tick: boolean;
}

export interface ResidencyReport {
  from: string;
  to: string;
  sites: SiteRef[];
  months: { month: string; moveIns: number; transfersIn: number; moveOuts: number; transfersOut: number }[];
  bySite: { siteId: string; siteName: string; units: number; vacant: number; moveIns: number; moveOuts: number; waiting: number; away: number }[];
  reasons: { label: string; count: number }[];
  destinations: { label: string; count: number }[];
  lengthOfStay: { count: number; medianDays: number | null; averageDays: number | null };
  vacancies: { unitId: string; siteName: string; label: string; unitType: string | null; vacantSince: string | null; days: number | null }[];
  checklist: {
    due: number;
    onTime: number;
    late: number;
    missing: number;
    skipped: number;
    byTask: { key: string; label: string; due: number; onTime: number; missing: number }[];
  };
}

/** Whether units and move-ins apply at a site (case management on, supportive). */
export function useResidencyFor() {
  const on = useCaseManagement();
  return (site: Pick<Site, "siteType"> | undefined | null) => on && site?.siteType === "supportive";
}

export function useResidencyMeta(enabled = true) {
  return useQuery({ queryKey: ["residency", "meta"], queryFn: () => api.get<ResidencyMeta>("/residency/meta"), enabled, staleTime: Infinity });
}

/** Units at the selected sites (comma list of codes; undefined = all of mine). */
export function useUnits(site: string | undefined, enabled: boolean, opts: { retired?: boolean } = {}) {
  const qs = new URLSearchParams({ ...(site ? { site } : {}), ...(opts.retired ? { retired: "1" } : {}) });
  return useQuery({
    queryKey: ["roster", "units", site ?? "all", opts.retired ? "retired" : "active"],
    queryFn: () => api.get<UnitsResponse>(`/residency/units?${qs}`),
    enabled,
    placeholderData: (prev) => prev,
  });
}

export function useResidency(tenantId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["roster", "residency", tenantId ?? ""],
    queryFn: () => api.get<ResidencyView>(`/residency/tenants/${tenantId}`),
    enabled: Boolean(tenantId) && enabled,
  });
}

export function useTasks(site: string | undefined, view: string, mine: boolean, enabled = true) {
  const qs = new URLSearchParams({ view, ...(site ? { site } : {}), ...(mine ? { mine: "1" } : {}) });
  return useQuery({
    queryKey: ["roster", "tasks", site ?? "all", view, mine],
    queryFn: () => api.get<{ view: string; sites: SiteRef[]; items: TaskRow[] }>(`/residency/tasks?${qs}`),
    enabled,
    placeholderData: (prev) => prev,
  });
}

export function useResidencyReport(site: string | undefined, from: string, to: string, enabled = true) {
  const qs = new URLSearchParams({ from, to, ...(site ? { site } : {}) });
  return useQuery({
    queryKey: ["roster", "report", site ?? "all", from, to],
    queryFn: () => api.get<ResidencyReport>(`/residency/report?${qs}`),
    enabled,
    placeholderData: (prev) => prev,
  });
}

export const residencyApi = {
  moveIn: (unitId: string, body: { date: string; people: { tenantId: string; relation?: string | null }[]; program?: string | null }) =>
    api.post<{ moved: number }>(`/residency/units/${unitId}/move-in`, body),
  transfer: (tenantId: string, body: { toUnitId: string; date: string; reason?: string | null; withHousehold?: boolean; relations?: Record<string, string> }) =>
    api.post<{ moved: number }>(`/residency/tenants/${tenantId}/transfer`, body),
  moveOut: (
    tenantId: string,
    body: { date: string; reason: string; destination?: string | null; forwardingAddress?: Record<string, string> | null; note?: string | null; alsoIds?: string[]; newHeadId?: string | null }
  ) => api.post<{ movedOut: number }>(`/residency/tenants/${tenantId}/move-out`, body),
  away: (tenantId: string, body: { lastSeen: string; reason: string; detail?: string | null; expectedReturn?: string | null }) =>
    api.post<{ ok: true }>(`/residency/tenants/${tenantId}/away`, body),
  returned: (tenantId: string, date: string) => api.post<{ ok: true }>(`/residency/tenants/${tenantId}/returned`, { date }),
  household: (tenantId: string, body: { relation?: string; makeHead?: boolean; formerHeadRelation?: string }) =>
    api.post<{ ok: true }>(`/residency/tenants/${tenantId}/household`, body),
  task: (taskId: string, body: { status: "done" | "skipped" | "open"; doneOn?: string; note?: string | null }) =>
    api.post<{ task: TaskRow; next: TaskRow | null }>(`/residency/tasks/${taskId}`, body),
  createUnit: (body: { site: string; label: string; unitType?: string | null; program?: string | null; notes?: string | null }) => api.post<UnitRow>("/residency/units", body),
  updateUnit: (id: string, body: { label?: string; unitType?: string | null; program?: string | null; notes?: string | null; active?: boolean }) =>
    api.patch<UnitRow>(`/residency/units/${id}`, body),
  bulkUnits: (body: { site: string; labels: string[]; unitType?: string | null; program?: string | null }) =>
    api.post<{ added: number; skipped: number }>("/residency/units/bulk", body),
  seedUnits: (site: string) => api.post<{ unitsAdded: number; residentsLinked: number; unitsTotal: number }>("/residency/units/seed", { site }),
};

/** After any move: the roster, units, the person's page and the checklist all change. */
export function useResidencyRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["roster"] });
}

/** "Head of household's child" → "Child". */
export function shortRelation(r: string | null | undefined): string | null {
  if (!r) return null;
  if (r.startsWith("Self")) return "Head of household";
  return r.replace(/^Head of household's /, "").replace(/^Other: /, "").replace(/^./, (c) => c.toUpperCase());
}

/** "2026-03-14" → "Mar 14, 2026". */
export function fmtDay(v: string | null | undefined): string {
  if (!v) return "—";
  const [y, m, d] = v.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? v : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Today, "YYYY-MM-DD", on this device. */
export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
