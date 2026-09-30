import { describe, expect, it } from "vitest";
import { defaultSettings } from "@/lib/content/schemas";
import { blankDraft, parseSavedDrafts } from "./drafts";
import { orderKind, outsideDeliveryArea, phoneDigits, startProblem } from "./start-order";

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

  it("needs a full name and a 10-digit phone for pickup, like the order API", () => {
    expect(startProblem(blankDraft({ customerMode: "identified", firstName: "Maria" }), "pickup", settings)).toMatch(/first and last name/);
    expect(startProblem(blankDraft({ customerMode: "identified", ...person, phone: "555-0199" }), "pickup", settings)).toMatch(/10-digit/);
    expect(startProblem(blankDraft({ customerMode: "identified", ...person, phone: "1-508-555-0199" }), "pickup", settings)).toBe("");
  });

  it("needs an address for delivery, saved or typed", () => {
    const draft = blankDraft({ customerMode: "identified", fulfillment: "delivery", ...person });
    expect(startProblem(draft, "delivery", settings)).toMatch(/address/);
    expect(startProblem({ ...draft, address }, "delivery", settings)).toBe("");
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
