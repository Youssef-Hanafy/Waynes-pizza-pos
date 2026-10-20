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
  env: { WAYNE_BUILD_ID: buildId },
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
  poweredByHeader: false,
  reactStrictMode: true
};

export default nextConfig;
