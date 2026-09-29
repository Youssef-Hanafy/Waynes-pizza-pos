import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = resolve(process.cwd(), "supabase/migrations");
const migrations = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();

const waynesWorkspaceId = "40000000-0000-4000-8000-000000000001";
const other = "98400000-0000-4000-8000-00000000000b";
const otherLocation = "98400000-0000-4000-8000-0000000000b1";
const platformOwner = "98400000-0000-4000-8000-000000000004";
const waynesOwner = "98400000-0000-4000-8000-000000000003";

type Row = Record<string, unknown>;

describe("Hanafy Platform Phase 14 regression hardening", () => {
  const database = new PGlite({ extensions: { pgcrypto } });

  async function run<T extends Row>(role: "anon" | "authenticated", userId: string, sql: string) {
    await database.exec(`begin; set local role ${role}; select set_config('request.jwt.claim.sub', '${userId}', true);`);
    try {
      return (await database.query<T>(sql)).rows;
    } finally {
      await database.exec("rollback");
    }
  }

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
      insert into auth.users (id, email, email_confirmed_at) values ('${platformOwner}', 'platform@hanafy.test', now()), ('${waynesOwner}', 'owner@waynes.test', now());
      insert into public.platform_users (auth_user_id, platform_role, active) values ('${platformOwner}', 'platform_owner', true);
      update public.profiles set role_id = (select id from public.roles where code = 'owner'), active = true where id = '${waynesOwner}';
      insert into public.workspace_domains (workspace_id, location_id, hostname, is_canonical, active)
        select '${waynesWorkspaceId}', id, 'waynespizzaofworcester.com', true, true from public.locations where workspace_id = '${waynesWorkspaceId}'
        on conflict (hostname) do nothing;
      insert into public.workspaces (id, slug, name, status) values ('${other}', 'other-shop', 'Other Shop', 'active');
      insert into public.locations (id, workspace_id, slug, name, status) values ('${otherLocation}', '${other}', 'main', 'Main', 'active');
      insert into public.workspace_services (workspace_id, service_id, status, source)
        select '${other}', service.id, 'enabled', 'manual' from public.service_catalog service where service.code in ('pos', 'online_ordering', 'website_storefront');
      insert into public.menu_categories (name, workspace_id) values ('Wayne Subs', '${waynesWorkspaceId}'), ('Other Tacos', '${other}');
      insert into public.promotions (code, description, discount_type, discount_value, minimum_order_cents, workspace_id) values
        ('WAYNEDEAL', 'Wayne deal', 'fixed', 300, 0, '${waynesWorkspaceId}'), ('OTHERDEAL', 'Other deal', 'fixed', 300, 0, '${other}');
    `);
  }, 180_000);

  afterAll(async () => database.close());

  it("keeps old deployments' public menu and deals to Wayne's only", async () => {
    const [menu] = await run<{ value: { name: string }[] }>("anon", "", "select public.wayne_public_menu() as value");
    const names = menu!.value.map((category) => category.name);
    expect(names).toContain("Wayne Subs");
    expect(names).not.toContain("Other Tacos");
    const [deals] = await run<{ value: { code: string }[] }>("anon", "", "select public.wayne_public_promotions() as value");
    expect(deals!.value.map((deal) => deal.code)).toContain("WAYNEDEAL");
    expect(deals!.value.map((deal) => deal.code)).not.toContain("OTHERDEAL");
  });

  it("serves the same Wayne's menu through the storefront and the legacy path", async () => {
    const [both] = await run<{ same: boolean; deals_same: boolean }>("anon", "", `select public.hanafy_public_menu('waynespizzaofworcester.com') = public.wayne_public_menu() as same,
      public.hanafy_public_promotions('WaynesPizzaOfWorcester.com') = public.wayne_public_promotions() as deals_same`);
    expect(both).toEqual({ same: true, deals_same: true });
  });

  it("does not expose the per-business builders to browsers", async () => {
    await expect(run("anon", "", `select public.hanafy_workspace_menu('${other}')`)).rejects.toThrow("permission denied");
    await expect(run("authenticated", waynesOwner, `select public.hanafy_workspace_promotions('${other}')`)).rejects.toThrow("permission denied");
  });

  it("keeps Wayne's platform view whole after phases 10-13", async () => {
    const [summary] = await run<{ value: { slug: string; status: string; billing: { agreement: null }; hardware: { devices: number }; health: { level: string } } }>(
      "authenticated", platformOwner, `select public.hanafy_platform_workspace_detail('waynes-pizza') as value`);
    expect(summary!.value).toMatchObject({ slug: "waynes-pizza", status: "active", billing: { agreement: null } });
    expect(summary!.value.hardware.devices).toBeGreaterThanOrEqual(3);
    const [setup] = await run<{ value: { blocking: string[] } }>("authenticated", platformOwner, `select public.hanafy_platform_workspace_setup('waynes-pizza') as value`);
    expect(Array.isArray(setup!.value.blocking)).toBe(true);
    const [dashboard] = await run<{ value: { billing: { without_agreement: number } } }>("authenticated", platformOwner, `select public.hanafy_platform_dashboard() as value`);
    expect(dashboard!.value.billing.without_agreement).toBeGreaterThanOrEqual(1);
  });
});
