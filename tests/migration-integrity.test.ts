import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(process.cwd(), "supabase/migrations/20260908000000_phase0_foundation.sql");
const migration = readFileSync(migrationPath, "utf8").toLowerCase();

describe("Phase 0 migration integrity", () => {
  it.each(["roles", "permissions", "role_permissions", "profiles"])("creates and enables RLS for %s", (table) => {
    expect(migration).toContain(`create table public.${table}`);
    expect(migration).toContain(`alter table public.${table} enable row level security`);
  });

  it("contains server-authoritative permission functions", () => {
    expect(migration).toContain("function public.wayne_has_permission");
    expect(migration).toContain("security definer");
    expect(migration).toContain("profile.id = auth.uid()");
  });

  it("does not grant anonymous access to foundation tables", () => {
    expect(migration).toContain("revoke all on public.roles, public.permissions, public.role_permissions, public.profiles from anon");
    expect(migration).not.toMatch(/grant\s+(all|select|insert|update|delete).*\s+to\s+anon/);
  });
});
