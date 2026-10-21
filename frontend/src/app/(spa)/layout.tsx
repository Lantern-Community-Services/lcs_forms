"use client";

import dynamic from "next/dynamic";

// The SPA is client-only (react-router owns the URL; auth/theme read the
// browser). Disable SSR so nothing renders on the server.
const AppClient = dynamic(() => import("@/AppClient"), {
  ssr: false,
  loading: () => <div style={{ height: "100vh" }} />,
});

/**
 * Hosts the whole SPA, mounted once per page load.
 *
 * Why a layout and not the [[...slug]] page: Next keys each segment's subtree
 * by its param value, so the catch-all page for /forms lives under the key
 * `slug|forms`. react-router moves around with pushState, which Next follows
 * without asking the server — but whenever Next does fetch the route's payload
 * (a dev HMR refresh, router.refresh(), or Back into an entry from before a
 * reload, whose cached tree is gone), the answer carries the new slug, the key
 * changes, and everything under it remounts: AuthProvider refetches
 * /api/auth/me, the QueryClient is rebuilt, and every screen's cache is lost.
 *
 * A layout above the dynamic segment keeps its place in the tree whatever the
 * slug, so the SPA lives here and the page renders nothing. The route group
 * (no effect on URLs) keeps app/error.tsx above this layout, so a failure while
 * the client bundle mounts still gets that fallback rather than global-error.
 */
export default function SpaLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AppClient />
      {children}
    </>
  );
}
