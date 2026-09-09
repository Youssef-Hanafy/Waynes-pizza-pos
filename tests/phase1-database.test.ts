import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const phase0 = readFileSync(resolve(process.cwd(), "supabase/migrations/20260908000000_phase0_foundation.sql"), "utf8");
const phase1 = readFileSync(resolve(process.cwd(), "supabase/migrations/20260908010000_phase1_public_menu.sql"), "utf8");
const ownerId = "31000000-0000-4000-8000-000000000001";
const cashierId = "31000000-0000-4000-8000-000000000002";

describe("Phase 1 menu database", () => {
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
    await database.exec(phase0);
    await database.exec(phase1);
    await database.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values
        ('${ownerId}', 'owner@phase1.test', '{"display_name":"Owner"}'),
        ('${cashierId}', 'cashier@phase1.test', '{"display_name":"Cashier"}');
      update public.profiles set role_id = (select id from public.roles where code = 'owner') where id = '${ownerId}';
    `);
  }, 30_000);

  afterAll(async () => database.close());

  it("applies both migrations cleanly and enables RLS", async () => {
    const result = await database.query<{ relname: string; relrowsecurity: boolean }>(`select relname, relrowsecurity from pg_class where relname in ('store_settings','store_special_hours','menu_categories','menu_items','menu_item_variants','modifier_groups','modifier_choices','menu_item_modifier_groups') order by relname`);
    expect(result.rows).toHaveLength(8);
    expect(result.rows.every((row) => row.relrowsecurity)).toBe(true);
  });

  it("lets the owner transactionally create a category, item, variants, and modifiers", async () => {
    await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${ownerId}', true); insert into public.menu_categories (id,name,description,sort_order) values ('41000000-0000-4000-8000-000000000001','Pizza','Greek- and Italian-style pizza',1); select public.wayne_create_menu_item('${JSON.stringify(samplePayload).replaceAll("'", "''")}'::jsonb); commit;`);
    const counts = await database.query<{ variants: number; groups: number; choices: number }>(`select (select count(*)::int from public.menu_item_variants) variants, (select count(*)::int from public.modifier_groups) groups, (select count(*)::int from public.modifier_choices) choices`);
    expect(counts.rows[0]).toEqual({ variants: 2, groups: 1, choices: 2 });
  });

  it("returns public nested menu data and keeps sold-out items visible", async () => {
    await database.exec("begin; set local role anon;");
    const result = await database.query<{ menu: unknown }>("select public.wayne_public_menu() as menu");
    await database.exec("rollback");
    const menu = result.rows[0]?.menu as { items: { sold_out: boolean; variants: unknown[]; modifier_groups: unknown[] }[] }[];
    expect(menu[0]?.items[0]?.sold_out).toBe(true);
    expect(menu[0]?.items[0]?.variants).toHaveLength(2);
    expect(menu[0]?.items[0]?.modifier_groups).toHaveLength(1);
  });

  it("hides archived items from the public result without deleting their children", async () => {
    const item = await database.query<{ id: string }>("select id from public.menu_items limit 1");
    await database.exec(`update public.menu_items set archived_at = now() where id = '${item.rows[0]?.id}'; begin; set local role anon;`);
    const result = await database.query<{ menu: unknown }>("select public.wayne_public_menu() as menu");
    await database.exec("rollback");
    const menu = result.rows[0]?.menu as { items: unknown[] }[];
    expect(menu[0]?.items).toHaveLength(0);
    const variants = await database.query<{ count: number }>("select count(*)::int as count from public.menu_item_variants");
    expect(variants.rows[0]?.count).toBe(2);
  });

  it("denies menu writes to a cashier", async () => {
    await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${cashierId}', true);`);
    await expect(database.query(`select public.wayne_create_menu_item('${JSON.stringify(samplePayload).replaceAll("'", "''")}'::jsonb)`)).rejects.toThrow(/Menu management permission required/);
    await database.exec("rollback");
  });
});

const samplePayload = {
  category_id: "41000000-0000-4000-8000-000000000001",
  name: "Wayne's Special", description: "A test pizza", image_path: null, image_alt: "Wayne's Special pizza", base_price_cents: 1200,
  tax_category: "prepared_food", included_count_label: "", sold_out: true, customer_visible: true, pos_visible: true, featured: true, kitchen_route: "pizza",
  available_days: [0,1,2,3,4,5,6], available_start: "", available_end: "", sort_order: 1,
  variants: [{ name: "Small", price_cents: 1200, sku: "", sort_order: 0 }, { name: "Large", price_cents: 1800, sku: "", sort_order: 1 }],
  modifier_groups: [{ name: "Toppings", customer_label: "Choose toppings", min_select: 0, max_select: 3, required: false, allow_quantities: true, choices: [{ name: "Pepperoni", price_delta_cents: 150, default_selected: false }, { name: "Mushrooms", price_delta_cents: 100, default_selected: false }] }]
};
