import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const phase0 = readFileSync(resolve(process.cwd(), "supabase/migrations/20260908000000_phase0_foundation.sql"), "utf8");
const phase1 = readFileSync(resolve(process.cwd(), "supabase/migrations/20261002080000_phase1_core_tenancy.sql"), "utf8");
const phase2 = readFileSync(resolve(process.cwd(), "supabase/migrations/20261003080000_phase2_waynes_operational_backfill.sql"), "utf8");

const workspaceTables = [
  "store_settings", "store_special_hours", "customers", "customer_phones", "customer_addresses", "marketing_consents",
  "promotions", "menu_categories", "menu_items", "menu_item_variants", "modifier_groups", "modifier_choices",
  "menu_item_modifier_groups", "modifier_choice_variant_prices", "menu_item_included_choices", "customer_segments",
  "customer_segment_memberships", "customer_events", "customer_segment_evaluation_runs", "order_idempotency",
  "integration_destinations", "integration_outbox", "integration_delivery_logs", "payment_provider_settings",
  "payment_webhook_events", "reward_grants", "audit_log", "orders", "order_items", "order_item_modifiers",
  "order_discounts", "order_events", "payments", "refunds", "delivery_assignments", "kitchen_tickets", "print_jobs",
  "registers", "register_shifts", "cash_movements", "payment_terminals", "store_phone_lines", "phone_calls", "pos_drafts",
  "pos_hardware_settings", "pilot_checks"
];

const locationTables = [
  "store_settings", "store_special_hours", "orders", "order_items", "order_item_modifiers", "order_discounts", "order_events",
  "payments", "refunds", "delivery_assignments", "kitchen_tickets", "print_jobs", "registers", "register_shifts",
  "cash_movements", "payment_terminals", "payment_webhook_events", "store_phone_lines", "phone_calls", "pos_drafts",
  "pos_hardware_settings", "pilot_checks", "audit_log"
];

describe("Hanafy Platform Phase 2 operational backfill", () => {
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
    await database.exec("insert into public.customers default values; insert into public.orders default values; insert into public.phone_calls default values;");
    await database.exec(phase2);
  }, 30_000);

  afterAll(async () => database.close());

  it("adds nullable workspace scope to every tenant-owned operational table", async () => {
    const result = await database.query<{ table_name: string }>(`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'workspace_id'
      order by table_name
    `);
    expect(workspaceTables.every((table) => result.rows.some((row) => row.table_name === table))).toBe(true);
  });

  it("adds location scope only to location-operational tables", async () => {
    const result = await database.query<{ table_name: string }>(`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'location_id'
      order by table_name
    `);
    expect(locationTables.every((table) => result.rows.some((row) => row.table_name === table))).toBe(true);
    expect(result.rows.some((row) => row.table_name === "customers")).toBe(false);
  });

  it("backfills existing Wayne's operational rows to its workspace and Worcester location", async () => {
    const result = await database.query<{ workspace_id: string; location_id: string }>(`
      select workspace_id, location_id from public.orders
    `);
    expect(result.rows).toEqual([{
      workspace_id: "40000000-0000-4000-8000-000000000001",
      location_id: "40000000-0000-4000-8000-000000000002"
    }]);
  });

  it("leaves the new scope columns nullable until Phase 3 authorization rollout", async () => {
    const result = await database.query<{ is_nullable: string }>(`
      select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'orders' and column_name = 'workspace_id'
    `);
    expect(result.rows).toEqual([{ is_nullable: "YES" }]);
  });
});
