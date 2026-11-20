import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useAuth, useCaseManagement } from "./auth";
import type { TaskRow } from "./residency";

/**
 * A case lead's caseload (backend routes/caseload.ts): their residents, their
 * open checklist as a to-do list, and the residents nobody leads yet. Case
 * management only. Query keys sit under "roster" so ticking a task off
 * (lib/residency useResidencyRefresh) refreshes these too.
 */

export interface CaseloadLead {
  id: string;
  name: string;
  self: boolean;
}

export interface CaseloadResident {
  id: string;
  displayName: string;
  site: { id: string; code: string; name: string };
  unit: string | null;
  movedIn: boolean;
  movedInOn: string | null;
  away: { since: string; reason: string | null } | null;
  highAcuity: boolean;
  tasks: {
    open: number;
    overdue: number;
    oldestOverdue: { label: string; dueOn: string } | null;
    next: { label: string; dueOn: string } | null;
  };
  lastContact: { at: string; entryId: string; formSlug: string; byName: string } | null;
}

export interface CaseloadResponse {
  lead: CaseloadLead;
  today: string;
  totals: { residents: number; overdue: number; away: number; noRecentContact: number };
  residents: CaseloadResident[];
  can: { pickLead: boolean; assign: boolean; tick: boolean };
}

export type TaskWhen = "overdue" | "week" | "later";
export interface CaseloadTask extends TaskRow {
  siteName: string;
  when: TaskWhen;
}

export interface UnassignedSite {
  id: string;
  code: string;
  name: string;
  leads: { id: string; name: string; title: string | null }[];
  residents: { id: string; displayName: string; unit: string | null; movedIn: boolean; movedInOn: string | null; away: boolean }[];
}

export interface LeadChoice {
  id: string;
  name: string;
  title: string | null;
  residents: number;
}

/**
 * Whether Caseload is offered: case management on, and the person has client
 * information or manages a site's roster (the API answers the same).
 */
export function useShowCaseload(): boolean {
  const { can } = useAuth();
  return useCaseManagement() && can("roster.view") && (can("clients.view") || can("roster.archive"));
}

const leadQs = (lead: string | null | undefined) => (lead ? `?${new URLSearchParams({ lead })}` : "");

export function useCaseload(lead: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["roster", "caseload", lead ?? "me"],
    queryFn: () => api.get<CaseloadResponse>(`/caseload${leadQs(lead)}`),
    enabled,
    placeholderData: (prev) => prev,
  });
}

export function useCaseloadTasks(lead: string | null | undefined) {
  return useQuery({
    queryKey: ["roster", "caseload-tasks", lead ?? "me"],
    queryFn: () => api.get<{ lead: CaseloadLead; today: string; items: CaseloadTask[] }>(`/caseload/tasks${leadQs(lead)}`),
    placeholderData: (prev) => prev,
  });
}

export function useCaseloadLeads(enabled: boolean) {
  return useQuery({ queryKey: ["roster", "caseload-leads"], queryFn: () => api.get<LeadChoice[]>("/caseload/leads"), enabled, staleTime: 60_000 });
}

export function useUnassigned(site: string | undefined, enabled: boolean) {
  const qs = site ? `?${new URLSearchParams({ site })}` : "";
  return useQuery({
    queryKey: ["roster", "caseload-unassigned", site ?? "all"],
    queryFn: () => api.get<{ sites: UnassignedSite[] }>(`/caseload/unassigned${qs}`),
    enabled,
    placeholderData: (prev) => prev,
  });
}

export const caseloadApi = {
  assign: (leadId: string, tenantIds: string[]) =>
    api.post<{ lead: { id: string; name: string }; assigned: { tenantId: string; name: string }[]; skipped: { tenantId: string; name: string | null; reason: string }[] }>(
      "/caseload/assign",
      { leadId, tenantIds }
    ),
};
