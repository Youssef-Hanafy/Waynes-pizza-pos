import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as openKeyedCard } from "@/app/api/pos/keyed-card/intent/route";

/**
 * /api/pos/keyed-card/intent with a tip taken on the phone (owner, 2026-10-31):
 * the approval is created ONCE for order + tip, only for the amount the cashier
 * saw, and the tip inside it is recorded on the payment and on Stripe's record.
 */
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/access", () => ({ getCurrentAccess: async () => ({ workspace_id: workspaceId, location_id: null, workspace_name: "Wayne's Pizza" }) }));
vi.mock("@/lib/auth/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/payments/config", () => ({ resolvePaymentProvider: async () => ({ ok: true, value: { provider: stripe } }) }));
vi.mock("@/lib/supabase/server", () => ({ createServiceSupabaseClient: () => service, createServerSupabaseClient: async () => user }));

const workspaceId = "40000000-0000-4000-8000-000000000001";
const orderId = "81000000-0000-4000-8000-000000000001";
const paymentId = "81000000-0000-4000-8000-0000000000aa";

let order = { id: orderId, source: "phone", fulfillment_type: "delivery", total_cents: 3500, tip_cents: 500 };
let lockedOrder = { total_cents: 3500, tip_cents: 500 };
let paidCents = 0;
let begun: { payment_id: string; duplicate: boolean; amount_cents: number; order_number: string } = { payment_id: paymentId, duplicate: false, amount_cents: 3500, order_number: "W001300" };
let existingPayment = { provider_payment_id: "pi_existing", amount_cents: 3500, metadata: { entry: "pos_keyed_card" } };
const updates: Array<Record<string, unknown>> = [];

const stripe = {
  code: "stripe",
  createOnlinePaymentIntent: vi.fn(async (input: { amountCents: number }) => ({ providerPaymentId: "pi_new", status: "pending", providerStatus: "requires_payment_method", amountCents: input.amountCents, clientSecret: "pi_new_secret" })),
  getOnlinePaymentIntent: vi.fn(async () => ({ providerPaymentId: "pi_existing", status: "pending", providerStatus: "requires_payment_method", amountCents: 3500, clientSecret: "pi_existing_secret" })),
};
const user = {
  rpc: vi.fn(async (name: string) => {
    if (name === "wayne_order_paid_cents") return { data: paidCents, error: null };
    if (name === "wayne_begin_payment") return { data: begun, error: null };
    throw new Error(`Unexpected user RPC ${name}`);
  }),
};
let ordersRead = 0;
const service = {
  rpc: vi.fn(async () => ({ data: { status: "failed" }, error: null })),
  from: (table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq"]) query[method] = () => query;
    query.update = (value: Record<string, unknown>) => { updates.push(value); return { eq: async () => ({ error: null }) }; };
    query.maybeSingle = async () => {
      if (table === "orders") return { data: ordersRead++ === 0 ? order : lockedOrder, error: null };
      if (table === "payments") return { data: existingPayment, error: null };
      throw new Error(`Unexpected table ${table}`);
    };
    return query;
  },
};

const request = (body: Record<string, unknown>) => new Request("http://localhost/api/pos/keyed-card/intent", {
  method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" },
  body: JSON.stringify({ order_id: orderId, idempotency_key: `pos-keyed-card-${orderId}-0000000001`, ...body }),
});

beforeEach(() => {
  vi.clearAllMocks(); updates.length = 0; ordersRead = 0; paidCents = 0;
  order = { id: orderId, source: "phone", fulfillment_type: "delivery", total_cents: 3500, tip_cents: 500 };
  lockedOrder = { total_cents: 3500, tip_cents: 500 };
  begun = { payment_id: paymentId, duplicate: false, amount_cents: 3500, order_number: "W001300" };
  existingPayment = { provider_payment_id: "pi_existing", amount_cents: 3500, metadata: { entry: "pos_keyed_card" } };
});

