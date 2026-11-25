import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { reconcilePayarcConnectNotice } from "@/lib/payments/payarc-connect-operation";
import {
  checkPayarcConnectReader, payarcConnectCallbackAuthorized, payarcConnectConfig, payarcConnectAccessToken, payarcConnectOutcome,
  sendPayarcConnectSale, type PayarcConnectAttempt,
} from "@/lib/payments/payarc-connect";

vi.mock("server-only", () => ({}));

const locationId = randomUUID();
const env = {
  PAYARC_ENVIRONMENT: "sandbox",
  PAYARC_CONNECT_LOCATION_ID: locationId,
  PAYARC_CONNECT_TERMINAL_SERIAL: "0123456789",
  PAYARC_CONNECT_MID: "012345678912",
  PAYARC_CONNECT_EMAIL: "merchant@example.invalid",
  PAYARC_CONNECT_CLIENT_SECRET: "test-client-secret",
  PAYARC_API_TOKEN: "test-merchant-token",
  PAYARC_CONNECT_CALLBACK_ORIGIN: "https://pos.example.invalid",
};
const traceId = randomUUID();
const attempt: PayarcConnectAttempt = {
  id: randomUUID(), terminal_checkout_id: null, status: "pending", amount_cents: 2700,
  metadata: {
    payarc_connect_ref: "12345678abcdef90", payarc_connect_tip_cents: 500, payarc_connect_tax_cents: 200,
    payarc_connect_serial: env.PAYARC_CONNECT_TERMINAL_SERIAL, environment: "sandbox",
  },
};
const approval = {
  traceId, transactionId: attempt.metadata.payarc_connect_ref, transType: "SALE", status: "APPROVED", chargeId: "example-charge",
  amount: { total: 2700, approved: 2700, currency: "USD", tip: 500, tax: 200 },
};

afterEach(() => vi.unstubAllGlobals());

