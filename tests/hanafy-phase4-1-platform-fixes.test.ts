import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = resolve(process.cwd(), "supabase/migrations");
const migrations = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();
const waynesWorkspaceId = "40000000-0000-4000-8000-000000000001";
const worcesterLocationId = "40000000-0000-4000-8000-000000000002";
const ownerId = "91000000-0000-4000-8000-000000000001";
const platformUserId = "91000000-0000-4000-8000-000000000002";

describe("Hanafy Platform Phase 4.1 fixes", () => {
  const database = new PGlite({ extensions: { pgcrypto } });

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
      insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
      values ('${ownerId}', 'owner@example.test', now(), '{"display_name":"Owner"}');
      update public.profiles set role_id = (select id from public.roles where code = 'owner'), active = true where id = '${ownerId}';
    `);
  }, 120_000);

  afterAll(async () => database.close());

  it("serves Wayne's storefront on every host it is published on, and nothing else", async () => {
    const hosts = ["waynes-pizza-pos.vercel.app", "WWW.WaynesPizzaOfWorcester.com.:443", "waynespizzaofworcester.com"];
    for (const host of hosts) {
      const result = await database.query<{ settings: { canonical_url: string } | null }>(
        "select public.hanafy_public_store_settings($1) as settings", [host],
      );
      expect(result.rows[0]?.settings?.canonical_url).toBe("https://waynespizzaofworcester.com");
    }
    const unknown = await database.query<{ settings: unknown }>("select public.hanafy_public_store_settings('waynes-pizza-pos-git-x.vercel.app') as settings");
    expect(unknown.rows[0]?.settings).toBeNull();
  });

  it("records Wayne's real AWS sender and switches off the unprovisioned email identity", async () => {
    const result = await database.query<{ channel: string; sender_address: string; provider: string; active: boolean }>(
      `select channel, case when channel = 'sms' then sender_address else '' end as sender_address, provider, active from public.workspace_messaging_identities
       where workspace_id = '${waynesWorkspaceId}' order by channel`,
    );
    expect(result.rows).toEqual([
      { channel: "email", sender_address: "", provider: "none", active: false },
      { channel: "sms", sender_address: "+15136764597", provider: "aws_end_user_messaging", active: true },
    ]);
  });

  it("enables the services Wayne's uses today and leaves email off", async () => {
    const result = await database.query<{ code: string }>(`
      select service.code from public.workspace_services workspace_service
      join public.service_catalog service on service.id = workspace_service.service_id
      where workspace_service.workspace_id = '${waynesWorkspaceId}' and public.hanafy_service_active(workspace_service.workspace_id, service.code)
      order by service.code`);
    const codes = result.rows.map((row) => row.code);
    expect(codes).toContain("sms");
    expect(codes).toContain("automations");
    expect(codes).not.toContain("email");
  });

  it("grants platform ownership only after the invited email is confirmed", async () => {
    await database.exec(`insert into auth.users (id, email, raw_user_meta_data) values ('${platformUserId}', 'HanafyMedia@gmail.com', '{}')`);
    const before = await database.query("select * from public.platform_users where auth_user_id = $1", [platformUserId]);
    expect(before.rows).toHaveLength(0);

    await database.exec(`update auth.users set email_confirmed_at = now() where id = '${platformUserId}'`);
    const after = await database.query<{ platform_role: string; active: boolean }>(
      "select platform_role, active from public.platform_users where auth_user_id = $1", [platformUserId],
    );
    expect(after.rows).toEqual([{ platform_role: "platform_owner", active: true }]);
    const membership = await database.query("select * from public.workspace_members where auth_user_id = $1 and status = 'active'", [platformUserId]);
    expect(membership.rows).toHaveLength(0);
  });

  it("keeps hardware settings identical in the new and legacy tables in both directions", async () => {
    await database.exec(`update public.location_hardware_configurations set configuration = configuration || '{"caller_line_count":3}'::jsonb where location_id = '${worcesterLocationId}'`);
    const legacy = await database.query<{ caller_line_count: number }>("select caller_line_count from public.pos_hardware_settings");
    expect(legacy.rows).toEqual([{ caller_line_count: 3 }]);

    await database.exec("update public.pos_hardware_settings set caller_udp_port = 4000");
    const current = await database.query<{ port: string }>(`select configuration ->> 'caller_udp_port' as port from public.location_hardware_configurations where location_id = '${worcesterLocationId}'`);
    expect(current.rows).toEqual([{ port: "4000" }]);

    await expect(database.exec(
      `update public.location_hardware_configurations set configuration = configuration || '{"caller_line_count":99}'::jsonb where location_id = '${worcesterLocationId}'`,
    )).rejects.toThrow();
  });

  it("keeps payment settings identical in the new and legacy tables", async () => {
    await database.exec(`update public.location_payment_configurations set provider = 'square', application_id = 'sq0idp-test', provider_location_id = 'L123' where location_id = '${worcesterLocationId}'`);
    const legacy = await database.query<{ provider: string; application_id: string; location_id: string }>(
      "select provider, application_id, location_id from public.payment_provider_settings",
    );
    expect(legacy.rows).toEqual([{ provider: "square", application_id: "sq0idp-test", location_id: "L123" }]);
  });

  it("mirrors caller lines to the legacy phone board", async () => {
    await database.exec(`insert into public.location_caller_lines (workspace_id, location_id, line_number, label) values ('${waynesWorkspaceId}', '${worcesterLocationId}', 3, 'Line 3')`);
    const legacy = await database.query<{ label: string }>("select label from public.store_phone_lines where line_number = 3");
    expect(legacy.rows).toEqual([{ label: "Line 3" }]);
  });

  it("saves website settings once, without the SEO about-title defect", async () => {
    await database.exec("update public.store_settings set seo_about_description = 'Original description'");
    await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${ownerId}', true);`);
    const saved = await database.query<{ saved: Record<string, unknown> }>(`select public.hanafy_save_location_settings('{"seo_about_title":"About us, really","ordering_open":false}'::jsonb) as saved`);
    await database.exec("commit");
    expect(saved.rows[0]?.saved).toMatchObject({ seo_about_title: "About us, really", ordering_open: false });
    const legacy = await database.query<{ seo_about_title: string; seo_about_description: string; ordering_open: boolean }>(
      "select seo_about_title, seo_about_description, ordering_open from public.store_settings",
    );
    expect(legacy.rows).toEqual([{ seo_about_title: "About us, really", seo_about_description: "Original description", ordering_open: false }]);
  });
});
