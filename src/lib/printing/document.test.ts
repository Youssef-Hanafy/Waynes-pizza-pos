import { describe, expect, it } from "vitest";
import { encodeDrawerKick, encodeEscPos } from "@/hardware/printers/escpos";
import { renderLayoutHtml } from "@/hardware/printers/render-html";
import { columnsFor, printerModel } from "@/hardware/printers/models";
import { buildKitchenTicket, buildOnlineOrderSlip, buildReceipt, buildTestPage, buildTipSignatureSlip, layoutToText, routeToKitchen, type PrintDocument } from "./document";

const doc: PrintDocument = {
  store: { name: "Wayne's Pizza", address_line1: "93 West Boylston St", address_line2: "", city: "Worcester", state: "MA", postal_code: "01606", phone: "5085551000", timezone: "America/New_York" },
  order: {
    id: "66000000-0000-4000-8000-000000000001", order_number: "W000123", daily_number: null, add_on_to: null, source: "phone", fulfillment_type: "delivery", status: "placed",
    payment_status: "unpaid", payment_method: "cash", placed_at: "2026-09-20T22:42:00Z", promised_at: "2026-09-20T23:25:00Z", phone_line: 1,
    customer_name: "John Smith", customer_phone: "+15085551234",
    delivery_address: { address1: "123 Main Street", address2: "Apt 2", city: "Worcester", state: "MA", postal_code: "01606", delivery_instructions: "Side door" },
    special_instructions: "Ring twice", subtotal_cents: 2899, discount_cents: 0, delivery_fee_cents: 300, tax_cents: 200, tip_cents: 0, total_cents: 3399, taken_by: "Maria",
  },
  items: [
    { id: "66000000-0000-4000-8000-000000000011", name: "Cheese Pizza", variant: "Large", category: "Pizza", station: "kitchen", quantity: 1, line_total_cents: 1899, instructions: "Well done",
      modifiers: [{ name: "Pepperoni", group: "Toppings", quantity: 1 }, { name: "NO Onions", group: "Toppings", quantity: 1 }] },
    { id: "66000000-0000-4000-8000-000000000012", name: "Coke", variant: "2 Liter", category: "Drinks", station: "kitchen", quantity: 1, line_total_cents: 1000, instructions: "", modifiers: [] },
  ],
};

