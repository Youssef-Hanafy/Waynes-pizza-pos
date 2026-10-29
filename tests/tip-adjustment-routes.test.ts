import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as stripeWebhook } from "@/app/api/webhooks/stripe/route";
import { POST as keyedWebhook } from "@/app/api/payments/webhooks/[key]/route";
import { POST as scheduledCapture } from "@/app/api/pos/tips/auto/route";
import { POST as tips } from "@/app/api/pos/tips/route";
import { captureHeldCards } from "@/lib/payments/tip-capture";
import { applyProviderWebhook } from "@/lib/payments/registry";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createServiceSupabaseClient: () => service, createServerSupabaseClient: () => service }));
vi.mock("@/lib/payments/config", () => ({ resolveWebhookProvider: async () => ({ connection, provider: { handleWebhook: () => envelope } }) }));
vi.mock("@/lib/payments/registry", () => ({
  buildWebhookProvider: () => ({ handleWebhook: () => envelope }),
  webhookSignature: () => "fixture-signature",
  applyProviderWebhook: vi.fn(async () => {}),
}));
vi.mock("@/lib/payments/tip-capture", () => ({ captureHeldCards: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ getCurrentAccess: async () => ({ workspace_id: workspaceId, location_id: null }) }));
vi.mock("@/lib/auth/permissions", () => ({ hasPermission: () => true }));

const workspaceId = "40000000-0000-4000-8000-000000000001";
const orderId = "80000000-0000-4000-8000-000000000001";
const releasedOrderId = "80000000-0000-4000-8000-000000000002";
const jobToken = "local-only-test-job-token-with-32-characters";
const connection = {
  id: "90000000-0000-4000-8000-000000000001", workspace_id: workspaceId, location_id: null,
  provider: "stripe", connection_mode: "api", status: "connected", environment: "sandbox",
  merchant_reference: null, capabilities: {}, public_configuration: {}, secret_reference: "env:STRIPE", purpose: "online",
};
let envelope = tipEnvelope();
let duplicate = false;
let recoveryUnavailable = false;
function tipEnvelope() {
  return { eventId: "evt_local_tip", eventType: "payment_intent.succeeded", signatureVerified: true,
    payload: { data: { object: { id: "pi_local", status: "succeeded", metadata: { wayne_tip_adjust: "true" } } } } };
}
const filters: Array<{ table: string; method: string; args: unknown[] }> = [];
const service = {
  rpc: vi.fn(async (name: string) => {
    if (name === "hanafy_payment_connection_by_webhook_key") return { data: connection, error: null };
    if (name === "hanafy_record_payment_webhook") return { data: duplicate ? { duplicate: true } : { duplicate: false, id: "local-webhook-row" }, error: null };
    if (name === "wayne_finish_payment_webhook") return { data: null, error: null };
    throw new Error(`Unexpected RPC ${name}`);
  }),
  from: (table: string) => {
    const result = () => {
      if (table === "payment_webhook_events") return { data: { id: "local-webhook-row" }, error: null };
      if (table === "scheduled_job_tokens") return { data: { token: jobToken }, error: null };
      if (table === "payments") return { data: [{ id: orderId, order_id: orderId, workspace_id: workspaceId, location_id: null }], error: null };
      if (table === "pos_tip_operations") return {
        data: recoveryUnavailable ? null : [
          { payment_id: orderId, order_id: orderId, workspace_id: workspaceId, location_id: null, requested_tip_cents: 500 },
          { payment_id: releasedOrderId, order_id: releasedOrderId, workspace_id: workspaceId, location_id: null, requested_tip_cents: 800 },
        ], error: recoveryUnavailable ? { message: "database unavailable" } : null,
      };
      throw new Error(`Unexpected table ${table}`);
    };
    const query: Record<string, unknown> = { then: (resolve: (data: unknown) => unknown) => resolve(result()) };
    for (const method of ["select", "eq", "in", "lt", "or", "order", "limit", "maybeSingle"]) {
      query[method] = (...args: unknown[]) => { filters.push({ table, method, args }); return query; };
    }
    return query;
  },
};

