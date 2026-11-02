import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ownerId, startTipPostgres } from "./helpers/tip-postgres";
vi.mock("server-only", () => ({}));

/**
 * Orders "cancelling themselves and being recreated with the same names"
 * (owner, 2026-11-01).  A ticket taken back from the payment screen and sent
 * again must land on the ORIGINAL order: same order, same order number, same
 * daily slip number, one kitchen slip — on real PostgreSQL with every migration.
 */
describe("sending a changed ticket again keeps the same order (real PostgreSQL)", () => {
  let db: Awaited<ReturnType<typeof startTipPostgres>>;
  let item = "";
  beforeAll(async () => {
    db = await startTipPostgres();
    item = (await db.admin.query("select id from public.menu_items where name='Test item'")).rows[0].id;
    await db.admin.query("update public.store_settings set delivery_enabled=true, delivery_fee_cents=200, delivery_postal_codes='{}'");
  }, 180_000);
  afterEach(async () => { await db.closeTestClients(); });
  afterAll(async () => { await db?.stop(); });

  async function create(payload: object) {
    const client = await db.connect();
    try {
      await client.query("begin; set local role authenticated");
      await client.query("select set_config('request.jwt.claim.sub',$1,true)", [ownerId]);
      const result = await client.query("select public.wayne_create_pos_order($1) value", [JSON.stringify(payload)]);
      await client.query("commit");
      return result.rows[0].value as { id: string; order_number: string; total_cents: number; duplicate: boolean; replaced?: boolean; daily_number?: number };
    } catch (error) { await client.query("rollback"); throw error; }
  }
  const phoneOrder = (overrides: object = {}) => ({
    idempotency_key: randomUUID(), customer_mode: "identified", source: "phone", fulfillment_type: "delivery", payment_method: "test_manual",
    phone: "5085550191", first_name: "David", last_name: "Mita",
    address: { address1: "93 West Boylston St", address2: "", city: "Worcester", state: "MA", postal_code: "01606", delivery_instructions: "" },
    items: [{ menu_item_id: item, variant_id: null, quantity: 1, modifiers: [], special_instructions: "" }], ...overrides,
  });
  const row = async (id: string) => (await db.admin.query("select * from public.orders where id=$1", [id])).rows[0];

  it("Back → change → send again: same order, same numbers, new contents, ONE held kitchen ticket with the final items", async () => {
    const first = await create(phoneOrder());
    const before = await row(first.id);
    const ordersBefore = (await db.admin.query("select count(*)::int n from public.orders")).rows[0].n;

    // The customer switches to pickup and wants two (owner's 2026-10-29 example), sent again from the same ticket.
    const resent = await create(phoneOrder({ fulfillment_type: "pickup", replaces_order_id: first.id, items: [{ menu_item_id: item, variant_id: null, quantity: 2, modifiers: [], special_instructions: "well done" }] }));
    expect(resent).toMatchObject({ id: first.id, order_number: first.order_number, duplicate: false, replaced: true, daily_number: before.daily_number });
    const after = await row(first.id);
    expect(after).toMatchObject({ status: "placed", payment_status: "unpaid", fulfillment_type: "pickup", delivery_fee_cents: 0, subtotal_cents: 4000, daily_number: before.daily_number, order_number: before.order_number, cancelled_at: null });
    expect((await db.admin.query("select count(*)::int n from public.orders")).rows[0].n).toBe(ordersBefore);
    const items = (await db.admin.query("select quantity, special_instructions from public.order_items where order_id=$1", [first.id])).rows;
    expect(items).toEqual([{ quantity: 2, special_instructions: "well done" }]);
    // Kitchen: one pending ticket, rebuilt with the final order; nothing printed.
    const jobs = (await db.admin.query("select status, payload from public.print_jobs where order_id=$1 and job_type='kitchen_ticket'", [first.id])).rows;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("pending");
    expect(jobs[0].payload).toMatchObject({ fulfillment_type: "pickup", daily_number: before.daily_number });
    expect(jobs[0].payload.items).toEqual([expect.objectContaining({ quantity: 2, instructions: "well done" })]);
    const kitchen = (await db.admin.query("select payload from public.kitchen_tickets where order_id=$1", [first.id])).rows;
    expect(kitchen).toHaveLength(1);
    expect(kitchen[0].payload.items).toEqual([expect.objectContaining({ quantity: 2 })]);
    const events = (await db.admin.query("select event_type from public.order_events where order_id=$1 order by created_at", [first.id])).rows.map((r) => r.event_type);
    expect(events).toEqual(["order.placed", "order.changed_before_payment"]);
    expect(events).not.toContain("order.cancelled");
  });

  it("the slip counter is not used up: the next new order gets the very next number", async () => {
    const first = await create(phoneOrder());
    const base = (await row(first.id)).daily_number as number;
    await create(phoneOrder({ replaces_order_id: first.id }));
    await create(phoneOrder({ replaces_order_id: first.id, fulfillment_type: "pickup" }));
    const next = await create(phoneOrder({ phone: "5085550192" }));
    expect((await row(next.id)).daily_number).toBe(base + 1);
  });

  it("a retry of the same resend (dropped connection) changes nothing twice", async () => {
    const first = await create(phoneOrder());
    const resend = phoneOrder({ replaces_order_id: first.id, items: [{ menu_item_id: item, variant_id: null, quantity: 3, modifiers: [], special_instructions: "" }] });
    const a = await create(resend);
    const b = await create(resend);
    expect(a.id).toBe(first.id);
    expect(b).toMatchObject({ id: first.id, duplicate: true });
    expect((await db.admin.query("select count(*)::int n from public.order_events where order_id=$1 and event_type='order.changed_before_payment'", [first.id])).rows[0].n).toBe(1);
  });

  it("a discount taken off on the resend is gone from the order", async () => {
    const first = await create(phoneOrder({ manual_discount_type: "fixed", manual_discount_value: 300, manual_discount_reason: "regular" }));
    expect((await row(first.id)).discount_cents).toBe(300);
    await create(phoneOrder({ replaces_order_id: first.id }));
    expect((await row(first.id)).discount_cents).toBe(0);
    expect((await db.admin.query("select count(*)::int n from public.order_discounts where order_id=$1", [first.id])).rows[0].n).toBe(0);
  });

  it.each([
    ["a card approval", async (id: string, total: number) => { await db.admin.query("insert into public.payments(order_id,provider,provider_payment_id,method,amount_cents,status,authorized_at) values($1,'stripe',$2,'card',$3,'authorized',now())", [id, `pi_${randomUUID().replaceAll("-", "")}`, total]); }],
    ["a card payment in progress", async (id: string, total: number) => { await db.admin.query("insert into public.payments(order_id,provider,provider_payment_id,method,amount_cents,status) values($1,'stripe',$2,'card',$3,'pending')", [id, `pi_${randomUUID().replaceAll("-", "")}`, total]); }],
    ["a printed kitchen slip", async (id: string) => { await db.admin.query("update public.print_jobs set status='printed', printed_at=now() where order_id=$1", [id]); }],
  ])("refuses to overwrite an order with %s — the original is left exactly as it was", async (_label, touch) => {
    const first = await create(phoneOrder());
    await touch(first.id, first.total_cents);
    const before = await row(first.id);
    await expect(create(phoneOrder({ replaces_order_id: first.id, fulfillment_type: "pickup" }))).rejects.toThrow(/can't be sent again/);
    const after = await row(first.id);
    expect({ ...after, updated_at: null }).toEqual({ ...before, updated_at: null });
  });

  it("refuses a cancelled order", async () => {
    const first = await create(phoneOrder());
    await db.admin.query("update public.orders set status='cancelled', cancelled_at=now() where id=$1", [first.id]);
    await expect(create(phoneOrder({ replaces_order_id: first.id }))).rejects.toThrow(/can't be sent again/);
  });

  it("a normal new order (no replaces_order_id) is unchanged", async () => {
    const created = await create(phoneOrder({ phone: "5085550193" }));
    expect(created).toMatchObject({ duplicate: false, replaced: false });
    const events = (await db.admin.query("select event_type from public.order_events where order_id=$1", [created.id])).rows.map((r) => r.event_type);
    expect(events).toEqual(["order.placed"]);
  });
});
