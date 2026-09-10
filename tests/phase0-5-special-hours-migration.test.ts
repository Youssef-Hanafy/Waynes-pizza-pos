import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260909070000_phase0_5_special_hours_carryover.sql",
  ),
  "utf8",
).toLowerCase();

describe("Phase 0–5 special-hours carry-over migration", () => {
  it("updates the database open-state function without rewriting an applied migration", () => {
    expect(migration).toContain("create or replace function public.wayne_store_is_open");
    expect(migration).toContain("service_date = local_moment::date - 1");
    expect(migration).toContain("yesterday_special.opens_at > yesterday_special.closes_at");
  });

  it("gives public browser status evaluation the preceding service-date override", () => {
    expect(migration).toContain("create or replace function public.wayne_public_store_settings");
    expect(migration).toContain("special.service_date >= current_date - 1");
    expect(migration).toContain("grant execute on function public.wayne_public_store_settings() to anon, authenticated");
  });
});
