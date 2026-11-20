import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { SiteRef, Tenant } from "./types";

/**
 * Applicants: people referred for a unit at a supportive site, up to the day
 * they're accepted onto the roster (backend routes/applicants.ts). Case
 * management only. Query keys sit under "roster", so a move-in (which ends an
 * accepted applicant's wait) refreshes them too (useResidencyRefresh).
 */

export type StageGroup = "open" | "accepted" | "closed";

export interface ApplicantStep {
  id: string;
  stage: string;
  label: string;
  date: string;
  viewingDate: string | null;
  reason: string | null;
  note: string | null;
  byName: string;
  at: string;
}

export interface Applicant {
  id: string;
  siteId: string;
  siteName: string | null;
  program: string | null;
  firstName: string;
  middleName: string | null;
  lastName: string;
  preferredName: string | null;
  displayName: string;
  dateOfBirth: string | null;
  age: number | null;
  phone: string | null;
  email: string | null;
  referralSource: string | null;
  referralAgency: string | null;
  referralDate: string | null;
  eligibilityNotes: string | null;
  stage: string;
  stageLabel: string;
  stageDate: string;
  daysInStage: number;
  viewingDate: string | null;
  outcomeReason: string | null;
  /** Still in the pipeline, or accepted and not moved in yet. */
  open: boolean;
  /** "Waiting to move in", "Moved in", "Removed from the roster", or the closed stage. */
  outcome: string | null;
  tenantId: string | null;
  resident: { id: string; displayName: string; status: string; movedIn: boolean; moveInDate: string | null } | null;
  history: ApplicantStep[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicantsMeta {
  stages: { key: string; label: string; hint: string; group: StageGroup }[];
  closeReasons: Record<string, string[]>;
  acceptFrom: string[];
  referralSources: string[];
  programs: { value: string; site: string }[];
}

export type ApplicantStatus = "open" | "closed" | "all";

export interface ApplicantsList {
  status: ApplicantStatus;
  sites: SiteRef[];
  items: Applicant[];
  truncated: boolean;
  can: { manage: boolean };
}

export interface ApplicantReport {
  from: string;
  to: string;
  sites: SiteRef[];
  columns: { key: string; label: string }[];
  bySite: ({ siteId: string; siteName: string; open: number; movedIn: number; medianDays: number | null } & Record<string, number | string | null>)[];
  open: number;
  referralToMoveIn: { count: number; medianDays: number | null };
}

/** The fields Add and Edit send. */
export interface ApplicantDetails {
  firstName: string;
  middleName?: string | null;
  lastName?: string;
  preferredName?: string | null;
  dateOfBirth?: string | null;
  phone?: string | null;
  email?: string | null;
  program?: string | null;
  referralSource?: string | null;
  referralAgency?: string | null;
  referralDate?: string | null;
  eligibilityNotes?: string | null;
}

export function useApplicantsMeta(enabled = true) {
  return useQuery({ queryKey: ["roster", "applicants", "meta"], queryFn: () => api.get<ApplicantsMeta>("/applicants/meta"), enabled, staleTime: Infinity });
}

/** Applicants at the selected sites (comma list of codes; undefined = all of mine). Stage and program are filtered on the device. */
export function useApplicants(site: string | undefined, status: ApplicantStatus, enabled: boolean) {
  const qs = new URLSearchParams({ status, ...(site ? { site } : {}) });
  return useQuery({
    queryKey: ["roster", "applicants", "list", site ?? "all", status],
    queryFn: () => api.get<ApplicantsList>(`/applicants?${qs}`),
    enabled,
    placeholderData: (prev) => prev,
  });
}

export function useApplicantReport(site: string | undefined, enabled: boolean) {
  const qs = new URLSearchParams(site ? { site } : {});
  return useQuery({
    queryKey: ["roster", "applicants", "report", site ?? "all"],
    queryFn: () => api.get<ApplicantReport>(`/applicants/report?${qs}`),
    enabled,
    placeholderData: (prev) => prev,
  });
}

export const applicantsApi = {
  add: (body: ApplicantDetails & { site: string }) => api.post<Applicant>("/applicants", body),
  update: (id: string, body: Partial<ApplicantDetails> & { version: number; site?: string }) => api.patch<Applicant>(`/applicants/${id}`, body),
  move: (id: string, body: { version: number; stage: string; date?: string; viewingDate?: string | null; reason?: string | null; note?: string | null }) =>
    api.post<Applicant>(`/applicants/${id}/stage`, body),
  accept: (id: string, body: { version: number; date?: string; note?: string | null }) =>
    api.post<{ applicant: Applicant; resident: Tenant; copied: string[] }>(`/applicants/${id}/accept`, body),
};
