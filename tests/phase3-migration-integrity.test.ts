import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20260908030000_phase3_admin_orders.sql"), "utf8").toLowerCase();

describe("Phase 3 migration integrity", () => {
  it("adds a dedicated order viewing permission for owners and managers", () => {
    expect(migration).toContain("'orders.view'");
    expect(migration).toContain("role.code in ('owner', 'manager')");
  });

  it.each(["wayne_admin_orders", "wayne_admin_order_calendar", "wayne_admin_order_detail"])("server-authorizes %s", (name) => {
    expect(migration).toContain(`function public.${name}`);
    expect(migration).toContain("wayne_has_permission('orders.view')");
    expect(migration).toContain(`grant execute on function public.${name}`);
  });

  it("groups and filters using the configured store timezone", () => {
    expect(migration).toContain("select timezone into store_timezone from public.store_settings");
    expect(migration).toContain("placed_at at time zone store_timezone");
  });

  it("never returns private public-status or idempotency tokens in order detail", () => {
    expect(migration).toContain("- 'public_access_token' - 'idempotency_key'");
  });
});
