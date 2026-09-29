import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = resolve(process.cwd(), "supabase/migrations");
const migrations = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();

const waynesWorkspaceId = "40000000-0000-4000-8000-000000000001";
const waynesLocationId = "40000000-0000-4000-8000-000000000002";
const tenantA = "98000000-0000-4000-8000-00000000000a";
const tenantALocation = "98000000-0000-4000-8000-0000000000a1";
const ownerA = "98000000-0000-4000-8000-000000000001";
const waynesOwner = "98000000-0000-4000-8000-000000000003";
const platformOwner = "98000000-0000-4000-8000-000000000004";
const platformSupport = "98000000-0000-4000-8000-000000000005";

// Wayne's real Admin → Hardware settings (2026-09-28).
const waynesConfig = {
  caller_id_provider: "simulated",
  caller_device_model: "CallerID.com Whozz Calling? Basic POS 2 Ethernet",
  caller_line_count: 2,
  caller_udp_port: 3520,
  caller_bind_address: "0.0.0.0",
  caller_device_ip: "",
  call_expire_minutes: 10,
  simulator_enabled: true,
  receipt_printer: { ip: "10.10.10.161", mac: "50:57:9C:06:47:43", name: "Front counter", port: 9100, model: "Epson TM-T20III L (M352A), Ethernet", enabled: true, protocol: "escpos", model_key: "epson-tm-t20iii", paper_width_mm: 80 },
  kitchen_printers: [{ ip: "10.10.10.171", mac: "50:57:9C:58:F4:CE", name: "Kitchen", port: 9100, model: "Epson TM-U220B (M188B) + UB-E04 Ethernet", enabled: true, protocol: "escpos", model_key: "epson-tm-u220b", paper_width_mm: 76, routing_categories: [] }],
  cash_drawer: { model: "Cash drawer on the TM-T20III DK port", connection: "receipt_printer" },
  payment_terminal_mode: "manual_external",
};

type Row = Record<string, unknown>;
type Device = { id: string; device_type: string; name: string; status: string; health: string; ownership_type: string; ip_address: string | null; managed_by_settings: boolean; caller_lines: { line_number: number }[]; payment_terminal: { label: string } | null; notes: string | null; serial_number: string | null };

