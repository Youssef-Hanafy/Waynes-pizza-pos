import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20260908020000_phase2_orders.sql"), "utf8").toLowerCase();

describe("Phase 2 migration integrity", () => {
  it.each(["customers", "customer_addresses", "marketing_consents", "orders", "order_items", "order_item_modifiers", "order_discounts", "order_events", "order_idempotency"])("creates and protects %s", (table) => {
    expect(migration).toContain(`create table public.${table}`);
    expect(migration).toContain(`alter table public.${table} enable row level security`);
  });
  it("uses integer cents and basis points", () => {
    expect(migration).toContain("subtotal_cents integer");
    expect(migration).toContain("tax_rate_basis_points integer");
    expect(migration).not.toContain("subtotal numeric");
  });
  it("creates one idempotent server-authoritative order transaction", () => {
    expect(migration).toContain("function public.wayne_create_test_order");
    expect(migration).toContain("insert into public.order_idempotency");
    expect(migration).toContain("for update");
    expect(migration).toContain("duplicate', true");
  });
  it("keeps menu and customer snapshots on orders", () => {
    expect(migration).toContain("item_name_snapshot");
    expect(migration).toContain("customer_name_snapshot");
    expect(migration).toContain("delivery_address_snapshot jsonb");
  });
  it("does not grant anonymous direct table access", () => {
    expect(migration).toContain("revoke all on public.customers");
    expect(migration).not.toMatch(/grant\s+(select|insert|update|delete).*public\.orders.*to anon/);
  });
  it("labels early payments as test/manual and never stores card data", () => {
    expect(migration).toContain("'test_manual'");
    expect(migration).toContain("'test / manual'");
    expect(migration).not.toMatch(/card_(number|cvv|pan)/);
  });
});
