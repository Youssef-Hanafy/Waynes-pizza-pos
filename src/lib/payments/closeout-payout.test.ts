import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createCloseoutStripe, payoutTotals, PayoutReview, PayoutWaiting, verifyPayout, type BalanceTransaction, type PayoutBatch, type PayoutItem, type StripePayout } from "./closeout-payout";

const tx = (amount = 100000, fee = 2900, status: "available" | "pending" = "available"): BalanceTransaction => ({ id: "txn_sale", amount, fee, net: amount - fee, status, currency: "usd", available_on: 1 });
const batch = (): PayoutBatch => ({ id: "batch-1", workspace_id: "workspace-1", location_id: "location-1", business_date: "2026-11-05", account_id: "acct_test", bank_id: "ba_test", connection_id: "connection-1", environment: "sandbox", state: "submitting", net_cents: 97100, submitted_at: new Date().toISOString(), stripe_payout_id: null });
const item = (): PayoutItem => ({ id: "item-1", source_id: "payment-1", kind: "charge", payment_id: "payment-1", provider_id: "pi_test", ledger_status: "captured", refunded_cents: 0, transaction: null });
const payout = (): StripePayout => ({ id: "po_test", amount: 97100, currency: "usd", status: "pending", arrival_date: 1, destination: "ba_test", method: "standard", type: "bank_account", livemode: false, metadata: { wayne_closeout_payout: "batch-1" } });
afterEach(() => { vi.unstubAllGlobals(); });
describe("Standard closeout payout accounting", () => {
  it("uses exact Stripe fees and refund ledger net, including fee adjustments", () => {
    const refund = { ...tx(-10000, -100), id: "txn_refund" };
    expect(payoutTotals([tx(), refund])).toEqual({ gross: 100000, refunds: 10000, fees: 2800, net: 87200 });
  });
  it("does not pay pending funds, duplicate transactions or inconsistent amounts", () => {
    expect(() => payoutTotals([tx(1000, 30, "pending")])).toThrow(PayoutWaiting);
    expect(() => payoutTotals([tx(), tx()])).toThrow(PayoutReview);
    expect(() => payoutTotals([{ ...tx(), net: 100000 }])).toThrow(PayoutReview);
  });
  it("sends a standard bank payout using a stable key and an explicit bank destination", async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json(payout())); vi.stubGlobal("fetch", fetcher);
    const stripe = createCloseoutStripe("sk_test_secret"); const b = batch();
    await stripe.create(b); await stripe.create(b);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toBe("https://api.stripe.com/v1/payouts"); expect(init.headers["Idempotency-Key"]).toBe("closeout-bank-payout-batch-1");
      expect(Object.fromEntries(init.body)).toMatchObject({ amount: "97100", method: "standard", destination: "ba_test", source_type: "card" });
    }
  });
  it("uses Stripe's configured default bank without reading or changing bank details", async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json(payout())); vi.stubGlobal("fetch", fetcher);
    const b = { ...batch(), bank_id: "default" };
    await createCloseoutStripe("sk_test_secret").create(b);
    expect(fetcher.mock.calls[0][1].body.has("destination")).toBe(false);
    expect(() => verifyPayout(b, payout())).not.toThrow();
    expect(() => verifyPayout(b, { ...payout(), type: "card", destination: "card_123" })).toThrow(PayoutReview);
  });
  it("returns account eligibility when Stripe denies the Connect bank-list endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ id: "acct_own", default_currency: "usd", payouts_enabled: true, settings: { payouts: { schedule: { interval: "manual" } } } }))
      .mockResolvedValueOnce(Response.json({ error: { code: "permission_denied" } }, { status: 403 })));
    const account = await createCloseoutStripe("sk_live_secret").account();
    expect(account).toMatchObject({ id: "acct_own", payouts_enabled: true, default_currency: "usd", bankLookupAvailable: false, banks: [] });
  });
  it("never recreates an ambiguous request after Stripe can expire its key", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const b = { ...batch(), submitted_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() };
    await expect(createCloseoutStripe("sk_test_secret").create(b)).rejects.toThrow(PayoutReview); expect(fetcher).not.toHaveBeenCalled();
  });
  it("recovers an accepted payout from paginated history after a lost response", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ data: [{ ...payout(), id: "po_other", metadata: {} }], has_more: true }))
      .mockResolvedValueOnce(Response.json({ data: [payout()], has_more: false })); vi.stubGlobal("fetch", fetcher);
    expect((await createCloseoutStripe("sk_test_secret").find(batch()))?.id).toBe("po_test");
    expect(fetcher.mock.calls[1][0]).toContain("starting_after=po_other");
    expect(fetcher.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
  });
  it("rejects a different amount, bank, mode or instant payout during reconciliation", () => {
    for (const override of [{ amount: 1 }, { destination: "ba_other" }, { livemode: true }, { method: "instant" }, { metadata: {} }]) expect(() => verifyPayout(batch(), { ...payout(), ...override })).toThrow(PayoutReview);
    expect(() => verifyPayout(batch(), payout())).not.toThrow();
  });
  it("waits for held delivery cards and checks an authoritative payment identity", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ id: "pi_test", livemode: false, status: "requires_capture", metadata: {} }))
      .mockResolvedValueOnce(Response.json({ id: "pi_wrong", livemode: false, status: "succeeded", metadata: {} })); vi.stubGlobal("fetch", fetcher);
    const stripe = createCloseoutStripe("sk_test_secret");
    await expect(stripe.transaction(item())).rejects.toThrow(PayoutWaiting);
    await expect(stripe.transaction(item())).rejects.toThrow(PayoutReview);
  });
  it("does not ignore a late refund just because a charge's fees were cached", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "pi_test", livemode: false, status: "succeeded", metadata: {}, latest_charge: { amount_refunded: 500, balance_transaction: tx(), payment_method_details: { type: "card" } } })); vi.stubGlobal("fetch", fetcher);
    await expect(createCloseoutStripe("sk_test_secret").transaction({ ...item(), transaction: tx() })).rejects.toThrow(PayoutWaiting);
  });
});
