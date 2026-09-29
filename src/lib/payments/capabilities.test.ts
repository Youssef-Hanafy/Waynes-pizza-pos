import { describe, expect, it } from "vitest";
import { capabilityGate, providerSecrets, type PaymentConnection } from "./capabilities";

const base: PaymentConnection = {
  id: "97900000-0000-4000-8000-000000000001",
  workspace_id: "97900000-0000-4000-8000-000000000002",
  location_id: null,
  provider: "square",
  connection_mode: "api",
  status: "connected",
  environment: "sandbox",
  merchant_reference: "L1",
  capabilities: { online_card: true, card_present: true, card_present_integrated: true, manual_confirmation: false, refunds_via_api: true, voids_via_api: true, webhooks: true },
  public_configuration: { online_card_enabled: true, terminal_card_enabled: false },
  secret_reference: "env:SQUARE",
  purpose: "counter_and_online",
};

describe("payment capability model", () => {
  it("allows only what the connection can do and has switched on", () => {
    expect(capabilityGate(base, "online")).toEqual({ ok: true });
    expect(capabilityGate(base, "terminal")).toMatchObject({ ok: false, reason: "Card reader payment is switched off." });
    expect(capabilityGate({ ...base, status: "disabled" }, "online")).toMatchObject({ ok: false });
  });

  it("treats a manual external terminal as a person-run payment, never an API call", () => {
    const manual: PaymentConnection = {
      ...base, provider: "manual_external", connection_mode: "manual_external", status: "manual",
      capabilities: { online_card: false, card_present: true, card_present_integrated: false, manual_confirmation: true, refunds_via_api: false, voids_via_api: false, webhooks: false },
      public_configuration: {}, secret_reference: null, purpose: "counter",
    };
    expect(capabilityGate(manual, "terminal")).toMatchObject({ ok: false, manual: true });
    expect(capabilityGate(manual, "online")).toMatchObject({ ok: false });
  });

  it("reads provider secrets only from the connection's own env prefix", () => {
    const env = { SQUARE_ACCESS_TOKEN: "token-1234567890", SQUARE_WEBHOOK_SIGNATURE_KEY: "sigkey-1234567890", OTHER_ACCESS_TOKEN: "x" } as unknown as NodeJS.ProcessEnv;
    expect(providerSecrets("env:SQUARE", env)).toEqual({ accessToken: "token-1234567890", webhookSignatureKey: "sigkey-1234567890" });
    expect(providerSecrets("env:OTHER", env)).toBeNull();
    expect(providerSecrets(null, env)).toBeNull();
  });
});
