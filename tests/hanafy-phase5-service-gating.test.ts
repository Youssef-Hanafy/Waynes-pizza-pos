import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = resolve(process.cwd(), "supabase/migrations");
const migrations = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();
const waynesWorkspaceId = "40000000-0000-4000-8000-000000000001";
const tenantWorkspaceId = "95000000-0000-4000-8000-000000000001";
const tenantLocationId = "95000000-0000-4000-8000-000000000002";
const tenantUserId = "95000000-0000-4000-8000-000000000011";
const waynesOwnerId = "95000000-0000-4000-8000-000000000012";
const newStaffId = "95000000-0000-4000-8000-000000000013";

type Row = Record<string, unknown>;

describe("Hanafy Platform Phase 5 workspace selection and service gating", () => {
  const database = new PGlite({ extensions: { pgcrypto } });

  async function as<T extends Row>(userId: string, sql: string, params: unknown[] = []) {
    await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${userId}', true);`);
    try {
      return (await database.query<T>(sql, params)).rows;
    } finally {
      await database.exec("rollback");
    }
  }

  async function setService(code: string, status: "enabled" | "disabled", workspaceId = tenantWorkspaceId) {
    await database.exec(`
      insert into public.workspace_services (workspace_id, service_id, status, disabled_at)
      select '${workspaceId}', id, '${status}', ${status === "disabled" ? "now()" : "null"} from public.service_catalog where code = '${code}'
      on conflict (workspace_id, service_id) do update set status = excluded.status, disabled_at = excluded.disabled_at;
    `);
  }

  beforeAll(async () => {
    await database.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb not null default '{}'::jsonb);
      create schema storage;
      create table storage.buckets(id text primary key, name text not null, public boolean not null default false, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text not null);
    `);
    for (const migration of migrations) await database.exec(readFileSync(resolve(directory, migration), "utf8"));
    await database.exec(`
      insert into auth.users (id, email, email_confirmed_at) values
        ('${tenantUserId}', 'tenant@example.test', now()),
        ('${waynesOwnerId}', 'waynes-owner@example.test', now());
      update public.profiles set role_id = (select id from public.roles where code = 'owner'), active = true where id = '${waynesOwnerId}';
      insert into public.workspaces (id, slug, name) values ('${tenantWorkspaceId}', 'tenant-test', 'Tenant Test');
      insert into public.locations (id, workspace_id, slug, name) values ('${tenantLocationId}', '${tenantWorkspaceId}', 'main', 'Tenant Main');
      insert into public.workspace_members (workspace_id, auth_user_id, workspace_role_id)
      values ('${tenantWorkspaceId}', '${tenantUserId}', (select id from public.roles where code = 'owner'));
      update public.profiles set active = true where id = '${tenantUserId}';
      insert into public.workspace_domains (workspace_id, location_id, hostname, is_canonical) values ('${tenantWorkspaceId}', '${tenantLocationId}', 'tenant.example', true);
      insert into public.customers (id, workspace_id, first_name, last_name, phone_normalized)
      values ('96000000-0000-4000-8000-000000000001', '${tenantWorkspaceId}', 'Test', 'Customer', '+15550100001');
    `);
    await setService("pos", "enabled");
  }, 120_000);

  afterAll(async () => database.close());

  it("gives a workspace member only the permissions of the services the workspace has", async () => {
    const [row] = await as<{ access: { permissions: string[]; enabled_services: string[]; workspace_slug: string; legacy_operations: boolean } }>(
      tenantUserId, "select public.hanafy_current_workspace_access() as access",
    );
    expect(row?.access.workspace_slug).toBe("tenant-test");
    expect(row?.access.enabled_services).toEqual(["pos"]);
    expect(row?.access.legacy_operations).toBe(false);
    expect(row?.access.permissions).toContain("pos.access");
    expect(row?.access.permissions).toContain("admin.access");
    expect(row?.access.permissions).not.toContain("customers.view");
    expect(row?.access.permissions).not.toContain("reports.view");
    expect(row?.access.permissions).not.toContain("driver.access");
  });

  it("blocks a disabled service in RLS and restores it when the service is enabled", async () => {
    const hidden = await as<{ count: number }>(tenantUserId, "select count(*)::int as count from public.customers");
    expect(hidden).toEqual([{ count: 0 }]);

    await setService("crm", "enabled");
    const shown = await as<{ count: number; allowed: boolean }>(tenantUserId,
      `select count(*)::int as count, public.hanafy_has_workspace_permission('${tenantWorkspaceId}', 'customers.view') as allowed from public.customers`);
    expect(shown).toEqual([{ count: 1, allowed: true }]);

    await setService("crm", "disabled");
    const hiddenAgain = await as<{ allowed: boolean }>(tenantUserId, `select public.hanafy_has_workspace_permission('${tenantWorkspaceId}', 'customers.view') as allowed`);
    expect(hiddenAgain).toEqual([{ allowed: false }]);
  });

  it("gates the legacy Wayne's RPC permission check the same way", async () => {
    const before = await as<{ allowed: boolean }>(waynesOwnerId, "select public.wayne_has_permission('pos.access') as allowed");
    expect(before).toEqual([{ allowed: true }]);

    await database.exec("begin");
    await setService("pos", "disabled", waynesWorkspaceId);
    await database.exec(`set local role authenticated; select set_config('request.jwt.claim.sub', '${waynesOwnerId}', true);`);
    const whileOff = await database.query<{ pos: boolean; kitchen: boolean; online_orders: boolean; settings: boolean }>(`
      select public.wayne_has_permission('pos.access') as pos, public.wayne_has_permission('kitchen.access') as kitchen,
             public.wayne_has_permission('orders.view') as online_orders, public.wayne_has_permission('settings.manage') as settings`);
    await database.exec("rollback");
    // POS-only permissions go; order history stays readable through online ordering; core settings never gated.
    expect(whileOff.rows).toEqual([{ pos: false, kitchen: false, online_orders: true, settings: true }]);

    const after = await as<{ allowed: boolean }>(waynesOwnerId, "select public.wayne_has_permission('pos.access') as allowed");
    expect(after).toEqual([{ allowed: true }]);
  });

  it("selects an explicit workspace for a user with several memberships and never guesses", async () => {
    await database.exec(`insert into public.workspace_members (workspace_id, auth_user_id, workspace_role_id)
      values ('${waynesWorkspaceId}', '${tenantUserId}', (select id from public.roles where code = 'cashier'))`);
    try {
      const rows = await as<{ none: unknown; waynes: { workspace_slug: string; role: string; legacy_operations: boolean }; tenant: { workspace_slug: string }; foreign: unknown; list: Array<{ slug: string }> }>(tenantUserId, `
        select public.hanafy_current_workspace_access() as none,
               public.hanafy_current_workspace_access('waynes-pizza') as waynes,
               public.hanafy_current_workspace_access('tenant-test') as tenant,
               public.hanafy_current_workspace_access('someone-else') as foreign,
               public.hanafy_my_workspaces() as list`);
      expect(rows[0]?.none).toBeNull();
      expect(rows[0]?.waynes).toMatchObject({ workspace_slug: "waynes-pizza", role: "cashier", legacy_operations: true });
      expect(rows[0]?.tenant).toMatchObject({ workspace_slug: "tenant-test" });
      expect(rows[0]?.foreign).toBeNull();
      expect(rows[0]?.list.map((workspace) => workspace.slug).sort()).toEqual(["tenant-test", "waynes-pizza"]);
    } finally {
      await database.exec(`delete from public.workspace_members where workspace_id = '${waynesWorkspaceId}' and auth_user_id = '${tenantUserId}'`);
    }
  });

  it("saves configuration only into the selected workspace", async () => {
    await database.exec(`insert into public.location_settings (location_id, workspace_id, configuration) values ('${tenantLocationId}', '${tenantWorkspaceId}', '{"store_name":"Tenant Test"}')`);
    await database.exec(`insert into public.workspace_settings (workspace_id, display_name) values ('${tenantWorkspaceId}', 'Tenant Test')`);
    // content.manage belongs to website_storefront: without it the save is refused.
    await expect(as(tenantUserId, `select public.hanafy_save_location_settings('{"store_name":"Tenant Renamed"}'::jsonb, 'tenant-test')`)).rejects.toThrow("content.manage");
    await setService("website_storefront", "enabled");
    await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${tenantUserId}', true);`);
    try {
      await database.query(`select public.hanafy_save_location_settings('{"store_name":"Tenant Renamed"}'::jsonb, 'tenant-test')`);
      await database.exec("commit");
    } catch (error) {
      await database.exec("rollback");
      throw error;
    }
    const rows = await database.query<{ workspace_id: string; store_name: string }>(
      "select workspace_id, configuration ->> 'store_name' as store_name from public.location_settings order by workspace_id",
    );
    expect(rows.rows).toContainEqual({ workspace_id: tenantWorkspaceId, store_name: "Tenant Renamed" });
    expect(rows.rows.find((row) => row.workspace_id === waynesWorkspaceId)?.store_name).not.toBe("Tenant Renamed");

    await expect(as(tenantUserId, `select public.hanafy_save_location_settings('{"store_name":"Hijack"}'::jsonb, 'waynes-pizza')`)).rejects.toThrow();
  });

  it("exposes a host's enabled services to the storefront and nothing for unknown hosts", async () => {
    const rows = await database.query<{ known: { workspace_slug: string; enabled_services: string[] }; unknown: unknown }>(
      "select public.hanafy_public_workspace('Tenant.Example:443') as known, public.hanafy_public_workspace('nobody.example') as unknown",
    );
    expect(rows.rows[0]?.known).toMatchObject({ workspace_slug: "tenant-test", enabled_services: ["pos", "website_storefront"] });
    expect(rows.rows[0]?.unknown).toBeNull();
  });

  it("refuses to record orders, rings and deliveries for a service the workspace does not have", async () => {
    const triggers = await database.query<{ table: string }>(
      "select tgrelid::regclass::text as table from pg_trigger where tgname = 'ab_hanafy_require_service' order by 1",
    );
    expect(triggers.rows.map((row) => row.table)).toEqual(["delivery_assignments", "orders", "phone_calls"]);

    await database.exec(`
      create schema guard_probe;
      create table guard_probe.orders (workspace_id uuid, source text);
      create table guard_probe.phone_calls (workspace_id uuid);
      create trigger probe before insert on guard_probe.orders for each row execute function public.hanafy_require_service_for_row();
      create trigger probe before insert on guard_probe.phone_calls for each row execute function public.hanafy_require_service_for_row();
    `);
    await database.exec(`insert into guard_probe.orders values ('${tenantWorkspaceId}', 'pos')`);
    await expect(database.exec(`insert into guard_probe.orders values ('${tenantWorkspaceId}', 'online')`)).rejects.toThrow("SERVICE_DISABLED:online_ordering");
    await expect(database.exec(`insert into guard_probe.phone_calls values ('${tenantWorkspaceId}')`)).rejects.toThrow("SERVICE_DISABLED:caller_id");
    await database.exec(`insert into guard_probe.phone_calls values ('${waynesWorkspaceId}')`);
  });

  it("holds Hanafy CRM delivery while crm is off and releases it, in order, when it is on", async () => {
    await database.exec(`
      insert into public.integration_destinations (id, endpoint_url, signing_secret, active)
      values ('hanafy', 'https://crm.example/events', repeat('s', 40), true) on conflict (id) do update set active = true;
      insert into public.integration_outbox (id, workspace_id, destination, event_type, payload)
      values ('97000000-0000-4000-8000-000000000001', '${tenantWorkspaceId}', 'hanafy', 'customer.created', '{}');
      update public.integration_outbox set status = 'delivered' where id <> '97000000-0000-4000-8000-000000000001';
    `);
    const held = await database.query<{ job: unknown }>("select public.wayne_claim_hanafy_outbox('test') as job");
    expect(held.rows[0]?.job).toBeNull();

    await setService("crm", "enabled");
    const released = await database.query<{ job: { id: string } | null }>("select public.wayne_claim_hanafy_outbox('test') as job");
    expect(released.rows[0]?.job?.id).toBe("97000000-0000-4000-8000-000000000001");
    await setService("crm", "disabled");
  });

  it("does not enrol a new Auth user in Wayne's until a Wayne's manager activates them", async () => {
    await database.exec(`insert into auth.users (id, email, email_confirmed_at) values ('${newStaffId}', 'new-staff@example.test', now())`);
    const before = await database.query("select * from public.workspace_members where auth_user_id = $1", [newStaffId]);
    expect(before.rows).toHaveLength(0);

    await database.exec(`update public.profiles set active = true where id = '${newStaffId}'`);
    const after = await database.query<{ workspace_id: string; status: string }>(
      "select workspace_id, status from public.workspace_members where auth_user_id = $1", [newStaffId],
    );
    expect(after.rows).toEqual([{ workspace_id: waynesWorkspaceId, status: "active" }]);
  });
});
