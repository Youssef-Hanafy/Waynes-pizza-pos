import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = resolve(process.cwd(), "supabase/migrations");
const migrations = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();

const waynesWorkspaceId = "40000000-0000-4000-8000-000000000001";
const tenantA = "97700000-0000-4000-8000-00000000000a";
const tenantALocation = "97700000-0000-4000-8000-0000000000a1";
const tenantB = "97700000-0000-4000-8000-00000000000b";
const tenantBLocation = "97700000-0000-4000-8000-0000000000b1";
const tenantC = "97700000-0000-4000-8000-00000000000c";
const tenantCLocation = "97700000-0000-4000-8000-0000000000c1";
const ownerA = "97700000-0000-4000-8000-000000000001";
const ownerB = "97700000-0000-4000-8000-000000000002";
const ownerC = "97700000-0000-4000-8000-000000000003";
const waynesOwner = "97700000-0000-4000-8000-000000000004";
const platformOwner = "97700000-0000-4000-8000-000000000005";
const readOnlyA = "97700000-0000-4000-8000-000000000006";

const senderA = "+15085550101";
const senderB = "+16175550102";

type Row = Record<string, unknown>;

describe("Hanafy Platform Phase 7 CRM + messaging tenancy", () => {
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
        ('${ownerA}', 'a@example.test', now()), ('${ownerB}', 'b@example.test', now()), ('${ownerC}', 'c@example.test', now()),
        ('${waynesOwner}', 'waynes@example.test', now()), ('${platformOwner}', 'platform@hanafy.test', now()),
        ('${readOnlyA}', 'reader@example.test', now());
      update public.profiles set role_id = (select id from public.roles where code = 'owner'), active = true where id = '${waynesOwner}';
      insert into public.platform_users (auth_user_id, platform_role, active) values ('${platformOwner}', 'platform_owner', true);
      insert into public.workspaces (id, slug, name) values
        ('${tenantA}', 'tenant-a', 'Tenant A'), ('${tenantB}', 'tenant-b', 'Tenant B'), ('${tenantC}', 'tenant-c', 'Tenant C');
      insert into public.locations (id, workspace_id, slug, name) values
        ('${tenantALocation}', '${tenantA}', 'main', 'A Main'), ('${tenantBLocation}', '${tenantB}', 'main', 'B Main'),
        ('${tenantCLocation}', '${tenantC}', 'main', 'C Main');
      insert into public.workspace_members (workspace_id, auth_user_id, workspace_role_id) values
        ('${tenantA}', '${ownerA}', (select id from public.roles where code = 'owner')),
        ('${tenantA}', '${readOnlyA}', (select id from public.roles where code = 'marketing_readonly')),
        ('${tenantB}', '${ownerB}', (select id from public.roles where code = 'owner')),
        ('${tenantC}', '${ownerC}', (select id from public.roles where code = 'owner'));
      update public.profiles set active = true where id in ('${ownerA}', '${ownerB}', '${ownerC}', '${readOnlyA}');
      insert into public.workspace_services (workspace_id, service_id, status, source)
      select workspace.id, service.id, 'enabled', 'manual'
      from (values ('${tenantA}'::uuid), ('${tenantB}'::uuid), ('${tenantC}'::uuid)) workspace(id)
      cross join public.service_catalog service where service.code in ('crm', 'sms', 'customer_segments');

      insert into public.messaging_connections (id, workspace_id, provider, status, aws_region, dispatch_mode) values
        ('97700000-0000-4000-8000-0000000000e1', '${tenantA}', 'aws_end_user_messaging', 'active', 'us-east-1', 'platform'),
        ('97700000-0000-4000-8000-0000000000e2', '${tenantB}', 'aws_end_user_messaging', 'active', 'us-east-1', 'platform');
      insert into public.messaging_origination_identities (id, workspace_id, messaging_connection_id, phone_number, status, is_default) values
        ('97700000-0000-4000-8000-0000000000f1', '${tenantA}', '97700000-0000-4000-8000-0000000000e1', '${senderA}', 'active', true),
        ('97700000-0000-4000-8000-0000000000f2', '${tenantB}', '97700000-0000-4000-8000-0000000000e2', '${senderB}', 'active', true);

      insert into public.customers (id, workspace_id, first_name, last_name, phone_normalized, sms_marketing_opt_in) values
        ('97700000-0000-4000-8000-0000000000a2', '${tenantA}', 'Ana', 'One', '+15085551001', true),
        ('97700000-0000-4000-8000-0000000000a3', '${tenantA}', 'Abe', 'Two', '+15085551002', true),
        ('97700000-0000-4000-8000-0000000000a4', '${tenantA}', 'Al', 'NoConsent', '+15085551003', false),
        ('97700000-0000-4000-8000-0000000000a5', '${tenantA}', 'Ava', 'Stopped', '+15085551004', true),
        ('97700000-0000-4000-8000-0000000000b2', '${tenantB}', 'Bea', 'One', '+16175552001', true),
        ('97700000-0000-4000-8000-0000000000b3', '${tenantB}', 'Bo', 'Two', '+16175552002', true);
      insert into public.customer_segments (id, workspace_id, name, description, rules_json) values
        ('97700000-0000-4000-8000-0000000000d2', '${tenantB}', 'B regulars', '', '{"all": [{"field": "order_count", "value": 5, "operator": ">="}]}'::jsonb);
      insert into public.suppression_entries (workspace_id, channel, address, reason) values ('${tenantA}', 'sms', '+15085551004', 'manual');
    `);
  }, 180_000);

  afterAll(async () => database.close());

  it("maps Wayne's to its old CRM business and its real AWS number, still sent by the CRM", async () => {
    const link = await one<{ legacy_business_slug: string; legacy_project_ref: string }>(
      `select legacy_business_slug, legacy_project_ref from public.crm_legacy_business_links where workspace_id = '${waynesWorkspaceId}'`,
    );
    expect(link).toMatchObject({ legacy_business_slug: "waynes-pizza", legacy_project_ref: "lgbdfqpnlvjxdlalhnbk" });
    const connection = await one<{ dispatch_mode: string; status: string; live_sending: boolean }>(
      `select dispatch_mode, status, live_sending from public.messaging_connections where workspace_id = '${waynesWorkspaceId}'`,
    );
    expect(connection).toEqual({ dispatch_mode: "legacy_crm_bridge", status: "active", live_sending: false });
    const identity = await one<{ phone_number: string; is_default: boolean }>(
      `select phone_number, is_default from public.messaging_origination_identities where workspace_id = '${waynesWorkspaceId}'`,
    );
    expect(identity).toEqual({ phone_number: "+15136764597", is_default: true });

    // Wayne's campaigns can't be sent from the platform while the CRM sends.
    const [campaign] = await commitAs<{ id: string }>(waynesOwner, `
      select public.hanafy_campaign_save('waynes-pizza', '{"name":"Test","body":"Hi {{first_name}}"}'::jsonb) as id`);
    await expect(commitAs(waynesOwner, `select public.hanafy_campaign_send('waynes-pizza', '${campaign?.id}')`)).rejects.toThrow("LEGACY_CRM_SENDS");
  });

  it("lets a phone number belong to only one business", async () => {
    await expect(database.exec(`
      insert into public.messaging_origination_identities (workspace_id, messaging_connection_id, phone_number, status)
      values ('${tenantB}', '97700000-0000-4000-8000-0000000000e2', '${senderA}', 'pending')`)).rejects.toThrow("messaging_identities_number_owner");
    // A sender cannot hang off another business's connection either.
    await expect(database.exec(`
      insert into public.messaging_origination_identities (workspace_id, messaging_connection_id, phone_number, status)
      values ('${tenantB}', '97700000-0000-4000-8000-0000000000e1', '+16175559999', 'pending')`)).rejects.toThrow("foreign key");
  });

  it("sends each business's campaign only from its own number, to its own customers", async () => {
    const [saved] = await commitAs<{ id: string }>(ownerA, `
      select public.hanafy_campaign_save('tenant-a', '{"name":"Spring","body":"{{business_name}}: hi {{first_name}}! Reply STOP to opt out"}'::jsonb) as id`);
    const campaignId = saved?.id as string;

    const [audience] = await as<{ audience: { total: number; eligible: number; skipped: Record<string, number> } }>(
      ownerA, `select public.hanafy_campaign_audience('tenant-a', '${campaignId}') as audience`);
    expect(audience?.audience).toMatchObject({ total: 3, eligible: 2, skipped: { suppressed: 1 } });

    const [sent] = await commitAs<{ result: { recipients: number; queued: number; skipped: number } }>(
      ownerA, `select public.hanafy_campaign_send('tenant-a', '${campaignId}') as result`);
    expect(sent?.result).toMatchObject({ recipients: 3, queued: 2, skipped: 1 });

    const jobs = (await database.query<{ recipient: string; sender: string; body: string; workspace_id: string }>(`
      select job.recipient, identity.phone_number as sender, job.body, job.workspace_id
      from public.message_jobs job join public.messaging_origination_identities identity on identity.id = job.origin_identity_id
      where job.campaign_id = '${campaignId}' order by job.recipient`)).rows;
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.sender).toBe(senderA);
      expect(job.workspace_id).toBe(tenantA);
      expect(job.recipient.startsWith("+1508")).toBe(true);
    }
    expect(jobs[0]?.body).toBe("Tenant A: hi Ana! Reply STOP to opt out");

    // Tenant B sees none of it.
    const [seen] = await as<{ campaigns: number; jobs: number; customers: number }>(ownerB, `
      select (select count(*)::int from public.marketing_campaigns where workspace_id = '${tenantA}') as campaigns,
             (select count(*)::int from public.message_jobs where workspace_id = '${tenantA}') as jobs,
             (select count(*)::int from public.customers where workspace_id = '${tenantA}') as customers`);
    expect(seen).toEqual({ campaigns: 0, jobs: 0, customers: 0 });
    await expect(as(ownerB, `select public.hanafy_campaign_audience('tenant-a', '${campaignId}')`)).rejects.toThrow("permission");
  });

  it("refuses another business's sender, segment or customer", async () => {
    // Tenant A points a campaign at B's segment.
    await expect(commitAs(ownerA, `
      select public.hanafy_campaign_save('tenant-a', '{"name":"Steal","body":"x","audience_type":"segment","segment_id":"97700000-0000-4000-8000-0000000000d2"}'::jsonb)`))
      .rejects.toThrow("does not belong to this business");
    // Direct send path: B's number for an A message.
    await expect(database.exec(`select public.hanafy_enqueue_message('{"workspace_id":"${tenantA}","customer_id":"97700000-0000-4000-8000-0000000000a2","body":"x","idempotency_key":"cross-sender-1","origin_identity_id":"97700000-0000-4000-8000-0000000000f2","message_type":"transactional"}'::jsonb)`))
      .rejects.toThrow("SENDER_NOT_IN_WORKSPACE");
    // B's customer in an A message.
    await expect(database.exec(`select public.hanafy_enqueue_message('{"workspace_id":"${tenantA}","customer_id":"97700000-0000-4000-8000-0000000000b2","body":"x","idempotency_key":"cross-customer-1","message_type":"transactional"}'::jsonb)`))
      .rejects.toThrow("CUSTOMER_NOT_IN_WORKSPACE");
    // Even a raw insert that skips the function is stopped by the composite keys.
    await expect(database.exec(`
      insert into public.message_jobs (workspace_id, channel, message_type, origin_identity_id, recipient, body, idempotency_key)
      values ('${tenantA}', 'sms', 'transactional', '97700000-0000-4000-8000-0000000000f2', '+15085551001', 'x', 'raw-cross-1')`)).rejects.toThrow("foreign key");
  });

  it("fails visibly when a business has no sender, never borrowing another's number", async () => {
    const [saved] = await commitAs<{ id: string }>(ownerC, `select public.hanafy_campaign_save('tenant-c', '{"name":"No number","body":"hello"}'::jsonb) as id`);
    await expect(commitAs(ownerC, `select public.hanafy_campaign_send('tenant-c', '${saved?.id}')`)).rejects.toThrow("NO_SENDER");
    const [jobs] = await as<{ count: number }>(platformOwner, `select count(*)::int as count from public.message_jobs where workspace_id = '${tenantC}'`);
    expect(jobs?.count).toBe(0);
  });

  it("keeps a STOP inside the business whose number received it", async () => {
    const result = await one<{ result: { action: string; workspace_id: string } }>(
      `select public.hanafy_messaging_inbound('${senderA}', '+15085551002', 'Stop', 'evt-stop-1') as result`);
    expect(result.result).toMatchObject({ action: "opted_out", workspace_id: tenantA });
    const again = await one<{ result: { duplicate: boolean } }>(`select public.hanafy_messaging_inbound('${senderA}', '+15085551002', 'Stop', 'evt-stop-1') as result`);
    expect(again.result.duplicate).toBe(true);

    const customer = await one<{ sms_marketing_opt_in: boolean }>(`select sms_marketing_opt_in from public.customers where id = '97700000-0000-4000-8000-0000000000a3'`);
    expect(customer.sms_marketing_opt_in).toBe(false);
    // The queued campaign text to that number is skipped, not sent.
    const job = await one<{ status: string; skip_reason: string }>(`select status, skip_reason from public.message_jobs where recipient = '+15085551002'`);
    expect(job).toEqual({ status: "skipped", skip_reason: "suppressed" });
    const counts = await one<{ a: number; b: number }>(`
      select (select count(*)::int from public.suppression_entries where workspace_id = '${tenantA}' and address = '+15085551002' and lifted_at is null) as a,
             (select count(*)::int from public.suppression_entries where workspace_id = '${tenantB}') as b`);
    expect(counts).toEqual({ a: 1, b: 0 });
    // The same person can still get a test text from business B.
    const test = await one<{ result: { status: string } }>(`select public.hanafy_enqueue_message('{"workspace_id":"${tenantB}","recipient":"+15085551002","body":"hi","idempotency_key":"b-test-1","is_test":true}'::jsonb) as result`);
    expect(test.result.status).toBe("queued");
    await database.exec(`update public.message_jobs set status = 'cancelled' where idempotency_key = 'b-test-1'`);
  });

  it("re-checks consent at send time and never re-sends an interrupted message", async () => {
    // Ana withdraws consent after the campaign was queued.
    await database.exec(`update public.customers set sms_marketing_opt_in = false where id = '97700000-0000-4000-8000-0000000000a2'`);
    const [claim] = (await database.query<{ jobs: Array<{ job_id: string }> }>(`select public.hanafy_message_jobs_claim(25, 120) as jobs`)).rows;
    expect(claim?.jobs).toHaveLength(0);
    const ana = await one<{ status: string; skip_reason: string }>(`select status, skip_reason from public.message_jobs where recipient = '+15085551001'`);
    expect(ana).toEqual({ status: "skipped", skip_reason: "no_consent" });

    // A transactional text for B gets claimed, interrupted, and marked unknown, not retried.
    await database.exec(`select public.hanafy_enqueue_message('{"workspace_id":"${tenantB}","customer_id":"97700000-0000-4000-8000-0000000000b3","body":"Your order is ready","idempotency_key":"b-ready-1","message_type":"transactional"}'::jsonb)`);
    const [claimed] = (await database.query<{ jobs: Array<{ job_id: string; lease_token: string; origination_identity: string; workspace_id: string }> }>(`select public.hanafy_message_jobs_claim(25, 120) as jobs`)).rows;
    expect(claimed?.jobs).toHaveLength(1);
    expect(claimed?.jobs[0]).toMatchObject({ origination_identity: senderB, workspace_id: tenantB });
    await database.exec(`update public.message_jobs set lease_expires_at = now() - interval '1 minute' where idempotency_key = 'b-ready-1'`);
    const [next] = (await database.query<{ jobs: unknown[] }>(`select public.hanafy_message_jobs_claim(25, 120) as jobs`)).rows;
    expect(next?.jobs).toHaveLength(0);
    const status = await one<{ status: string }>(`select status from public.message_jobs where idempotency_key = 'b-ready-1'`);
    expect(status.status).toBe("unknown");

    // A normal success path, and the same key twice creates one job.
    const first = await one<{ result: { job_id: string; duplicate: boolean } }>(`select public.hanafy_enqueue_message('{"workspace_id":"${tenantB}","customer_id":"97700000-0000-4000-8000-0000000000b3","body":"Out for delivery","idempotency_key":"b-ready-2","message_type":"transactional"}'::jsonb) as result`);
    const second = await one<{ result: { job_id: string; duplicate: boolean } }>(`select public.hanafy_enqueue_message('{"workspace_id":"${tenantB}","customer_id":"97700000-0000-4000-8000-0000000000b3","body":"Out for delivery","idempotency_key":"b-ready-2","message_type":"transactional"}'::jsonb) as result`);
    expect(second.result).toMatchObject({ job_id: first.result.job_id, duplicate: true });
    const [again] = (await database.query<{ jobs: Array<{ job_id: string; lease_token: string }> }>(`select public.hanafy_message_jobs_claim(25, 120) as jobs`)).rows;
    const job = again?.jobs[0];
    expect(job?.job_id).toBe(first.result.job_id);
    const done = await one<{ result: { ok: boolean } }>(`select public.hanafy_message_job_finish('${job?.job_id}', '${job?.lease_token}', 'sent', 'aws-msg-1', null, true, 1) as result`);
    expect(done.result.ok).toBe(true);
    const receipt = await one<{ result: { matched: boolean } }>(`select public.hanafy_message_delivery_status('aws_end_user_messaging', 'evt-dlr-1', 'aws-msg-1', 'DELIVERED') as result`);
    expect(receipt.result.matched).toBe(true);
    const dup = await one<{ result: { duplicate: boolean } }>(`select public.hanafy_message_delivery_status('aws_end_user_messaging', 'evt-dlr-1', 'aws-msg-1', 'DELIVERED') as result`);
    expect(dup.result.duplicate).toBe(true);
    const delivered = await one<{ status: string; simulated: boolean }>(`select status, simulated from public.message_jobs where id = '${job?.job_id}'`);
    expect(delivered).toEqual({ status: "delivered", simulated: true });
  });

  it("never claims jobs for a business whose texts still go out from the old CRM", async () => {
    await database.exec(`
      insert into public.message_jobs (workspace_id, channel, message_type, origin_identity_id, recipient, body, idempotency_key)
      select '${waynesWorkspaceId}', 'sms', 'transactional', id, '+15085550000', 'x', 'waynes-direct-1'
      from public.messaging_origination_identities where workspace_id = '${waynesWorkspaceId}'`);
    const [claim] = (await database.query<{ jobs: unknown[] }>(`select public.hanafy_message_jobs_claim(25, 120) as jobs`)).rows;
    expect(claim?.jobs).toHaveLength(0);
    await database.exec(`delete from public.message_jobs where idempotency_key = 'waynes-direct-1'`);
  });

  it("stops texts when SMS is switched off for the business", async () => {
    await database.exec(`update public.workspace_services set status = 'disabled', disabled_at = now() where workspace_id = '${tenantB}' and service_id = (select id from public.service_catalog where code = 'sms')`);
    const skipped = await one<{ result: { status: string; skip_reason: string } }>(`select public.hanafy_enqueue_message('{"workspace_id":"${tenantB}","customer_id":"97700000-0000-4000-8000-0000000000b2","body":"x","idempotency_key":"b-sms-off-1","message_type":"transactional"}'::jsonb) as result`);
    expect(skipped.result).toMatchObject({ status: "skipped", skip_reason: "service_disabled" });
    await expect(as(ownerB, `select public.hanafy_marketing_overview('tenant-b')`)).rejects.toThrow("permission");
    await database.exec(`update public.workspace_services set status = 'enabled', disabled_at = null where workspace_id = '${tenantB}' and service_id = (select id from public.service_catalog where code = 'sms')`);
  });

  it("gives read-only staff a view but no send, and keeps the overview scoped", async () => {
    const [overview] = await as<{ overview: { can_manage: boolean; senders: Array<{ phone_number: string }>; campaigns: unknown[] } }>(
      readOnlyA, `select public.hanafy_marketing_overview('tenant-a') as overview`);
    expect(overview?.overview.can_manage).toBe(false);
    expect(overview?.overview.senders.map((sender) => sender.phone_number)).toEqual([senderA]);
    await expect(as(readOnlyA, `select public.hanafy_campaign_save('tenant-a', '{"name":"x","body":"y"}'::jsonb)`)).rejects.toThrow("permission");
    await expect(as(readOnlyA, `select public.hanafy_suppression_set('tenant-a', '{"address":"+15085551001"}'::jsonb)`)).rejects.toThrow("permission");
    await expect(as(readOnlyA, `insert into public.message_jobs (workspace_id, channel, message_type, origin_identity_id, recipient, body, idempotency_key) values ('${tenantA}', 'sms', 'transactional', '97700000-0000-4000-8000-0000000000f1', '+15085551001', 'x', 'ro-insert-1')`)).rejects.toThrow("permission denied");
    await expect(as(ownerA, `select public.hanafy_enqueue_message('{"workspace_id":"${tenantA}","customer_id":"97700000-0000-4000-8000-0000000000a2","body":"x","idempotency_key":"browser-1"}'::jsonb)`)).rejects.toThrow("permission denied");
  });

  it("lets platform staff see and change messaging only with a reason and confirmation", async () => {
    await expect(as(ownerA, `select public.hanafy_platform_workspace_messaging('tenant-a')`)).rejects.toThrow("Hanafy platform access required");
    const [view] = await as<{ view: { connection: { dispatch_mode: string }; identities: unknown[]; opt_outs: number } }>(
      platformOwner, `select public.hanafy_platform_workspace_messaging('waynes-pizza') as view`);
    expect(view?.view.connection.dispatch_mode).toBe("legacy_crm_bridge");
    expect(view?.view.identities).toHaveLength(1);

    const [ask] = await commitAs<{ result: { status: string; warnings: string[] } }>(platformOwner, `
      select public.hanafy_platform_save_messaging('waynes-pizza', '{"dispatch_mode":"platform"}'::jsonb, 'Cut over Wayne''s texts', false) as result`);
    expect(ask?.result.status).toBe("needs_confirmation");
    expect(ask?.result.warnings.join(" ")).toContain("Pause every live automation");
    const unchanged = await one<{ dispatch_mode: string }>(`select dispatch_mode from public.messaging_connections where workspace_id = '${waynesWorkspaceId}'`);
    expect(unchanged.dispatch_mode).toBe("legacy_crm_bridge");

    const [saved] = await commitAs<{ result: { status: string } }>(platformOwner, `
      select public.hanafy_platform_save_messaging('tenant-c', '{"status":"sandbox","identity":{"phone_number":"+17745550103","status":"active"}}'::jsonb, 'Set up Tenant C number', true) as result`);
    expect(saved?.result.status).toBe("saved");
    const audit = await one<{ count: number }>(`select count(*)::int as count from public.platform_audit_log where action = 'platform.messaging.updated' and workspace_id = '${tenantC}'`);
    expect(audit.count).toBe(1);
    const [sender] = await as<{ id: string }>(ownerC, `select public.hanafy_resolve_sender('${tenantC}', null, 'sms', null) as id`).catch(() => [{ id: "blocked" }]);
    expect(sender?.id).toBe("blocked");
    const resolved = await one<{ phone_number: string }>(`select identity.phone_number from public.messaging_origination_identities identity where identity.id = public.hanafy_resolve_sender('${tenantC}', null, 'sms', null)`);
    expect(resolved.phone_number).toBe("+17745550103");
  });
});
