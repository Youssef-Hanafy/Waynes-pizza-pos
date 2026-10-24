import { describe, expect, it } from "vitest";
import { posEditItemsInputSchema } from "@/lib/pos/schemas";
import { blankDraft, draftToEditPayload } from "./drafts";
import { cartLineFor } from "./edit-order";

const existing = (id: string, quantity: number) => ({ id, name: "Cheese Pizza", variant: "Large", quantity, unitCents: 1599, modifiers: [], instructions: "", line: null });
const addTo = {
  orderId: "64000000-0000-4000-8000-0000000000a1", orderNumber: "W000120", dailyNumber: 12, customerName: "Sam", fulfillment: "pickup" as const, paid: false,
  editing: true, existing: [existing("64000000-0000-4000-8000-0000000000b1", 1), existing("64000000-0000-4000-8000-0000000000b2", 2)],
  removed: ["64000000-0000-4000-8000-0000000000b1"], quantities: { "64000000-0000-4000-8000-0000000000b2": 3 }, discountCents: 0,
};

describe("editing an order already sent (owner, 2026-10-24)", () => {
  it("sends what was taken off, quantities changed and the new lines — nothing else", () => {
    const payload = draftToEditPayload(blankDraft({ addTo, cart: [{ line_id: "n1", menu_item_id: "64000000-0000-4000-8000-0000000000c1", variant_id: null, quantity: 1, special_instructions: "", modifiers: [] }] }));
    expect(payload.remove_item_ids).toEqual(["64000000-0000-4000-8000-0000000000b1"]);
    expect(payload.quantities).toEqual([{ id: "64000000-0000-4000-8000-0000000000b2", quantity: 3 }]);
    expect(payload.items).toHaveLength(1);
    expect(posEditItemsInputSchema.safeParse(payload).success).toBe(true);
  });

  it("refuses an edit that changes nothing", () => {
    const payload = draftToEditPayload(blankDraft({ addTo: { ...addTo, removed: [], quantities: {} } }));
    expect(posEditItemsInputSchema.safeParse(payload).success).toBe(false);
  });

  it("opens an open item (misc charge) again with its name and price", () => {
    const line = cartLineFor([], { id: "64000000-0000-4000-8000-0000000000b3", menu_item_id: null, variant_id: null, name: "Extra bag", variant: null, quantity: 2, unit_price_cents: 50, modifier_unit_total_cents: 0, line_total_cents: 100, instructions: "", pos_line: null, modifiers: [] });
    expect(line?.open_item).toEqual({ name: "Extra bag", price_cents: 50 });
    expect(line?.quantity).toBe(2);
  });
});
