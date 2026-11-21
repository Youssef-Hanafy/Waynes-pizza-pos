import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ access: vi.fn(), resolve: vi.fn(), rpc: vi.fn(), execute: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ getCurrentAccess: mocks.access }));
vi.mock("@/lib/auth/permissions", () => ({ hasPermission: (access: unknown) => Boolean(access) }));
vi.mock("@/lib/payments/config", () => ({ resolvePaymentProvider: mocks.resolve }));
vi.mock("@/lib/supabase/server", () => ({ createServiceSupabaseClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/payments/payarc-operation", () => ({ executePayarcPayment: mocks.execute }));
import { POST } from "@/app/api/pos/orders/[id]/original-card/route";
const orderId = "7d000000-0000-4000-8000-000000000001";
const args = { params: Promise.resolve({ id: orderId }) };
const input = { idempotency_key: "online-extra-stable-request", expected_amount_cents: 535, customer_approved: true };
const request = (body = input, origin = "https://pos.example") => new Request(`https://pos.example/api/pos/orders/${orderId}/original-card`, { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
describe("POS original online card route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue({ workspace_id: "workspace", location_id: "location", profile_id: "staff" });
    mocks.resolve.mockResolvedValue({ ok: true, value: { provider: { code: "payarc", createAdditionalPayment() {} }, connection: { id: "connection" } } });
    mocks.rpc.mockResolvedValue({ data: { payment_id: "extra", amount_cents: 535, original_provider_payment_id: "original-from-database" }, error: null });
    mocks.execute.mockResolvedValue({ payment_id: "extra", status: "captured" });
  });
  it("requires POS access, same-origin submission, and customer approval", async () => {
    mocks.access.mockResolvedValueOnce(null);
    expect((await POST(request(), args)).status).toBe(403);
    expect((await POST(request(input, "https://other.example"), args)).status).toBe(403);
    expect((await POST(request({ ...input, customer_approved: false }), args)).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("reserves against the signed-in workspace and uses only the server-selected original card", async () => {
    const response = await POST(request({ ...input, original_provider_payment_id: "untrusted", source_id: "untrusted" } as typeof input), args);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ payment_status: "captured", amount_cents: 535 });
    expect(mocks.rpc).toHaveBeenCalledWith("wayne_begin_online_extra_payment", expect.objectContaining({ target_order_id: orderId, target_workspace_id: "workspace", target_location_id: "location", target_connection_id: "connection", actor_id: "staff", expected_cents: 535 }));
    expect(mocks.execute.mock.calls[0].slice(-3)).toEqual(["", input.idempotency_key, "original-from-database"]);
  });
  it("a changed balance or locked order never reaches the payment provider", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "The order total changed", code: "40001" } });
    expect((await POST(request(), args)).status).toBe(409);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
