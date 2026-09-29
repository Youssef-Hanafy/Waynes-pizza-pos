import { createHmac, timingSafeEqual } from "node:crypto";

/** Verifies Stripe's signed raw event body before any event data is trusted. */
export function verifyStripeSignature(rawBody: string, signature: string | null, webhookSecret: string, toleranceSeconds = 300) {
  if (!signature || !webhookSecret) return false;
  const parts = signature.split(",").map((part) => part.split("=", 2));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value).filter((value): value is string => Boolean(value));
  if (!timestamp || !/^\d+$/.test(timestamp) || !signatures.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  const expected = createHmac("sha256", webhookSecret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return signatures.some((candidate) => {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(candidate, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

export function readStripeWebhookObject(payload: Record<string, unknown>) {
  const data = payload.data as { object?: Record<string, unknown> } | undefined;
  return data?.object ?? {};
}
