import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = resolve(process.cwd(), "supabase/migrations");
const migrations = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();

const waynesOwner = "98200000-0000-4000-8000-000000000003";
const platformOwner = "98200000-0000-4000-8000-000000000004";
const platformSupport = "98200000-0000-4000-8000-000000000005";
const newOwner = "98200000-0000-4000-8000-000000000006";

type Row = Record<string, unknown>;
type Checklist = { status: string; is_test: boolean; can_activate: boolean; blocking: string[]; items: { key: string; status: string; required: boolean }[] };

describe("Hanafy Platform Phase 12 Add Business provisioning", () => {
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

  const json = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  const testBusiness = {
    business: { name: "Test Deli", slug: "test-deli", timezone: "America/New_York", currency_code: "USD", industry: "restaurant", contact_name: "Pat Tester", contact_email: "pat@example.test", is_test: true },
    location: { name: "Main Street", address_line_1: "1 Main St", city: "Worcester", state_region: "MA", postal_code: "01609", phone: "(508) 555-0100", email: "hello@example.test", hours: { open: "10:00", close: "20:00", closed_days: ["sunday"] } },
    services: ["pos", "crm", "caller_id"],
  };
  const provision = (payload: unknown, user = platformOwner, reason = "Developer test workspace") =>
    commitAs<{ result: { slug: string; workspace_id: string } }>(user, `select public.hanafy_platform_provision_workspace(${json(payload)}, '${reason}') as result`);
  const setup = async (slug = "test-deli") =>
    (await commitAs<{ data: Checklist }>(platformOwner, `select public.hanafy_platform_workspace_setup('${slug}') as data`))[0]!.data;
  const setStatus = (status: string, confirmed = false, slug = "test-deli", user = platformOwner) =>
    commitAs<{ result: { status: string; warnings?: string[] } }>(user, `select public.hanafy_platform_set_workspace_status('${slug}', '${status}', 'Checklist complete', ${confirmed}) as result`);

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
        ('${waynesOwner}', 'waynes@example.test', now()), ('${platformOwner}', 'platform@hanafy.test', now()),
        ('${platformSupport}', 'support@hanafy.test', now()), ('${newOwner}', 'pat@example.test', now());
      update public.profiles set role_id = (select id from public.roles where code = 'owner'), active = true where id = '${waynesOwner}';
      insert into public.platform_users (auth_user_id, platform_role, active) values ('${platformOwner}', 'platform_owner', true), ('${platformSupport}', 'platform_support', true);
    `);
  }, 180_000);

  afterAll(async () => database.close());

  it("creates a test workspace without SQL, in provisioning, with only the services picked", async () => {
    const [created] = await provision(testBusiness);
    expect(created!.result.slug).toBe("test-deli");
    const workspace = (await database.query<{ status: string; is_test: boolean; timezone: string }>("select status, is_test, timezone from public.workspaces where slug = 'test-deli'")).rows[0];
    expect(workspace).toEqual({ status: "provisioning", is_test: true, timezone: "America/New_York" });
    const services = (await database.query<{ code: string }>(`select service.code from public.workspace_services ws join public.service_catalog service on service.id = ws.service_id
      where ws.workspace_id = '${created!.result.workspace_id}' and ws.status = 'enabled' order by service.code`)).rows.map((row) => row.code);
    expect(services).toEqual(["caller_id", "crm", "pos"]);
    const location = (await database.query<{ status: string; hours: { sunday: { closed: boolean }; monday: { open: string } } }>(`select location.status, settings.configuration -> 'business_hours' as hours
      from public.locations location join public.location_settings settings on settings.location_id = location.id where location.workspace_id = '${created!.result.workspace_id}'`)).rows[0];
    expect(location).toMatchObject({ status: "provisioning", hours: { sunday: { closed: true }, monday: { open: "10:00" } } });
    expect((await database.query(`select 1 from public.location_hardware_configurations where workspace_id = '${created!.result.workspace_id}'`)).rows).toHaveLength(1);
    expect((await database.query(`select 1 from public.location_caller_lines where workspace_id = '${created!.result.workspace_id}'`)).rows).toHaveLength(1);
    const audit = await database.query<{ summary: string }>("select summary from public.platform_audit_log where action = 'platform.workspace.provisioned'");
    expect(audit.rows[0]?.summary).toContain("[TEST]");
  });

  it("refuses bad or taken names, missing requirements and non-admins", async () => {
    await expect(provision({ ...testBusiness })).rejects.toThrow("already uses the web name");
    await expect(provision({ ...testBusiness, business: { ...testBusiness.business, slug: "platform" } })).rejects.toThrow("reserved");
    await expect(provision({ ...testBusiness, business: { ...testBusiness.business, slug: "Bad Slug" } })).rejects.toThrow("lowercase");
    await expect(provision({ ...testBusiness, business: { ...testBusiness.business, slug: "sms-only" }, services: ["sms"] })).rejects.toThrow("needs CRM");
    await expect(provision({ ...testBusiness, business: { ...testBusiness.business, slug: "tz-bad", timezone: "Mars/Olympus" } })).rejects.toThrow("Unknown time zone");
    await expect(provision({ ...testBusiness, business: { ...testBusiness.business, slug: "by-support" } }, platformSupport)).rejects.toThrow("platform access required");
    await expect(provision({ ...testBusiness, business: { ...testBusiness.business, slug: "by-owner" } }, waynesOwner)).rejects.toThrow("platform access required");
  });

  it("will not go live until every required check passes", async () => {
    let checklist = await setup();
    expect(checklist.can_activate).toBe(false);
    expect(checklist.blocking).toEqual(expect.arrayContaining(["Owner account", "Caller-ID box recorded and serving a line"]));
    await expect(setStatus("active", true)).rejects.toThrow("Not ready to go live");

    await commitAs(platformOwner, `select public.hanafy_platform_set_member('test-deli', 'pat@example.test', 'owner', 'active', 'Owner for the test deli')`);
    await commitAs(platformOwner, `select public.hanafy_platform_save_hardware_device('test-deli', ${json({ device_type: "caller_id", name: "Caller ID box", monitoring: "telemetry", caller_lines: [1] })}, 'Test caller ID box')`);
    checklist = await setup();
    expect(checklist.items.find((item) => item.key === "owner")?.status).toBe("pass");
    expect(checklist.items.find((item) => item.key === "access")?.status).toBe("pass");
    expect(checklist.items.find((item) => item.key === "caller_id")?.status).toBe("pass");
    expect(checklist.can_activate).toBe(true);

    // Test workspaces go live without the extra confirmation.
    expect((await setStatus("active"))[0]!.result.status).toBe("saved");
    const live = (await database.query<{ status: string; location_status: string }>(`select workspace.status, location.status as location_status
      from public.workspaces workspace join public.locations location on location.workspace_id = workspace.id where workspace.slug = 'test-deli'`)).rows[0];
    expect(live).toEqual({ status: "active", location_status: "active" });
  });

  it("gives the new owner exactly this business and its services", async () => {
    const access = await as<{ data: { workspace_slug: string; enabled_services: string[]; role: string } }>(newOwner, "select public.hanafy_current_workspace_access('test-deli') as data");
    expect(access[0]!.data).toMatchObject({ workspace_slug: "test-deli", role: "owner" });
    expect([...access[0]!.data.enabled_services].sort()).toEqual(["caller_id", "crm", "pos"]);
    const waynes = await as<{ data: unknown }>(newOwner, "select public.hanafy_current_workspace_access('waynes-pizza') as data");
    expect(waynes[0]!.data).toBeNull();
    const orders = await as<{ id: string }>(newOwner, "select id from public.orders");
    expect(orders).toHaveLength(0);
  });

  it("suspends and archives with confirmation, and never archives Wayne's", async () => {
    const first = await setStatus("suspended");
    expect(first[0]!.result.status).toBe("needs_confirmation");
    await setStatus("suspended", true);
    await setStatus("archived", true);
    const row = (await database.query<{ status: string; domains: number }>(`select status, (select count(*)::int from public.workspace_domains domain where domain.workspace_id = workspace.id and domain.active) as domains
      from public.workspaces workspace where slug = 'test-deli'`)).rows[0];
    expect(row).toEqual({ status: "archived", domains: 0 });
    await expect(setStatus("active", true)).rejects.toThrow("stays archived");
    await expect(setStatus("archived", true, "waynes-pizza")).rejects.toThrow("cannot be archived");
    expect((await database.query<{ status: string }>("select status from public.workspaces where slug = 'waynes-pizza'")).rows[0]?.status).toBe("active");
    const audit = await database.query<{ action: string }>("select action from public.platform_audit_log where action like 'platform.workspace.%' order by id");
    expect(audit.rows.map((entry) => entry.action)).toEqual(["platform.workspace.provisioned", "platform.workspace.activated", "platform.workspace.suspended", "platform.workspace.archived"]);
  });
});
