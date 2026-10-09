import { useEffect, useRef } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";
import { useAuth } from "./auth";
import { useToast } from "@/components/ui/toast";

/**
 * Notifications (backend services/notifications.ts): the bell's count, the
 * list on /notifications, and the person's preferences on Profile. The count
 * is polled once a minute while the app is in view, and when it comes back
 * into view.
 */

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  /** A path of this site. */
  link: string | null;
  source: string;
  sourceLabel: string | null;
  read: boolean;
  createdAt: string;
}

export type EmailMode = "instant" | "daily" | "off";

export interface NotificationPrefs {
  emailMode: EmailMode;
  mailConfigured: boolean;
  digestHour: number;
  types: { key: string; label: string; description: string; inApp: boolean; email: boolean; defaults: { inApp: boolean; email: boolean } }[];
  /** Forms they can open or that have notified them; each kind follows `types` until set here (custom). */
  forms: {
    id: string;
    title: string;
    kind: string;
    category: string | null;
    sent: number;
    kinds: { key: string; label: string; inApp: boolean; email: boolean; custom: boolean }[];
  }[];
}

export const notificationKeys = {
  all: ["notifications"] as const,
  unread: ["notifications", "unread"] as const,
  list: (filter: "all" | "unread") => ["notifications", "list", filter] as const,
  one: (id: string) => ["notifications", "one", id] as const,
  prefs: ["notifications", "prefs"] as const,
};

const POLL_MS = 60_000;

export function useUnreadNotifications() {
  const { user } = useAuth();
  return useQuery({
    queryKey: notificationKeys.unread,
    queryFn: () => api.get<{ unread: number; latest: AppNotification | null }>("/notifications/unread"),
    enabled: Boolean(user),
    refetchInterval: POLL_MS,
    staleTime: 20_000,
  });
}

/** The bell's number. */
export function useUnreadCount(): number {
  return useUnreadNotifications().data?.unread ?? 0;
}

export function useNotificationList(filter: "all" | "unread") {
  return useInfiniteQuery({
    queryKey: notificationKeys.list(filter),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.get<{ items: AppNotification[]; nextBefore: string | null; unread: number }>(
        `/notifications?${new URLSearchParams({ limit: "30", ...(filter === "unread" ? { unread: "1" } : {}), ...(pageParam ? { before: pageParam } : {}) })}`
      ),
    getNextPageParam: (last) => last.nextBefore,
  });
}

export function useNotification(id: string | undefined) {
  return useQuery({ queryKey: notificationKeys.one(id ?? ""), queryFn: () => api.get<AppNotification>(`/notifications/${id}`), enabled: Boolean(id), retry: false });
}

/** Mark read / unread, delete, mark all read, clear read: each refreshes the list and the bell. */
export function useNotificationActions() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: notificationKeys.all });
  const opts = { onSettled: done };
  return {
    setRead: useMutation({ mutationFn: ({ id, read }: { id: string; read: boolean }) => api.post(`/notifications/${id}/read`, { read }), ...opts }),
    remove: useMutation({ mutationFn: (id: string) => api.delete(`/notifications/${id}`), ...opts }),
    readAll: useMutation({ mutationFn: () => api.post<{ count: number }>("/notifications/read-all", {}), ...opts }),
    clearRead: useMutation({ mutationFn: () => api.delete<{ count: number }>("/notifications/read"), ...opts }),
  };
}

export function useNotificationPrefs() {
  return useQuery({ queryKey: notificationKeys.prefs, queryFn: () => api.get<NotificationPrefs>("/notifications/prefs") });
}

/**
 * A toast when a new notification arrives while the app is open, with Open to
 * go to it. Not for what was already waiting when the app opened, and not on
 * /notifications, where it shows up in the list anyway.
 */
export function useNewNotificationToast() {
  const { data } = useUnreadNotifications();
  const toast = useToast();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const seen = useRef<string | null | undefined>(undefined);
  const latest = data?.latest ?? null;
  useEffect(() => {
    if (!data) return;
    const first = seen.current === undefined;
    const fresh = latest && latest.id !== seen.current;
    seen.current = latest?.id ?? null;
    if (first || !fresh || pathname.startsWith("/notifications")) return;
    // Only one that arrived since the last look, not an older one surfacing after the newest was read.
    if (Date.now() - new Date(latest.createdAt).getTime() > POLL_MS * 3) return;
    toast(latest.title, "info", { action: { label: "Open", onClick: () => navigate(`/notifications/${latest.id}`) } });
  }, [data, latest, pathname, toast, navigate]);
}
