import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = resolve(process.cwd(), "supabase/migrations");
const migrations = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();

const waynesWorkspaceId = "40000000-0000-4000-8000-000000000001";
const tenantWorkspaceId = "98000000-0000-4000-8000-000000000001";
const tenantLocationId = "98000000-0000-4000-8000-000000000002";
const platformOwnerId = "97100000-0000-4000-8000-000000000001";
const platformSupportId = "97100000-0000-4000-8000-000000000002";
const platformReadOnlyId = "97100000-0000-4000-8000-000000000003";
const waynesOwnerId = "97100000-0000-4000-8000-000000000004";
const tenantOwnerId = "97100000-0000-4000-8000-000000000005";
const spareUserId = "97100000-0000-4000-8000-000000000006";

type Row = Record<string, unknown>;

describe("Hanafy Platform Phase 6 Platform Admin foundation", () => {
  const database = new PGlite({ extensions: { pgcrypto } });

  /** Runs as a signed-in user and rolls back. */
  async function as<T extends Row>(userId: string, sql: string) {
    await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${userId}', true);`);
    try {
      return (await database.query<T>(sql)).rows;
    } finally {
      await database.exec("rollback");
    }
  }

  /** Runs as a signed-in user and keeps the result. */
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
        ('${platformOwnerId}', 'owner@hanafy.test', now()),
        ('${platformSupportId}', 'support@hanafy.test', now()),
        ('${platformReadOnlyId}', 'readonly@hanafy.test', now()),
        ('${waynesOwnerId}', 'waynes-owner@example.test', now()),
        ('${tenantOwnerId}', 'tenant-owner@example.test', now()),
        ('${spareUserId}', 'spare@example.test', now());
      insert into public.platform_users (auth_user_id, platform_role, active) values
        ('${platformOwnerId}', 'platform_owner', true),
        ('${platformSupportId}', 'platform_support', true),
        ('${platformReadOnlyId}', 'platform_read_only', true);
      update public.profiles set role_id = (select id from public.roles where code = 'owner'), active = true where id = '${waynesOwnerId}';
      insert into public.workspaces (id, slug, name) values ('${tenantWorkspaceId}', 'tenant-six', 'Tenant Six');
      insert into public.locations (id, workspace_id, slug, name) values ('${tenantLocationId}', '${tenantWorkspaceId}', 'main', 'Tenant Main');
      insert into public.workspace_members (workspace_id, auth_user_id, workspace_role_id)
      values ('${tenantWorkspaceId}', '${tenantOwnerId}', (select id from public.roles where code = 'owner'));
      update public.profiles set active = true where id = '${tenantOwnerId}';
      insert into public.workspace_services (workspace_id, service_id, status, source)
      select '${tenantWorkspaceId}', id, 'enabled', 'manual' from public.service_catalog where code = 'pos';
    `);
  }, 180_000);

  afterAll(async () => database.close());

  it("keeps ordinary business owners out of the Platform Admin console", async () => {
    const [me] = await as<{ me: unknown; role: unknown }>(waynesOwnerId, "select public.hanafy_platform_me() as me, public.hanafy_platform_role() as role");
    expect(me?.me).toBeNull();
    expect(me?.role).toBeNull();
    for (const call of [
      "select public.hanafy_platform_dashboard()",
      "select public.hanafy_platform_workspaces()",
      "select public.hanafy_platform_workspace_detail('waynes-pizza')",
      "select public.hanafy_platform_workspace_members('waynes-pizza')",
      "select public.hanafy_platform_workspace_audit('waynes-pizza', 50)",
      "select public.hanafy_platform_audit(50)",
      "select public.hanafy_platform_set_service('waynes-pizza', 'pos', 'disabled', 'manual', null, null, 'owner tries', true)",
      "select public.hanafy_platform_set_member('waynes-pizza', 'spare@example.test', 'owner', 'active', 'owner tries')",
      "select public.hanafy_platform_start_support('waynes-pizza', 'owner tries to support', null, 60)",
    ]) {
      await expect(as(waynesOwnerId, call)).rejects.toThrow("Hanafy platform access required");
    }
    const [logs] = await as<{ count: number }>(waynesOwnerId, "select count(*)::int as count from public.platform_audit_log");
    expect(logs?.count).toBe(0);
  });

  it("gives a platform owner no silent access inside a business", async () => {
    const [row] = await as<{ orders: boolean; data: boolean; access: unknown; context: { permissions: string[]; support_session: unknown } }>(platformOwnerId, `
      select public.hanafy_has_workspace_permission('${waynesWorkspaceId}', 'orders.view') as orders,
             public.hanafy_can_access_workspace_data('${waynesWorkspaceId}', array['orders.view', 'menu.manage']) as data,
             public.hanafy_current_workspace_access('waynes-pizza') as access,
             public.hanafy_workspace_context('${waynesWorkspaceId}') as context`);
    expect(row?.orders).toBe(false);
    expect(row?.data).toBe(false);
    expect(row?.access).toBeNull();
    expect(row?.context.permissions).toEqual([]);
    expect(row?.context.support_session).toBeNull();
  });

  it("shows platform staff the dashboard, the business list and each business", async () => {
    const [row] = await as<{ me: { platform_role: string; can_manage: boolean }; dashboard: { workspaces: { total: number }; workspace_rows: Array<{ slug: string; health: { level: string } }>; billing: unknown }; detail: { slug: string; service_catalog: Array<{ code: string; effective: boolean; requires_any: string[] }>; counts: { customers: number } }; members: { members: Array<{ email: string; role: string }>; roles: Array<{ code: string }> } }>(
      platformReadOnlyId, `
      select public.hanafy_platform_me() as me,
             public.hanafy_platform_dashboard() as dashboard,
             public.hanafy_platform_workspace_detail('tenant-six') as detail,
             public.hanafy_platform_workspace_members('waynes-pizza') as members`);
    expect(row?.me).toMatchObject({ platform_role: "platform_read_only", can_manage: false });
    expect(Number(row?.dashboard.workspaces.total)).toBe(2);
    expect(row?.dashboard.workspace_rows.map((workspace) => workspace.slug).sort()).toEqual(["tenant-six", "waynes-pizza"]);
    // Phase 11 filled in Hanafy billing: nothing is owed until an agreement is recorded.
    expect(row?.dashboard.billing).toMatchObject({ monthly_recurring_cents: 0, open_balance_cents: 0, equipment_balance_cents: 0 });
    expect(row?.detail.slug).toBe("tenant-six");
    expect(row?.detail.service_catalog.find((service) => service.code === "pos")?.effective).toBe(true);
    expect(row?.detail.service_catalog.find((service) => service.code === "sms")?.requires_any).toEqual(["crm"]);
    expect(row?.members.members.map((member) => member.email)).toContain("waynes-owner@example.test");
    expect(row?.members.roles.map((role) => role.code)).toContain("owner");

    // Read-only staff cannot change anything.
    await expect(as(platformReadOnlyId, "select public.hanafy_platform_set_service('tenant-six', 'crm', 'enabled', 'manual', null, null, 'try', false)")).rejects.toThrow("Hanafy platform access required");
    await expect(as(platformReadOnlyId, "select public.hanafy_platform_start_support('tenant-six', 'read only tries', null, 60)")).rejects.toThrow("Hanafy platform access required");
  });

  it("enforces service requirements and asks before switching off a business-critical service", async () => {
    await expect(as(platformOwnerId, "select public.hanafy_platform_set_service('tenant-six', 'sms', 'enabled', 'manual', null, null, 'turn on texting', false)"))
      .rejects.toThrow("needs CRM turned on first");
    await expect(as(platformOwnerId, "select public.hanafy_platform_set_service('tenant-six', 'crm', 'enabled', 'manual', null, null, '', false)"))
      .rejects.toThrow("Give a reason");

    const [crm] = await commitAs<{ result: { status: string; effective: boolean } }>(platformOwnerId,
      "select public.hanafy_platform_set_service('tenant-six', 'crm', 'enabled', 'custom_contract', null, null, 'Signed CRM add-on', false) as result");
    expect(crm?.result).toMatchObject({ status: "saved", effective: true });
    await commitAs(platformOwnerId, "select public.hanafy_platform_set_service('tenant-six', 'sms', 'trial', 'manual', null, null, 'Two week SMS trial', false)");

    await expect(as(platformOwnerId, "select public.hanafy_platform_set_service('tenant-six', 'crm', 'disabled', 'manual', null, null, 'cancel crm', true)"))
      .rejects.toThrow("Turn off SMS first");

    const [ask] = await as<{ result: { status: string; warnings: string[] } }>(platformOwnerId,
      "select public.hanafy_platform_set_service('tenant-six', 'pos', 'disabled', 'manual', null, null, 'Closing account', false) as result");
    expect(ask?.result.status).toBe("needs_confirmation");
    expect(ask?.result.warnings[0]).toContain("register");

    // Every business-critical switch explains itself before it happens.
    await commitAs(platformOwnerId, "select public.hanafy_platform_set_service('tenant-six', 'online_ordering', 'enabled', 'manual', null, null, 'Online ordering add-on', false)");
    for (const code of ["pos", "online_ordering", "sms"]) {
      const [warned] = await as<{ result: { status: string; warnings: string[] } }>(platformOwnerId,
        `select public.hanafy_platform_set_service('tenant-six', '${code}', 'suspended', 'manual', null, null, 'Checking the warning', false) as result`);
      expect(warned?.result.status).toBe("needs_confirmation");
      expect(warned?.result.warnings.length).toBeGreaterThan(0);
    }

    const [done] = await commitAs<{ result: { status: string; effective: boolean } }>(platformOwnerId,
      "select public.hanafy_platform_set_service('tenant-six', 'pos', 'disabled', 'manual', null, null, 'Closing account', true) as result");
    expect(done?.result).toMatchObject({ status: "saved", effective: false });
    const [owner] = await as<{ allowed: boolean }>(tenantOwnerId, `select public.hanafy_has_workspace_permission('${tenantWorkspaceId}', 'pos.access') as allowed`);
    expect(owner?.allowed).toBe(false);

    // A service scheduled to end in the past is not effective.
    await commitAs(platformOwnerId, "select public.hanafy_platform_set_service('tenant-six', 'pos', 'enabled', 'plan', now() - interval '2 days', now() - interval '1 day', 'Expired plan window', true)");
    const expired = await database.query<{ active: boolean }>(`select public.hanafy_service_active('${tenantWorkspaceId}', 'pos') as active`);
    expect(expired.rows[0]?.active).toBe(false);
    await commitAs(platformOwnerId, "select public.hanafy_platform_set_service('tenant-six', 'pos', 'enabled', 'manual', null, null, 'Reinstated', true)");

    // Every change is in the platform log and in the business's own audit log.
    const platformRows = await database.query<{ action: string; reason: string }>(
      `select action, reason from public.platform_audit_log where workspace_id = '${tenantWorkspaceId}' and action = 'platform.service_changed' order by id`);
    expect(platformRows.rows.map((row) => row.reason)).toEqual(["Signed CRM add-on", "Two week SMS trial", "Online ordering add-on", "Closing account", "Expired plan window", "Reinstated"]);
    const businessRows = await as<{ actor_type: string; actor_name: string }>(tenantOwnerId,
      "select actor_type, actor_name from public.audit_log where action = 'platform.service_changed'");
    expect(businessRows).toHaveLength(6);
    expect(businessRows[0]).toMatchObject({ actor_type: "platform_user" });
    expect(businessRows[0]?.actor_name).toContain("(Hanafy)");
  });

  it("manages a business's users and never removes its last owner", async () => {
    await expect(as(platformOwnerId, "select public.hanafy_platform_set_member('tenant-six', 'tenant-owner@example.test', 'manager', 'active', 'demote')"))
      .rejects.toThrow("At least one active owner is required");
    await expect(as(platformOwnerId, "select public.hanafy_platform_set_member('tenant-six', 'nobody@example.test', 'cashier', 'active', 'add')"))
      .rejects.toThrow("No account uses that email");

    await commitAs(platformOwnerId, "select public.hanafy_platform_set_member('tenant-six', 'spare@example.test', 'cashier', 'active', 'New cashier')");
    const [member] = await as<{ access: { workspace_slug: string; role: string } }>(spareUserId, "select public.hanafy_current_workspace_access('tenant-six') as access");
    expect(member?.access).toMatchObject({ workspace_slug: "tenant-six", role: "cashier" });
    // Joining another business never enrols the account in Wayne's.
    const waynes = await database.query(`select 1 from public.workspace_members where workspace_id = '${waynesWorkspaceId}' and auth_user_id = '${spareUserId}'`);
    expect(waynes.rows).toHaveLength(0);

    await commitAs(platformOwnerId, "select public.hanafy_platform_set_member('tenant-six', 'spare@example.test', 'cashier', 'suspended', 'Left the job')");
    const [suspended] = await as<{ access: unknown }>(spareUserId, "select public.hanafy_current_workspace_access('tenant-six') as access");
    expect(suspended?.access).toBeNull();

    // Wayne's keeps staff on profiles: the change lands there and in the membership.
    await commitAs(platformOwnerId, "select public.hanafy_platform_set_member('waynes-pizza', 'support@hanafy.test', 'manager', 'active', 'Test manager account')");
    const legacy = await database.query<{ role: string; active: boolean; status: string }>(`
      select role.code as role, profile.active, membership.status
      from public.profiles profile join public.roles role on role.id = profile.role_id
      join public.workspace_members membership on membership.auth_user_id = profile.id and membership.workspace_id = '${waynesWorkspaceId}'
      where profile.id = '${platformSupportId}'`);
    expect(legacy.rows).toEqual([{ role: "manager", active: true, status: "active" }]);
    await commitAs(platformOwnerId, "select public.hanafy_platform_set_member('waynes-pizza', 'support@hanafy.test', 'manager', 'suspended', 'Remove test manager')");
    const removed = await database.query<{ active: boolean }>(`select active from public.profiles where id = '${platformSupportId}'`);
    expect(removed.rows).toEqual([{ active: false }]);
  });

  it("lets Hanafy act inside a business only in an audited, time-limited support session", async () => {
    await expect(as(platformOwnerId, "select public.hanafy_platform_start_support('waynes-pizza', 'x', null, 60)")).rejects.toThrow("Say why");
    await expect(as(platformOwnerId, "select public.hanafy_platform_start_support('waynes-pizza', 'Menu price fix', null, 600)")).rejects.toThrow("between 15 minutes and 8 hours");

    const [started] = await commitAs<{ session: { id: string; workspace_slug: string } }>(platformOwnerId,
      "select public.hanafy_platform_start_support('waynes-pizza', 'Owner asked for a menu price fix', 'TICKET-7', 30) as session");
    expect(started?.session.workspace_slug).toBe("waynes-pizza");

    const [inside] = await as<{ menu: boolean; tenant: boolean; access: { role: string; display_name: string; permissions: string[]; support_session: { id: string } }; context: { permissions: string[] } }>(platformOwnerId, `
      select public.hanafy_has_workspace_permission('${waynesWorkspaceId}', 'menu.manage') as menu,
             public.hanafy_has_workspace_permission('${tenantWorkspaceId}', 'pos.access') as tenant,
             public.hanafy_current_workspace_access('waynes-pizza') as access,
             public.hanafy_workspace_context('${waynesWorkspaceId}') as context`);
    expect(inside?.menu).toBe(true);
    expect(inside?.tenant).toBe(false); // only the one business
    expect(inside?.access.role).toBe("hanafy_support");
    expect(inside?.access.display_name).toContain("(Hanafy support)");
    expect(inside?.access.permissions).toContain("menu.manage");
    expect(inside?.access.support_session.id).toBe(started?.session.id);
    expect(inside?.context.permissions).toContain("menu.manage");

    // Anything written to the audit log during the session is stamped with it.
    // (as a SECURITY DEFINER RPC would write it, with the caller's identity)
    await database.exec(`begin; select set_config('request.jwt.claim.sub', '${platformOwnerId}', true);
      select public.wayne_write_audit('menu_items.update', 'menu_items', 'probe', 'Changed a price', '{}'::jsonb, '{}'::jsonb); commit;`);
    const stamped = await database.query<{ actor_type: string; support_session_id: string; actor_name: string }>(
      "select actor_type, support_session_id, actor_name from public.audit_log where entity_id = 'probe'");
    expect(stamped.rows).toHaveLength(1);
    expect(stamped.rows[0]).toMatchObject({ actor_type: "platform_user", support_session_id: started?.session.id });
    expect(stamped.rows[0]?.actor_name).toContain("(Hanafy support)");

    // The business can see that Hanafy was inside, and why.
    const [visible] = await as<{ reason: string; ticket_reference: string }>(waynesOwnerId, "select reason, ticket_reference from public.platform_support_sessions");
    expect(visible).toMatchObject({ reason: "Owner asked for a menu price fix", ticket_reference: "TICKET-7" });
    const other = await as(tenantOwnerId, "select * from public.platform_support_sessions");
    expect(other).toHaveLength(0);

    // Ending it removes access at once.
    await commitAs(platformOwnerId, "select public.hanafy_platform_end_support()");
    const [after] = await as<{ menu: boolean; access: unknown }>(platformOwnerId,
      `select public.hanafy_has_workspace_permission('${waynesWorkspaceId}', 'menu.manage') as menu, public.hanafy_current_workspace_access('waynes-pizza') as access`);
    expect(after).toEqual({ menu: false, access: null });
    const actions = await database.query<{ action: string }>(`select action from public.platform_audit_log where support_session_id = '${started?.session.id}' order by id`);
    expect(actions.rows.map((row) => row.action)).toEqual(["platform.support_started", "platform.support_ended"]);
  });

  it("gives platform support read-only support access and expires sessions on time", async () => {
    await commitAs(platformSupportId, "select public.hanafy_platform_start_support('waynes-pizza', 'Checking a missing order', null, 15)");
    const [row] = await as<{ orders: boolean; menu: boolean; settings: boolean }>(platformSupportId, `
      select public.hanafy_has_workspace_permission('${waynesWorkspaceId}', 'orders.view') as orders,
             public.hanafy_has_workspace_permission('${waynesWorkspaceId}', 'menu.manage') as menu,
             public.hanafy_has_workspace_permission('${waynesWorkspaceId}', 'settings.manage') as settings`);
    expect(row).toEqual({ orders: true, menu: false, settings: false });

    await database.exec(`update public.platform_support_sessions set started_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'
      where platform_auth_user_id = '${platformSupportId}' and ended_at is null`);
    const [expired] = await as<{ orders: boolean }>(platformSupportId, `select public.hanafy_has_workspace_permission('${waynesWorkspaceId}', 'orders.view') as orders`);
    expect(expired?.orders).toBe(false);

    // Deactivating a platform user ends their access even inside a live session.
    await commitAs(platformOwnerId, "select public.hanafy_platform_start_support('tenant-six', 'Setting up the menu', null, 60)");
    await database.exec(`update public.platform_users set active = false where auth_user_id = '${platformOwnerId}'`);
    const [revoked] = await as<{ pos: boolean }>(platformOwnerId, `select public.hanafy_has_workspace_permission('${tenantWorkspaceId}', 'pos.access') as pos`);
    expect(revoked?.pos).toBe(false);
    await database.exec(`update public.platform_users set active = true where auth_user_id = '${platformOwnerId}'`);
    await commitAs(platformOwnerId, "select public.hanafy_platform_end_support()");
  });

  it("keeps the platform audit log append-only and the console functions closed to anonymous callers", async () => {
    await expect(database.exec("update public.platform_audit_log set summary = 'edited'")).rejects.toThrow();
    await expect(database.exec("delete from public.platform_audit_log")).rejects.toThrow();
    const grants = await database.query<{ name: string; anon: boolean; authenticated: boolean }>(`
      select proname as name, has_function_privilege('anon', oid, 'execute') as anon, has_function_privilege('authenticated', oid, 'execute') as authenticated
      from pg_proc where pronamespace = 'public'::regnamespace
        and proname in ('hanafy_platform_dashboard', 'hanafy_platform_set_service', 'hanafy_platform_write_audit', 'hanafy_platform_workspace_health')
      order by proname`);
    expect(grants.rows).toEqual([
      { name: "hanafy_platform_dashboard", anon: false, authenticated: true },
      { name: "hanafy_platform_set_service", anon: false, authenticated: true },
      { name: "hanafy_platform_workspace_health", anon: false, authenticated: false },
      { name: "hanafy_platform_write_audit", anon: false, authenticated: false },
    ]);
  });
});