describe("receipts and kitchen tickets (build sheet §23)", () => {
  it("prints the line, customer, address, items and totals on the receipt", () => {
    const text = layoutToText(buildReceipt(doc)).join("\n");
    expect(text).toContain("DELIVERY · PHONE · LINE 1");
    // The day's number, not the W number, is the big one (owner, 2026-10-13); W000123 is only a reference.
    expect(text).toContain("ORDER #123");
    expect(text).toContain("Ref W000123");
    expect(layoutToText(buildReceipt({ ...doc, order: { ...doc.order, daily_number: 7 } })).join("\n")).toContain("ORDER #7");
    expect(text).toContain("(508) 555-1234");
    expect(text).toContain("123 Main Street, Apt 2");
    expect(text).toMatch(/1× Large Cheese Pizza\s+\$18\.99/);
    expect(text).toContain("NO ONIONS");
    expect(text).toMatch(/TOTAL\s+\$33\.99/);
    expect(text).toContain("CASH — COLLECT ON DELIVERY");
  });

  it("routes kitchen items by category, and sends everything when no routing is chosen", () => {
    expect(routeToKitchen(doc, ["pizza"]).map((item) => item.name)).toEqual(["Cheese Pizza"]);
    expect(routeToKitchen(doc, [])).toHaveLength(2);
    const ticket = layoutToText(buildKitchenTicket(doc, ["Pizza"])!).join("\n");
    expect(ticket).toContain("Cheese Pizza");
    expect(ticket).not.toContain("Coke");
    // Item lines carry no prices; the order totals and the item count are printed (owner, 2026-10-13).
    expect(ticket).not.toMatch(/Cheese Pizza\s+\$/);
    expect(ticket).toMatch(/TOTAL\s+\$33\.99/);
    expect(ticket).toContain("1 ITEM (OF 2 ON ORDER)");
    expect(layoutToText(buildKitchenTicket(doc)!).join("\n")).toContain("2 ITEMS");
    expect(buildKitchenTicket(doc, ["Desserts"])).toBeNull();
  });

  it("renders printable HTML with everything escaped", () => {
    const html = renderLayoutHtml(buildReceipt({ ...doc, order: { ...doc.order, special_instructions: "<b>hi</b>" } }), 58);
    expect(html).toContain("size: 58mm auto");
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(html).not.toContain("<b>hi</b>");
  });

  it("encodes ESC/POS only with core commands, and pulses the drawer", () => {
    const bytes = encodeEscPos(buildTestPage("Front"), { columns: 42 });
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x1b, 0x40]);
    expect(Array.from(bytes.slice(-4))).toEqual([0x1d, 0x56, 66, 3]);
    expect(Array.from(bytes).every((byte) => byte <= 0xff)).toBe(true);
    expect(Array.from(encodeDrawerKick())).toEqual([0x1b, 0x70, 0x00, 0x19, 0xfa]);
  });

  it("keeps long lines inside the paper", () => {
    const lines = layoutToText({ title: "t", lines: [{ kind: "text", text: "A very long delivery instruction that goes on and on past the edge of the paper" }] }, 32);
    expect(lines.every((line) => line.length <= 32)).toBe(true);
  });

  it("prints online orders as a bannered slip and a tip & signature slip", () => {
    const online = { ...doc, order: { ...doc.order, source: "online", payment_method: "card", payment_status: "paid", tip_cents: 300, total_cents: 3699 } };
    const slip = layoutToText(buildOnlineOrderSlip(online), 48).join("\n");
    expect(slip).toContain("*** ONLINE ORDER ***");
    expect(slip).toContain("DELIVERY · ONLINE");
    expect(slip).toMatch(/TOTAL\s+\$36\.99/);
    const tip = layoutToText(buildTipSignatureSlip(online), 48);
    const text = tip.join("\n");
    expect(text).toContain("TIP & SIGNATURE - STORE COPY");
    expect(text).toMatch(/Tip added online\s+\$3\.00/);
    expect(text).toMatch(/Extra tip:\s+_+/);
    expect(text).toMatch(/Total:\s+_+/);
    expect(text).toContain("X____");
    expect(text).toContain("PAID");
    expect(tip.every((line) => line.length <= 48)).toBe(true);
    const noTip = layoutToText(buildTipSignatureSlip({ ...online, order: { ...online.order, tip_cents: 0 } }), 48).join("\n");
    expect(noTip).toMatch(/\nTip:\s+_+/);
  });

  it("knows Wayne's two Epson printers", () => {
    const thermal = printerModel("epson-tm-t20iii");
    const impact = printerModel("epson-tm-u220b");
    expect(columnsFor(thermal, 80, null)).toBe(48);
    expect(columnsFor(impact, 76, null)).toBe(40);
    expect(columnsFor(impact, 76, 42)).toBe(42);
    expect(columnsFor(printerModel("unknown"), 58, null)).toBe(32);
    const test = layoutToText(buildTestPage("Kitchen", new Date(), 40), 40);
    expect(test).toContain("----+----1----+----2----+----3----+----4");
  });

  it("cuts the TM-U220B after feeding past its cutter, and prints NO lines in red with a two-colour ribbon", () => {
    const layout = buildKitchenTicket(doc)!;
    const impact = Array.from(encodeEscPos(layout, { columns: 40, cut: "feed_then_cut", feedBeforeCut: 4, red: true }));
    expect(impact.slice(-6)).toEqual([0x1b, 0x64, 4, 0x1d, 0x56, 1]);
    const text = String.fromCharCode(...impact);
    const noLine = text.indexOf("NO ONIONS");
    expect(text.lastIndexOf("\x1br\x01", noLine)).toBeGreaterThan(text.lastIndexOf("\x1br\x00", noLine));
    const black = Array.from(encodeEscPos(layout, { columns: 40, cut: "feed_then_cut" }));
    expect(String.fromCharCode(...black)).not.toContain("\x1br\x01");
    expect(Array.from(encodeEscPos(layout, { cut: "none" })).slice(-3)).not.toEqual([0x1d, 0x56, 1]);
  });

  it("says PAID or NOT PAID in big letters at the top of every slip (owner, 2026-10-12)", () => {
    const unpaid = layoutToText(buildKitchenTicket(doc)!, 40);
    expect(unpaid.slice(0, 3).join("\n")).toContain("!! NOT PAID !!");
    expect(unpaid.join("\n")).toContain("COLLECT $33.99 AT THE DOOR");
    expect(layoutToText(buildReceipt(doc), 48).join("\n")).toContain("COLLECT $33.99 AT THE DOOR");
    const paid = { ...doc, order: { ...doc.order, fulfillment_type: "pickup", payment_status: "paid", payment_method: "card" } };
    const paidTicket = layoutToText(buildKitchenTicket(paid)!, 40).join("\n");
    expect(paidTicket).toContain("** PAID - CARD **");
    expect(paidTicket).not.toContain("NOT PAID");
    expect(layoutToText(buildReceipt(paid), 48).join("\n")).toContain("** PAID - CARD **");
    const held = { ...doc, order: { ...doc.order, payment_status: "authorized", payment_method: "card" } };
    // A card held for the tip on the slip (owner, 2026-10-13): paid by card, driver gets the slip signed.
    const heldTicket = layoutToText(buildKitchenTicket(held)!, 40).join("\n");
    expect(heldTicket).toContain("** PAID - CARD **");
    expect(heldTicket).toContain("get the slip signed");
    const heldPickup = { ...held, order: { ...held.order, fulfillment_type: "pickup" } };
    expect(layoutToText(buildTipSignatureSlip(heldPickup), 48).join("\n")).toContain("CARD APPROVED — ADD TIP BELOW");
  });

  it("prints bigger text: taller by default, tall and wide on extra large", () => {
    const layout = { title: "t", lines: [{ kind: "text" as const, text: "Hello" }] };
    // The byte after the first GS ! (0x1d 0x21) and after the first ESC ! (0x1b 0x21).
    const after = (bytes: Uint8Array, lead: number) => { const all = Array.from(bytes); const at = all.findIndex((value, index) => value === lead && all[index + 1] === 0x21); return all[at + 2]; };
    const sizeOf = (bytes: Uint8Array) => after(bytes, 0x1d);
    const modeOf = (bytes: Uint8Array) => after(bytes, 0x1b);
    expect(sizeOf(encodeEscPos(layout, { columns: 42 }))).toBe(0x01);
    expect(sizeOf(encodeEscPos(layout, { columns: 42, textSize: "normal" }))).toBe(0x00);
    expect(sizeOf(encodeEscPos(layout, { columns: 42, textSize: "xlarge" }))).toBe(0x11);
    // ESC ! carries the same size for printers that ignore GS ! (the kitchen's TM-U220B, owner 2026-10-13).
    expect(modeOf(encodeEscPos(layout, { columns: 42 }))).toBe(0x10);
    expect(modeOf(encodeEscPos(layout, { columns: 42, textSize: "normal" }))).toBe(0x00);
    expect(modeOf(encodeEscPos(layout, { columns: 42, textSize: "xlarge" }))).toBe(0x30);
    const long = { title: "t", lines: [{ kind: "text" as const, text: "x".repeat(30) }] };
    const lines = String.fromCharCode(...encodeEscPos(long, { columns: 42, textSize: "xlarge", cut: "none" })).split("\n").filter((line) => line.includes("x"));
    expect(lines.length).toBe(2);
    expect(renderLayoutHtml(layout, 80, "xlarge")).toContain("font: 20px");
  });

  it("prints only the items added after the ticket went out, marked ADDED, and add-ons as ADD-ON (owner, 2026-10-13)", () => {
    const numbered = { ...doc, order: { ...doc.order, daily_number: 12 } };
    const added = layoutToText(buildKitchenTicket(numbered, [], { onlyItemIds: ["66000000-0000-4000-8000-000000000012"] })!, 40).join("\n");
    expect(added).toContain("ADDED TO #12");
    expect(added).toContain("Coke");
    expect(added).not.toContain("Cheese Pizza");
    expect(added).toContain("1 ITEM ADDED (2 ON ORDER)");
    expect(buildKitchenTicket(numbered, [], { onlyItemIds: [] })).toBeNull();
    const addOn = layoutToText(buildKitchenTicket({ ...numbered, order: { ...numbered.order, add_on_to: "W000100" } })!, 40).join("\n");
    expect(addOn).toContain("ADD-ON TO #12");
  });

  it("keeps kitchen item lines full width (tall, not wide) and picks the TM-U220B's 40-column font", () => {
    const lines = layoutToText(buildKitchenTicket(doc)!, 40);
    expect(lines.every((line) => line.length <= 40)).toBe(true);
    // An item line is tall only: GS ! 0x01 (double height), never 0x11 (double width too).
    const bytes = Array.from(encodeEscPos({ title: "t", lines: [{ kind: "text", text: "1x Large Cheese Pizza", tall: true, bold: true }] }, { columns: 40, textSize: "normal", fontB: true, cut: "none" }));
    expect(bytes.slice(2, 5)).toEqual([0x1b, 0x4d, 1]);
    const gs = bytes.findIndex((value, index) => value === 0x1d && bytes[index + 1] === 0x21);
    expect(bytes[gs + 2]).toBe(0x01);
    const esc = bytes.findIndex((value, index) => index > 4 && value === 0x1b && bytes[index + 1] === 0x21);
    // ESC ! keeps font B (bit 0) with bold + double height.
    expect(bytes[esc + 2]).toBe(0x01 | 0x08 | 0x10);
    expect(printerModel("epson-tm-u220b").fontB).toBe(true);
    expect(printerModel("epson-tm-t20iii").fontB).toBe(false);
  });
});
