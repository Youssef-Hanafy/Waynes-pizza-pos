import { createHash } from "node:crypto";

const forwardedHeader = "x-forwarded-for";

/**
 * Returns a privacy-preserving, stable key for the database-backed public
 * checkout limiter. Vercel sets x-vercel-forwarded-for from the trusted edge;
 * local development falls back to x-forwarded-for or a shared local key.
 */
export function checkoutRateLimitKey(headers: Headers) {
  const forwarded =
    headers.get("x-vercel-forwarded-for") ?? headers.get(forwardedHeader);
  const address = forwarded?.split(",")[0]?.trim() || "local-development";
  return createHash("sha256").update(address).digest("hex");
}
