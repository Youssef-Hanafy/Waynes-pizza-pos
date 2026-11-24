import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { publicMenuSchema } from "@/lib/menu/schemas";
import { cartLineUnitCents } from "@/lib/orders/cart";
import { buildKitchenTicket, buildReceipt, layoutToText, printDocumentSchema } from "@/lib/printing/document";
import { ownerId, startTipPostgres } from "./helpers/tip-postgres";

const category = randomUUID();
const pizza = randomUUID();
const large = randomUUID();
const wings = randomUUID();
const eight = randomUUID();
const fries = randomUUID();
const soda = randomUUID();
const largePizza = { menu_item_id: pizza, variant_id: large, quantity: 1 };
const mixed = [largePizza, { menu_item_id: wings, variant_id: eight, quantity: 1 },
  { menu_item_id: fries, variant_id: null, quantity: 1 },
  { menu_item_id: soda, variant_id: null, quantity: 1 }];

let db: Awaited<ReturnType<typeof startTipPostgres>>;
beforeAll(async () => {
  db = await startTipPostgres();
  await db.admin.query("insert into public.menu_categories(id, name) values($1, 'Bundle fixtures')", [category]);
  await db.admin.query(
    `insert into public.menu_items(id, category_id, name, base_price_cents)
     values ($2, $1, 'Cheese Pizza', 1200), ($3, $1, 'Wings', 850), ($4, $1, 'Large Fries', 500), ($5, $1, 'Soda', 250)`,
    [category, pizza, wings, fries, soda],
  );
  await db.admin.query(
    `insert into public.menu_item_variants(id, menu_item_id, name, price_cents)
     values ($1, $2, 'Large', 1599), ($3, $4, '8 Piece', 850)`,
    [large, pizza, eight, wings],
  );
}, 60_000);
afterAll(async () => { await db?.stop(); });

async function rpc<T>(expression: string, args: unknown[] = []): Promise<T> {
  await db.admin.query("begin; set local role authenticated");
  try {
    await db.admin.query("select set_config('request.jwt.claim.sub', $1, true)", [ownerId]);
    const result = await db.admin.query<{ value: T }>(`select ${expression} as value`, args);
    await db.admin.query("commit");
    return result.rows[0].value;
  } catch (error) {
    await db.admin.query("rollback");
    throw error;
  }
}

function save(name: string, price: number, components: typeof mixed, id: string | null = null, revision?: number) {
  return rpc<string>("public.wayne_save_bundle_special($1, $2)", [id, { name, price_cents: price, expected_revision: revision, components }]);
}

function line(id: string, quantity = 1) {
  return { line_id: randomUUID(), menu_item_id: id, variant_id: null, quantity, modifiers: [], special_instructions: "" };
}

function ring(id: string, quantity = 1, overrides: Record<string, unknown> = {}) {
  return rpc<{ id: string }>("public.wayne_create_pos_order($1)", [{
    idempotency_key: randomUUID(), source: "pos", fulfillment_type: "pickup",
    customer_mode: "walk_in", payment_method: "cash", items: [line(id, quantity)], ...overrides,
  }]);
}

it("rings two large pizzas at one fixed price and prints the prep quantity for multiple bundles", async () => {
  const id = await save("Two Large Cheese Pizzas", 2099, [{ ...largePizza, quantity: 2 }]);
  const menu = publicMenuSchema.parse(await rpc("public.wayne_pos_menu()"));
  expect(menu.flatMap((category) => category.items).find((item) => item.id === id)).toMatchObject({
    special: true, special_bundle: [{ name: "Large Cheese Pizza", quantity: 2 }],
  });
  expect(cartLineUnitCents(menu, line(id))).toBe(2099);
  const order = await ring(id, 2);
  const doc = printDocumentSchema.parse(await rpc("public.wayne_pos_print_document($1)", [order.id]));
  expect(doc.order.subtotal_cents).toBe(4198);
  expect(doc.items).toHaveLength(1);
  expect(doc.items[0].line_total_cents).toBe(4198);
  expect(layoutToText(buildKitchenTicket(doc, ["Pizza"])!).join("\n")).toContain("4× Large Cheese Pizza");
  expect(layoutToText(buildReceipt(doc)).join("\n")).toContain("4× Large Cheese Pizza");
});

it("adds a mixed combo to a POS order at its fixed price and preserves the original receipt after a menu edit", async () => {
  const id = await save("Pizza, Wings, Fries & Soda", 2799, mixed);
  const order = await ring(id);
  await rpc("public.wayne_pos_edit_items($1, $2)", [order.id, { idempotency_key: randomUUID(), items: [line(id)] }]);
  const revision = (await db.admin.query("select menu_revision from public.menu_items where id = $1", [id])).rows[0].menu_revision;
  await save("Pizza, Wings & Fries", 2599, mixed.slice(0, -1), id, revision);
  await expect(save("Stale edit", 2599, mixed, id, revision)).rejects.toThrow(/bundle changed/i);
  const doc = printDocumentSchema.parse(await rpc("public.wayne_pos_print_document($1)", [order.id]));
  expect(doc.order.subtotal_cents).toBe(5598);
  expect(doc.items).toHaveLength(2);
  for (const item of doc.items) {
    expect(item.name).toBe("Pizza, Wings, Fries & Soda");
    expect(item.modifiers.map((component) => component.name).sort()).toEqual(["8 Piece Wings", "Large Cheese Pizza", "Large Fries", "Soda"]);
  }
  const price = (await db.admin.query("select price_cents from public.menu_item_variants where id = $1", [large])).rows[0].price_cents;
  expect(price).toBe(1599);
});

it("rejects incomplete recipes and stops sale when a component is sold out", async () => {
  await expect(save("Single item", 2099, [largePizza])).rejects.toThrow(/at least two/i);
  await expect(save("Wrong size", 2099, [{ ...largePizza, variant_id: eight, quantity: 2 }])).rejects.toThrow(/active size/i);
  const id = await save("Unavailable bundle", 2799, mixed);
  await db.admin.query("update public.menu_items set sold_out = true where id = $1", [soda]);
  try {
    const menu = publicMenuSchema.parse(await rpc("public.wayne_pos_menu()"));
    expect(menu.flatMap((category) => category.items).find((item) => item.id === id)?.sold_out).toBe(true);
    await expect(ring(id)).rejects.toThrow(/bundle special .* is unavailable/i);
  } finally {
    await db.admin.query("update public.menu_items set sold_out = false where id = $1", [soda]);
  }
});

it("keeps bundles off the customer menu and rejects adding them to a delivery", async () => {
  const id = await save("Pickup Bundle", 2799, mixed);
  const customerMenu = publicMenuSchema.parse(await rpc("public.wayne_public_menu()"));
  expect(customerMenu.flatMap((category) => category.items).some((item) => item.id === id)).toBe(false);
  const order = await ring(fries);
  await db.admin.query("update public.orders set fulfillment_type = 'delivery' where id = $1", [order.id]);
  await expect(rpc("public.wayne_pos_edit_items($1, $2)", [
    order.id, { idempotency_key: randomUUID(), items: [line(id)] },
  ])).rejects.toThrow(/pickup orders only/i);
});
