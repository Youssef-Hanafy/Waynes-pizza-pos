import { describe, expect, it } from "vitest";
import { declineWords, mapTerminalIntent, terminalIntentState } from "./stripe-terminal-mapping";

describe("Stripe M2 PaymentIntent mapping", () => {
  it("keeps a declined intent open for the next card", () => {
    expect(terminalIntentState("requires_payment_method")).toBe("open");
    const mapped = mapTerminalIntent({ id: "pi_1", status: "requires_payment_method", amount: 2599, client_secret: "pi_1_secret_x", last_payment_error: { decline_code: "insufficient_funds" } });
    expect(mapped.state).toBe("open");
    expect(mapped.declineMessage).toMatch(/not enough funds/);
  });

  it("reads the card from the expanded charge", () => {
    const mapped = mapTerminalIntent({
      id: "pi_2", status: "succeeded", amount: 1800, client_secret: "pi_2_secret_y",
      latest_charge: { receipt_url: "https://pay.stripe.com/receipts/x", payment_method_details: { card_present: { brand: "visa", last4: "4242" } } },
    });
    expect(mapped).toMatchObject({ state: "captured", cardBrand: "visa", cardLast4: "4242", amountCents: 1800, receiptUrl: "https://pay.stripe.com/receipts/x" });
  });

  it("does not trip over an unexpanded charge id", () => {
    expect(mapTerminalIntent({ id: "pi_3", status: "canceled", latest_charge: "ch_1" })).toMatchObject({ state: "canceled", cardLast4: null });
  });

  it("maps every status the reader can leave behind", () => {
    expect(terminalIntentState("requires_capture")).toBe("authorized");
    expect(terminalIntentState("processing")).toBe("processing");
    expect(terminalIntentState(undefined)).toBe("open");
    expect(declineWords("something_new")).toMatch(/declined/);
  });
});