describe("Hanafy Platform Phase 10 hardware / device administration", () => {
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

  const one = async <T extends Row>(sql: string) => (await database.query<T>(sql)).rows[0] as T;
  const hardware = async (slug = "waynes-pizza") =>
    (await commitAs<{ data: { devices: Device[]; counts: Record<string, number>; can_manage: boolean } }>(platformOwner, `select public.hanafy_platform_workspace_hardware('${slug}') as data`))[0]!.data;
  const byType = async (type: string) => (await hardware()).devices.filter((device) => device.device_type === type);
  const save = (payload: Record<string, unknown>, reason = "Recording store hardware", user = platformOwner, slug = "waynes-pizza") =>
    commitAs<{ result: { status: string; id: string } }>(user, `select public.hanafy_platform_save_hardware_device('${slug}', '${JSON.stringify(payload).replaceAll("'", "''")}'::jsonb, '${reason}') as result`);

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
        ('${ownerA}', 'a@example.test', now()), ('${waynesOwner}', 'waynes@example.test', now()),
        ('${platformOwner}', 'platform@hanafy.test', now()), ('${platformSupport}', 'support@hanafy.test', now());
      update public.profiles set role_id = (select id from public.roles where code = 'owner'), active = true where id = '${waynesOwner}';
      insert into public.platform_users (auth_user_id, platform_role, active) values ('${platformOwner}', 'platform_owner', true), ('${platformSupport}', 'platform_support', true);
      insert into public.workspaces (id, slug, name) values ('${tenantA}', 'hw-a', 'HW A');
      insert into public.locations (id, workspace_id, slug, name) values ('${tenantALocation}', '${tenantA}', 'main', 'A Main');
      insert into public.workspace_members (workspace_id, auth_user_id, workspace_role_id) values ('${tenantA}', '${ownerA}', (select id from public.roles where code = 'owner'));
      update public.profiles set active = true where id = '${ownerA}';
      insert into public.workspace_services (workspace_id, service_id, status, source)
      select '${tenantA}', service.id, 'enabled', 'manual' from public.service_catalog service where service.code in ('pos', 'hardware_management');
      update public.location_hardware_configurations set configuration = '${JSON.stringify(waynesConfig)}'::jsonb where location_id = '${waynesLocationId}';
    `);
  }, 180_000);

  afterAll(async () => database.close());

  it("represents Wayne's known hardware in Platform Admin", async () => {
    const data = await hardware();
    const types = data.devices.map((device) => device.device_type).sort();
    expect(types).toEqual(["access_point", "caller_id", "cash_drawer", "kitchen_printer", "payment_terminal", "receipt_printer", "router"]);

    const [receipt] = await byType("receipt_printer");
    expect(receipt).toMatchObject({ name: "Front counter", ip_address: "10.10.10.161", ownership_type: "customer_owned", managed_by_settings: true, status: "active" });
    const [kitchen] = await byType("kitchen_printer");
    expect(kitchen).toMatchObject({ name: "Kitchen", ip_address: "10.10.10.171" });
    const [caller] = await byType("caller_id");
    expect(caller?.caller_lines.map((line) => line.line_number)).toEqual([1, 2]);
    const [terminal] = await byType("payment_terminal");
    expect(terminal?.payment_terminal?.label).toBe("Counter card terminal (Boston North)");
    const terminalRow = await one<{ linked: boolean }>(`select hardware_device_id is not null as linked from public.payment_terminals where workspace_id = '${waynesWorkspaceId}'`);
    expect(terminalRow.linked).toBe(true);
    expect(data.can_manage).toBe(true);
  });

  it("never shows a device live just because it has a row", async () => {
    const health = Object.fromEntries((await hardware()).devices.map((device) => [device.device_type, device.health]));
    expect(health).toMatchObject({ router: "not_monitored", access_point: "not_monitored", payment_terminal: "not_monitored", caller_id: "unknown", receipt_printer: "unknown" });

    // A heartbeat for an unmonitored device is ignored.
    const [router] = await byType("router");
    const ignored = await one<{ result: { recorded: boolean } }>(`select public.hanafy_hardware_heartbeat('${router!.id}', true, null) as result`);
    expect(ignored.result.recorded).toBe(false);
    expect((await byType("router"))[0]?.health).toBe("not_monitored");

    // A simulated ring proves nothing; a real one does, and it lands on its line.
    await database.exec(`insert into public.phone_calls (line_number, caller_number, simulated, workspace_id, location_id) values (1, '+15085550199', true, '${waynesWorkspaceId}', '${waynesLocationId}')`);
    expect((await byType("caller_id"))[0]?.health).toBe("unknown");
    await database.exec(`insert into public.phone_calls (line_number, caller_number, simulated, workspace_id, location_id) values (2, '+15085550198', false, '${waynesWorkspaceId}', '${waynesLocationId}')`);
    expect((await byType("caller_id"))[0]?.health).toBe("ok");
    const call = await one<{ line: number }>(`select line.line_number as line from public.phone_calls call join public.location_caller_lines line on line.id = call.phone_line_id where call.caller_number = '+15085550198'`);
    expect(call.line).toBe(2);
  });

  it("learns printer health from real print jobs", async () => {
    const order = await one<{ id: string }>(`insert into public.orders(order_number, source, fulfillment_type, status, payment_status, payment_method, customer_name_snapshot, customer_phone_snapshot, placed_at, idempotency_key, pricing_snapshot, subtotal_cents, total_cents, workspace_id, location_id)
      values ('HW-1', 'pos', 'pickup', 'completed', 'paid', 'cash', 'Rita', '5085550100', now(), 'phase10-hw-order-1', '{}'::jsonb, 1500, 1605, '${waynesWorkspaceId}', '${waynesLocationId}') returning id`);
    const job = await one<{ id: string }>(`insert into public.print_jobs (order_id, destination, job_type, payload, workspace_id, location_id) values ('${order.id}', 'kitchen', 'kitchen_ticket', '{}'::jsonb, '${waynesWorkspaceId}', '${waynesLocationId}') returning id`);
    await database.exec(`update public.print_jobs set status = 'failed', last_error = 'Printer did not answer at 10.10.10.171:9100' where id = '${job.id}'`);
    const [kitchen] = await byType("kitchen_printer");
    expect(kitchen?.health).toBe("error");
    const health = await one<{ summary: { hardware: { problems: number }; health: { issues: { code: string }[] } } }>(`select public.hanafy_platform_workspace_summary('${waynesWorkspaceId}') as summary`);
    expect(health.summary.hardware.problems).toBe(1);
    expect(health.summary.health.issues.map((issue) => issue.code)).toContain("hardware_error");

    await database.exec(`update public.print_jobs set status = 'printed', printed_at = now(), last_error = null where id = '${job.id}'`);
    expect((await byType("kitchen_printer"))[0]?.health).toBe("ok");
    expect((await byType("receipt_printer"))[0]?.health).toBe("unknown");
  });

  it("follows Admin → Hardware and keeps what only the registry knows", async () => {
    const [receipt] = await byType("receipt_printer");
    await save({ id: receipt!.id, serial_number: "X5E1234567", asset_tag: "WP-001" });
    await database.exec(`update public.location_hardware_configurations set configuration = jsonb_set(configuration, '{receipt_printer,ip}', '"10.10.10.162"') where location_id = '${waynesLocationId}'`);
    const [moved] = await byType("receipt_printer");
    expect(moved).toMatchObject({ ip_address: "10.10.10.162", serial_number: "X5E1234567", id: receipt!.id });

    // The legacy settings row (what the old screens save) flows through too.
    await database.exec(`update public.pos_hardware_settings set cash_drawer = '{"connection":"none","model":""}'::jsonb where location_id = '${waynesLocationId}'`);
    expect((await byType("cash_drawer"))[0]?.status).toBe("inactive");
    await database.exec(`update public.location_hardware_configurations set configuration = jsonb_set(configuration, '{receipt_printer,ip}', '"10.10.10.161"') where location_id = '${waynesLocationId}'`);
  });

  it("adds, changes and retires devices only for Hanafy admins, audited, with no secrets", async () => {
    const created = await save({ device_type: "pos_tablet", name: "Front counter tablet", vendor: "Samsung", model: "Galaxy Tab A9+", ownership_type: "hanafy_owned", connection_type: "wifi", ip_address: "10.10.10.50", monitoring: "telemetry", assigned_service: "pos" }, "Hanafy supplied the counter tablet");
    const id = created[0]!.result.id;
    const audit = await one<{ count: number }>(`select count(*)::int as count from public.platform_audit_log where action = 'platform.hardware.created' and resource_id = '${id}'`);
    expect(audit.count).toBe(1);
    const businessAudit = await one<{ count: number }>(`select count(*)::int as count from public.audit_log where action = 'platform.hardware.created' and workspace_id = '${waynesWorkspaceId}'`);
    expect(businessAudit.count).toBe(1);

    // Heartbeat → ok; retire → off.
    await database.exec(`select public.hanafy_hardware_heartbeat('${id}', true, null)`);
    expect((await byType("pos_tablet"))[0]?.health).toBe("ok");
    await save({ id, status: "retired" }, "Tablet replaced under warranty");
    const retired = (await byType("pos_tablet"))[0];
    expect(retired).toMatchObject({ status: "retired", health: "off" });
    expect((await one<{ count: number }>(`select count(*)::int as count from public.platform_audit_log where action = 'platform.hardware.retired'`)).count).toBe(1);

    // Settings-managed fields stay with Admin → Hardware.
    const [kitchen] = await byType("kitchen_printer");
    await expect(save({ id: kitchen!.id, ip_address: "10.10.10.99" })).rejects.toThrow("Admin → Hardware");
    // Secrets are refused; bad addresses are refused.
    await expect(save({ device_type: "router", name: "Router", configuration: { admin_password: "hunter2" } })).rejects.toThrow("HARDWARE_SECRET_REFUSED");
    await expect(save({ device_type: "router", name: "Router", ip_address: "10.10.10.999" })).rejects.toThrow("IP address");
    // No reason, no change.
    await expect(save({ device_type: "ups", name: "UPS" }, "x")).rejects.toThrow("reason");
    // Support staff and business owners can't change the registry.
    await expect(save({ device_type: "ups", name: "UPS" }, "support tries", platformSupport)).rejects.toThrow("platform access required");
    await expect(save({ device_type: "ups", name: "UPS" }, "owner tries", waynesOwner)).rejects.toThrow("platform access required");
  });

  it("keeps each business's devices and lines to itself", async () => {
    await save({ device_type: "receipt_printer", name: "A printer", location_id: tenantALocation, ownership_type: "financed" }, "HW A bought a printer", platformOwner, "hw-a");
    // Another business's location can't be used, nor its caller lines.
    await expect(save({ device_type: "router", name: "Wrong", location_id: tenantALocation }, "wrong location test")).rejects.toThrow("does not belong");
    const [caller] = await byType("caller_id");
    await database.exec(`insert into public.location_caller_lines (workspace_id, location_id, line_number, label) values ('${tenantA}', '${tenantALocation}', 1, 'Line 1')`);
    await expect(database.exec(`update public.location_caller_lines set caller_id_device_id = '${caller!.id}' where workspace_id = '${tenantA}'`)).rejects.toThrow("caller-ID device at the same location");

    const waynesSees = await as<{ name: string }>(waynesOwner, "select name from public.hardware_devices");
    expect(waynesSees.length).toBeGreaterThan(0);
    expect(waynesSees.map((row) => row.name)).not.toContain("A printer");
    const aSees = await as<{ name: string }>(ownerA, "select name from public.hardware_devices");
    expect(aSees.map((row) => row.name)).toEqual(["A printer"]);
    const aList = await as<{ list: { name: string }[] }>(ownerA, "select public.hanafy_workspace_devices('hw-a') as list");
    expect(aList[0]!.list.map((device) => device.name)).toEqual(["A printer"]);
    await expect(as(ownerA, "select public.hanafy_workspace_devices('waynes-pizza')")).rejects.toThrow();
    // No direct writes from a browser session.
    await expect(as(waynesOwner, `update public.hardware_devices set name = 'x' where workspace_id = '${waynesWorkspaceId}'`)).rejects.toThrow();
    await expect(as(ownerA, `select public.hanafy_hardware_heartbeat('${caller!.id}', false, 'x')`)).rejects.toThrow();
  });

  it("keeps the existing caller-ID and printer abstractions working", async () => {
    const settings = await as<{ data: Record<string, unknown> }>(waynesOwner, "select public.wayne_pos_hardware_settings() as data");
    expect(settings[0]!.data).toMatchObject({ caller_line_count: 2, caller_udp_port: 3520 });
    const board = await as<{ data: unknown }>(waynesOwner, "select public.wayne_phone_board() as data");
    expect(board[0]!.data).toBeTruthy();
  });
});
