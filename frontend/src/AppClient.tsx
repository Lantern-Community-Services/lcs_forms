"use client";

import { useEffect, useState } from "react";
import { startOffline } from "./lib/offline";
import { startTelemetry } from "./lib/telemetry";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./lib/auth";
import { PrefsProvider } from "./lib/prefs";
import { ToastProvider } from "./components/ui/toast";
import { App } from "./App";
import { RoutedErrorBoundary } from "./components/RoutedErrorBoundary";

/**
 * Client entry point — the React-Router SPA and its provider tree. Mounted by
 * the Next catch-all route with SSR disabled so browser-only state (auth,
 * theme, localStorage) is safe.
 */
export function AppClient() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        // Refetch on focus: a phone coming back from the lock screen should see
        // the roster as it is now, not as it was an hour ago.
        //
        // networkMode "always": with the default, a device that says it's
        // offline never sends a request at all, so a screen waits forever
        // instead of getting the service worker's stored copy (lib/offline.ts),
        // and a save never says it failed.
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 15_000, networkMode: "always" },
          mutations: { networkMode: "always" },
        },
      })
  );
  useEffect(() => startOffline(), []);
  useEffect(() => startTelemetry(), []);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <PrefsProvider>
          <AuthProvider>
            <ToastProvider>
              <RoutedErrorBoundary>
                <App />
              </RoutedErrorBoundary>
            </ToastProvider>
          </AuthProvider>
        </PrefsProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default AppClient;
