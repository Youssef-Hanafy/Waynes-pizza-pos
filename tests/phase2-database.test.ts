import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrations = [
  "20260908000000_phase0_foundation.sql",
  "20260908010000_phase1_public_menu.sql",
  "20260908020000_phase2_orders.sql",
].map((file) =>
  readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8"),
);
const categoryId = "43000000-0000-4000-8000-000000000001";
let itemId = "";
let variantId = "";
let pepperoniId = "";

describe("Phase 2 order database", () => {
  const database = new PGlite();

  beforeAll(async () => {
    await database.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}'::jsonb);
      create schema storage;
      create table storage.buckets (id text primary key, name text not null, public boolean not null default false, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text not null);
    `);
    for (const migration of migrations) await database.exec(migration);
    await database.exec(`
      update public.store_settings set
        business_hours = '{"sunday":{"closed":false,"open":"00:00","close":"23:59"},"monday":{"closed":false,"open":"00:00","close":"23:59"},"tuesday":{"closed":false,"open":"00:00","close":"23:59"},"wednesday":{"closed":false,"open":"00:00","close":"23:59"},"thursday":{"closed":false,"open":"00:00","close":"23:59"},"friday":{"closed":false,"open":"00:00","close":"23:59"},"saturday":{"closed":false,"open":"00:00","close":"23:59"}}',
        tax_rate_basis_points = 625, delivery_fee_cents = 300, tips_enabled = true;
      insert into public.menu_categories (id, name) values ('${categoryId}', 'Pizza');
      insert into public.menu_items (id, category_id, name, description, base_price_cents, tax_category)
      values ('43000000-0000-4000-8000-000000000002', '${categoryId}', 'Classic Pizza', 'Snapshot description', 1200, 'prepared_food');
      insert into public.menu_item_variants (id, menu_item_id, name, price_cents, sort_order)
      values ('43000000-0000-4000-8000-000000000003', '43000000-0000-4000-8000-000000000002', 'Large', 1800, 0);
      insert into public.modifier_groups (id, name, customer_label, min_select, max_select, required, allow_quantities)
      values ('43000000-0000-4000-8000-000000000004', 'Toppings', 'Choose toppings', 0, 3, false, true);
      insert into public.modifier_choices (id, modifier_group_id, name, price_delta_cents)
      values ('43000000-0000-4000-8000-000000000005', '43000000-0000-4000-8000-000000000004', 'Pepperoni', 150);
      insert into public.menu_item_modifier_groups (menu_item_id, modifier_group_id)
      values ('43000000-0000-4000-8000-000000000002', '43000000-0000-4000-8000-000000000004');
      insert into public.promotions (code, description, discount_type, discount_value) values ('SAVE10', 'Ten percent off', 'percent', 1000);
    `);
    itemId = "43000000-0000-4000-8000-000000000002";
    variantId = "43000000-0000-4000-8000-000000000003";
    pepperoniId = "43000000-0000-4000-8000-000000000005";
  }, 30_000);

  afterAll(async () => database.close());

  it("normalizes US phone numbers", async () => {
    const result = await database.query<{ phone: string }>(
      "select public.wayne_normalize_phone('(508) 852-6326') phone",
    );
    expect(result.rows[0]?.phone).toBe("+15088526326");
  });

  it("creates one authoritative pickup order and returns it for duplicate requests", async () => {
    const payload = orderPayload("pickup-key-0000000001", "pickup");
    const first = await createOrder(database, payload);
    const duplicate = await createOrder(database, payload);
    expect(first.duplicate).toBe(false);
    expect(duplicate).toMatchObject({
      id: first.id,
      order_number: first.order_number,
      duplicate: true,
    });
    const counts = await database.query<{ orders: number; events: number }>(
      "select (select count(*)::int from public.orders) orders, (select count(*)::int from public.order_events) events",
    );
    expect(counts.rows[0]).toEqual({ orders: 1, events: 1 });
  });

  it("calculates discount, delivery fee, tax, and tip in integer cents", async () => {
    const result = await createOrder(database, {
      ...orderPayload("delivery-key-00000001", "delivery"),
      promo_code: "SAVE10",
      tip_cents: 200,
      address: {
        address1: "10 Main St",
        address2: "2A",
        city: "Worcester",
        state: "MA",
        postal_code: "01606",
        delivery_instructions: "Side door",
      },
    });
    const order = await database.query<{
      subtotal_cents: number;
      discount_cents: number;
      delivery_fee_cents: number;
      tax_cents: number;
      tip_cents: number;
      total_cents: number;
    }>(
      `select subtotal_cents, discount_cents, delivery_fee_cents, tax_cents, tip_cents, total_cents from public.orders where id = '${result.id}'`,
    );
    expect(order.rows[0]).toEqual({
      subtotal_cents: 3900,
      discount_cents: 390,
      delivery_fee_cents: 300,
      tax_cents: 238,
      tip_cents: 200,
      total_cents: 4248,
    });
  });

  it("keeps order snapshots stable after menu and customer edits", async () => {
    const order = await database.query<{
      id: string;
      public_access_token: string;
    }>(
      "select id, public_access_token from public.orders order by created_at limit 1",
    );
    await database.exec(
      "update public.menu_items set name = 'Renamed Pizza'; update public.menu_item_variants set name = 'Renamed Size'; update public.customers set first_name = 'Changed';",
    );
    const status = await database.query<{
      result: {
        customer_name: string;
        items: { name: string; variant_name: string }[];
      };
    }>(
      `select public.wayne_public_order_status('${order.rows[0]?.id}', '${order.rows[0]?.public_access_token}') result`,
    );
    expect(status.rows[0]?.result.customer_name).toBe("Test Customer");
    expect(status.rows[0]?.result.items[0]).toMatchObject({
      name: "Classic Pizza",
      variant_name: "Large",
    });
  });

  it("hides customer and order tables from anonymous direct access", async () => {
    await database.exec("set role anon");
    await expect(
      database.query("select * from public.customers"),
    ).rejects.toThrow(/permission denied/);
    await expect(database.query("select * from public.orders")).rejects.toThrow(
      /permission denied/,
    );
    await database.exec("reset role");
  });

  it("rejects email marketing consent without an email address", async () => {
    await database.exec("set role anon");
    await expect(database.query(`select public.wayne_create_test_order('${JSON.stringify({ ...orderPayload("email-consent-key-001", "pickup"), email: "", email_opt_in: true }).replaceAll("'", "''")}'::jsonb)`)).rejects.toThrow(/email address is required/i);
    await database.exec("reset role");
  });

  it("does not accept an ASAP order while ordering is closed", async () => {
    await database.exec("update public.store_settings set ordering_open = false; set role anon");
    await expect(database.query(`select public.wayne_create_test_order('${JSON.stringify(orderPayload("closed-order-key-0001", "pickup")).replaceAll("'", "''")}'::jsonb)`)).rejects.toThrow(/currently closed/i);
    await database.exec("reset role; update public.store_settings set ordering_open = true");
  });
});

async function createOrder(database: PGlite, payload: Record<string, unknown>) {
  await database.exec("set role anon");
  const result = await database.query<{
    result: { id: string; order_number: string; duplicate: boolean };
  }>(
    `select public.wayne_create_test_order('${JSON.stringify(payload).replaceAll("'", "''")}'::jsonb) result`,
  );
  await database.exec("reset role");
  return result.rows[0]!.result;
}

function orderPayload(
  idempotency_key: string,
  fulfillment_type: "pickup" | "delivery",
) {
  return {
    idempotency_key,
    fulfillment_type,
    first_name: "Test",
    last_name: "Customer",
    phone: "508-555-0101",
    email: "test@example.com",
    sms_opt_in: true,
    email_opt_in: false,
    tip_cents: 0,
    special_instructions: "Ring bell",
    items: [
      {
        menu_item_id: itemId,
        variant_id: variantId,
        quantity: 2,
        special_instructions: "Well done",
        modifiers: [{ choice_id: pepperoniId, quantity: 1 }],
      },
    ],
  };
}
