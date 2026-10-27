import { describe, expect, it } from "vitest";
import type { PosCustomer } from "@/lib/pos/schemas";
import { callerCardInfo, callerIdPersonName, customerName, isPlaceholderName } from "./caller-display";
import { draftFromCall } from "@/lib/orders/drafts";

const david: PosCustomer = {
  id: "7c4e1d20-841a-4c1a-99d8-9302d6f96be2", first_name: "David", last_name: "", phone: "+15084509547", email: null,
  first_order_at: "2026-10-24T16:36:28Z", last_order_at: "2026-10-27T16:23:44Z", order_count: 2, lifetime_spend_cents: 2248, average_order_value_cents: 1124,
  notes: "", phones: [],
  addresses: [{ id: "5e0f1c3a-9d3c-4f86-9c1e-2f7c1f6b7a10", label: "", address1: "12 Elm St", address2: "Apt 2", city: "Worcester", state: "MA", postal_code: "01605", delivery_instructions: "", is_default: true, created_at: "", updated_at: "" }],
};

describe("caller ID like a saved contact (owner, 2026-10-27)", () => {
  it("reads the phone company's name only when it is a name", () => {
    expect(callerIdPersonName("DAVID STRUB")).toBe("David Strub");
    expect(callerIdPersonName("PEREZ,KEVIN")).toBe("Kevin Perez");
    expect(callerIdPersonName("BOTSIS, JOHN")).toBe("John Botsis");
    expect(callerIdPersonName("O'BRIEN KATE")).toBe("O'brien Kate"); // same as Postgres initcap()
    expect(callerIdPersonName("WIRELESS CALLER")).toBeNull();
    expect(callerIdPersonName("NORTHFIELD   MA")).toBeNull();
    expect(callerIdPersonName("800 SERVICE")).toBeNull();
    expect(callerIdPersonName("")).toBeNull();
  });

  it("never shows the old placeholder as a name", () => {
    expect(isPlaceholderName("Customer", "")).toBe(true);
    expect(isPlaceholderName("Phone caller", "")).toBe(true);
    expect(customerName({ first_name: "Customer", last_name: "" })).toBe("");
    expect(customerName(david)).toBe("David");
  });

  it("pops the saved name, number and address while the phone rings", () => {
    const info = callerCardInfo({ phoneNumber: "+15084509547", callerName: "DAVID STRUB", lookup: "done", matches: [david] });
    expect(info.name).toBe("David");
    expect(info.phone).toBe("(508) 450-9547");
    expect(info.address).toBe("12 Elm St, Apt 2, Worcester");
    expect(info.detail).toMatch(/Returning customer · 2 orders/);
  });

  it("falls back to caller ID for a placeholder profile or a new caller", () => {
    const placeholder = { ...david, first_name: "Customer", addresses: [] };
    expect(callerCardInfo({ phoneNumber: "+15084509547", callerName: "DAVID STRUB", lookup: "done", matches: [placeholder] }).name).toBe("David Strub");
    expect(callerCardInfo({ phoneNumber: "+18603353218", callerName: "WIRELESS CALLER", lookup: "done", matches: [] }).name).toBe("New caller");
    expect(callerCardInfo({ phoneNumber: "+15083959752", callerName: "STONE PAUL", lookup: "done", matches: [] }).name).toBe("Stone Paul");
  });

  it("fills the order's name from caller ID so nobody types it", () => {
    const base = { callKey: "k", callId: null, line: 1, phoneNumber: "+15083959752" };
    expect(draftFromCall({ ...base, callerName: "STONE PAUL", customer: null }).firstName).toBe("Stone Paul");
    expect(draftFromCall({ ...base, callerName: "WIRELESS CALLER", customer: null }).firstName).toBe("");
    expect(draftFromCall({ ...base, callerName: "DAVID STRUB", customer: { ...david, first_name: "Customer" } }).firstName).toBe("David Strub");
    expect(draftFromCall({ ...base, callerName: "SOMEONE ELSE", customer: david }).firstName).toBe("David");
  });
});
