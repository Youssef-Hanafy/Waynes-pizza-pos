import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as openKeyedCard } from "@/app/api/pos/keyed-card/intent/route";
import { POST as confirmKeyedCard } from "@/app/api/pos/keyed-card/confirm/route";

/**
 * Verification of the keyed-card routes (2026-10-31): a lost answer can be resumed
 * on the SAME approval (never a second one, never a different amount), and the
 * books are only settled for exactly the amount the payment was opened for.
 */
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/access", () => ({ getCurrentAccess: async () => ({ workspace_id: workspaceId, location_id: null, workspace_name: "Wayne's Pizza" }) }));
vi.mock("@/lib/auth/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/payments/config", () => ({ resolvePaymentProvider: async () => ({ ok: true, value: { provider: stripe } }) }));
vi.mock("@/lib/supabase/server", () => ({ createServiceSupabaseClient: () => service, createServerSupabaseClient: async () => user }));

const workspaceId = "40000000-0000-4000-8000-000000000001";
const orderId = "82000000-0000-4000-8000-000000000001";
const openId = "82000000-0000-4000-8000-0000000000aa";

let order = { id: orderId, source: "phone", fulfillment_type: "delivery", total_cents: 3500, tip_cents: 500 };
let open: Record<string, unknown> | null = null;
let stripeIntent = { providerPaymentId: "pi_open", status: "pending", providerStatus: "requires_payment_method", amountCents: 3500, clientSecret: "pi_open_secret" };
let confirmPayment: Record<string, unknown> = {};
let statusAnswer: Record<string, unknown> = {};
const updates: Array<Record<string, unknown>> = [];

const stripe = {
  code: "stripe",
  createOnlinePaymentIntent: vi.fn(async (input: { amountCents: number }) => ({ ...stripeIntent, providerPaymentId: "pi_recreated", amountCents: input.amountCents, clientSecret: "pi_recreated_secret" })),
  getOnlinePaymentIntent: vi.fn(async () => stripeIntent),
  getPaymentStatus: vi.fn(async () => statusAnswer),
};
const user = {
  rpc: vi.fn(async (name: string) => {
    if (name === "wayne_order_paid_cents") return { data: 0, error: null };
    if (name === "wayne_begin_payment") return { data: null, error: { code: "40001", message: "A payment is already open on this order" } };
    throw new Error(`Unexpected user RPC ${name}`);
  }),
};
const service = {
  rpc: vi.fn(async () => ({ data: { status: "authorized" }, error: null })),
  from: (table: string) => {
    let selected = "";
    const query: Record<string, unknown> = {};
    for (const method of ["eq", "order", "limit"]) query[method] = () => query;
    query.select = (columns: string) => { selected = columns; return query; };
    query.update = (value: Record<string, unknown>) => { updates.push(value); return { eq: async () => ({ error: null }) }; };
    query.maybeSingle = async () => {
      if (table === "orders") return { data: order, error: null };
      if (table === "payments" && selected.includes("idempotency_key")) return { data: open, error: null };
      if (table === "payments" && selected.includes("order:orders")) return { data: confirmPayment, error: null };
      if (table === "payments") return { data: { metadata: open?.metadata ?? {} }, error: null };
      throw new Error(`Unexpected table ${table}`);
    };
    return query;
  },
};

const post = (url: string, body: Record<string, unknown>) => new Request(`http://localhost${url}`, {
  method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(body),
});
const retry = (expected?: number) => openKeyedCard(post("/api/pos/keyed-card/intent", { order_id: orderId, idempotency_key: `pos-keyed-card-${orderId}-retry000001`, ...(expected === undefined ? {} : { expected_amount_cents: expected, expected_tip_cents: 500 }) }));
const openPayment = (secondsAgo: number, extra: Record<string, unknown> = {}) => ({
  id: openId, provider_payment_id: "pi_open", amount_cents: 3500, created_at: new Date(Date.now() - secondsAgo * 1000).toISOString(),
  metadata: { entry: "pos_keyed_card", tip_adjust: true, held_for: "delivery_tip" }, idempotency_key: `pos-keyed-card-${orderId}-first0000001`,
  order: { order_number: "W001400", total_cents: 3500, tip_cents: 500 }, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks(); updates.length = 0;
  order = { id: orderId, source: "phone", fulfillment_type: "delivery", total_cents: 3500, tip_cents: 500 };
  open = null;
  stripeIntent = { providerPaymentId: "pi_open", status: "pending", providerStatus: "requires_payment_method", amountCents: 3500, clientSecret: "pi_open_secret" };
});

