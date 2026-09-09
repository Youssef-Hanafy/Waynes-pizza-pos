import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20260908010000_phase1_public_menu.sql"), "utf8").toLowerCase();

describe("Phase 1 migration integrity", () => {
  it.each(["store_settings", "store_special_hours", "menu_categories", "menu_items", "menu_item_variants", "modifier_groups", "modifier_choices", "menu_item_modifier_groups"])("creates and enables RLS for %s", (table) => { expect(migration).toContain(`create table public.${table}`); expect(migration).toContain(`alter table public.${table} enable row level security`); });
  it("uses archive fields and restricts relational deletes", () => { expect(migration).toContain("archived_at timestamptz"); expect(migration).toContain("references public.menu_items(id) on delete restrict"); expect(migration).not.toMatch(/grant\s+delete\s+on\s+public\.menu_/); });
  it("stores money as integer cents", () => { expect(migration).toContain("base_price_cents integer"); expect(migration).toContain("price_delta_cents integer"); expect(migration).not.toContain("base_price numeric"); });
  it("checks menu management inside transactional RPC functions", () => { expect(migration).toContain("function public.wayne_create_menu_item"); expect(migration).toContain("function public.wayne_update_menu_item"); expect(migration).toContain("wayne_has_permission('menu.manage')"); });
  it("creates a constrained public image bucket", () => { expect(migration).toContain("'wayne-menu'"); expect(migration).toContain("5242880"); expect(migration).toContain("image/webp"); });
});
