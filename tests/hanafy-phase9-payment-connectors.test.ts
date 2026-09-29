import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = resolve(process.cwd(), "supabase/migrations");
const migrations = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();

const waynesWorkspaceId = "40000000-0000-4000-8000-000000000001";
const waynesLocationId = "40000000-0000-4000-8000-000000000002";
const tenantA = "97900000-0000-4000-8000-00000000000a";
const tenantALocation = "97900000-0000-4000-8000-0000000000a1";
const tenantB = "97900000-0000-4000-8000-00000000000b";
const tenantBLocation = "97900000-0000-4000-8000-0000000000b1";
const ownerA = "97900000-0000-4000-8000-000000000001";
const waynesOwner = "97900000-0000-4000-8000-000000000003";
const platformOwner = "97900000-0000-4000-8000-000000000004";

type Row = Record<string, unknown>;
type Connection = { id: string; provider: string; status: string; workspace_id: string; purpose: string; capabilities: Record<string, boolean> } | null;

describe("Hanafy Platform Phase 9 integration registry + payment connectors", () => {
  const database = new PGlite({ extensions: { pgcrypto } });

  async function as<T extends Row>(userId: string, sql: string) {
    await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${userId}', true);`);
    try {
      return (await database.query<T>(sql)).rows;
    } finally {
      await database.exec("rollback");
    }
  }

  async function commitAs<T extends Row>(userId: string, sql: string) {
    await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${userId}', true);`);
    try {
      const rows = (await database.query<T>(sql)).rows;
      await database.exec("commit");
      return rows;
    } catch (error) {
      await database.exec("rollback");
      throw error;
    }
  }

  async function one<T extends Row>(sql: string) {
    return (await database.query<T>(sql)).rows[0] as T;
  }

  const resolveFor = async (workspace: string, location: string, purpose: string) =>
    (await one<{ connection: Connection }>(`select public.hanafy_payment_connection_for('${workspace}', '${location}', '${purpose}') as connection`)).connection;

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
      insert into auth.users (id, email, email_confirmed_at) values
        ('${ownerA}', 'a@example.test', now()), ('${waynesOwner}', 'waynes@example.test', now()), ('${platformOwner}', 'platform@hanafy.test', now());
      update public.profiles set role_id = (select id from public.roles where code = 'owner'), active = true where id = '${waynesOwner}';
      insert into public.platform_users (auth_user_id, platform_role, active) values ('${platformOwner}', 'platform_owner', true);
      insert into public.workspaces (id, slug, name) values ('${tenantA}', 'pay-a', 'Pay A'), ('${tenantB}', 'pay-b', 'Pay B');
      insert into public.locations (id, workspace_id, slug, name) values ('${tenantALocation}', '${tenantA}', 'main', 'A Main'), ('${tenantBLocation}', '${tenantB}', 'main', 'B Main');
      insert into public.workspace_members (workspace_id, auth_user_id, workspace_role_id) values ('${tenantA}', '${ownerA}', (select id from public.roles where code = 'owner'));
      update public.profiles set active = true where id = '${ownerA}';
      insert into public.workspace_services (workspace_id, service_id, status, source)
      select '${tenantA}', service.id, 'enabled', 'manual' from public.service_catalog service where service.code in ('pos', 'online_ordering', 'crm');
    `);
  }, 180_000);

  afterAll(async () => database.close());

  it("records Wayne's counter as the processor's own terminal run by hand, with nothing online", async () => {
    const counter = await resolveFor(waynesWorkspaceId, waynesLocationId, "counter");
    expect(counter).toMatchObject({ provider: "manual_external", status: "manual", purpose: "counter", workspace_id: waynesWorkspaceId });
    expect(counter?.capabilities).toMatchObject({ card_present: true, card_present_integrated: false, manual_confirmation: true, online_card: false });
    expect(await resolveFor(waynesWorkspaceId, waynesLocationId, "online")).toBeNull();

    const terminal = await one<{ label: string; terminal_type: string }>(`select label, terminal_type from public.payment_terminals where workspace_id = '${waynesWorkspaceId}'`);
    expect(terminal).toEqual({ label: "Counter card terminal (Boston North)", terminal_type: "external_manual" });
    const registry = (await database.query<{ integration_type: string; provider: string; status: string }>(`
      select integration_type, provider, status from public.integration_connections where workspace_id = '${waynesWorkspaceId}' order by integration_type`)).rows;
    expect(registry).toContainEqual({ integration_type: "messaging", provider: "aws_end_user_messaging", status: "active" });
    expect(registry).toContainEqual({ integration_type: "payment", provider: "manual_external", status: "manual" });
  });

  it("resolves each business to its own provider, with no crossover (Scenario C)", async () => {
    await commitAs(platformOwner, `select public.hanafy_platform_save_payment_connection('pay-a', '${JSON.stringify({
      provider: "square", purpose: "counter_and_online", location_id: tenantALocation, environment: "sandbox", merchant_reference: "LSQ1",
      secret_reference: "env:SQUARE_PAY_A", public_configuration: { application_id: "sandbox-sq0idb-a", provider_location_id: "LSQ1", online_card_enabled: true, terminal_card_enabled: false },
    })}'::jsonb, 'Pay A signed up with Square', false)`);
    await commitAs(platformOwner, `select public.hanafy_platform_save_payment_connection('pay-b', '${JSON.stringify({
      provider: "manual_external", purpose: "counter", location_id: tenantBLocation, merchant_reference: "Local processor", terminal_label: "B terminal",
    })}'::jsonb, 'Pay B uses its own terminal', false)`);

    const a = await resolveFor(tenantA, tenantALocation, "online");
    const b = await resolveFor(tenantB, tenantBLocation, "online");
    const bCounter = await resolveFor(tenantB, tenantBLocation, "counter");
    expect(a).toMatchObject({ provider: "square", workspace_id: tenantA, status: "pending_verification" });
    expect(b).toBeNull();
    expect(bCounter).toMatchObject({ provider: "manual_external", workspace_id: tenantB });
    // Asking with another business's location never returns that business's connection.
    expect(await resolveFor(tenantB, tenantALocation, "counter")).toBeNull();
    expect(await resolveFor(tenantA, tenantBLocation, "online")).toBeNull();

    // A location of another business can't be attached.
    await expect(commitAs(platformOwner, `select public.hanafy_platform_save_payment_connection('pay-a', '{"provider":"manual_external","purpose":"counter","location_id":"${tenantBLocation}"}'::jsonb, 'wrong location test', false)`))
      .rejects.toThrow("That location does not belong");
  });

  it("never shows a connection connected without a real test, and never fakes a planned provider", async () => {
    const a = await one<{ id: string }>(`select id from public.payment_connections where workspace_id = '${tenantA}'`);
    await expect(commitAs(platformOwner, `select public.hanafy_platform_save_payment_connection('pay-a', '{"id":"${a.id}","status":"connected"}'::jsonb, 'force connected', true)`))
      .rejects.toThrow("shows connected only after");
    await expect(database.exec(`update public.payment_connections set status = 'connected' where id = '${a.id}'`)).rejects.toThrow("check");
    await expect(commitAs(platformOwner, `select public.hanafy_platform_save_payment_connection('pay-a', '{"provider":"worldpay","purpose":"online","status":"pending_verification"}'::jsonb, 'try worldpay', true)`))
      .rejects.toThrow("is planned, not built");

    const checked = await one<{ result: { status: string } }>(`select public.hanafy_payment_connection_record_check('${a.id}', true, 'Square location is active (sandbox).') as result`);
    expect(checked.result.status).toBe("connected");
    const registry = await one<{ status: string; verified: boolean }>(`select status, verified_at is not null as verified from public.integration_connections where source_id = '${a.id}'`);
    expect(registry).toEqual({ status: "connected", verified: true });
    const audit = await one<{ count: number }>(`select count(*)::int as count from public.platform_audit_log where action = 'platform.payment_connection.tested' and workspace_id = '${tenantA}'`);
    expect(audit.count).toBe(1);

    // Changing the setup makes it unverified again.
    await commitAs(platformOwner, `select public.hanafy_platform_save_payment_connection('pay-a', '{"id":"${a.id}","merchant_reference":"LSQ2"}'::jsonb, 'moved to a new Square location', false)`);
    const after = await one<{ status: string; verified_at: string | null }>(`select status, verified_at from public.payment_connections where id = '${a.id}'`);
    expect(after).toEqual({ status: "pending_verification", verified_at: null });
  });

  it("refuses raw card data anywhere it could be stored", async () => {
    await expect(commitAs(platformOwner, `select public.hanafy_platform_save_payment_connection('pay-b', '{"provider":"square","purpose":"online","public_configuration":{"card_number":"x"}}'::jsonb, 'card data test', true)`))
      .rejects.toThrow("CARD_DATA_REFUSED");
    await expect(commitAs(platformOwner, `select public.hanafy_platform_save_payment_connection('pay-b', '{"provider":"square","purpose":"online","public_configuration":{"note":"4111 1111 1111 1111"}}'::jsonb, 'card data test', true)`))
      .rejects.toThrow("CARD_DATA_REFUSED");
    const order = await one<{ id: string | null }>(`select id from public.orders limit 1`);
    if (order?.id) {
      await expect(database.exec(`insert into public.payments (order_id, provider, method, amount_cents, status, metadata) values ('${order.id}', 'manual', 'card', 100, 'pending', '{"cvv":"123"}'::jsonb)`)).rejects.toThrow("CARD_DATA_REFUSED");
    }
    const problem = await one<{ a: string | null; b: string | null; c: string | null }>(`
      select public.hanafy_card_data_problem('{"card_last4":"1111","card_brand":"VISA","order_number":"W001008","epoch":"1727550000000"}'::jsonb) as a,
             public.hanafy_card_data_problem('{"payment":{"track2":"x"}}'::jsonb) as b,
             public.hanafy_card_data_problem('["5555555555554444"]'::jsonb) as c`);
    expect(problem.a).toBeNull();
    expect(problem.b).toContain("card data");
    expect(problem.c).toContain("card number");
  });

  it("keeps payment secrets and webhook keys out of browsers and other businesses", async () => {
    await expect(as(ownerA, `select webhook_key from public.payment_connections`)).rejects.toThrow("permission denied");
    const [own] = await as<{ count: number }>(ownerA, `select count(*)::int as count from public.integration_connections where workspace_id = '${tenantA}'`);
    const [other] = await as<{ count: number }>(ownerA, `select count(*)::int as count from public.integration_connections where workspace_id <> '${tenantA}'`);
    expect(own?.count).toBeGreaterThan(0);
    expect(other?.count).toBe(0);
    await expect(as(ownerA, `select public.hanafy_payment_connection_for('${tenantB}', '${tenantBLocation}', 'counter')`)).rejects.toThrow("permission denied");
    await expect(as(ownerA, `select public.hanafy_platform_save_payment_connection('pay-a', '{"provider":"manual_external","purpose":"counter"}'::jsonb, 'owner tries it', true)`))
      .rejects.toThrow("Hanafy platform access required");

    const [summary] = await as<{ summary: Array<Record<string, unknown>> }>(ownerA, `select public.hanafy_payment_connections_summary('pay-a') as summary`);
    expect(summary?.summary).toHaveLength(1);
    expect(summary?.summary[0]).not.toHaveProperty("webhook_key");
    expect(summary?.summary[0]).not.toHaveProperty("secret_reference");
  });

  it("routes a webhook by its connection key into that connection's business, once", async () => {
    const a = await one<{ id: string; webhook_key: string }>(`select id, webhook_key from public.payment_connections where workspace_id = '${tenantA}'`);
    const found = await one<{ connection: Connection }>(`select public.hanafy_payment_connection_by_webhook_key('${a.webhook_key}') as connection`);
    expect(found.connection).toMatchObject({ id: a.id, workspace_id: tenantA });
    const first = await one<{ result: { duplicate: boolean } }>(`select public.hanafy_record_payment_webhook('${a.id}', '{"event_id":"sq-evt-1","event_type":"payment.updated","signature_verified":true,"payload":{"id":"x"}}'::jsonb) as result`);
    const again = await one<{ result: { duplicate: boolean } }>(`select public.hanafy_record_payment_webhook('${a.id}', '{"event_id":"sq-evt-1","event_type":"payment.updated","signature_verified":true,"payload":{"id":"x"}}'::jsonb) as result`);
    expect(first.result.duplicate).toBe(false);
    expect(again.result.duplicate).toBe(true);
    const stored = await one<{ workspace_id: string; location_id: string }>(`select workspace_id, location_id from public.payment_webhook_events where event_id = 'sq-evt-1'`);
    expect(stored).toEqual({ workspace_id: tenantA, location_id: tenantALocation });
  });

  it("keeps the old Square settings screen and the connection in step", async () => {
    await database.exec(`
      update public.location_payment_configurations
      set provider = 'square', application_id = 'sandbox-sq0idb-w', provider_location_id = 'LWAYNE', environment = 'sandbox'
      where location_id = '${waynesLocationId}'`);
    const square = await one<{ purpose: string; status: string; merchant_reference: string; secret_reference: string }>(`
      select purpose, status, merchant_reference, secret_reference from public.payment_connections where workspace_id = '${waynesWorkspaceId}' and provider = 'square'`);
    expect(square).toEqual({ purpose: "online", status: "pending_verification", merchant_reference: "LWAYNE", secret_reference: "env:SQUARE" });
    const counter = await resolveFor(waynesWorkspaceId, waynesLocationId, "counter");
    expect(counter?.provider).toBe("manual_external");
    await database.exec(`update public.location_payment_configurations set provider = 'none', application_id = '', provider_location_id = '' where location_id = '${waynesLocationId}'`);
    expect(await resolveFor(waynesWorkspaceId, waynesLocationId, "online")).toBeNull();
  });
});
