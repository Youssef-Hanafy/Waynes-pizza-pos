import { describe, expect, it } from "vitest";
import { provisionInputSchema, suggestSlug } from "./provisioning";

describe("Add Business input", () => {
  it("suggests a clean web name", () => {
    expect(suggestSlug("Joe's Deli & Grill")).toBe("joes-deli-grill");
    expect(suggestSlug("  Wayne’s Pizza!! ")).toBe("waynes-pizza");
  });

  it("validates the business, location and hours before the database sees them", () => {
    const base = {
      reason: "Developer test", services: ["pos"], service_source: "manual",
      business: { name: "Test", slug: "test-shop", timezone: "America/New_York", currency_code: "usd", is_test: true },
      location: { name: "Main", hours: { open: "10:00", close: "20:00", closed_days: ["sunday"] } },
    };
    const parsed = provisionInputSchema.parse(base);
    expect(parsed.business.currency_code).toBe("USD");
    expect(provisionInputSchema.safeParse({ ...base, business: { ...base.business, slug: "Bad Slug" } }).success).toBe(false);
    expect(provisionInputSchema.safeParse({ ...base, location: { ...base.location, hours: { open: "25:00", close: "20:00", closed_days: [] } } }).success).toBe(false);
  });
});