describe("keyed delivery card with a phone tip", () => {
  it("$30 order + $5 tip: ONE Stripe approval for $35, the tip recorded on the payment and on Stripe", async () => {
    const response = await openKeyedCard(request({ expected_amount_cents: 3500, expected_tip_cents: 500 }));
    expect(response.status).toBe(200);
    expect(stripe.createOnlinePaymentIntent).toHaveBeenCalledTimes(1);
    expect(stripe.createOnlinePaymentIntent).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 3500, tipCents: 500, tipAdjust: true }));
    const note = (stripe.createOnlinePaymentIntent.mock.calls[0]![0] as unknown as { note: string }).note;
    expect(note).toContain("order $30.00 + $5.00 tip");
    expect(updates[0]).toMatchObject({ provider_payment_id: "pi_new", metadata: { tip_adjust: true, held_for: "delivery_tip", tip_included_cents: 500, order_cents: 3000 } });
  });

  it("a stale screen (order now $38) is refused before any payment opens or Stripe is called", async () => {
    order = { ...order, total_cents: 3800, tip_cents: 800 };
    const response = await openKeyedCard(request({ expected_amount_cents: 3500, expected_tip_cents: 500 }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "AMOUNT_CHANGED", amount_cents: 3800, tip_cents: 800 });
    expect(user.rpc).not.toHaveBeenCalledWith("wayne_begin_payment", expect.anything());
    expect(stripe.createOnlinePaymentIntent).not.toHaveBeenCalled();
  });

  it("a different tip at the same total is refused too", async () => {
    order = { ...order, total_cents: 3500, tip_cents: 300 };
    const response = await openKeyedCard(request({ expected_amount_cents: 3500, expected_tip_cents: 500 }));
    expect(response.status).toBe(409);
    expect(stripe.createOnlinePaymentIntent).not.toHaveBeenCalled();
  });

  it("an order changed in the instant between the check and the payment opening: that payment is closed, Stripe never sees it", async () => {
    begun = { ...begun, amount_cents: 3800 };
    lockedOrder = { total_cents: 3800, tip_cents: 800 };
    const response = await openKeyedCard(request({ expected_amount_cents: 3500, expected_tip_cents: 500 }));
    expect(response.status).toBe(409);
    expect(service.rpc).toHaveBeenCalledWith("wayne_settle_payment", { payload: expect.objectContaining({ payment_id: paymentId, status: "failed" }) });
    expect(stripe.createOnlinePaymentIntent).not.toHaveBeenCalled();
  });

  it("a replayed request may only continue the same amount — never retried with a changed total", async () => {
    begun = { ...begun, duplicate: true };
    existingPayment = { ...existingPayment, amount_cents: 3500 };
    expect((await openKeyedCard(request({ expected_amount_cents: 3500, expected_tip_cents: 500 }))).status).toBe(200);
    expect(stripe.getOnlinePaymentIntent).toHaveBeenCalledTimes(1);
    expect(stripe.createOnlinePaymentIntent).not.toHaveBeenCalled();

    ordersRead = 0; paidCents = 0; order = { ...order, total_cents: 3800, tip_cents: 800 };
    existingPayment = { ...existingPayment, amount_cents: 3500 };
    const changed = await openKeyedCard(request({ expected_amount_cents: 3800, expected_tip_cents: 800 }));
    expect(changed.status).toBe(409);
    expect(stripe.createOnlinePaymentIntent).not.toHaveBeenCalled();
  });

  it("the rest of a partly paid order carries no tip of its own", async () => {
    paidCents = 3500; order = { ...order, total_cents: 4300, tip_cents: 500 };
    begun = { ...begun, amount_cents: 800 }; lockedOrder = { total_cents: 4300, tip_cents: 500 };
    const response = await openKeyedCard(request({ expected_amount_cents: 800, expected_tip_cents: 0 }));
    expect(response.status).toBe(200);
    expect(stripe.createOnlinePaymentIntent).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 800, tipCents: 0 }));
    expect(updates[0]!.metadata).not.toHaveProperty("tip_included_cents");
  });

  it("split card charges only the selected portion, including when the order already has a tip", async () => {
    begun = { ...begun, amount_cents: 1000 };
    const response = await openKeyedCard(request({ amount_cents: 1000, expected_amount_cents: 1000, expected_tip_cents: 0 }));
    expect(response.status).toBe(200);
    expect(user.rpc).toHaveBeenCalledWith("wayne_begin_payment", { payload: expect.objectContaining({ amount_cents: 1000 }) });
    expect(stripe.createOnlinePaymentIntent).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 1000, tipAdjust: false }));
  });

  it("a split card cannot exceed the unpaid balance", async () => {
    paidCents = 3000;
    const response = await openKeyedCard(request({ amount_cents: 1000, expected_amount_cents: 1000, expected_tip_cents: 0 }));
    expect(response.status).toBe(409);
    expect(stripe.createOnlinePaymentIntent).not.toHaveBeenCalled();
  });

  it("a register still on the previous build (no expected amount) works exactly as before", async () => {
    order = { ...order, total_cents: 3000, tip_cents: 0 }; lockedOrder = { total_cents: 3000, tip_cents: 0 };
    begun = { ...begun, amount_cents: 3000 };
    const response = await openKeyedCard(request({}));
    expect(response.status).toBe(200);
    expect(user.rpc).not.toHaveBeenCalledWith("wayne_order_paid_cents", expect.anything());
    expect(stripe.createOnlinePaymentIntent).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 3000, tipCents: 0, tipAdjust: true }));
    expect((stripe.createOnlinePaymentIntent.mock.calls[0]![0] as unknown as { note: string }).note).toContain("tip added at cash-out");
  });
});
