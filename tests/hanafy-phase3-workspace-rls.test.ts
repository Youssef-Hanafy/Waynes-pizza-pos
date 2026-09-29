import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const phase0 = readFileSync(resolve(process.cwd(), "supabase/migrations/20260908000000_phase0_foundation.sql"), "utf8");
const phase1 = readFileSync(resolve(process.cwd(), "supabase/migrations/20261002080000_phase1_core_tenancy.sql"), "utf8");
const phase2 = readFileSync(resolve(process.cwd(), "supabase/migrations/20261003080000_phase2_waynes_operational_backfill.sql"), "utf8");
const phase3 = readFileSync(resolve(process.cwd(), "supabase/migrations/20261004080000_phase3_workspace_rls_hardening.sql"), "utf8");

const workspaceTables = [
  "store_settings", "store_special_hours", "customers", "customer_phones", "customer_addresses", "marketing_consents",
  "promotions", "menu_categories", "menu_items", "menu_item_variants", "modifier_groups", "modifier_choices",
  "menu_item_modifier_groups", "modifier_choice_variant_prices", "menu_item_included_choices", "customer_segments",
  "customer_segment_memberships", "customer_events", "customer_segment_evaluation_runs", "order_idempotency",
  "integration_destinations", "integration_outbox", "integration_delivery_logs", "payment_provider_settings",
  "payment_webhook_events", "reward_grants", "audit_log", "orders", "order_items", "order_item_modifiers",
  "order_discounts", "order_events", "payments", "refunds", "delivery_assignments", "kitchen_tickets", "print_jobs",
  "registers", "register_shifts", "cash_movements", "payment_terminals", "store_phone_lines", "phone_calls", "pos_drafts",
  "pos_hardware_settings", "pilot_checks",
];

const tenantAUserId = "70000000-0000-4000-8000-000000000001";
const tenantBUserId = "70000000-0000-4000-8000-000000000002";
const tenantAWorkspaceId = "71000000-0000-4000-8000-000000000001";
const tenantBWorkspaceId = "72000000-0000-4000-8000-000000000001";
const tenantALocationId = "71000000-0000-4000-8000-000000000002";
const tenantBLocationId = "72000000-0000-4000-8000-000000000002";

describe("Hanafy Platform Phase 3 cross-tenant RLS", () => {
  const database = new PGlite();

  beforeAll(async () => {
    await database.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}'::jsonb);
    `);
    await database.exec(phase0);
    await database.exec(phase1);
    await database.exec(workspaceTables.map((table) => `
      create table public.${table} (
        id uuid primary key default gen_random_uuid(),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        started_at timestamptz not null default now(),
        occurred_at timestamptz not null default now()
      );
    `).join("\n"));
    await database.exec(phase2);

    await database.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values
        ('${tenantAUserId}', 'tenant-a@example.test', '{"display_name":"Tenant A Owner"}'),
        ('${tenantBUserId}', 'tenant-b@example.test', '{"display_name":"Tenant B Owner"}');
      update public.profiles set role_id = (select id from public.roles where code = 'owner')
      where id in ('${tenantAUserId}', '${tenantBUserId}');
      insert into public.workspaces (id, slug, name) values
        ('${tenantAWorkspaceId}', 'tenant-a', 'Tenant A'),
        ('${tenantBWorkspaceId}', 'tenant-b', 'Tenant B');
      insert into public.locations (id, workspace_id, slug, name) values
        ('${tenantALocationId}', '${tenantAWorkspaceId}', 'main', 'Tenant A Main'),
        ('${tenantBLocationId}', '${tenantBWorkspaceId}', 'main', 'Tenant B Main');
      insert into public.workspace_members (workspace_id, auth_user_id, workspace_role_id) values
        ('${tenantAWorkspaceId}', '${tenantAUserId}', (select id from public.roles where code = 'owner')),
        ('${tenantBWorkspaceId}', '${tenantBUserId}', (select id from public.roles where code = 'owner'));
      insert into public.permissions (code, description) values
        ('customers.view', 'View workspace customers'),
        ('orders.view', 'View workspace orders');
      insert into public.role_permissions (role_id, permission_id)
      select role.id, permission.id from public.roles role cross join public.permissions permission
      where role.code = 'owner' and permission.code in ('customers.view', 'orders.view');
    `);
    await database.exec(phase3);
    await database.exec(`
      delete from public.workspace_members
      where workspace_id = '40000000-0000-4000-8000-000000000001'
        and auth_user_id in ('${tenantAUserId}', '${tenantBUserId}');
      insert into public.customers (id, workspace_id) values
        ('73000000-0000-4000-8000-000000000001', '${tenantAWorkspaceId}'),
        ('73000000-0000-4000-8000-000000000002', '${tenantBWorkspaceId}');
      insert into public.orders (id, workspace_id, location_id) values
        ('74000000-0000-4000-8000-000000000001', '${tenantAWorkspaceId}', '${tenantALocationId}'),
        ('74000000-0000-4000-8000-000000000002', '${tenantBWorkspaceId}', '${tenantBLocationId}');
      insert into public.integration_outbox (id, workspace_id) values
        ('75000000-0000-4000-8000-000000000001', '${tenantAWorkspaceId}'),
        ('75000000-0000-4000-8000-000000000002', '${tenantBWorkspaceId}');
    `);
  }, 30_000);

  afterAll(async () => database.close());

  it("keeps Tenant B customer and order data invisible to Tenant A", async () => {
    await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${tenantAUserId}', true);`);
    const [customers, orders] = await Promise.all([
      database.query<{ count: number }>("select count(*)::int as count from public.customers"),
      database.query<{ count: number }>("select count(*)::int as count from public.orders"),
    ]);
    await database.exec("rollback");

    expect(customers.rows).toEqual([{ count: 1 }]);
    expect(orders.rows).toEqual([{ count: 1 }]);
  });

  it("rejects a Tenant A write that targets Tenant B", async () => {
    await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${tenantAUserId}', true);`);
    await expect(database.exec(`
      insert into public.store_settings (workspace_id, location_id)
      values ('${tenantBWorkspaceId}', '${tenantBLocationId}')
    `)).rejects.toThrow();
    await database.exec("rollback");
  });

  it("does not grant legacy Wayne RPC authorization to another tenant", async () => {
    await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${tenantBUserId}', true);`);
    const result = await database.query<{ allowed: boolean }>("select public.wayne_has_permission('settings.manage') as allowed");
    await database.exec("rollback");
    expect(result.rows).toEqual([{ allowed: false }]);
  });
});
