/** @type {import('next').NextConfig} */
const API_TARGET = process.env.BACKEND_URL || "http://localhost:4200";

const nextConfig = {
  reactStrictMode: true,
  // Self-contained server bundle for the Docker image (frontend/Dockerfile).
  output: "standalone",
  // Proxy API calls to the Express backend (replaces the old Vite dev proxy).
  // Works in `next dev` and `next start`.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_TARGET}/api/:path*` },
    ];
  },
};

export default nextConfig;
