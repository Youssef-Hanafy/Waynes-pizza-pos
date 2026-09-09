import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260908000000_phase0_foundation.sql"),
  "utf8"
);

const ownerId = "30000000-0000-4000-8000-000000000001";
const cashierId = "30000000-0000-4000-8000-000000000002";
const unknownId = "30000000-0000-4000-8000-000000000099";

describe("Phase 0 clean database and RLS", () => {
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
    await database.exec(migration);
    await database.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values
        ('${ownerId}', 'owner@test.local', '{"display_name":"Test Owner"}'),
        ('${cashierId}', 'cashier@test.local', '{"display_name":"Test Cashier"}');
      update public.profiles
      set role_id = (select id from public.roles where code = 'owner')
      where id = '${ownerId}';
    `);
  }, 30_000);

  afterAll(async () => database.close());

  it("applies the complete migration to an empty PostgreSQL database", async () => {
    const result = await database.query<{ table_name: string }>(`
      select table_name from information_schema.tables
      where table_schema = 'public'
      order by table_name
    `);
    expect(result.rows.map((row) => row.table_name)).toEqual(["permissions", "profiles", "role_permissions", "roles"]);
  });

  it("enables RLS on every private foundation table", async () => {
    const result = await database.query<{ relname: string; relrowsecurity: boolean }>(`
      select relname, relrowsecurity from pg_class
      where relname in ('roles', 'permissions', 'role_permissions', 'profiles')
      order by relname
    `);
    expect(result.rows).toHaveLength(4);
    expect(result.rows.every((row) => row.relrowsecurity)).toBe(true);
  });

  it("allows the owner permission set and staff visibility", async () => {
    await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${ownerId}', true);`);
    const permission = await database.query<{ allowed: boolean }>("select public.wayne_has_permission('admin.access') as allowed");
    const profiles = await database.query<{ count: number }>("select count(*)::int as count from public.profiles");
    await database.exec("rollback");

    expect(permission.rows[0]?.allowed).toBe(true);
    expect(profiles.rows[0]?.count).toBe(2);
  });

  it("denies cashier admin access and hides other staff profiles", async () => {
    await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${cashierId}', true);`);
    const permission = await database.query<{ allowed: boolean }>("select public.wayne_has_permission('admin.access') as allowed");
    const posPermission = await database.query<{ allowed: boolean }>("select public.wayne_has_permission('pos.access') as allowed");
    const profiles = await database.query<{ count: number }>("select count(*)::int as count from public.profiles");
    await database.exec("rollback");

    expect(permission.rows[0]?.allowed).toBe(false);
    expect(posPermission.rows[0]?.allowed).toBe(true);
    expect(profiles.rows[0]?.count).toBe(1);
  });

  it("fails closed for an authenticated identity without a profile", async () => {
    await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${unknownId}', true);`);
    const permission = await database.query<{ allowed: boolean }>("select public.wayne_has_permission('admin.access') as allowed");
    const profiles = await database.query<{ count: number }>("select count(*)::int as count from public.profiles");
    await database.exec("rollback");

    expect(permission.rows[0]?.allowed).toBe(false);
    expect(profiles.rows[0]?.count).toBe(0);
  });
});
