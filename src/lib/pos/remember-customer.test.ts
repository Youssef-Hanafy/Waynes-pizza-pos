import { describe, expect, it } from "vitest";
import { blankDraft } from "@/lib/orders/drafts";
import type { PosCustomer } from "@/lib/pos/schemas";
import { alreadySaved, rememberPayload, savedAddressId } from "./remember-customer";

const street = { address1: "12 Elm St", address2: "Apt 2", city: "Worcester", state: "MA", postal_code: "01605", delivery_instructions: "" };
const david: PosCustomer = {
  id: "7c4e1d20-841a-4c1a-99d8-9302d6f96be2", first_name: "David", last_name: "Strub", phone: "+15084509547", email: null,
  first_order_at: null, last_order_at: null, order_count: 2, lifetime_spend_cents: 2248, average_order_value_cents: 1124, notes: "", phones: [],
  addresses: [{ id: "5e0f1c3a-9d3c-4f86-9c1e-2f7c1f6b7a10", label: "Delivery", ...street, is_default: true, created_at: "", updated_at: "" }],
};

describe("saving the customer from the order screen (owner, 2026-10-27)", () => {
  it("saves as soon as there is a full phone number — test orders too", () => {
    expect(rememberPayload(blankDraft({ phone: "508-450" }), "pickup")).toBeNull();
    const payload = rememberPayload(blankDraft({ phone: "(508) 450-9547", firstName: " David ", isTest: true }), "pickup");
    expect(payload).toEqual({ phone: "5084509547", first_name: "David", last_name: "", email: "" });
    // Walk-ins with a number are saved as well.
    expect(rememberPayload(blankDraft({ phone: "5084509547" }), "walkin")?.phone).toBe("5084509547");
  });

  it("keeps a typed delivery address with the customer, never a half-typed email", () => {
    const payload = rememberPayload(blankDraft({ phone: "5084509547", email: "david@", address: street }), "delivery");
    expect(payload?.address?.address1).toBe("12 Elm St");
    expect(payload?.email).toBe("");
    // A saved address picked from the list is already saved; a pickup has no address to keep.
    expect(rememberPayload(blankDraft({ phone: "5084509547", address: street, addressId: david.addresses[0]!.id }), "delivery")?.address).toBeUndefined();
    expect(rememberPayload(blankDraft({ phone: "5084509547", address: street }), "pickup")?.address).toBeUndefined();
  });

  it("skips the save when the profile on the ticket already has these details", () => {
    const draft = blankDraft({ phone: "5084509547", firstName: "David", lastName: "Strub", customer: david });
    expect(alreadySaved(draft, rememberPayload(draft, "pickup")!)).toBe(true);
    const renamed = { ...draft, firstName: "Dave" };
    expect(alreadySaved(renamed, rememberPayload(renamed, "pickup")!)).toBe(false);
    const noProfile = { ...draft, customer: null };
    expect(alreadySaved(noProfile, rememberPayload(noProfile, "pickup")!)).toBe(false);
  });

  it("points the order at the saved address so it is not added twice", () => {
    expect(savedAddressId(david, { ...street, address1: "12 elm st ", address2: "apt 2" })).toBe(david.addresses[0]!.id);
    expect(savedAddressId(david, { ...street, address1: "99 Oak Ave" })).toBe("");
  });
});
