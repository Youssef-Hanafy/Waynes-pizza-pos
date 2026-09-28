import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const phase0 = readFileSync(resolve(process.cwd(), "supabase/migrations/20260908000000_phase0_foundation.sql"), "utf8");
const phase1 = readFileSync(resolve(process.cwd(), "supabase/migrations/20261002080000_phase1_core_tenancy.sql"), "utf8");

const waynesOwnerId = "50000000-0000-4000-8000-000000000001";
const otherOwnerId = "50000000-0000-4000-8000-000000000002";
const platformAdminId = "50000000-0000-4000-8000-000000000003";
const otherWorkspaceId = "60000000-0000-4000-8000-000000000001";

describe("Hanafy Platform Phase 1 tenancy database foundation", () => {
  const database = new PGlite();

  beforeAll(async () => {
    await database.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      create table auth.users (
        id uuid primary key,
        email text,
        raw_user_meta_data jsonb not null default '{}'::jsonb
      );
    `);
    await database.exec(phase0);
    await database.exec(phase1);
    await database.exec(`
      insert into auth.users (id, email) values
        ('${waynesOwnerId}', 'wayne-owner@test.local'),
        ('${otherOwnerId}', 'other-owner@test.local'),
        ('${platformAdminId}', 'platform-admin@test.local');
      update public.profiles
      set role_id = (select id from public.roles where code = 'owner')
      where id in ('${waynesOwnerId}', '${otherOwnerId}', '${platformAdminId}');
      insert into public.workspaces (id, slug, name)
      values ('${otherWorkspaceId}', 'other-tenant', 'Other tenant');
      insert into public.workspace_members (workspace_id, auth_user_id, workspace_role_id)
      select workspace.id, '${waynesOwnerId}', role.id
      from public.workspaces workspace cross join public.roles role
      where workspace.slug = 'waynes-pizza' and role.code = 'owner';
      insert into public.workspace_members (workspace_id, auth_user_id, workspace_role_id)
      select '${otherWorkspaceId}', '${otherOwnerId}', role.id
      from public.roles role where role.code = 'owner';
      insert into public.platform_users (auth_user_id, platform_role)
      values ('${platformAdminId}', 'platform_admin');
    `);
  }, 30_000);

  afterAll(async () => database.close());

  it("backfills active legacy staff into Wayne's workspace with their existing role", async () => {
    const result = await database.query<{ role: string }>(`
      select role.code as role
      from public.workspace_members membership
      join public.workspaces workspace on workspace.id = membership.workspace_id
      join public.roles role on role.id = membership.workspace_role_id
      where workspace.slug = 'waynes-pizza' and membership.auth_user_id = '${waynesOwnerId}'
    `);
    expect(result.rows).toEqual([{ role: "owner" }]);
  });

  it("isolates workspace, location, membership, and entitlement reads", async () => {
    await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${waynesOwnerId}', true);`);
    const workspaces = await database.query<{ slug: string }>("select slug from public.workspaces order by slug");
    const locations = await database.query<{ count: number }>("select count(*)::int as count from public.locations");
    const memberships = await database.query<{ count: number }>("select count(*)::int as count from public.workspace_members");
    const services = await database.query<{ count: number }>("select count(*)::int as count from public.workspace_services");
    await database.exec("rollback");

    expect(workspaces.rows).toEqual([{ slug: "waynes-pizza" }]);
    expect(locations.rows[0]?.count).toBe(1);
    expect(memberships.rows[0]?.count).toBe(1);
    expect(services.rows[0]?.count).toBeGreaterThan(0);
  });

  it("does not let a workspace member create membership in another tenant", async () => {
    await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${waynesOwnerId}', true);`);
    await expect(
      database.exec(`
        insert into public.workspace_members (workspace_id, auth_user_id, workspace_role_id)
        select '${otherWorkspaceId}', '${waynesOwnerId}', id from public.roles where code = 'owner'
      `)
    ).rejects.toThrow();
    await database.exec("rollback");
  });

  it("does not treat workspace ownership as platform administration", async () => {
    await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${waynesOwnerId}', true);`);
    const result = await database.query<{ platform: boolean; admin: boolean }>(`
      select public.hanafy_has_platform_access() as platform, public.hanafy_is_platform_admin() as admin
    `);
    await database.exec("rollback");
    expect(result.rows).toEqual([{ platform: false, admin: false }]);
  });

  it("gives an explicit platform administrator cross-workspace read access", async () => {
    await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${platformAdminId}', true);`);
    const workspaces = await database.query<{ count: number }>("select count(*)::int as count from public.workspaces");
    const context = await database.query<{ context: { is_platform_admin: boolean } }>(`
      select public.hanafy_workspace_context('${otherWorkspaceId}') as context
    `);
    await database.exec("rollback");

    expect(workspaces.rows[0]?.count).toBe(2);
    expect(context.rows[0]?.context.is_platform_admin).toBe(true);
  });

  it("enforces service entitlement and workspace permission checks", async () => {
    const waynesWorkspaceId = "40000000-0000-4000-8000-000000000001";
    await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${waynesOwnerId}', true);`);
    const result = await database.query<{ pos_enabled: boolean; sms_enabled: boolean; admin_allowed: boolean }>(`
      select
        public.hanafy_workspace_service_enabled('${waynesWorkspaceId}', 'pos') as pos_enabled,
        public.hanafy_workspace_service_enabled('${waynesWorkspaceId}', 'sms') as sms_enabled,
        public.hanafy_has_workspace_permission('${waynesWorkspaceId}', 'admin.access') as admin_allowed
    `);
    await database.exec("rollback");
    expect(result.rows).toEqual([{ pos_enabled: true, sms_enabled: false, admin_allowed: true }]);
  });
});