describe("Payarc Connect V3", () => {
  it("uses a dedicated V3 bearer credential without exchanging the merchant gateway token", async () => {
    const fetchApi = vi.fn();
    vi.stubGlobal("fetch", fetchApi);
    const config = payarcConnectConfig({ ...env, PAYARC_CONNECT_API_TOKEN: "verified-connect-token" })!;
    expect(await payarcConnectAccessToken(config)).toBe("verified-connect-token");
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it("checks reader connectivity with the same V3 credential used for sales", async () => {
    const fetchApi = vi.fn().mockResolvedValue(Response.json({ serialNumber: env.PAYARC_CONNECT_TERMINAL_SERIAL, online: true }));
    vi.stubGlobal("fetch", fetchApi);
    const config = payarcConnectConfig({ ...env, PAYARC_CONNECT_API_TOKEN: "verified-connect-token" })!;
    expect(await checkPayarcConnectReader(config)).toBe(true);
    expect(fetchApi).toHaveBeenCalledWith(
      `https://testpayarcconnectapi.payarc.net/v3/terminals/${config.serial}/connectivity`,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer verified-connect-token" }) }),
    );
  });

  it("keeps the merchant profile MID for Login separate from the V3 tenant ID", async () => {
    const config = payarcConnectConfig({ ...env, PAYARC_CONNECT_LOGIN_MID: "0709900000098856" })!;
    const send = vi.fn().mockResolvedValue(Response.json({
      ErrorCode: 0,
      BearerTokenInfo: { AccessToken: "connect-access-token" },
    }));
    vi.stubGlobal("fetch", send);
    expect(await payarcConnectAccessToken(config)).toBe("connect-access-token");
    expect(JSON.parse(send.mock.calls[0]![1].body).MID).toBe("0709900000098856");
    expect(config.mid).toBe(env.PAYARC_CONNECT_MID);
    expect(payarcConnectConfig(env)?.loginMid).toBe(env.PAYARC_CONNECT_MID);
  });

  it("posts the tip-inclusive amount and suppresses the reader tip prompt", async () => {
    const send = vi.fn().mockResolvedValue(Response.json({ traceId, response: { status: "SUCCESS" } }));
    vi.stubGlobal("fetch", send);
    expect(await sendPayarcConnectSale(payarcConnectConfig(env)!, "connect-session-token", attempt)).toEqual({ traceId });
    const [url, request] = send.mock.calls[0]!;
    expect(url).toBe("https://testpayarcconnectapi.payarc.net/v3/transactions/sale");
    expect(request.headers).toMatchObject({ Authorization: "Bearer connect-session-token", "X-Idempotency-Key": attempt.id });
    const { callbackURL, ...sale } = JSON.parse(request.body);
    const callback = new URL(callbackURL);
    const key = callback.searchParams.get("key");
    expect(callback.origin + callback.pathname).toBe(`https://pos.example.invalid/api/payments/payarc-connect/${attempt.id}`);
    expect(payarcConnectCallbackAuthorized(payarcConnectConfig(env)!, attempt.id, key)).toBe(true);
    expect(payarcConnectCallbackAuthorized(payarcConnectConfig(env)!, randomUUID(), key)).toBe(false);
    expect(sale).toEqual({
      tenantId: env.PAYARC_CONNECT_MID, terminalId: env.PAYARC_CONNECT_TERMINAL_SERIAL,
      transactionId: attempt.metadata.payarc_connect_ref, tenderType: "CREDIT",
      amount: { total: 2700, subtotal: 2000, currency: "USD", tip: 500, tax: 200 },
      printReceipt: 0, tipRequestFlag: false,
    });
  });

  it("only releases a definitive pre-dispatch rejection", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(Response.json({ response: { status: "FAILURE", error: { code: "TERMINAL_OFFLINE" } } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({}, { status: 502 }));
    vi.stubGlobal("fetch", send);
    expect(await sendPayarcConnectSale(payarcConnectConfig(env)!, "token", attempt)).toEqual({ rejected: "TERMINAL_OFFLINE" });
    expect(await sendPayarcConnectSale(payarcConnectConfig(env)!, "token", attempt)).toEqual({});
  });

  it("accepts a matching approval before a trace has been written and rejects mismatched or ambiguous results", () => {
    expect(payarcConnectOutcome(approval, attempt)).toMatchObject({ status: "captured", traceId, chargeId: "example-charge" });
    for (const change of [
      { transactionId: "other" }, { transType: "REFUND" }, { status: "TIMEOUT" }, { status: "DUP TRANSACTION" },
      { amount: { ...approval.amount, approved: 2600 } }, { amount: { ...approval.amount, tip: 400 } },
      { amount: { ...approval.amount, currency: "CAD" } }, { chargeId: undefined },
    ]) expect(payarcConnectOutcome({ ...approval, ...change }, attempt)).toBeNull();
    expect(payarcConnectOutcome(approval, { ...attempt, terminal_checkout_id: randomUUID() })).toBeNull();
    expect(payarcConnectOutcome({ ...approval, status: "DECLINE" }, attempt)).toMatchObject({ status: "failed" });
    expect(payarcConnectOutcome({ ...approval, status: "CANCELLED" }, attempt)).toMatchObject({ status: "voided" });
  });

  it("settles only the authenticated Payarc lookup, even when the callback claims approval", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "captured", error: null });
    const service = { rpc } as unknown as Parameters<typeof reconcilePayarcConnectNotice>[0];
    const login = () => Response.json({ ErrorCode: 0, BearerTokenInfo: { AccessToken: "connect-access" } });
    const request = vi.fn()
      .mockResolvedValueOnce(login())
      .mockResolvedValueOnce(Response.json({ ...approval, transactionId: "other" }))
      .mockResolvedValueOnce(login())
      .mockResolvedValueOnce(Response.json(approval));
    vi.stubGlobal("fetch", request);
    const config = payarcConnectConfig(env)!;
    expect(await reconcilePayarcConnectNotice(service, config, attempt, approval)).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect(await reconcilePayarcConnectNotice(service, config, attempt, { ...approval, chargeId: "wrong-charge" })).toBe(true);
    expect(rpc).toHaveBeenCalledWith("wayne_settle_payarc_connect_payment", expect.objectContaining({
      target_payment_id: attempt.id, payload: expect.objectContaining({ charge_id: approval.chargeId }),
    }));
  });

  it("refuses an environment or host mismatch", () => {
    expect(payarcConnectConfig({ ...env, PAYARC_ENVIRONMENT: "production" })).toBeNull();
    expect(payarcConnectConfig({ ...env, PAYARC_CONNECT_API_ORIGIN: "https://testpayarcconnectapi.payarc.net.example.invalid" })).toBeNull();
    expect(payarcConnectConfig({ ...env, PAYARC_CONNECT_CALLBACK_ORIGIN: "http://pos.example.invalid" })).toBeNull();
  });
});
