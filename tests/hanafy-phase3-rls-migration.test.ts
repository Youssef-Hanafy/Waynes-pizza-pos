import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261004080000_phase3_workspace_rls_hardening.sql"),
  "utf8",
).toLowerCase();

describe("Hanafy Platform Phase 3 RLS hardening migration", () => {
  it("uses workspace membership and permissions as the RLS predicate", () => {
    expect(migration).toContain("hanafy_can_access_workspace_data");
    expect(migration).toContain("hanafy_is_workspace_member(target_workspace_id)");
    expect(migration).toContain("hanafy_has_workspace_permission(target_workspace_id");
  });

  it("covers customer, order, messaging, payment, and hardware tenant data", () => {
    for (const table of [
      "customers",
      "orders",
      "integration_outbox",
      "payment_provider_settings",
      "payment_terminals",
      "store_phone_lines",
      "pos_hardware_settings",
    ]) {
      expect(migration).toContain(`('${table}'`);
    }
  });

  it("prevents unscoped or cross-workspace writes", () => {
    expect(migration).toContain("workspace_id is required");
    expect(migration).toContain("workspace_id cannot be reassigned");
    expect(migration).toContain("location_id must belong to workspace_id");
    expect(migration).toContain("alter column workspace_id set not null");
  });

  it("pins legacy Wayne RPC authorization to the seeded workspace", () => {
    expect(migration).toContain("create or replace function public.wayne_has_permission");
    expect(migration).toContain("40000000-0000-4000-8000-000000000001");
  });

  it("adds isolated private workspace storage policies", () => {
    expect(migration).toContain("hanafy-workspace-private");
    expect(migration).toContain("hanafy_workspace_private_storage_select");
    expect(migration).toContain("hanafy_storage_workspace_id(name)");
  });
});
