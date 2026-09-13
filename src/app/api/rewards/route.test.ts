import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createServiceSupabaseClient: mocks.create }));
import { POST } from "./route";
import { WAYNE_REWARDS_CONSENT_VERSION } from "@/lib/wayne/rewards";
const body = { firstName: "Test", lastName: "Guest", phone: "5085550198", consent: true, consentVersion: WAYNE_REWARDS_CONSENT_VERSION };
function request(input: unknown = body) { return new Request("https://waynes.example/api/rewards", { method: "POST", headers: { "Content-Type": "application/json", origin: "https://waynes.example" }, body: JSON.stringify(input) }); }
function database(replies: unknown[]) {
  const upserts: unknown[] = [];
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "eq", "order", "limit", "update"]) chain[name] = vi.fn(() => chain);
  chain.upsert = vi.fn((value) => { upserts.push(value); return chain; });
  chain.single = vi.fn(() => Promise.resolve(replies.shift()));
  chain.maybeSingle = vi.fn(() => Promise.resolve(replies.shift()));
  chain.then = (resolve: (value: unknown) => void) => resolve(replies.shift());
  const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
  const db = { from: vi.fn(() => chain), rpc };
  mocks.create.mockReturnValue(db);
  return { db, upserts, chain };
}
beforeEach(() => vi.clearAllMocks());
describe("public rewards endpoint", () => {
  it("rejects missing consent without reaching the database", async () => {
    expect((await POST(request({ ...body, consent: false }))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("records proof before granting consent and uses the existing limiter's hash format", async () => {
    const { db, upserts } = database([{ error: null }, { data: { id: "customer-1", sms_marketing_opt_in: false } }, { data: null }, { error: null }, { error: null }]);
    expect((await POST(request())).status).toBe(200);
    expect(db.rpc.mock.calls[0][1].client_key).toMatch(/^[a-f0-9]{64}$/);
    expect(upserts[1]).toMatchObject({ channel: "sms", status: "opted_in", consent_text_version: WAYNE_REWARDS_CONSENT_VERSION });
  });
  it("does not override an existing opt-out", async () => {
    const { upserts, chain } = database([{ error: null }, { data: { id: "customer-1", sms_marketing_opt_in: false } }, { data: { status: "opted_out" } }]);
    expect((await POST(request())).status).toBe(409);
    expect(upserts).toHaveLength(1);
    expect(chain.update).not.toHaveBeenCalled();
  });
  it("does not grant consent when recording proof fails", async () => {
    const { chain } = database([{ error: null }, { data: { id: "customer-1", sms_marketing_opt_in: false } }, { data: null }, { error: { message: "offline" } }]);
    expect((await POST(request())).status).toBe(503);
    expect(chain.update).not.toHaveBeenCalled();
  });
});
