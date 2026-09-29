import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = resolve(process.cwd(), "supabase/migrations");
const migrations = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();

const waynesWorkspaceId = "40000000-0000-4000-8000-000000000001";
const tenantA = "97800000-0000-4000-8000-00000000000a";
const tenantB = "97800000-0000-4000-8000-00000000000b";
const ownerA = "97800000-0000-4000-8000-000000000001";
const ownerB = "97800000-0000-4000-8000-000000000002";
const waynesOwner = "97800000-0000-4000-8000-000000000003";
const platformOwner = "97800000-0000-4000-8000-000000000004";
const customerA = "97800000-0000-4000-8000-0000000000a2";
const customerANoConsent = "97800000-0000-4000-8000-0000000000a3";
const customerB = "97800000-0000-4000-8000-0000000000b2";
const segmentA = "97800000-0000-4000-8000-0000000000d1";
const segmentB = "97800000-0000-4000-8000-0000000000d2";
const waynesCustomer = "97800000-0000-4000-8000-0000000000c1";

type Row = Record<string, unknown>;

describe("Hanafy Platform Phase 8 events + automations", () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  let automationA = "";
  let automationB = "";

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

  const event = (workspace: string, eventId: string, eventType: string, customer: string, data: Record<string, unknown> = {}) =>
    database.query(`select public.hanafy_record_domain_event('${JSON.stringify({ event_id: eventId, workspace_id: workspace, event_type: eventType, customer_id: customer, subject_type: "customer", subject_id: customer, data: { customer_id: customer, ...data } })}'::jsonb)`);

  const tick = () => one<{ result: { events: number; runs_created: number; runs_executed: number } }>(`select public.hanafy_automation_tick(200, 100) as result`);

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
        ('${ownerA}', 'a@example.test', now()), ('${ownerB}', 'b@example.test', now()),
        ('${waynesOwner}', 'waynes@example.test', now()), ('${platformOwner}', 'platform@hanafy.test', now());
      update public.profiles set role_id = (select id from public.roles where code = 'owner'), active = true where id = '${waynesOwner}';
      insert into public.platform_users (auth_user_id, platform_role, active) values ('${platformOwner}', 'platform_owner', true);
      insert into public.workspaces (id, slug, name) values ('${tenantA}', 'auto-a', 'Auto A'), ('${tenantB}', 'auto-b', 'Auto B');
      insert into public.locations (workspace_id, slug, name) values ('${tenantA}', 'main', 'A Main'), ('${tenantB}', 'main', 'B Main');
      insert into public.workspace_members (workspace_id, auth_user_id, workspace_role_id) values
        ('${tenantA}', '${ownerA}', (select id from public.roles where code = 'owner')),
        ('${tenantB}', '${ownerB}', (select id from public.roles where code = 'owner'));
      update public.profiles set active = true where id in ('${ownerA}', '${ownerB}');
      insert into public.workspace_services (workspace_id, service_id, status, source)
      select workspace.id, service.id, 'enabled', 'manual'
      from (values ('${tenantA}'::uuid), ('${tenantB}'::uuid)) workspace(id)
      cross join public.service_catalog service where service.code in ('crm', 'sms', 'automations', 'customer_segments');
      insert into public.messaging_connections (id, workspace_id, provider, status, aws_region, dispatch_mode) values
        ('97800000-0000-4000-8000-0000000000e1', '${tenantA}', 'aws_end_user_messaging', 'active', 'us-east-1', 'platform'),
        ('97800000-0000-4000-8000-0000000000e2', '${tenantB}', 'aws_end_user_messaging', 'active', 'us-east-1', 'platform');
      insert into public.messaging_origination_identities (workspace_id, messaging_connection_id, phone_number, status, is_default) values
        ('${tenantA}', '97800000-0000-4000-8000-0000000000e1', '+15085550201', 'active', true),
        ('${tenantB}', '97800000-0000-4000-8000-0000000000e2', '+16175550202', 'active', true);
      insert into public.customers (id, workspace_id, first_name, last_name, phone_normalized, sms_marketing_opt_in) values
        ('${customerA}', '${tenantA}', 'Amy', 'A', '+15085553001', true),
        ('${customerANoConsent}', '${tenantA}', 'Art', 'A', '+15085553002', false),
        ('${customerB}', '${tenantB}', 'Ben', 'B', '+16175554001', true);
      insert into public.customer_segments (id, workspace_id, name, description, rules_json) values
        ('${segmentA}', '${tenantA}', 'A inactive', '', '{"all": [{"field": "order_count", "value": 1, "operator": ">="}]}'::jsonb),
        ('${segmentB}', '${tenantB}', 'B inactive', '', '{"all": [{"field": "order_count", "value": 1, "operator": ">="}]}'::jsonb);
    `);
  }, 180_000);

  afterAll(async () => database.close());

  it("records domain events in the same transaction as the outbox and mirrors Wayne's CRM automations without running them", async () => {
    const mirrored = (await database.query<{ name: string; executor: string; status: string; trigger: string }>(`
      select automation.name, automation.executor, automation.status, version_row.trigger_event_type as trigger
      from public.automations automation join public.automation_versions version_row on version_row.id = automation.current_version_id
      where automation.workspace_id = '${waynesWorkspaceId}' order by automation.name`)).rows;
    expect(mirrored).toHaveLength(3);
    expect(mirrored.every((row) => row.executor === "legacy_crm")).toBe(true);
    expect(mirrored.find((row) => row.name === "Text club welcome")).toMatchObject({ status: "active", trigger: "customer.reward.issued" });

    await database.exec(`
      insert into public.integration_destinations (id, endpoint_url, business_id, signing_secret) values ('hanafy', 'https://crm.example.test/events', 'waynes-pizza', repeat('s', 40)) on conflict do nothing;
      insert into public.customers (id, workspace_id, first_name, last_name, phone_normalized, sms_marketing_opt_in) values ('${waynesCustomer}', '${waynesWorkspaceId}', 'Wes', 'W', '+15085559001', true);
      insert into public.integration_outbox (event_id, destination, event_type, payload, workspace_id) values
        ('97800000-0000-4000-8000-00000000f001', 'hanafy', 'customer.reward.issued',
         '{"event_id":"97800000-0000-4000-8000-00000000f001","source":"waynes-pos","version":1,"data":{"customer_id":"${waynesCustomer}","reward":{"code":"WAYNE1","discount_cents":450,"minimum_order_cents":2699,"expires_at":"2026-10-14T02:00:00Z"}}}'::jsonb,
         '${waynesWorkspaceId}');
    `);
    const recorded = await one<{ workspace_id: string; customer_id: string; subject_type: string; automation_status: string }>(
      `select workspace_id, customer_id, subject_type, automation_status from public.domain_events where event_id = '97800000-0000-4000-8000-00000000f001'`);
    expect(recorded).toEqual({ workspace_id: waynesWorkspaceId, customer_id: waynesCustomer, subject_type: "customer", automation_status: "pending" });

    const context = await one<{ context: Record<string, string> }>(`select public.hanafy_event_message_context('97800000-0000-4000-8000-00000000f001') as context`);
    expect(context.context).toMatchObject({ first_name: "Wes", reward_code: "WAYNE1", reward_minimum: "$26.99", reward_amount: "$4.50", reward_expires: "Oct 13" });

    await tick();
    const after = await one<{ automation_status: string; runs: number }>(`
      select automation_status, (select count(*)::int from public.automation_runs where event_id = '97800000-0000-4000-8000-00000000f001') as runs
      from public.domain_events where event_id = '97800000-0000-4000-8000-00000000f001'`);
    expect(after).toEqual({ automation_status: "processed", runs: 0 });
  });

  it("refuses to switch on a texting automation while a business still sends from the old CRM, and lets only platform admins adopt", async () => {
    const waynes = await one<{ id: string }>(`select id from public.automations where workspace_id = '${waynesWorkspaceId}' and name = 'Text club welcome'`);
    await expect(commitAs(waynesOwner, `select public.hanafy_automation_set_status('waynes-pizza', '${waynes.id}', 'paused')`)).rejects.toThrow("runs in the Hanafy CRM");
    await expect(commitAs(waynesOwner, `select public.hanafy_platform_adopt_legacy_automations('waynes-pizza', 'owner tries')`)).rejects.toThrow("Hanafy platform access required");
    await expect(commitAs(platformOwner, `select public.hanafy_platform_adopt_legacy_automations('waynes-pizza', 'too early cut over')`)).rejects.toThrow("Switch this business");

    const [created] = await commitAs<{ id: string }>(waynesOwner, `select public.hanafy_automation_save('waynes-pizza', '{"name":"Birthday","trigger_event_type":"customer.updated","actions":[{"type":"send_sms","body":"hi"}]}'::jsonb) as id`);
    await expect(commitAs(waynesOwner, `select public.hanafy_automation_set_status('waynes-pizza', '${created?.id}', 'active')`)).rejects.toThrow("LEGACY_CRM_SENDS");
  });

  it("creates exactly one run for a segment-enter event, and a duplicate event sends nothing more", async () => {
    const [saved] = await commitAs<{ id: string }>(ownerA, `select public.hanafy_automation_save('auto-a', '${JSON.stringify({
      name: "Win-back",
      trigger_event_type: "customer.segment.entered",
      trigger_filters: { segment_id: segmentA },
      conditions: [{ field: "sms_marketing_opt_in", operator: "=", value: "true" }],
      actions: [{ type: "send_sms", body: "{{business_name}}: we miss you {{first_name}}! Reply STOP to opt out" }, { type: "add_tag", tag: "winback" }],
      cooldown_hours: 720,
    })}'::jsonb) as id`);
    automationA = saved?.id as string;
    await commitAs(ownerA, `select public.hanafy_automation_set_status('auto-a', '${automationA}', 'active')`);

    const [savedB] = await commitAs<{ id: string }>(ownerB, `select public.hanafy_automation_save('auto-b', '${JSON.stringify({
      name: "B win-back", trigger_event_type: "customer.segment.entered", actions: [{ type: "send_sms", body: "B says hi" }],
    })}'::jsonb) as id`);
    automationB = savedB?.id as string;
    await commitAs(ownerB, `select public.hanafy_automation_set_status('auto-b', '${automationB}', 'active')`);

    await event(tenantA, "97800000-0000-4000-8000-00000000a001", "customer.segment.entered", customerA, { segment_id: segmentA });
    await event(tenantA, "97800000-0000-4000-8000-00000000a001", "customer.segment.entered", customerA, { segment_id: segmentA });
    const stored = await one<{ count: number }>(`select count(*)::int as count from public.domain_events where event_id = '97800000-0000-4000-8000-00000000a001'`);
    expect(stored.count).toBe(1);

    const first = await tick();
    expect(first.result.runs_created).toBe(1);
    const runs = (await database.query<{ automation_id: string; status: string; workspace_id: string }>(`
      select automation_id, status, workspace_id from public.automation_runs where event_id = '97800000-0000-4000-8000-00000000a001'`)).rows;
    expect(runs).toEqual([{ automation_id: automationA, status: "completed", workspace_id: tenantA }]);

    const jobs = (await database.query<{ body: string; sender: string; idempotency_key: string }>(`
      select job.body, identity.phone_number as sender, job.idempotency_key from public.message_jobs job
      join public.messaging_origination_identities identity on identity.id = job.origin_identity_id
      where job.automation_run_id is not null and job.workspace_id = '${tenantA}'`)).rows;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ body: "Auto A: we miss you Amy! Reply STOP to opt out", sender: "+15085550201" });
    const tag = await one<{ count: number }>(`select count(*)::int as count from public.customer_tags where customer_id = '${customerA}' and tag = 'winback'`);
    expect(tag.count).toBe(1);

    // Replaying the same event, re-running the worker, or re-executing the run changes nothing.
    const [replay] = await commitAs<{ result: { created: boolean } }>(ownerA, `select public.hanafy_automation_replay_event('auto-a', '${automationA}', '97800000-0000-4000-8000-00000000a001', 'customer says no text came') as result`);
    expect(replay?.result.created).toBe(false);
    await tick();
    const runId = await one<{ id: string }>(`select id from public.automation_runs where event_id = '97800000-0000-4000-8000-00000000a001'`);
    await database.exec(`update public.automation_runs set status = 'waiting' where id = '${runId.id}'`);
    await database.exec(`select public.hanafy_automation_execute('${runId.id}')`);
    const total = await one<{ count: number }>(`select count(*)::int as count from public.message_jobs where automation_run_id is not null and workspace_id = '${tenantA}'`);
    expect(total.count).toBe(1);
    const audit = await one<{ count: number }>(`select count(*)::int as count from public.audit_log where action = 'automation.replayed' and workspace_id = '${tenantA}'`);
    expect(audit.count).toBe(1);

    // Tenant B's automation on the same event type never ran for A's event.
    const bRuns = await one<{ count: number }>(`select count(*)::int as count from public.automation_runs where automation_id = '${automationB}'`);
    expect(bRuns.count).toBe(0);
  });

  it("explains why an automation did not run", async () => {
    await event(tenantA, "97800000-0000-4000-8000-00000000a002", "customer.segment.entered", customerANoConsent, { segment_id: segmentA });
    await event(tenantA, "97800000-0000-4000-8000-00000000a003", "customer.segment.entered", customerA, { segment_id: "97800000-0000-4000-8000-0000000000ff" });
    await event(tenantA, "97800000-0000-4000-8000-00000000a004", "customer.segment.entered", customerA, { segment_id: segmentA });
    await tick();
    const noConsent = await one<{ status: string; outcome: string }>(`select status, outcome from public.automation_runs where event_id = '97800000-0000-4000-8000-00000000a002'`);
    expect(noConsent.status).toBe("skipped");
    expect(noConsent.outcome).toContain("sms_marketing_opt_in = true (was false)");
    const wrongSegment = await one<{ count: number; message: string }>(`
      select count(*)::int as count, max(message) as message from public.automation_run_log where event_id = '97800000-0000-4000-8000-00000000a003' and code = 'filter_mismatch'`);
    expect(wrongSegment.count).toBe(1);
    expect(wrongSegment.message).toContain("needs " + segmentA);
    const cooldown = await one<{ status: string; outcome: string }>(`select status, outcome from public.automation_runs where event_id = '97800000-0000-4000-8000-00000000a004'`);
    expect(cooldown).toMatchObject({ status: "skipped" });
    expect(cooldown.outcome).toContain("cooldown");

    const [detail] = await as<{ detail: { runs: unknown[]; log: Array<{ message: string }> } }>(ownerA, `select public.hanafy_automation_detail('auto-a', '${automationA}') as detail`);
    expect(detail?.detail.runs.length).toBeGreaterThan(2);
    expect(detail?.detail.log.some((line) => line.message.includes("did not run"))).toBe(true);
    await expect(as(ownerB, `select public.hanafy_automation_detail('auto-b', '${automationA}')`)).rejects.toThrow("Automation not found");
    await expect(as(ownerB, `select public.hanafy_automation_detail('auto-a', '${automationA}')`)).rejects.toThrow("permission");
  });

  it("never runs another business's workflow and never lets one business's event point at another's customer", async () => {
    await event(tenantB, "97800000-0000-4000-8000-00000000b001", "customer.segment.entered", customerB, { segment_id: segmentB });
    await tick();
    const runs = (await database.query<{ automation_id: string }>(`select automation_id from public.automation_runs where event_id = '97800000-0000-4000-8000-00000000b001'`)).rows;
    expect(runs).toEqual([{ automation_id: automationB }]);
    const job = await one<{ sender: string; body: string }>(`
      select identity.phone_number as sender, job.body from public.message_jobs job
      join public.messaging_origination_identities identity on identity.id = job.origin_identity_id
      where job.workspace_id = '${tenantB}' and job.automation_run_id is not null`);
    expect(job).toEqual({ sender: "+16175550202", body: "B says hi" });

    await expect(event(tenantB, "97800000-0000-4000-8000-00000000b002", "customer.segment.entered", customerA)).rejects.toThrow("CUSTOMER_NOT_IN_WORKSPACE");
    await expect(database.exec(`select public.hanafy_automation_evaluate('${automationB}', '97800000-0000-4000-8000-00000000a001')`)).resolves.toBeDefined();
    const crossed = await one<{ count: number }>(`select count(*)::int as count from public.automation_runs where automation_id = '${automationB}' and event_id = '97800000-0000-4000-8000-00000000a001'`);
    expect(crossed.count).toBe(0);
    // An outbox payload naming another business's customer is recorded without that customer.
    await database.exec(`
      insert into public.integration_outbox (event_id, destination, event_type, payload, workspace_id) values
        ('97800000-0000-4000-8000-00000000f002', 'hanafy', 'customer.updated', '{"data":{"customer_id":"${customerB}"}}'::jsonb, '${waynesWorkspaceId}')`);
    const stripped = await one<{ customer_id: string | null }>(`select customer_id from public.domain_events where event_id = '97800000-0000-4000-8000-00000000f002'`);
    expect(stripped.customer_id).toBeNull();
  });

  it("keeps versions immutable, waits for delays and pauses with the automations service", async () => {
    await expect(database.exec(`update public.automation_versions set delay_minutes = 5 where automation_id = '${automationB}'`)).rejects.toThrow("cannot be changed");
    await commitAs(ownerB, `select public.hanafy_automation_save('auto-b', '${JSON.stringify({
      id: automationB, name: "B win-back", trigger_event_type: "customer.segment.entered", delay_minutes: 30, actions: [{ type: "send_sms", body: "B later" }],
    })}'::jsonb)`);
    const versions = await one<{ count: number; current: number }>(`
      select count(*)::int as count, (select v.version from public.automation_versions v join public.automations a on a.current_version_id = v.id where a.id = '${automationB}') as current
      from public.automation_versions where automation_id = '${automationB}'`);
    expect(versions).toEqual({ count: 2, current: 2 });

    await event(tenantB, "97800000-0000-4000-8000-00000000b003", "customer.segment.entered", customerB);
    await tick();
    const waiting = await one<{ status: string }>(`select status from public.automation_runs where event_id = '97800000-0000-4000-8000-00000000b003'`);
    expect(waiting.status).toBe("waiting");

    await database.exec(`update public.workspace_services set status = 'disabled', disabled_at = now() where workspace_id = '${tenantB}' and service_id = (select id from public.service_catalog where code = 'automations')`);
    await database.exec(`update public.automation_runs set due_at = now() - interval '1 minute' where event_id = '97800000-0000-4000-8000-00000000b003'`);
    await event(tenantB, "97800000-0000-4000-8000-00000000b004", "customer.segment.entered", customerB);
    await tick();
    const paused = await one<{ run: string; event: string }>(`
      select (select status from public.automation_runs where event_id = '97800000-0000-4000-8000-00000000b003') as run,
             (select automation_status from public.domain_events where event_id = '97800000-0000-4000-8000-00000000b004') as event`);
    expect(paused).toEqual({ run: "waiting", event: "skipped" });
    await expect(as(ownerB, `select public.hanafy_automations_overview('auto-b')`)).rejects.toThrow("permission");

    await database.exec(`update public.workspace_services set status = 'enabled', disabled_at = null where workspace_id = '${tenantB}' and service_id = (select id from public.service_catalog where code = 'automations')`);
    await tick();
    const resumed = await one<{ status: string }>(`select status from public.automation_runs where event_id = '97800000-0000-4000-8000-00000000b003'`);
    expect(resumed.status).toBe("completed");
  });

  it("keeps automation data inside each business and closed to anonymous callers", async () => {
    const [seen] = await as<{ automations: number; runs: number; events: number }>(ownerB, `
      select (select count(*)::int from public.automations where workspace_id = '${tenantA}') as automations,
             (select count(*)::int from public.automation_runs where workspace_id = '${tenantA}') as runs,
             (select count(*)::int from public.domain_events where workspace_id = '${tenantA}') as events`);
    expect(seen).toEqual({ automations: 0, runs: 0, events: 0 });
    await expect(as(ownerA, `select public.hanafy_automation_tick(10, 10)`)).rejects.toThrow("permission denied");
    await expect(as(ownerA, `select public.hanafy_record_domain_event('{"workspace_id":"${tenantA}","event_type":"customer.updated"}'::jsonb)`)).rejects.toThrow("permission denied");
    await expect(as(ownerA, `insert into public.automation_runs (workspace_id, automation_id, version_id, event_id) select '${tenantA}', id, current_version_id, '97800000-0000-4000-8000-00000000a001' from public.automations where id = '${automationA}'`)).rejects.toThrow("permission denied");
  });
});
