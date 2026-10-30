import type { NextConfig } from "next";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseOrigin = supabaseUrl ? new URL(supabaseUrl) : undefined;

/**
 * This deploy's id, baked into the pages and the server alike, so a register
 * still running an older deploy can tell and reload itself when idle
 * (src/stores/use-app-update.ts, /api/version).  Vercel gives every deploy its
 * own id at build time; anywhere else it is empty and the check stays off.
 */
const buildId = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || "";

const nextConfig: NextConfig = {
  deploymentId: buildId || undefined,
  // Shown on POS → More → "This app" so each register's exact version can be read off the screen (owner, 2026-10-28).
  env: { WAYNE_BUILD_ID: buildId, WAYNE_COMMIT: process.env.VERCEL_GIT_COMMIT_SHA ?? "", WAYNE_BUILT_AT: new Date().toISOString() },
  // `npm run dev` seen from the Android emulator (10.0.2.2 is this computer there).
  allowedDevOrigins: ["10.0.2.2"],
  images: supabaseOrigin
    ? {
        maximumResponseBody: 5_000_000,
        qualities: [75],
        remotePatterns: [
          {
            protocol: supabaseOrigin.protocol === "http:" ? "http" : "https",
            hostname: supabaseOrigin.hostname,
            port: supabaseOrigin.port,
            pathname: "/storage/v1/object/public/wayne-menu/**",
            search: ""
          }
        ]
      }
    : undefined,
  experimental: {
    serverActions: { bodySizeLimit: "6mb" }
  },
  // The POS offline worker (public/pos-sw.js) must never be served stale, so a fix to it reaches the register at once.
  async headers() {
    return [{ source: "/pos/:path*", headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }] }, { source: "/pos-sw.js", headers: [{ key: "Cache-Control", value: "no-cache, max-age=0, must-revalidate" }] }];
  },
  poweredByHeader: false,
  reactStrictMode: true
};

export default nextConfig;
