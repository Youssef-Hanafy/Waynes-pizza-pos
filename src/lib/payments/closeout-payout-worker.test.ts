import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { runCloseoutPayout } from "./closeout-payout-worker";
import type { createServiceSupabaseClient } from "@/lib/supabase/server";

function harness(options: { pending?: boolean; lostPlan?: boolean; lostPayout?: boolean } = {}) {
  const batch = { id: "batch-1", workspace_id: "w", location_id: "l", business_date: "2026-11-05", account_id: "acct_test", bank_id: "ba_test", connection_id: "c", environment: "sandbox", state: "waiting", net_cents: null as number | null, submitted_at: null as string | null, stripe_payout_id: null as string | null };
  const items = [{ id: "i", source_id: "p", kind: "charge", provider_id: "pi_test", payment_id: "p", ledger_status: "captured", refunded_cents: 0, transaction: null as unknown }];
  let savedPayout: Record<string, unknown> | null = null;
  let losePlan = Boolean(options.lostPlan);
  const rpc = vi.fn(async (name, args) => {
    if (name === "wayne_claim_bank_payout") return { data: { batch: structuredClone(batch), items: structuredClone(items) }, error: null };
    if (args.action === "item") items[0].transaction = args.details.transaction;
    if (args.action === "plan") {
      Object.assign(batch, { state: "submitting", net_cents: args.details.net, submitted_at: new Date().toISOString() });
      if (losePlan) { losePlan = false; return { data: null, error: { message: "Lost plan response after commit" } }; }
    }
    if (args.action === "finish") {
      if (args.details.state) batch.state = args.details.state;
      if (args.details.payout_id) batch.stripe_payout_id = args.details.payout_id;
    }
    return { data: structuredClone(batch), error: null };
  });
  const service = { rpc, from(table: string) {
    const query = { select: () => query, eq: () => query, lt: () => query, is: () => query,
      maybeSingle: async () => ({ data: { workspace_id: "w", location_id: "l", provider: "stripe", status: "connected", environment: "sandbox", secret_reference: "env:STRIPE" }, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ data: table === "closeout_bank_payouts" ? [] : null, error: null }) };
    return query;
  } } as unknown as ReturnType<typeof createServiceSupabaseClient>;
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/v1/account") return Response.json({ id: "acct_test", payouts_enabled: true, settings: { payouts: { schedule: { interval: "manual" } } } });
    if (path.includes("external_accounts")) return Response.json({ data: [{ id: "ba_test", currency: "usd", object: "bank_account", status: "verified" }] });
    if (path.includes("payment_intents")) return Response.json({ id: "pi_test", livemode: false, status: "succeeded", metadata: {}, latest_charge: { amount_refunded: 0, payment_method_details: { type: "card" }, balance_transaction: { id: "txn_sale", amount: 100000, fee: 2900, net: 97100, currency: "usd", status: options.pending ? "pending" : "available", available_on: 1 } } });
    if (path === "/v1/balance") return Response.json({ available: [{ currency: "usd", source_types: { card: 97100 } }] });
    if (path === "/v1/payouts" && init.method === "GET") return Response.json({ data: savedPayout ? [savedPayout] : [], has_more: false });
    if (path === "/v1/payouts" && init.method === "POST") {
      savedPayout = { id: "po_once", amount: 97100, currency: "usd", destination: "ba_test", status: "pending", method: "standard", livemode: false, metadata: { wayne_closeout_payout: batch.id }, arrival_date: 1 };
      if (options.lostPayout) throw new Error("Network response lost AFTER Stripe accepted the payout");
      return Response.json(savedPayout);
    }
    throw new Error(`Unexpected Stripe call ${path}`);
  });
  vi.stubGlobal("fetch", fetcher); vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_12345678901234567890"); vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_12345678901234567890");
  return { service, batch, rpc, fetcher, posts: () => fetcher.mock.calls.filter(([url, init]) => url.endsWith("/payouts") && init.method === "POST") };
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("Closeout worker recovery", () => {
  it("never creates a payout while a day's funds are pending", async () => {
    const h = harness({ pending: true }); await runCloseoutPayout(h.service);
    expect(h.batch.state).toBe("waiting"); expect(h.posts()).toHaveLength(0);
  });
  it("persists the payout plan before sending to Stripe", async () => {
    const h = harness(); await runCloseoutPayout(h.service);
    expect(h.batch).toMatchObject({ state: "pending", net_cents: 97100, stripe_payout_id: "po_once" });
    expect(h.rpc.mock.calls.find(([, a]) => a.action === "plan")).toBeTruthy(); expect(h.posts()).toHaveLength(1);
  });
  it("reconciles an accepted payout after losing Stripe's response without a second POST", async () => {
    const h = harness({ lostPayout: true }); await runCloseoutPayout(h.service);
    expect(h.batch.state).toBe("submitting"); expect(h.batch.stripe_payout_id).toBeNull();
    await runCloseoutPayout(h.service);
    expect(h.batch.state).toBe("pending"); expect(h.batch.stripe_payout_id).toBe("po_once"); expect(h.posts()).toHaveLength(1);
  });
  it("does not send until a lost database plan acknowledgement is reconciled", async () => {
    const h = harness({ lostPlan: true }); await runCloseoutPayout(h.service);
    expect(h.batch.state).toBe("submitting"); expect(h.posts()).toHaveLength(0);
    await runCloseoutPayout(h.service); expect(h.posts()).toHaveLength(1); expect(h.batch.state).toBe("pending");
  });
});
