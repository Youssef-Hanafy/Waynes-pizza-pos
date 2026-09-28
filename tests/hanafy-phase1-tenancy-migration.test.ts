import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(process.cwd(), "supabase/migrations/20261002080000_phase1_core_tenancy.sql");
const migration = readFileSync(migrationPath, "utf8").toLowerCase();

describe("Hanafy Platform Phase 1 tenancy migration integrity", () => {
  it.each(["workspaces", "locations", "platform_users", "workspace_members", "service_catalog", "workspace_services"])(
    "creates and enables RLS for %s",
    (table) => {
      expect(migration).toContain(`create table public.${table}`);
      expect(migration).toContain(`alter table public.${table} enable row level security`);
    }
  );

  it("keeps tenant membership separate from platform administration", () => {
    expect(migration).toContain("create table public.platform_users");
    expect(migration).toContain("create table public.workspace_members");
    expect(migration).toContain("workspace_role_id uuid not null references public.roles(id)");
    expect(migration).toContain("workspace ownership must not imply platform administration");
    expect(migration).not.toContain("insert into public.platform_users");
  });

  it("seeds only Wayne's Pizza and its Worcester location", () => {
    expect(migration).toContain("'waynes-pizza', 'wayne''s pizza'");
    expect(migration).toContain("'worcester', 'worcester location'");
    expect(migration).toContain("'93 west boylston st.'");
  });

  it("provides server-authoritative tenant, permission, and entitlement helpers", () => {
    for (const functionName of [
      "hanafy_has_platform_access",
      "hanafy_is_platform_admin",
      "hanafy_is_workspace_member",
      "hanafy_has_workspace_permission",
      "hanafy_workspace_service_enabled",
      "hanafy_workspace_context"
    ]) {
      expect(migration).toContain(`function public.${functionName}`);
    }
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = ''");
  });

  it("does not attach existing operational tables to a workspace in Phase 1", () => {
    for (const table of ["orders", "customers", "menu_items", "payments", "print_jobs", "phone_calls"]) {
      expect(migration).not.toMatch(new RegExp(`alter table public\\.${table}.*workspace_id`, "s"));
    }
  });
});
