/** @type {import('next').NextConfig} */
const API_TARGET = process.env.BACKEND_URL || "http://localhost:4200";

const nextConfig = {
  reactStrictMode: true,
  // `next dev` refuses /_next/* requests from any host but localhost, which leaves a page
  // opened from another device (an iPad on the same Wi-Fi) unhydrated. Allow private LAN IPs.
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "172.*.*.*"],
  // Self-contained server bundle for the Docker image (frontend/Dockerfile).
  output: "standalone",
  // The offline service worker (public/sw.js). Never served from a cache, so a
  // new version reaches devices the next time they open the app.
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
    ];
  },
  // Proxy API calls to the Express backend (replaces the old Vite dev proxy).
  // Works in `next dev` and `next start`.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_TARGET}/api/:path*` },
    ];
  },
};

export default nextConfig;
