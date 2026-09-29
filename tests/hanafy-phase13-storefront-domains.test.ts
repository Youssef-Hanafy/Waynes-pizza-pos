import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = resolve(process.cwd(), "supabase/migrations");
const migrations = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();

const waynesWorkspaceId = "40000000-0000-4000-8000-000000000001";
const tenantB = "98300000-0000-4000-8000-00000000000b";
const tenantBLocation = "98300000-0000-4000-8000-0000000000b1";
const platformOwner = "98300000-0000-4000-8000-000000000004";
const waynesHost = "waynespizzaofworcester.com";
const bHost = "orders.bobs-bagels.example";

type Row = Record<string, unknown>;
type Menu = { name: string; items: { name: string }[] }[];

describe("Hanafy Platform Phase 13 multi-tenant storefront / custom domains", () => {
  const database = new PGlite({ extensions: { pgcrypto } });

  async function commitAs<T extends Row>(userId: string | null, sql: string) {
    await database.exec(`begin; set local role ${userId ? "authenticated" : "anon"}; select set_config('request.jwt.claim.sub', '${userId ?? ""}', true);`);
    try {
      const rows = (await database.query<T>(sql)).rows;
      await database.exec("commit");
      return rows;
    } catch (error) {
      await database.exec("rollback");
      throw error;
    }
  }
  const anon = async <T,>(sql: string) => (await commitAs<{ value: T }>(null, `select ${sql} as value`))[0]!.value;
  const json = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  const domain = (payload: unknown, confirmed = false, slug = "bobs-bagels") =>
    commitAs<{ result: { status: string; id: string } }>(platformOwner, `select public.hanafy_platform_save_domain('${slug}', ${json(payload)}, 'Connecting the web address', ${confirmed}) as result`);

  beforeAll(async () => {
    await database.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, last_sign_in_at timestamptz, raw_user_meta_data jsonb not null default '{}'::jsonb);
      create schema storage;
      create table storage.buckets(id text primary key, name text not null, public boolean not null default false, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text not null);
    `);
    for (const migration of migrations) await database.exec(readFileSync(resolve(directory, migration), "utf8"));
    await database.exec(`
      insert into auth.users (id, email, email_confirmed_at) values ('${platformOwner}', 'platform@hanafy.test', now());
      insert into public.platform_users (auth_user_id, platform_role, active) values ('${platformOwner}', 'platform_owner', true);
      insert into public.workspace_domains (workspace_id, location_id, hostname, is_canonical, active)
        select '${waynesWorkspaceId}', id, '${waynesHost}', true, true from public.locations where workspace_id = '${waynesWorkspaceId}'
        on conflict (hostname) do nothing;

      insert into public.workspaces (id, slug, name, status) values ('${tenantB}', 'bobs-bagels', 'Bob''s Bagels', 'provisioning');
      insert into public.workspace_settings (workspace_id, display_name) values ('${tenantB}', 'Bob''s Bagels');
      insert into public.locations (id, workspace_id, slug, name, status, city) values ('${tenantBLocation}', '${tenantB}', 'downtown', 'Downtown', 'active', 'Boston');
      insert into public.location_settings (location_id, workspace_id, configuration) values ('${tenantBLocation}', '${tenantB}',
        '{"store_name":"Bob''s Bagels","seo_home_title":"Bob''s Bagels | Boston","city":"Boston","public_phone":"(617) 555-0199"}'::jsonb);
      insert into public.workspace_services (workspace_id, service_id, status, source)
        select '${tenantB}', service.id, 'enabled', 'manual' from public.service_catalog service where service.code in ('pos', 'online_ordering', 'website_storefront');

      insert into public.menu_categories (name, workspace_id) values ('Wayne Pizzas', '${waynesWorkspaceId}');
      insert into public.menu_items (name, category_id, workspace_id, base_price_cents)
        select 'Large Cheese', id, '${waynesWorkspaceId}', 1500 from public.menu_categories where name = 'Wayne Pizzas';
      insert into public.menu_categories (name, workspace_id) values ('Bob Bagels', '${tenantB}');
      insert into public.menu_items (name, category_id, workspace_id, base_price_cents)
        select 'Everything Bagel', id, '${tenantB}', 300 from public.menu_categories where name = 'Bob Bagels';
      insert into public.promotions (code, description, discount_type, discount_value, minimum_order_cents, workspace_id) values
        ('WAYNE5', 'Wayne five off', 'fixed', 500, 0, '${waynesWorkspaceId}'), ('BOB1', 'Bob one off', 'fixed', 100, 0, '${tenantB}');
    `);
  }, 180_000);

  afterAll(async () => database.close());

  it("manages a business's web addresses with validation and audit", async () => {
    await domain({ hostname: "https://orders.bobs-bagels.example/menu" });
    const rows = (await database.query<{ hostname: string; is_canonical: boolean }>(`select hostname, is_canonical from public.workspace_domains where workspace_id = '${tenantB}'`)).rows;
    expect(rows).toEqual([{ hostname: bHost, is_canonical: true }]);
    await expect(domain({ hostname: waynesHost })).rejects.toThrow("already used by Wayne's Pizza");
    await expect(domain({ hostname: "app.hanafymedia.com" })).rejects.toThrow("Hanafy platform");
    await expect(domain({ hostname: "not a host" })).rejects.toThrow("Enter a web address");
    const second = await domain({ hostname: "www.bobs-bagels.example" });
    await domain({ id: second[0]!.result.id, action: "canonical" });
    const canonical = (await database.query<{ hostname: string }>(`select hostname from public.workspace_domains where workspace_id = '${tenantB}' and is_canonical`)).rows;
    expect(canonical).toEqual([{ hostname: "www.bobs-bagels.example" }]);
    await expect(domain({ id: second[0]!.result.id, action: "remove" })).rejects.toThrow("Switch the web address off");
    const audit = await database.query("select 1 from public.platform_audit_log where action like 'platform.domain.%'");
    expect(audit.rows.length).toBe(3);
  });

  it("does not answer for a business that is not live yet, and never falls back to Wayne's", async () => {
    expect(await anon(`public.hanafy_public_workspace('${bHost}')`)).toBeNull();
    expect(await anon(`public.hanafy_public_store_settings('${bHost}')`)).toBeNull();
    expect(await anon(`public.hanafy_public_menu('${bHost}')`)).toEqual([]);
    expect(await anon(`public.hanafy_public_menu('unknown.example')`)).toEqual([]);
    expect(await anon(`public.hanafy_public_promotions('unknown.example')`)).toEqual([]);
    await database.exec(`update public.workspaces set status = 'active' where id = '${tenantB}'`);
  });

  it("renders each host's own business: settings, menu, deals, theme (two tenants, no leakage)", async () => {
    const waynes = await anon<{ store_name: string }>(`public.hanafy_public_store_settings('${waynesHost}')`);
    const bob = await anon<{ store_name: string; seo_home_title: string; canonical_url: string }>(`public.hanafy_public_store_settings('${bHost.toUpperCase()}:443')`);
    expect(waynes.store_name).toBe("Wayne's Pizza");
    expect(bob).toMatchObject({ store_name: "Bob's Bagels", seo_home_title: "Bob's Bagels | Boston", canonical_url: "https://www.bobs-bagels.example" });

    const waynesMenu = await anon<Menu>(`public.hanafy_public_menu('${waynesHost}')`);
    const bobMenu = await anon<Menu>(`public.hanafy_public_menu('${bHost}')`);
    expect(waynesMenu.map((category) => category.name)).toContain("Wayne Pizzas");
    expect(waynesMenu.map((category) => category.name)).not.toContain("Bob Bagels");
    expect(bobMenu.map((category) => category.name)).toEqual(["Bob Bagels"]);
    expect(bobMenu[0]!.items.map((item) => item.name)).toEqual(["Everything Bagel"]);

    const waynesDeals = await anon<{ code: string }[]>(`public.hanafy_public_promotions('${waynesHost}')`);
    const bobDeals = await anon<{ code: string }[]>(`public.hanafy_public_promotions('${bHost}')`);
    expect(waynesDeals.map((deal) => deal.code)).toContain("WAYNE5");
    expect(waynesDeals.map((deal) => deal.code)).not.toContain("BOB1");
    expect(bobDeals.map((deal) => deal.code)).toEqual(["BOB1"]);

    const bobWorkspace = await anon<{ workspace_slug: string; legacy_operations: boolean; brand_colors: Record<string, string> }>(`public.hanafy_public_workspace('${bHost}')`);
    expect(bobWorkspace).toMatchObject({ workspace_slug: "bobs-bagels", legacy_operations: false, brand_colors: {} });
  });

  it("only shows an order confirmation on its own business's web address", async () => {
    const order = (await database.query<{ id: string; token: string }>(`insert into public.orders(order_number, source, fulfillment_type, status, payment_status, payment_method, customer_name_snapshot, customer_phone_snapshot, placed_at, idempotency_key, pricing_snapshot, subtotal_cents, total_cents, workspace_id)
      values ('WEB-9001', 'online', 'pickup', 'placed', 'unpaid', 'cash', 'Rita', '5085550100', now(), 'phase13-order-key-1', '{}'::jsonb, 1500, 1605, '${waynesWorkspaceId}') returning id, public_access_token as token`)).rows[0]!;
    expect(await anon(`public.hanafy_public_order_status('${waynesHost}', '${order.id}', '${order.token}')`)).not.toBeNull();
    expect(await anon(`public.hanafy_public_order_status('${bHost}', '${order.id}', '${order.token}')`)).toBeNull();
    expect(await anon(`public.hanafy_public_order_status('unknown.example', '${order.id}', '${order.token}')`)).toBeNull();
  });

  it("edits a business's storefront basics and theme without code, whitelisted and audited", async () => {
    await commitAs(platformOwner, `select public.hanafy_platform_save_storefront('bobs-bagels', '${tenantBLocation}', ${json({ homepage_heading: "Fresh every morning", brand_primary: "#1D4ED8", ordering_open: false })}, 'Owner sent the copy')`);
    const bob = await anon<{ homepage_heading: string; ordering_open: boolean }>(`public.hanafy_public_store_settings('${bHost}')`);
    expect(bob).toMatchObject({ homepage_heading: "Fresh every morning", ordering_open: false });
    const theme = await anon<{ brand_colors: { primary: string } }>(`public.hanafy_public_workspace('${bHost}')`);
    expect(theme.brand_colors.primary).toBe("#1d4ed8");
    // Wayne's is untouched.
    const waynes = await anon<{ homepage_heading: string }>(`public.hanafy_public_store_settings('${waynesHost}')`);
    expect(waynes.homepage_heading).not.toBe("Fresh every morning");
    await expect(commitAs(platformOwner, `select public.hanafy_platform_save_storefront('bobs-bagels', '${tenantBLocation}', ${json({ tax_rate_basis_points: 0 })}, 'sneaky change')`)).rejects.toThrow("cannot be changed here");
    await expect(commitAs(platformOwner, `select public.hanafy_platform_save_storefront('waynes-pizza', '${tenantBLocation}', ${json({ store_name: "x" })}, 'wrong location')`)).rejects.toThrow("does not belong");
  });

  it("warns before taking a live business's last web address off", async () => {
    const ids = (await database.query<{ id: string }>(`select id from public.workspace_domains where workspace_id = '${tenantB}' order by hostname`)).rows.map((row) => row.id);
    await domain({ id: ids[0], action: "deactivate" }, true);
    const last = await domain({ id: ids[1], action: "deactivate" });
    expect(last[0]!.result.status).toBe("needs_confirmation");
    await domain({ id: ids[1], action: "deactivate" }, true);
    expect(await anon(`public.hanafy_public_workspace('${bHost}')`)).toBeNull();
    await domain({ id: ids[0], action: "remove" });
    expect((await database.query(`select 1 from public.workspace_domains where workspace_id = '${tenantB}'`)).rows).toHaveLength(1);
  });
});
