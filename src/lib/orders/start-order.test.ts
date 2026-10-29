import { describe, expect, it } from "vitest";
import { defaultSettings } from "@/lib/content/schemas";
import { blankDraft, draftFromCall, draftToOrderPayload, parseSavedDrafts } from "./drafts";
import { posCustomerSchema } from "@/lib/pos/schemas";
import { customerDetailsPatch, editCustomerDetails, orderKind, orderTypePatch, outsideDeliveryArea, phoneDigits, startProblem } from "./start-order";

const settings = { ...defaultSettings, delivery_enabled: true, pickup_enabled: true };
const person = { firstName: "Maria", lastName: "Lopez", phone: "(508) 555-0199" };
const address = { address1: "12 Main St", address2: "", city: "Worcester", state: "MA", postal_code: "01609", delivery_instructions: "" };

describe("New Order card (owner, 2026-09-30)", () => {
  it("starts every new ticket on the card, and treats tickets saved before it as started", () => {
    expect(blankDraft().started).toBe(false);
    const legacy = blankDraft({ cart: [] }) as Record<string, unknown>;
    delete legacy.started;
    const restored = parseSavedDrafts(JSON.stringify({ activeId: legacy.id, drafts: [legacy] }));
    expect(restored?.drafts[0]?.started).toBe(true);
  });

  it("asks for an order type first", () => {
    expect(startProblem(blankDraft(), null, settings)).toMatch(/Walk-in, Pickup or Delivery/);
  });

  it("lets a walk-in start with nothing else", () => {
    expect(startProblem(blankDraft(), "walkin", settings)).toBe("");
  });

  it("needs nothing about the customer for pickup — a rush can skip it all (owner, 2026-10-11)", () => {
    expect(startProblem(blankDraft({ customerMode: "identified" }), "pickup", settings)).toBe("");
    expect(startProblem(blankDraft({ customerMode: "identified", firstName: "Maria" }), "pickup", settings)).toBe("");
    expect(startProblem(blankDraft({ customerMode: "identified", ...person, phone: "1-508-555-0199" }), "pickup", settings)).toBe("");
  });

  it("still checks a phone number that was typed", () => {
    expect(startProblem(blankDraft({ customerMode: "identified", ...person, phone: "555-0199" }), "pickup", settings)).toMatch(/10-digit/);
  });

  it("starts a test ticket like any other, flagged for the order API", () => {
    const draft = blankDraft({ customerMode: "identified", isTest: true });
    expect(startProblem(draft, "pickup", settings)).toBe("");
    expect(blankDraft().isTest).toBe(false);
  });

  it("never needs a name, phone orders included — Jump to take order always works (owner, 2026-10-29)", () => {
    const phone = blankDraft({ customerMode: "identified", source: "phone", phone: "(508) 555-0199" });
    expect(startProblem(phone, "pickup", settings)).toBe("");
    // A delivery still needs its address, nothing more.
    expect(startProblem(phone, "delivery", { ...settings })).toMatch(/street address/);
    expect(startProblem({ ...phone, address: { ...phone.address, address1: "12 Main St" } }, "delivery", { ...settings })).toBe("");
    // Caller ID filled it in: still fine.
    expect(startProblem({ ...phone, firstName: "David Strub" }, "pickup", settings)).toBe("");
    // Walk-ins and counter orders never need a name.
    expect(startProblem(phone, "walkin", settings)).toBe("");
    expect(startProblem({ ...phone, source: "pos" }, "pickup", settings)).toBe("");
  });

  it("needs an address for delivery, saved or typed", () => {
    const draft = blankDraft({ customerMode: "identified", fulfillment: "delivery", ...person });
    expect(startProblem(draft, "delivery", settings)).toMatch(/address/);
    expect(startProblem({ ...draft, address }, "delivery", settings)).toBe("");
    // The street alone is enough; city, state and ZIP fall back to the store's.
    expect(startProblem({ ...draft, firstName: "", lastName: "", phone: "", address: { ...address, city: "", state: "", postal_code: "" } }, "delivery", settings)).toBe("");
    expect(startProblem({ ...draft, addressId: "5e0f1c3a-9d3c-4f86-9c1e-2f7c1f6b7a10" }, "delivery", settings)).toBe("");
    expect(startProblem({ ...draft, address }, "delivery", { ...settings, delivery_enabled: false })).toMatch(/switched off/);
  });

  it("reads what a ticket already is", () => {
    expect(orderKind(blankDraft())).toBe("walkin");
    expect(orderKind(blankDraft({ customerMode: "identified" }))).toBe("pickup");
    expect(orderKind(blankDraft({ customerMode: "identified", fulfillment: "delivery" }))).toBe("delivery");
  });

  it("flags a ZIP outside the delivery area only when the store set one", () => {
    expect(outsideDeliveryArea("01609", [])).toBe(false);
    expect(outsideDeliveryArea("01609", ["01602", "01609"])).toBe(false);
    expect(outsideDeliveryArea("01701", ["01602", "01609"])).toBe(true);
    expect(outsideDeliveryArea("016", ["01602"])).toBe(false);
  });

  it("normalises phone digits", () => {
    expect(phoneDigits("+1 (508) 555-0199")).toBe("5085550199");
  });
});

