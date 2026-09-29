import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = resolve(process.cwd(), "supabase/migrations");
const migrations = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();
const workspaceId = "81000000-0000-4000-8000-000000000001";
const locationId = "81000000-0000-4000-8000-000000000002";

describe("Hanafy Platform Phase 4 workspace/location configuration", () => {
  const database = new PGlite({ extensions: { pgcrypto } });

  beforeAll(async () => {
    await database.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}'::jsonb);
      create schema storage;
      create table storage.buckets(id text primary key, name text not null, public boolean not null default false, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text not null);
    `);
    for (const migration of migrations) await database.exec(readFileSync(resolve(directory, migration), "utf8"));
    await database.exec(`
      insert into public.workspaces (id, slug, name, timezone, currency_code)
      values ('${workspaceId}', 'configuration-test', 'Configuration Test', 'America/Chicago', 'USD');
      insert into public.locations (id, workspace_id, slug, name, timezone)
      values ('${locationId}', '${workspaceId}', 'main', 'Test Main', 'America/Chicago');
      insert into public.workspace_settings (workspace_id, display_name) values ('${workspaceId}', 'Configuration Test');
      insert into public.location_settings (location_id, workspace_id, configuration)
      values ('${locationId}', '${workspaceId}', jsonb_build_object(
        'store_name', 'Configuration Test Store', 'timezone', 'America/Chicago', 'ordering_open', false,
        'business_hours', '{}'::jsonb, 'tax_rate_basis_points', 875, 'delivery_fee_cents', 299
      ));
      insert into public.workspace_domains (workspace_id, location_id, hostname, is_canonical)
      values ('${workspaceId}', '${locationId}', 'configuration-test.example', true);
      insert into public.location_payment_configurations (location_id, workspace_id, provider, environment, application_id, provider_location_id, online_card_enabled)
      values ('${locationId}', '${workspaceId}', 'square', 'sandbox', 'app-test', 'location-test', true);
      insert into public.location_hardware_configurations (location_id, workspace_id, configuration)
      values ('${locationId}', '${workspaceId}', '{"caller_line_count":4,"caller_udp_port":4555}'::jsonb);
      insert into public.location_caller_lines (workspace_id, location_id, line_number, label)
      values ('${workspaceId}', '${locationId}', 1, 'Main line'), ('${workspaceId}', '${locationId}', 2, 'Overflow line');
    `);
  }, 120_000);

  afterAll(async () => database.close());

  it("resolves a configured tenant by hostname and exposes its changed operational settings", async () => {
    const result = await database.query<{ settings: Record<string, unknown> }>(
      "select public.hanafy_public_store_settings('configuration-test.example') as settings",
    );
    expect(result.rows[0]?.settings).toMatchObject({
      store_name: "Configuration Test Store",
      timezone: "America/Chicago",
      ordering_open: false,
      tax_rate_basis_points: 875,
      delivery_fee_cents: 299,
      canonical_url: "https://configuration-test.example",
    });
  });

  it("fails closed for an unknown hostname instead of falling back to Wayne's", async () => {
    const result = await database.query<{ settings: Record<string, unknown> | null }>(
      "select public.hanafy_public_store_settings('unknown.example') as settings",
    );
    expect(result.rows).toEqual([{ settings: null }]);
  });

  it("stores payment, hardware, and caller-line configuration independently per location", async () => {
    const result = await database.query<{ provider: string; lines: number; port: number }>(`
      select payment.provider, count(line.id)::int as lines, (hardware.configuration ->> 'caller_udp_port')::int as port
      from public.location_payment_configurations payment
      join public.location_hardware_configurations hardware on hardware.location_id = payment.location_id
      left join public.location_caller_lines line on line.location_id = payment.location_id
      where payment.location_id = '${locationId}'
      group by payment.provider, hardware.configuration
    `);
    expect(result.rows).toEqual([{ provider: "square", lines: 2, port: 4555 }]);
  });
});
