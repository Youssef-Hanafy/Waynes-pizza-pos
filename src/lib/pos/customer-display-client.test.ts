import { beforeEach, describe, expect, it, vi } from "vitest";
import { listCustomerDisplays, publishCustomerDisplay, readCustomerDisplay, respondToCustomerDisplay } from "./customer-display-client";

const { rpc, abortSignal, browserClient } = vi.hoisted(() => ({ rpc: vi.fn(), abortSignal: vi.fn(), browserClient: vi.fn() }));

vi.mock("@/lib/supabase/client", () => ({ createBrowserSupabaseClient: browserClient }));

beforeEach(() => {
  rpc.mockReset().mockReturnValue({ abortSignal });
  abortSignal.mockReset();
  browserClient.mockReset().mockReturnValue({ rpc });
});

describe("authenticated customer display transport", () => {
  it("publishes the current request and returns the matching customer's answer", async () => {
    const response = { request_id: "request-1", kind: "tip", tip_cents: 500 };
    abortSignal.mockResolvedValue({ data: { response, screen_online: true }, error: null });
    await expect(publishCustomerDisplay({ kind: "publish", key: "Front", state: { phase: "tip", request_id: "request-1" }, publisher: "register-1", changed: true })).resolves.toEqual({ response, screen_online: true });
    expect(rpc).toHaveBeenCalledWith("wayne_display_publish", { screen_key: "Front", screen_state: { phase: "tip", request_id: "request-1" }, publisher: "register-1", changed: true });
  });

  it("reads the register state without a Vercel request", async () => {
    abortSignal.mockResolvedValue({ data: { found: true, state: { phase: "sign" }, register_online: true }, error: null });
    await expect(readCustomerDisplay(" Front ")).resolves.toMatchObject({ found: true, state: { phase: "sign" } });
    expect(rpc).toHaveBeenCalledWith("wayne_display_read", { screen_key: "Front" });
  });

  it("keeps a rejected tip or signature retryable", async () => {
    abortSignal.mockResolvedValue({ data: { accepted: false }, error: null });
    await expect(respondToCustomerDisplay("Front", { request_id: "stale-request", kind: "tip", tip_cents: 500 })).rejects.toThrow("could not be sent");
  });

  it("sends signatures to the existing permission-checked function", async () => {
    const answer = { request_id: "signature-1", kind: "signature", signature_svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1L2 2"/></svg>' };
    abortSignal.mockResolvedValue({ data: { accepted: true }, error: null });
    await expect(respondToCustomerDisplay("Front", answer)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("wayne_display_respond", { screen_key: "Front", answer });
  });

  it("does not hide expired sessions or permission failures", async () => {
    abortSignal.mockResolvedValue({ data: null, error: { message: "POS access required" } });
    await expect(readCustomerDisplay("Front")).rejects.toThrow("could not be reached");
    await expect(listCustomerDisplays()).rejects.toThrow("could not be listed");
  });
});