beforeEach(() => {
  vi.clearAllMocks(); filters.length = 0; envelope = tipEnvelope(); duplicate = false; recoveryUnavailable = false;
  vi.mocked(captureHeldCards).mockResolvedValue({ captures: [], skipped: [], problems: [] });
});
const routes = [
  { name: "host Stripe webhook", invoke: () => stripeWebhook(new Request("https://local.invalid/api/webhooks/stripe", { method: "POST", body: "fixture" })) },
  { name: "per-connection Stripe webhook", invoke: () => keyedWebhook(new Request("https://local.invalid/api/payments/webhooks/test", { method: "POST", body: "fixture" }), { params: Promise.resolve({ key: "a".repeat(32) }) }) },
];
describe.each(routes)("$name", ({ invoke }) => {
  it("re-applies a verified duplicate after the first delivery failed", async () => {
    vi.mocked(applyProviderWebhook).mockRejectedValueOnce(new Error("database write failed"));
    expect((await invoke()).status).toBe(500);
    duplicate = true;
    expect((await invoke()).status).toBe(200);
    expect(applyProviderWebhook).toHaveBeenCalledTimes(2);
    expect(service.rpc).toHaveBeenLastCalledWith("wayne_finish_payment_webhook", { target_id: "local-webhook-row", error_message: null });
    expect(filters).toContainEqual({ table: "payment_webhook_events", method: "eq", args: ["workspace_id", workspaceId] });
  });
  it("does not apply unsigned duplicate payloads", async () => {
    duplicate = true; envelope.signatureVerified = false;
    expect((await invoke()).status).toBe(200);
    expect(applyProviderWebhook).not.toHaveBeenCalled();
  });
  it("retries ordinary Stripe duplicates too, so a recorded failed apply is recoverable", async () => {
    duplicate = true; envelope.payload.data.object.metadata.wayne_tip_adjust = "false";
    expect((await invoke()).status).toBe(200);
    expect(applyProviderWebhook).toHaveBeenCalledTimes(1);
  });
  it("returns a retryable error if duplicate reconciliation fails again", async () => {
    duplicate = true;
    vi.mocked(applyProviderWebhook).mockRejectedValueOnce(new Error("database still unavailable"));
    expect((await invoke()).status).toBe(500);
  });
});

describe("tip entry point responses and recovery selection", () => {
  it("recovers saved tips and pending releases without resetting the tip to zero", async () => {
    const response = await scheduledCapture(new Request("https://local.invalid/api/pos/tips/auto", { method: "POST", headers: { "x-wayne-job-token": jobToken } }));
    expect(response.status).toBe(200);
    expect(captureHeldCards).toHaveBeenCalledWith(expect.objectContaining({ keyPrefix: "auto", requests: [
      { payment_id: orderId, order_id: orderId, tip_cents: 500 }, { payment_id: releasedOrderId, order_id: releasedOrderId, tip_cents: 800 },
    ] }));
    expect(filters).toContainEqual({ table: "pos_tip_operations", method: "or", args: ["state.eq.pending,release_pending.eq.true"] });
    expect(service.rpc).not.toHaveBeenCalledWith("wayne_pos_apply_card_tips", expect.anything());
  });
  it("does not initiate captures if recovery state cannot be loaded", async () => {
    recoveryUnavailable = true;
    expect((await scheduledCapture(new Request("https://local.invalid/api/pos/tips/auto", { method: "POST", headers: { "x-wayne-job-token": jobToken } }))).status).toBe(503);
    expect(captureHeldCards).not.toHaveBeenCalled();
  });
  it("rejects an invalid scheduler token before loading payments", async () => {
    expect((await scheduledCapture(new Request("https://local.invalid/api/pos/tips/auto", { method: "POST" }))).status).toBe(401);
    expect(filters.some((filter) => filter.table === "payments")).toBe(false);
    expect(captureHeldCards).not.toHaveBeenCalled();
  });
  it("reports already-committed receipts without re-applying the ledger, excluding test tips", async () => {
    vi.mocked(captureHeldCards).mockResolvedValue({ captures: [
      { order_id: orderId, payment_id: orderId, captured_cents: 2500, tip_cents: 500, card_brand: "visa", card_last4: "4242", is_test: false },
      { order_id: releasedOrderId, payment_id: releasedOrderId, captured_cents: 2800, tip_cents: 800, card_brand: "test", card_last4: "4242", is_test: true },
    ], problems: [], skipped: [] });
    const response = await tips(new Request("https://local.invalid/api/pos/tips", { method: "POST", headers: { origin: "https://local.invalid", "content-type": "application/json" }, body: JSON.stringify({ tips: [{ order_id: orderId, tip_cents: 500 }, { order_id: releasedOrderId, tip_cents: 800 }] }) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ charged: 2, tips_cents: 500 });
    expect(service.rpc).not.toHaveBeenCalledWith("wayne_pos_apply_card_tips", expect.anything());
    expect(service.rpc).toHaveBeenCalledWith("wayne_pos_clear_tip_drafts", { order_ids: [orderId, releasedOrderId] });
  });
});
