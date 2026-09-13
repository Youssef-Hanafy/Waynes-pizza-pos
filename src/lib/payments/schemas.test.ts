import { describe, expect, it } from "vitest";
import {
  cardCheckoutRequestSchema, parseAmountInput, paymentErrorMessage, refundableCents,
  refundRequestSchema, squareWebSdkUrl, terminalActionSchema,
} from "./schemas";

const orderPayload = {
  idempotency_key: "phase11-checkout-key-0001",
  fulfillment_type: "pickup" as const,
  first_name: "Card", last_name: "Customer", phone: "508-555-0188", email: "",
  sms_opt_in: false, email_opt_in: false, tip_cents: 0, promo_code: "", special_instructions: "",
  address: { address1: "", address2: "", city: "", state: "", postal_code: "", delivery_instructions: "" },
  items: [{ menu_item_id: "0b3f1a54-7a2c-4d1e-9a44-5e0f1b2c3d4e", variant_id: null, quantity: 1, special_instructions: "", modifiers: [] }],
};

describe("SDK environment", () => {
  it("keeps sandbox and production on different scripts", () => {
    expect(squareWebSdkUrl("sandbox")).toContain("sandbox.web.squarecdn.com");
    expect(squareWebSdkUrl("production")).toBe("https://web.squarecdn.com/v1/square.js");
  });
});

describe("card checkout request", () => {
  it("accepts an order with a card token", () => {
    const parsed = cardCheckoutRequestSchema.safeParse({
      order: orderPayload,
      payment: { source_id: "cnon:card-nonce-ok", verification_token: null, idempotency_key: "phase11-checkout-key-0001" },
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a payment with no card token", () => {
    expect(cardCheckoutRequestSchema.safeParse({
      order: orderPayload, payment: { source_id: "", idempotency_key: "phase11-checkout-key-0001" },
    }).success).toBe(false);
  });

  it("refuses an idempotency key too short to be unique", () => {
    expect(cardCheckoutRequestSchema.safeParse({
      order: orderPayload, payment: { source_id: "cnon:card-nonce-ok", idempotency_key: "short" },
    }).success).toBe(false);
  });

  it("still enforces the order rules, so a delivery with no address cannot be paid for", () => {
    expect(cardCheckoutRequestSchema.safeParse({
      order: { ...orderPayload, fulfillment_type: "delivery" },
      payment: { source_id: "cnon:card-nonce-ok", idempotency_key: "phase11-checkout-key-0001" },
    }).success).toBe(false);
  });
});

describe("card reader requests", () => {
  const base = {
    order_id: "0b3f1a54-7a2c-4d1e-9a44-5e0f1b2c3d4e",
    terminal_id: "1c4f2b65-8b3d-4e2f-8b55-6f1a2c3d4e5f",
    idempotency_key: "pos-terminal-key-000001",
  };

  it("accepts the three reader actions and nothing else", () => {
    for (const action of ["start", "status", "cancel"]) {
      expect(terminalActionSchema.safeParse({ ...base, action }).success).toBe(true);
    }
    expect(terminalActionSchema.safeParse({ ...base, action: "capture" }).success).toBe(false);
  });
});

describe("refund requests", () => {
  const base = { payment_id: "0b3f1a54-7a2c-4d1e-9a44-5e0f1b2c3d4e", idempotency_key: "refund-key-0000000001" };

  it("requires a positive amount and a real reason", () => {
    expect(refundRequestSchema.safeParse({ ...base, amount_cents: 500, reason: "Wrong order" }).success).toBe(true);
    expect(refundRequestSchema.safeParse({ ...base, amount_cents: 0, reason: "Wrong order" }).success).toBe(false);
    expect(refundRequestSchema.safeParse({ ...base, amount_cents: -500, reason: "Wrong order" }).success).toBe(false);
    expect(refundRequestSchema.safeParse({ ...base, amount_cents: 500, reason: "no" }).success).toBe(false);
  });
});

describe("refundable amount", () => {
  it("is what is left of a captured payment", () => {
    expect(refundableCents({ status: "captured", amount_cents: 2000, refunded_cents: 500 })).toBe(1500);
    expect(refundableCents({ status: "captured", amount_cents: 2000, refunded_cents: 2000 })).toBe(0);
  });

  it("is nothing at all on a payment that never captured", () => {
    for (const status of ["pending", "authorized", "failed", "voided"] as const) {
      expect(refundableCents({ status, amount_cents: 2000, refunded_cents: 0 })).toBe(0);
    }
  });

  it("never goes negative if the ledger is over-refunded", () => {
    expect(refundableCents({ status: "captured", amount_cents: 2000, refunded_cents: 2500 })).toBe(0);
  });
});

describe("amount entry", () => {
  it("accepts dollars, decimals and typed currency symbols", () => {
    expect(parseAmountInput("12")).toEqual({ ok: true, cents: 1200 });
    expect(parseAmountInput("12.50")).toEqual({ ok: true, cents: 1250 });
    expect(parseAmountInput("$1,234.56")).toEqual({ ok: true, cents: 123456 });
  });

  it("refuses nothing, nonsense, and zero", () => {
    expect(parseAmountInput("").ok).toBe(false);
    expect(parseAmountInput("twelve").ok).toBe(false);
    expect(parseAmountInput("12.345").ok).toBe(false);
    expect(parseAmountInput("0").ok).toBe(false);
    expect(parseAmountInput("-5").ok).toBe(false);
  });
});

describe("payment error messages", () => {
  it("explains a conflict and a permission problem", () => {
    expect(paymentErrorMessage({ code: "40001", message: "A payment is already open on this order" })).toContain("Refresh");
    expect(paymentErrorMessage({ code: "42501", message: "Payment management permission required" })).toContain("not allowed");
  });

  it("passes through safe database messages and hides the rest", () => {
    expect(paymentErrorMessage({ code: "22023", message: "This order is already paid" })).toBe("This order is already paid");
    expect(paymentErrorMessage({ code: "42P01", message: 'relation "public.payment_provider_settings" does not exist' }))
      .toBe("The payment could not be updated. Check it before retrying.");
    expect(paymentErrorMessage({ code: "42P01", message: 'relation "public.refunds" does not exist' }))
      .toBe("The payment could not be updated. Check it before retrying.");
  });
});
