import { describe, expect, it } from "vitest";
import {
  deliveryErrorMessage, driverActionSchema, formatAddress, minutesBetween, navigationUrl,
  nextDriverAction, parseCashInput, releaseDeliverySchema, telephoneUrl,
} from "./schemas";

describe("delivery address handling", () => {
  const address = { address1: "93 West Boylston St", address2: "Apt 2", city: "Worcester", state: "MA", postal_code: "01606", delivery_instructions: "Side door" };

  it("formats a full address on one line", () => {
    expect(formatAddress(address)).toBe("93 West Boylston St Apt 2, Worcester, MA, 01606");
  });

  it("skips missing parts instead of leaving empty separators", () => {
    expect(formatAddress({ address1: "10 Main St", city: "Worcester" })).toBe("10 Main St, Worcester");
  });

  it("returns nothing for a missing address so the map button can be hidden", () => {
    expect(formatAddress(null)).toBe("");
    expect(navigationUrl(null)).toBe("");
    expect(navigationUrl({})).toBe("");
  });

  it("builds an encoded map link for navigation hand-off", () => {
    expect(navigationUrl(address)).toBe("https://maps.google.com/?q=93%20West%20Boylston%20St%20Apt%202%2C%20Worcester%2C%20MA%2C%2001606");
  });

  it("builds a dialable phone link", () => {
    expect(telephoneUrl("(508) 852-6326")).toBe("tel:5088526326");
    expect(telephoneUrl("")).toBe("");
  });
});

describe("driver step sequencing", () => {
  it("asks the driver to accept first", () => {
    expect(nextDriverAction("assigned", "ready")).toEqual({ action: "accept", label: "Accept delivery", ready: true });
  });

  it("blocks pickup until the kitchen marks the order ready", () => {
    expect(nextDriverAction("accepted", "in_kitchen")?.ready).toBe(false);
    expect(nextDriverAction("accepted", "ready")?.ready).toBe(true);
    expect(nextDriverAction("accepted", "out_for_delivery")?.ready).toBe(true);
  });

  it("offers delivery only after pickup and nothing after delivery", () => {
    expect(nextDriverAction("picked_up", "out_for_delivery")?.action).toBe("delivered");
    expect(nextDriverAction("delivered", "completed")).toBeNull();
    expect(nextDriverAction("released", "ready")).toBeNull();
  });
});

describe("cash entry at the door", () => {
  it("accepts whole dollars, decimals, and typed currency symbols", () => {
    expect(parseCashInput("24")).toEqual({ ok: true, cents: 2400 });
    expect(parseCashInput("24.50")).toEqual({ ok: true, cents: 2450 });
    expect(parseCashInput("$120.05")).toEqual({ ok: true, cents: 12005 });
    expect(parseCashInput("1,200.00")).toEqual({ ok: true, cents: 120000 });
    expect(parseCashInput("0")).toEqual({ ok: true, cents: 0 });
  });

  it("refuses empty and malformed amounts instead of guessing", () => {
    expect(parseCashInput("").ok).toBe(false);
    expect(parseCashInput("twenty").ok).toBe(false);
    expect(parseCashInput("24.555").ok).toBe(false);
    expect(parseCashInput("-5").ok).toBe(false);
  });
});

describe("driver action payloads", () => {
  const orderId = "0b3f1a54-7a2c-4d1e-9a44-5e0f1b2c3d4e";

  it("requires a cash figure before a delivery can be closed", () => {
    expect(driverActionSchema.safeParse({ order_id: orderId, action: "delivered" }).success).toBe(false);
    expect(driverActionSchema.safeParse({ order_id: orderId, action: "delivered", cash_collected_cents: 0 }).success).toBe(true);
  });

  it("does not ask for cash on the earlier steps", () => {
    for (const action of ["claim", "accept", "picked_up"]) {
      expect(driverActionSchema.safeParse({ order_id: orderId, action }).success).toBe(true);
    }
  });

  it("rejects unknown actions and non-uuid orders", () => {
    expect(driverActionSchema.safeParse({ order_id: orderId, action: "paid_by_card", cash_collected_cents: 0 }).success).toBe(false);
    expect(driverActionSchema.safeParse({ order_id: "W900123", action: "accept" }).success).toBe(false);
  });

  it("requires a real reason before releasing a delivery", () => {
    expect(releaseDeliverySchema.safeParse({ order_id: orderId, reason: "no" }).success).toBe(false);
    expect(releaseDeliverySchema.safeParse({ order_id: orderId, reason: "Driver clocked out" }).success).toBe(true);
  });
});

describe("delivery error messages", () => {
  it("explains a conflicting screen and a permission problem", () => {
    expect(deliveryErrorMessage({ code: "40001", message: "Another driver already has this order" })).toContain("Refresh");
    expect(deliveryErrorMessage({ code: "42501", message: "Delivery dispatch permission required" })).toContain("not allowed");
  });

  it("passes through safe database messages and hides the rest", () => {
    expect(deliveryErrorMessage({ code: "22023", message: "The kitchen has not marked this order ready yet" }))
      .toBe("The kitchen has not marked this order ready yet");
    expect(deliveryErrorMessage({ code: "42P01", message: 'relation "public.delivery_assignments" does not exist' }))
      .toBe("The delivery could not be updated. Refresh to check it before retrying.");
  });
});

describe("elapsed minutes", () => {
  it("reports whole minutes between two timestamps", () => {
    expect(minutesBetween("2026-09-11T18:00:00.000Z", "2026-09-11T18:24:00.000Z")).toBe(24);
  });

  it("never reports a negative duration and tolerates missing timestamps", () => {
    expect(minutesBetween("2026-09-11T18:30:00.000Z", "2026-09-11T18:00:00.000Z")).toBe(0);
    expect(minutesBetween(null, "2026-09-11T18:00:00.000Z")).toBeNull();
    expect(minutesBetween("nonsense", "2026-09-11T18:00:00.000Z")).toBeNull();
  });
});
