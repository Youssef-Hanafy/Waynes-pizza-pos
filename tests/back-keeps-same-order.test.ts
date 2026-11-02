import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blankDraft, draftToOrderPayload, posDraftSchema } from "@/lib/orders/drafts";
import { posOrderCreatedSchema, posOrderInputSchema } from "@/lib/pos/schemas";
import { NOT_RESTORED, ticketSnapshot } from "@/stores/pos-history";

/**
 * Orders "cancelling themselves and then getting recreated with the same names"
 * (owner, 2026-11-01).  Production record: every cancelled order on 10/31–11/1 was
 * the POS close-out — Back from the payment screen (cancel + resend as a NEW
 * order/number) or leaving the payment screen (cancel).  Now Back changes the same
 * order and leaving keeps it like Pay later.
 */
const ORDER = "6a000000-0000-4000-8000-0000000000a1";
const line = { line_id: "6a000000-0000-4000-8000-0000000000c1", menu_item_id: "6a000000-0000-4000-8000-0000000000b1", variant_id: null, quantity: 1, modifiers: [], special_instructions: "" };

describe("Back from the payment screen changes the SAME order", () => {
  it("a ticket tied to its order sends replaces_order_id, and the API accepts it", () => {
    const draft = { ...blankDraft({ cart: [line] }), replacesOrderId: ORDER };
    const payload = draftToOrderPayload(draft);
    expect(payload).toMatchObject({ replaces_order_id: ORDER });
    expect(posOrderInputSchema.parse(payload).replaces_order_id).toBe(ORDER);
  });

  it("an ordinary ticket sends no replaces_order_id (new orders unchanged)", () => {
    const payload = draftToOrderPayload(blankDraft({ cart: [line] }));
    expect(payload).not.toHaveProperty("replaces_order_id");
    expect(posOrderInputSchema.parse(payload).replaces_order_id).toBeUndefined();
  });

  it("tickets saved before this change still load (field defaults to null)", () => {
    const { replacesOrderId: _drop, ...old } = blankDraft();
    void _drop;
    expect(posDraftSchema.parse(old).replacesOrderId).toBeNull();
  });

  it("Back / Forward steps can never strip the link (no second order from an older step)", () => {
    expect(NOT_RESTORED).toContain("replacesOrderId");
    expect(ticketSnapshot({ ...blankDraft(), replacesOrderId: ORDER })).not.toHaveProperty("replacesOrderId");
  });

  it("the server answer says the same order was updated", () => {
    expect(posOrderCreatedSchema.parse({ id: ORDER, order_number: "W001269", total_cents: 3046, duplicate: false, replaced: true, daily_number: 8 })).toMatchObject({ replaced: true, daily_number: 8 });
    expect(posOrderCreatedSchema.parse({ id: ORDER, order_number: "W001269", total_cents: 3046, duplicate: false }).replaced).toBe(false);
  });
});

describe("leaving keeps a sent order (like Pay later), never cancels it", () => {
  const calls: string[] = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal("window", Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } }));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(String(url)); return new Response(JSON.stringify({ released: true }), { status: 200 }); }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it("closing out a ticket taken back from payment keeps its order: kitchen slip released, nothing cancelled", async () => {
    const { orderStore } = await import("@/stores/order-store");
    const { closeOutUnsentTickets, unsettledOrder } = await import("@/stores/ticket-closeout");
    const draft = { ...blankDraft({ cart: [line] }), replacesOrderId: ORDER };
    orderStore.set({ activeId: draft.id, drafts: [draft] });
    unsettledOrder.id = ORDER;
    closeOutUnsentTickets();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toContain(`/api/pos/orders/${ORDER}/release-print`);
    expect(calls.some((url) => url.includes("/abandon"))).toBe(false);
    expect(unsettledOrder.id).toBeNull();
  });

  it("keepSentOrder releases the slip and frees the register's open order", async () => {
    const { keepSentOrder, unsettledOrder } = await import("@/stores/ticket-closeout");
    unsettledOrder.id = ORDER;
    keepSentOrder(ORDER);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([`/api/pos/orders/${ORDER}/release-print`]);
    expect(unsettledOrder.id).toBeNull();
  });
});

describe("guard: no register screen cancels a sent order by itself any more", () => {
  const root = new URL("..", import.meta.url).pathname;
  function files(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(join(root, dir))) {
      const path = join(dir, name);
      if (statSync(join(root, path)).isDirectory()) files(path, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
    }
    return out;
  }
  it("src/app/pos and src/stores never call the abandon (auto-cancel) endpoint", () => {
    const offenders = [...files("src/app/pos"), ...files("src/stores")].filter((path) => /\/abandon[`'"]/.test(readFileSync(join(root, path), "utf8")));
    expect(offenders).toEqual([]);
  });
  it("Back from the payment screen ties the reopened ticket to its order", () => {
    const history = readFileSync(join(root, "src/app/pos/use-pos-history.ts"), "utf8");
    expect(history).toMatch(/reviveTicket\(step\.ticket, revive\)/);
    expect(history).toMatch(/replacesOrderId \}/);
  });
});
