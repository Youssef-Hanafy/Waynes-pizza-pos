import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readStripeWebhookObject, verifyStripeSignature } from "./stripe-mapping";

describe("Stripe webhook verification", () => {
  const body = JSON.stringify({ id: "evt_test", type: "payment_intent.succeeded", data: { object: { id: "pi_test" } } });
  const secret = "whsec_test_secret";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

  it("accepts an authentic Stripe signature", () => {
    expect(verifyStripeSignature(body, `t=${timestamp},v1=${signature}`, secret)).toBe(true);
  });

  it("rejects tampered bodies", () => {
    expect(verifyStripeSignature(`${body}x`, `t=${timestamp},v1=${signature}`, secret)).toBe(false);
  });

  it("extracts the event object without trusting its data", () => {
    expect(readStripeWebhookObject(JSON.parse(body))).toMatchObject({ id: "pi_test" });
  });
});
