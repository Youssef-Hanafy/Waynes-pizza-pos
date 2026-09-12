import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  describeSquareError, mapSquarePayment, readSquareWebhookObject,
  squareCheckoutStatus, squarePaymentStatus, squareRefundStatus, verifySquareSignature,
} from "./square-mapping";

const NOTIFICATION_URL = "https://waynes.example.com/api/webhooks/square";
const SIGNATURE_KEY = "phase11-test-signature-key";
const sign = (body: string, key = SIGNATURE_KEY, url = NOTIFICATION_URL) =>
  createHmac("sha256", key).update(url + body, "utf8").digest("base64");

describe("webhook signature verification", () => {
  const body = JSON.stringify({ type: "payment.updated", event_id: "evt-1" });

  it("accepts a body signed with the registered key and URL", () => {
    expect(verifySquareSignature({ rawBody: body, signature: sign(body), notificationUrl: NOTIFICATION_URL, signatureKey: SIGNATURE_KEY })).toBe(true);
  });

  it("rejects a body that was altered after signing", () => {
    const signature = sign(body);
    const tampered = JSON.stringify({ type: "payment.updated", event_id: "evt-1", amount: 1 });
    expect(verifySquareSignature({ rawBody: tampered, signature, notificationUrl: NOTIFICATION_URL, signatureKey: SIGNATURE_KEY })).toBe(false);
  });

  it("rejects a signature made with a different key", () => {
    expect(verifySquareSignature({ rawBody: body, signature: sign(body, "someone-elses-key"), notificationUrl: NOTIFICATION_URL, signatureKey: SIGNATURE_KEY })).toBe(false);
  });

  it("rejects a signature made for a different notification URL", () => {
    expect(verifySquareSignature({ rawBody: body, signature: sign(body, SIGNATURE_KEY, "https://evil.example.com/hook"), notificationUrl: NOTIFICATION_URL, signatureKey: SIGNATURE_KEY })).toBe(false);
  });

  it("rejects a missing signature, key or URL rather than defaulting to trust", () => {
    expect(verifySquareSignature({ rawBody: body, signature: null, notificationUrl: NOTIFICATION_URL, signatureKey: SIGNATURE_KEY })).toBe(false);
    expect(verifySquareSignature({ rawBody: body, signature: sign(body), notificationUrl: NOTIFICATION_URL, signatureKey: "" })).toBe(false);
    expect(verifySquareSignature({ rawBody: body, signature: sign(body), notificationUrl: "", signatureKey: SIGNATURE_KEY })).toBe(false);
  });
});

describe("payment status mapping", () => {
  it("treats only COMPLETED as money in hand", () => {
    expect(squarePaymentStatus("COMPLETED")).toBe("captured");
    expect(squarePaymentStatus("APPROVED")).toBe("authorized");
    expect(squarePaymentStatus("FAILED")).toBe("failed");
    expect(squarePaymentStatus("CANCELED")).toBe("voided");
  });

  it("treats anything unrecognised as not yet paid", () => {
    expect(squarePaymentStatus(undefined)).toBe("pending");
    expect(squarePaymentStatus("SOMETHING_NEW")).toBe("pending");
  });

  it("keeps a reader checkout pending while the customer is still at the reader", () => {
    expect(squareCheckoutStatus("PENDING")).toBe("pending");
    expect(squareCheckoutStatus("IN_PROGRESS")).toBe("pending");
    expect(squareCheckoutStatus("CANCEL_REQUESTED")).toBe("pending");
    expect(squareCheckoutStatus("COMPLETED")).toBe("captured");
    expect(squareCheckoutStatus("CANCELED")).toBe("voided");
    expect(squareCheckoutStatus("UNKNOWN")).toBe("failed");
  });

  it("maps refund outcomes", () => {
    expect(squareRefundStatus("COMPLETED")).toBe("completed");
    expect(squareRefundStatus("PENDING")).toBe("pending");
    expect(squareRefundStatus("REJECTED")).toBe("rejected");
    expect(squareRefundStatus("FAILED")).toBe("failed");
    expect(squareRefundStatus(undefined)).toBe("pending");
  });
});

describe("payment mapping", () => {
  it("carries the card summary and receipt through", () => {
    const mapped = mapSquarePayment({
      id: "sq-1", status: "COMPLETED", amount_money: { amount: 2019 },
      card_details: { card: { card_brand: "VISA", last_4: "1111" } },
      receipt_url: "https://squareupsandbox.com/receipt/1",
    });
    expect(mapped).toMatchObject({ providerPaymentId: "sq-1", status: "captured", amountCents: 2019, cardBrand: "VISA", cardLast4: "1111" });
    expect(mapped.failureReason).toBeNull();
  });

  it("records a decline reason without inventing a payment", () => {
    const mapped = mapSquarePayment({ id: "sq-2", status: "FAILED", card_details: { errors: [{ code: "CARD_DECLINED", detail: "Issuer declined" }] } });
    expect(mapped.status).toBe("failed");
    expect(mapped.failureReason).toBe("CARD_DECLINED: Issuer declined");
  });

  it("returns a pending, empty payment for an empty response", () => {
    expect(mapSquarePayment(undefined)).toMatchObject({ providerPaymentId: null, status: "pending", amountCents: null });
  });
});

describe("error descriptions", () => {
  it("explains a decline in the customer's terms", () => {
    expect(describeSquareError([{ code: "CARD_DECLINED" }], "fallback").message).toContain("declined");
    expect(describeSquareError([{ code: "CVV_FAILURE" }], "fallback").message).toContain("security code");
  });

  it("never leaks an unrecognised provider error to the customer", () => {
    const described = describeSquareError([{ code: "INTERNAL_SERVER_ERROR", detail: "stack trace" }], "The card could not be charged.");
    expect(described.message).toBe("The card could not be charged.");
    expect(described.code).toBe("INTERNAL_SERVER_ERROR");
  });
});

describe("webhook envelope reading", () => {
  it("finds the payment inside the envelope", () => {
    const { payment, objectType } = readSquareWebhookObject({
      type: "payment.updated", event_id: "evt-2",
      data: { type: "payment", id: "sq-3", object: { payment: { id: "sq-3", status: "COMPLETED" } } },
    });
    expect(objectType).toBe("payment");
    expect(payment?.id).toBe("sq-3");
  });

  it("finds a terminal checkout and a refund", () => {
    expect(readSquareWebhookObject({ data: { object: { checkout: { id: "co-1", status: "COMPLETED", payment_ids: ["sq-4"] } } } }).checkout?.payment_ids)
      .toEqual(["sq-4"]);
    expect(readSquareWebhookObject({ data: { object: { refund: { id: "rf-1", status: "COMPLETED" } } } }).refund?.id).toBe("rf-1");
  });

  it("survives an envelope with nothing in it", () => {
    expect(readSquareWebhookObject({})).toMatchObject({ objectType: "", payment: undefined, refund: undefined, checkout: undefined });
  });
});
