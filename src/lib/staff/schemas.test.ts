import { describe, expect, it } from "vitest";
import { createStaffSchema, resetPasswordSchema } from "./schemas";

describe("staff account validation", () => {
  it("normalizes email and matches the Supabase password policy", () => {
    const parsed = createStaffSchema.parse({ email: " Kim@Example.com ", display_name: "Kim", role: "kitchen", password: "PizzaOven2026" });
    expect(parsed.email).toBe("kim@example.com");
    expect(createStaffSchema.safeParse({ email: "kim@example.com", display_name: "Kim", role: "kitchen", password: "short" }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ id: "58000000-0000-4000-8000-000000000001", password: "alllowercase123" }).success).toBe(false);
  });

  it("rejects roles that do not exist", () => {
    expect(createStaffSchema.safeParse({ email: "a@b.co", display_name: "A", role: "superadmin", password: "PizzaOven2026" }).success).toBe(false);
  });
});