const customer = posCustomerSchema.parse({
  id: "47000000-0000-4000-8000-000000000099", first_name: "Customer", last_name: "", phone: "5085550199", email: null,
  first_order_at: null, last_order_at: null, order_count: 3, lifetime_spend_cents: 5400, average_order_value_cents: 1800,
  addresses: [{ id: "47000000-0000-4000-8000-000000000098", label: "Home", ...address, is_default: true, created_at: "2026-10-20T12:00:00Z", updated_at: "2026-10-20T12:00:00Z" }],
});

describe("customer-first order entry", () => {
  it("fills editable customer and address fields without advancing the order", () => {
    const draft = blankDraft(customerDetailsPatch(customer));
    expect(draft).toMatchObject({ customer: { id: customer.id }, firstName: "", phone: customer.phone, addressId: customer.addresses[0]!.id, address, started: false });
  });

  it("corrects a placeholder name on the same customer record", () => {
    const selected = blankDraft(customerDetailsPatch(customer));
    const edited = { ...selected, ...editCustomerDetails(selected, { firstName: "Maria", lastName: "Lopez" }) };
    expect(draftToOrderPayload(edited)).toMatchObject({ customer_id: customer.id, first_name: "Maria", last_name: "Lopez", phone: customer.phone });
    expect(edited.addressId).toBe(customer.addresses[0]!.id);
  });

  it("keeps phone formatting edits attached and releases the match for a different number", () => {
    const selected = blankDraft(customerDetailsPatch(customer));
    expect(editCustomerDetails(selected, { phone: "+1 (508) 555-0199" })).not.toHaveProperty("customer");
    expect(editCustomerDetails(selected, { phone: "7745550111" })).toMatchObject({ customer: null, addressId: "" });
  });

  it("preserves customer information on a walk-in and links its order history", () => {
    const selected = blankDraft({ ...customerDetailsPatch(customer), ...person });
    const draft = { ...selected, ...orderTypePatch(selected, "walkin", "phone") };
    expect(draft).toMatchObject({ orderKind: "walkin", source: "pos", customerMode: "identified", started: false });
    expect(draftToOrderPayload(draft)).toMatchObject({ customer_id: customer.id, first_name: "Maria", last_name: "Lopez", phone: person.phone, customer_mode: "identified" });
    expect(orderKind(draft)).toBe("walkin");
  });

  it("preserves a newly typed walk-in's phone instead of discarding it", () => {
    const fresh = blankDraft(person);
    const draft = { ...fresh, ...orderTypePatch(fresh, "walkin", "pos") };
    expect(draftToOrderPayload(draft)).toMatchObject({ customer_mode: "identified", first_name: "Maria", phone: person.phone });
    expect(startProblem(draft, "walkin", settings)).toBe("");
    expect(startProblem({ ...draft, phone: "508" }, "walkin", settings)).toMatch(/10-digit/);
  });

  it("keeps anonymous rush orders available without losing a typed name", () => {
    const fresh = blankDraft({ firstName: "Pat" });
    const draft = { ...fresh, ...orderTypePatch(fresh, "walkin", "pos"), started: true };
    expect(draftToOrderPayload(draft)).toMatchObject({ customer_mode: "walk_in", customer_id: "", first_name: "Pat", phone: "" });
  });

  it("keeps phone orders on the customer details step", () => {
    const draft = blankDraft(draftFromCall({ callKey: "call-1", callId: null, line: 1, phoneNumber: customer.phone, callerName: "CUSTOMER", customer }));
    expect(draft).toMatchObject({ started: false, orderKind: "pickup", addressId: customer.addresses[0]!.id, address });
  });

  it("preserves the chosen order type and corrected customer through a reload", () => {
    const fresh = blankDraft({ ...customerDetailsPatch(customer), ...person });
    const draft = { ...fresh, ...orderTypePatch(fresh, "walkin", "pos") };
    const restored = parseSavedDrafts(JSON.stringify({ activeId: draft.id, drafts: [draft] }))!.drafts[0]!;
    expect(orderKind(restored)).toBe("walkin");
    expect(restored.started).toBe(false);
    expect(draftToOrderPayload(restored).customer_id).toBe(customer.id);
  });
});
