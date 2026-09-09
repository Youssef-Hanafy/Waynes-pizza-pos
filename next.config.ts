import type { NextConfig } from "next";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseOrigin = supabaseUrl ? new URL(supabaseUrl) : undefined;

const nextConfig: NextConfig = {
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
