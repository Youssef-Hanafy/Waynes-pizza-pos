import { describe, expect, it } from "vitest";
import { isOpenOrderStatus, nextHandOff, orderTransitionSchema, transitionErrorMessage } from "./status";

const id = "58000000-0000-4000-8000-000000000001";

describe("order hand-off rules", () => {
  it("hands ready pickup orders to the customer and ready delivery orders to a driver", () => {
    expect(nextHandOff("ready", "pickup")).toEqual({ status: "completed", label: "Picked up" });
    expect(nextHandOff("ready", "delivery")).toEqual({ status: "out_for_delivery", label: "Out for delivery" });
    expect(nextHandOff("out_for_delivery", "delivery")).toEqual({ status: "completed", label: "Delivered" });
    expect(nextHandOff("in_kitchen", "pickup")).toBeNull();
    expect(nextHandOff("completed", "pickup")).toBeNull();
  });

  it("requires a reason to cancel and only accepts open starting states", () => {
    expect(orderTransitionSchema.safeParse({ order_id: id, expected_status: "placed", next_status: "cancelled" }).success).toBe(false);
    expect(orderTransitionSchema.safeParse({ order_id: id, expected_status: "placed", next_status: "cancelled", reason: "Customer called" }).success).toBe(true);
    expect(orderTransitionSchema.safeParse({ order_id: id, expected_status: "completed", next_status: "cancelled", reason: "Too late" }).success).toBe(false);
    expect(isOpenOrderStatus("ready")).toBe(true);
    expect(isOpenOrderStatus("cancelled")).toBe(false);
  });

  it("never leaks raw database errors to staff", () => {
    expect(transitionErrorMessage({ code: "40001", message: "x" })).toMatch(/Another screen/);
    expect(transitionErrorMessage({ code: "XX000", message: "relation secret_table does not exist" })).toMatch(/could not be updated/);
    expect(transitionErrorMessage({ code: "22023", message: "A cancellation reason of at least 3 characters is required" })).toMatch(/reason/);
  });
});
