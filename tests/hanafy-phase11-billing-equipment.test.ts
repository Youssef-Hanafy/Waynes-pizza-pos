import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = resolve(process.cwd(), "supabase/migrations");
const migrations = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();

const waynesWorkspaceId = "40000000-0000-4000-8000-000000000001";
const tenantA = "98100000-0000-4000-8000-00000000000a";
const tenantALocation = "98100000-0000-4000-8000-0000000000a1";
const ownerA = "98100000-0000-4000-8000-000000000001";
const waynesOwner = "98100000-0000-4000-8000-000000000003";
const platformOwner = "98100000-0000-4000-8000-000000000004";
const platformBilling = "98100000-0000-4000-8000-000000000005";
const platformSupport = "98100000-0000-4000-8000-000000000006";

type Row = Record<string, unknown>;
type Totals = { agreement: { label: string } | null; monthly_recurring_cents: number; open_invoices: number; open_balance_cents: number; overdue_invoices: number; overdue_balance_cents: number; equipment_balance_cents: number };
type Invoice = { id: string; invoice_number: string; status: string; total_cents: number; paid_cents: number; balance_due_cents: number; overdue: boolean; items: { description: string; amount_cents: number }[] };

describe("Hanafy Platform Phase 11 billing + equipment balances", () => {
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
  const rpc = async <T,>(fn: string, slug: string | null, payload: unknown, reason = "Recording the agreement", user = platformOwner) =>
    (await commitAs<{ result: T }>(user, `select public.${fn}(${slug === null ? "" : `'${slug}', `}${json(payload)}, '${reason}') as result`))[0]!.result;
  const billing = async (slug = "waynes-pizza", user = platformOwner) =>
    (await commitAs<{ data: { totals: Totals; invoices: Invoice[]; equipment: { id: string; balance_due_cents: number; charged_cents: number; paid_cents: number }[]; can_manage: boolean } }>(user, `select public.hanafy_platform_workspace_billing('${slug}') as data`))[0]!.data;

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
        ('${ownerA}', 'a@example.test', now()), ('${waynesOwner}', 'waynes@example.test', now()), ('${platformOwner}', 'platform@hanafy.test', now()),
        ('${platformBilling}', 'billing@hanafy.test', now()), ('${platformSupport}', 'support@hanafy.test', now());
      update public.profiles set role_id = (select id from public.roles where code = 'owner'), active = true where id = '${waynesOwner}';
      insert into public.platform_users (auth_user_id, platform_role, active) values
        ('${platformOwner}', 'platform_owner', true), ('${platformBilling}', 'platform_billing', true), ('${platformSupport}', 'platform_support', true);
      insert into public.workspaces (id, slug, name) values ('${tenantA}', 'bill-a', 'Bill A');
      insert into public.locations (id, workspace_id, slug, name) values ('${tenantALocation}', '${tenantA}', 'main', 'A Main');
      insert into public.workspace_members (workspace_id, auth_user_id, workspace_role_id) values ('${tenantA}', '${ownerA}', (select id from public.roles where code = 'owner'));
      update public.profiles set active = true where id = '${ownerA}';
    `);
  }, 180_000);

  afterAll(async () => database.close());

  it("starts honest: no invented agreement, and Wayne's owes nothing on its own equipment", async () => {
    const data = await billing();
    expect(data.totals).toMatchObject({ agreement: null, monthly_recurring_cents: 0, open_balance_cents: 0, equipment_balance_cents: 0 });
    expect(data.invoices).toEqual([]);
    const dashboard = (await commitAs<{ data: { billing: { without_agreement: number } } }>(platformOwner, "select public.hanafy_platform_dashboard() as data"))[0]!.data;
    expect(dashboard.billing.without_agreement).toBeGreaterThanOrEqual(1);
  });

  it("answers: what is Wayne's on and what is the monthly price", async () => {
    const plan = await rpc<{ id: string }>("hanafy_platform_save_plan", null, { code: "restaurant_growth", name: "Restaurant Growth", base_monthly_price_cents: 29900, services: ["pos", "online_ordering", "crm", "sms"] }, "New standard plan");
    await rpc("hanafy_platform_save_subscription", "waynes-pizza", { plan_id: plan.id, label: "Wayne's custom agreement", price_cents: 24900, billing_interval: "monthly", start_date: "2026-09-01", custom_terms: "Founding client rate" });
    await rpc("hanafy_platform_save_subscription", "waynes-pizza", { kind: "addon", label: "Caller ID add-on", price_cents: 6000, billing_interval: "quarterly", start_date: "2026-09-01" });
    const data = await billing();
    expect(data.totals.agreement).toMatchObject({ label: "Wayne's custom agreement" });
    expect(data.totals.monthly_recurring_cents).toBe(24900 + 2000);
    // Only one live base agreement.
    await expect(rpc("hanafy_platform_save_subscription", "waynes-pizza", { label: "Second base", price_cents: 100 })).rejects.toThrow("workspace_subscriptions_one_base");
    // Money is whole cents.
    await expect(rpc("hanafy_platform_save_subscription", "waynes-pizza", { kind: "addon", label: "Bad", price_cents: 12.5 })).rejects.toThrow("whole cents");
  });

  it("answers: what invoices are unpaid", async () => {
    const draft = await rpc<{ id: string; invoice_number: string }>("hanafy_platform_save_invoice", "waynes-pizza",
      { include_agreements: true, period_start: "2026-09-01", period_end: "2026-09-30", items: [{ kind: "setup", description: "Menu load and training", unit_price_cents: 15000 }] }, "September invoice");
    expect(draft.invoice_number).toMatch(/^HM-\d{4}-\d{4}$/);
    let invoice = (await billing()).invoices.find((row) => row.id === draft.id)!;
    expect(invoice.status).toBe("draft");
    expect(invoice.total_cents).toBe(24900 + 6000 + 15000);

    await rpc("hanafy_platform_save_invoice", "waynes-pizza", { id: draft.id, action: "issue", issue_date: "2026-09-01", due_date: "2026-09-15" }, "Sent to Ehab");
    invoice = (await billing()).invoices.find((row) => row.id === draft.id)!;
    expect(invoice).toMatchObject({ status: "open", balance_due_cents: 45900, overdue: true });
    // Issued lines are locked.
    await expect(rpc("hanafy_platform_save_invoice", "waynes-pizza", { id: draft.id, items: [{ description: "x", unit_price_cents: 1 }] }, "try to edit")).rejects.toThrow("draft");

    // Partial payment, overpayment refused, then paid in full → paid by itself.
    await rpc("hanafy_platform_record_payment", "waynes-pizza", { target: "invoice", target_id: draft.id, amount_cents: 20000, method: "check", reference: "#1042" }, "Check received");
    await expect(rpc("hanafy_platform_record_payment", "waynes-pizza", { target: "invoice", target_id: draft.id, amount_cents: 30000, method: "cash" }, "Too much")).rejects.toThrow("more than");
    let totals = (await billing()).totals;
    expect(totals).toMatchObject({ open_invoices: 1, open_balance_cents: 25900, overdue_invoices: 1, overdue_balance_cents: 25900 });
    const last = await rpc<{ id: string }>("hanafy_platform_record_payment", "waynes-pizza", { target: "invoice", target_id: draft.id, amount_cents: 25900, method: "zelle" }, "Paid the rest");
    expect((await billing()).invoices.find((row) => row.id === draft.id)?.status).toBe("paid");

    // Voiding a payment re-opens it; payments and invoices are never deleted.
    await rpc("hanafy_platform_record_payment", "waynes-pizza", { target: "invoice", void_payment_id: last.id }, "Zelle bounced");
    totals = (await billing()).totals;
    expect(totals.open_balance_cents).toBe(25900);
    await expect(database.exec(`delete from public.platform_invoice_payments where id = '${last.id}'`)).rejects.toThrow("void instead");
    await expect(database.exec(`delete from public.platform_invoices where id = '${draft.id}'`)).rejects.toThrow("void instead");
    await expect(rpc("hanafy_platform_save_invoice", "waynes-pizza", { id: draft.id, action: "void" }, "Try to void a part-paid invoice")).rejects.toThrow("Void the payments");
  });

  it("answers: does the business owe money on Hanafy-supplied equipment", async () => {
    const tablet = await rpc<{ id: string }>("hanafy_platform_save_hardware_device", "bill-a", { device_type: "pos_tablet", name: "Counter tablet", location_id: tenantALocation }, "Supplied a tablet");
    const asset = await rpc<{ id: string; balance_due_cents: number }>("hanafy_platform_save_equipment", "bill-a",
      { hardware_device_id: tablet.id, ownership_type: "financed", hanafy_cost_cents: 22000, customer_price_cents: 30000, payment_schedule: "3 monthly payments of $100" }, "Tablet financed");
    expect(asset.balance_due_cents).toBe(30000);
    await rpc("hanafy_platform_record_payment", "bill-a", { target: "equipment", target_id: asset.id, amount_cents: 10000, method: "card" }, "First installment");
    await rpc("hanafy_platform_save_equipment", "bill-a", { id: asset.id, charge_cents: -2500, charge_description: "Loyalty credit" }, "Goodwill credit");
    const data = await billing("bill-a");
    expect(data.totals.equipment_balance_cents).toBe(30000 - 10000 - 2500);
    expect(data.equipment[0]).toMatchObject({ charged_cents: 27500, paid_cents: 10000, balance_due_cents: 17500 });
    await expect(rpc("hanafy_platform_record_payment", "bill-a", { target: "equipment", target_id: asset.id, amount_cents: 20000, method: "cash" }, "Too much")).rejects.toThrow("more than");

    // The device shows its balance and ownership follows the asset.
    const device = (await commitAs<{ data: { devices: { id: string; ownership_type: string; equipment: { balance_due_cents: number } | null }[] } }>(platformOwner, "select public.hanafy_platform_workspace_hardware('bill-a') as data"))[0]!.data.devices[0]!;
    expect(device).toMatchObject({ ownership_type: "financed", equipment: { balance_due_cents: 17500 } });
    // A device of another business can't be attached.
    const waynesDevice = await database.query<{ id: string }>(`select id from public.hardware_devices where workspace_id = '${waynesWorkspaceId}' limit 1`);
    await expect(rpc("hanafy_platform_save_equipment", "bill-a", { hardware_device_id: waynesDevice.rows[0]!.id, customer_price_cents: 100 }, "wrong business")).rejects.toThrow("does not belong");
  });

  it("lets only Hanafy billing staff change money, and keeps it out of browsers", async () => {
    await rpc("hanafy_platform_save_subscription", "bill-a", { label: "Bill A starter", price_cents: 9900 }, "Signed", platformBilling);
    await expect(rpc("hanafy_platform_save_subscription", "bill-a", { kind: "addon", label: "x", price_cents: 1 }, "support tries", platformSupport)).rejects.toThrow("platform access required");
    await expect(rpc("hanafy_platform_save_subscription", "bill-a", { kind: "addon", label: "x", price_cents: 1 }, "owner tries", ownerA)).rejects.toThrow("platform access required");
    expect((await billing("bill-a", platformSupport)).can_manage).toBe(false);
    await expect(rpc("hanafy_platform_save_subscription", "bill-a", { kind: "addon", label: "x", price_cents: 1 }, "no")).rejects.toThrow("reason");

    for (const table of ["platform_invoices", "workspace_subscriptions", "equipment_assets", "platform_invoice_payments"]) {
      await expect(as(ownerA, `select * from public.${table}`)).rejects.toThrow("permission denied");
    }
    // The business sees its own Hanafy bill, and only its own.
    const mine = await as<{ data: { totals: Totals } }>(ownerA, "select public.hanafy_workspace_hanafy_billing('bill-a') as data");
    expect(mine[0]!.data.totals).toMatchObject({ monthly_recurring_cents: 9900, equipment_balance_cents: 17500 });
    await expect(as(ownerA, "select public.hanafy_workspace_hanafy_billing('waynes-pizza')")).rejects.toThrow();

    const audit = await database.query<{ action: string }>("select distinct action from public.platform_audit_log where action like 'platform.billing.%' order by action");
    expect(audit.rows.map((row) => row.action)).toEqual(expect.arrayContaining([
      "platform.billing.equipment_charged", "platform.billing.equipment_created", "platform.billing.invoice_created", "platform.billing.invoice_issued",
      "platform.billing.payment_recorded", "platform.billing.payment_voided", "platform.billing.plan_created", "platform.billing.subscription_created",
    ]));
  });

  it("rolls every business into the dashboard", async () => {
    const dashboard = (await commitAs<{ data: { billing: { monthly_recurring_cents: number; open_balance_cents: number; equipment_balance_cents: number } } }>(platformOwner, "select public.hanafy_platform_dashboard() as data"))[0]!.data;
    expect(dashboard.billing).toMatchObject({ monthly_recurring_cents: 24900 + 2000 + 9900, open_balance_cents: 25900, equipment_balance_cents: 17500 });
    const overview = (await commitAs<{ data: { overdue: { invoice_number: string }[]; workspaces: { slug: string }[] } }>(platformBilling, "select public.hanafy_platform_billing_overview() as data"))[0]!.data;
    expect(overview.overdue).toHaveLength(1);
    expect(overview.workspaces.map((row) => row.slug)).toEqual(expect.arrayContaining(["waynes-pizza", "bill-a"]));
  });
});