describe("lost answer on a keyed card: resume the SAME approval", () => {
  it("an abandoned open card (older than the register's wait) is continued: same payment, same PaymentIntent, no new one", async () => {
    open = openPayment(60);
    const response = await retry(3500);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ payment_id: openId, client_secret: "pi_open_secret", resumed: true, payment_status: "pending" });
    expect(stripe.createOnlinePaymentIntent).not.toHaveBeenCalled();
  });

  it("an already approved card is only read back (the register skips confirming it again)", async () => {
    open = openPayment(60);
    stripeIntent = { ...stripeIntent, status: "authorized", providerStatus: "requires_capture" };
    expect(await (await retry(3500)).json()).toMatchObject({ payment_id: openId, payment_status: "authorized" });
  });

  it("a card another register opened moments ago is NOT taken over", async () => {
    open = openPayment(5);
    const response = await retry(3500);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/already in progress/);
    expect(stripe.getOnlinePaymentIntent).not.toHaveBeenCalled();
  });

  it("a retry for a different amount is refused — the open card keeps its amount", async () => {
    open = openPayment(60);
    const response = await retry(3800);
    expect(response.status).toBe(409);
    // Refused by the stale-screen check (the order is $35.00) before the open card is even looked at.
    expect(await response.json()).toMatchObject({ code: "AMOUNT_CHANGED", amount_cents: 3500 });
    expect(stripe.getOnlinePaymentIntent).not.toHaveBeenCalled();
  });

  it("an open card whose Stripe id was never saved is re-asked with its ORIGINAL idempotency key (Stripe returns the same intent)", async () => {
    open = openPayment(60, { provider_payment_id: null });
    const response = await retry(3500);
    expect(response.status).toBe(200);
    expect(stripe.createOnlinePaymentIntent).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: `pos-keyed-card-${orderId}-first0000001`, amountCents: 3500, tipCents: 500, paymentId: openId }));
    expect(updates[0]).toMatchObject({ provider_payment_id: "pi_recreated", metadata: { tip_included_cents: 500 } });
  });

  it("a Stripe intent whose amount differs from the payment is never resumed", async () => {
    open = openPayment(60);
    stripeIntent = { ...stripeIntent, amountCents: 3000 };
    expect((await retry(3500)).status).toBe(409);
  });

  it("an open payment that isn't a keyed card (reader, online) is never touched", async () => {
    open = openPayment(60, { metadata: { entry: "pos_terminal" } });
    expect((await retry(3500)).status).toBe(409);
    expect(stripe.getOnlinePaymentIntent).not.toHaveBeenCalled();
  });
});

describe("confirm settles only the amount the payment was opened for", () => {
  const confirm = () => confirmKeyedCard(post("/api/pos/keyed-card/confirm", { payment_id: openId }));
  beforeEach(() => {
    confirmPayment = { id: openId, provider_payment_id: "pi_open", amount_cents: 3500, metadata: { tip_included_cents: 500 }, order: { id: orderId, workspace_id: workspaceId, source: "phone", fulfillment_type: "delivery" } };
  });

  it("$35 approved for a $35 payment: held for the driver's cash-out", async () => {
    statusAnswer = { providerPaymentId: "pi_open", status: "authorized", providerStatus: "requires_capture", amountCents: 3500, maxCapturableCents: 3500, cardBrand: "visa", cardLast4: "4242", receiptUrl: null, failureReason: null };
    const response = await confirm();
    expect(await response.json()).toEqual({ payment_status: "authorized" });
    expect(service.rpc).toHaveBeenCalledWith("wayne_settle_payment", { payload: expect.objectContaining({ payment_id: openId, status: "authorized", amount_cents: 3500 }) });
  });

  it("Stripe showing a different amount is NOT written to the books", async () => {
    statusAnswer = { providerPaymentId: "pi_open", status: "authorized", providerStatus: "requires_capture", amountCents: 3000, cardBrand: "visa", cardLast4: "4242", receiptUrl: null, failureReason: null };
    const response = await confirm();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "AMOUNT_MISMATCH" });
    expect(service.rpc).not.toHaveBeenCalled();
  });
});
