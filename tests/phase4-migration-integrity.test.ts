import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20260908040000_phase4_front_pos.sql"), "utf8").toLowerCase();

describe("Phase 4 migration integrity", () => {
  it.each(["wayne_pos_menu", "wayne_pos_customer_search", "wayne_create_pos_order"])("server-authorizes %s", (name) => {
    expect(migration).toContain(`function public.${name}`);
    expect(migration).toContain("wayne_has_permission('pos.access')");
  });
  it("keeps manual discounts manager-controlled and auditable", () => {
    expect(migration).toContain("'pos.discount.manage'");
    expect(migration).toContain("'order.discount_applied'");
    expect(migration).toContain("manual_reason");
  });
  it("uses the canonical order tables and snapshots", () => {
    expect(migration).toContain("insert into public.orders");
    expect(migration).toContain("insert into public.order_items");
    expect(migration).toContain("insert into public.order_item_modifiers");
  });
  it("keeps Phase 4 payments inside the approved boundary", () => {
    expect(migration).toContain("payment_method_value not in ('test_manual', 'cash')");
    expect(migration).not.toMatch(/card_(number|cvv|pan)/);
  });
  it("rebuilds cached customer metrics from authoritative orders", () => {
    expect(migration).toContain("function public.wayne_rebuild_customer_metrics");
    expect(migration).toContain("from public.orders order_row");
  });
});
