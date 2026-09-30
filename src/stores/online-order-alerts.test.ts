import { describe, expect, it } from "vitest";
import type { OpenOrder } from "@/lib/orders/status";
import { newOnlineOrders } from "./online-order-alerts";

const order = (id: string, source: string, status = "placed"): OpenOrder => ({
  id, order_number: id, customer_name: "", fulfillment_type: "pickup", source, status, payment_method: "card", payment_status: "paid",
  total_cents: 1000, placed_at: "2026-09-30T20:00:00Z", promised_at: null, ready_at: null,
});

describe("online order chime", () => {
  it("announces only new, real online orders", () => {
    const seen = new Set(["a"]);
    const found = newOnlineOrders([order("a", "online"), order("b", "online"), order("c", "pos"), order("d", "phone"), order("e", "online", "payment_pending"), order("f", "online", "cancelled")], seen);
    expect(found.map((entry) => entry.id)).toEqual(["b"]);
  });

  it("announces an online card order once its payment goes through", () => {
    const seen = new Set<string>();
    expect(newOnlineOrders([order("x", "online", "payment_pending")], seen)).toEqual([]);
    expect(newOnlineOrders([order("x", "online", "placed")], seen).map((entry) => entry.id)).toEqual(["x"]);
  });
});
