import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/**
 * Staff groups (backend services/staffGroups.ts): the teams forms can be
 * limited to. Someone is in a group when their job title matches one of its
 * rules, or an admin added them; an admin can also take them out.
 */
export interface GroupPerson {
  id: string;
  name: string;
  email: string;
  title: string | null;
}

export interface StaffGroup {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  /** "Job title contains …" (lower-cased); a leading ^ means "starts with". */
  rules: string[];
  members: (GroupPerson & { via: "title" | "added" })[];
  /** Their title matches, but an admin took them out. */
  removed: GroupPerson[];
}

export const GROUPS_KEY = ["admin", "groups"];

export function useStaffGroups(enabled = true) {
  return useQuery({ queryKey: GROUPS_KEY, queryFn: () => api.get<StaffGroup[]>("/groups"), enabled });
}

/** A position a form can be limited to (backend knownTitles). */
export interface JobTitle {
  title: string;
  /** People who hold it now. */
  people: number;
  /** The groups its title rules put it in. */
  groupIds: string[];
  /** On Lantern's list of positions, rather than only someone's title. */
  listed: boolean;
}

/** Lantern's positions plus any other title someone has, with how many hold each and their groups. */
export function useJobTitles(enabled = true) {
  return useQuery({ queryKey: ["admin", "job-titles"], queryFn: () => api.get<JobTitle[]>("/groups/titles"), enabled });
}

/** Whether a title joins a group with these rules (the same test as the backend's groupsForTitle). */
export function titleMatches(title: string, rules: string[]) {
  const t = title.toLowerCase();
  return rules.some((r) => (r.startsWith("^") ? t.startsWith(r.slice(1)) : t.includes(r)));
}

export const groupsApi = {
  create: (body: { name: string; description?: string; rules: string[] }) => api.post<StaffGroup>("/groups", body),
  update: (id: string, body: { name?: string; description?: string; rules?: string[] }) => api.patch(`/groups/${id}`, body),
  remove: (id: string) => api.delete<{ ok: true; forms: number }>(`/groups/${id}`),
  /** true adds them by hand, false takes them out, null goes back to their job title. */
  setPerson: (groupId: string, userId: string, include: boolean | null) => api.put<{ inGroup: boolean }>(`/groups/${groupId}/people/${userId}`, { include }),
};

/** Rules typed one per line or comma-separated, cleaned up. */
export function parseRules(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((r) => r.trim().toLowerCase()).filter((r) => r.length >= 2))];
}

/** A rule in words, after "Job titles with": “…”, or starting “…”. */
export const ruleLabel = (r: string) => (r.startsWith("^") ? `starting “${r.slice(1)}”` : `“${r}”`);

/** Several rules as one phrase: “a”, “b” or starting “c”. */
export function rulesPhrase(rules: string[]) {
  const parts = rules.map(ruleLabel);
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
}
