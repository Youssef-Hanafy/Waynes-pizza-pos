import { afterEach, describe, expect, it, vi } from "vitest";
import { createStripeProvider } from "@/lib/payments/stripe";

vi.mock("server-only", () => ({}));
afterEach(() => vi.unstubAllGlobals());
const stripe = () => createStripeProvider({ secretKey: "sk_test_local_fixture", webhookSecret: "whsec_local_fixture" });

describe("Stripe durable tip operation transport", () => {
  it("creates without charging, then confirms only the saved ID with a stable key", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ id: "pi_bound", status: "requires_confirmation", amount: 2500 }))
      .mockResolvedValueOnce(Response.json({ id: "pi_bound", status: "succeeded", amount: 2500, amount_received: 2500 }));
    vi.stubGlobal("fetch", fetch);
    const provider = stripe();
    const prepared = await provider.createSavedCardIntent!({ customerId: "cus_local", paymentMethodId: "pm_local", amountCents: 2500, idempotencyKey: "tip-operation-prepare", note: "test", metadata: { wayne_tip_operation: "operation" } });
    expect(prepared.status).toBe("pending");
    const create = fetch.mock.calls[0][1];
    expect(create.body.get("confirm")).toBe("false");
    expect(create.body.get("off_session")).toBeNull();
    expect(create.body.get("metadata[wayne_tip_operation]")).toBe("operation");
    expect(create.headers["Idempotency-Key"]).toBe("tip-operation-prepare");
    await provider.confirmSavedCardIntent!(prepared.providerPaymentId!, "tip-operation-confirm");
    expect(fetch.mock.calls[1][0]).toBe("https://api.stripe.com/v1/payment_intents/pi_bound/confirm");
    expect(fetch.mock.calls[1][1].headers["Idempotency-Key"]).toBe("tip-operation-confirm");
    expect(fetch.mock.calls[1][1].body.get("off_session")).toBe("true");
  });
  it("reconciles using amount_received rather than the originally requested amount", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ id: "pi_partial", status: "succeeded", amount: 3000, amount_received: 2500 })));
    expect((await stripe().getPaymentStatus("pi_partial")).amountCents).toBe(2500);
  });
  it("treats network loss as an unknown retryable outcome", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network timeout")));
    await expect(stripe().confirmSavedCardIntent!("pi_bound", "tip-operation-confirm")).rejects.toMatchObject({ code: "NETWORK", retryable: true });
  });
});
