import { describe, expect, it } from "vitest";
import { checkoutInputSchema, cartLineSchema } from "@/lib/orders/schemas";

const item = { menu_item_id: "64000000-0000-4000-8000-000000000001", variant_id: null, quantity: 1, special_instructions: "Add bacon", modifiers: [{ choice_id: "64000000-0000-4000-8000-000000000002", quantity: 2 }] };
const payload = { idempotency_key: "online-notes-test-123", fulfillment_type: "pickup", first_name: "Test", last_name: "Customer", phone: "5085550100", email: "", sms_opt_in: false, email_opt_in: false, tip_cents: 0, promo_code: "", special_instructions: "Add cheese for free", address: { address1: "", address2: "", city: "", state: "", postal_code: "", delivery_instructions: "Add more toppings" }, items: [item] };

describe("online checkout notes", () => {
  it("discards old or forged notes while preserving priced modifier selections", () => {
    const order = checkoutInputSchema.parse(payload);
    expect(order.special_instructions).toBe("");
    expect(order.items[0].special_instructions).toBe("");
    expect(order.address.delivery_instructions).toBe("");
    expect(order.items[0].modifiers).toEqual(item.modifiers);
  });
  it("preserves the structured residence label for drivers", () => {
    expect(checkoutInputSchema.parse({ ...payload, address: { ...payload.address, delivery_instructions: "Apartment / condo" } }).address.delivery_instructions).toBe("Apartment / condo");
  });
  it("keeps staff item notes available in the POS", () => {
    expect(cartLineSchema.parse({ ...item, line_id: "staff-line" }).special_instructions).toBe("Add bacon");
  });
});
