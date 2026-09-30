import { describe, expect, it } from "vitest";
import { createWorkspaceSchema, workspaceAccessSchema, workspaceOnboardingSchema, workspaceSlugSchema } from "./schemas";

describe("workspace tenancy schemas", () => {
  it("accepts a safe workspace slug", () => {
    expect(workspaceSlugSchema.parse("marios-pizza-2")).toBe("marios-pizza-2");
  });

  it("rejects domain-like and ambiguous workspace slugs", () => {
    expect(workspaceSlugSchema.safeParse("marios.pizza").success).toBe(false);
    expect(workspaceSlugSchema.safeParse("Marios Pizza").success).toBe(false);
  });

  it("accepts the scoped access shape returned by the database", () => {
    const parsed = workspaceAccessSchema.parse({
      workspace_id: "50000000-0000-4000-8000-000000000001",
      workspace_slug: "waynes-pizza",
      workspace_name: "Wayne's Pizza",
      role: "owner",
      permissions: ["admin.access"],
      location_ids: ["50000000-0000-4000-8000-000000000101"]
    });
    expect(parsed.workspace_slug).toBe("waynes-pizza");
  });

  it("requires a secure owner account and at least one service when provisioning", () => {
    const parsed = createWorkspaceSchema.safeParse({
      workspace_slug: "marios-pizza",
      business_name: "Mario's Pizza",
      legal_name: "",
      public_email: "",
      public_phone: "",
      owner_name: "Mario",
      owner_email: "owner@mariospizza.test",
      owner_password: "SecurePassword7",
      location_name: "Main Street",
      timezone: "America/New_York",
      service_codes: ["restaurant_pos"]
    });
    expect(parsed.success).toBe(true);
    expect(createWorkspaceSchema.safeParse({ ...parsed.data, service_codes: [] }).success).toBe(false);
  });

  it("normalizes the country code submitted by a business owner", () => {
    const parsed = workspaceOnboardingSchema.parse({
      workspace_id: "50000000-0000-4000-8000-000000000001",
      workspace_slug: "waynes-pizza",
      location_id: "50000000-0000-4000-8000-000000000101",
      business_name: "Wayne's Pizza",
      legal_name: "",
      public_email: "",
      public_phone: "",
      location_name: "Main location",
      timezone: "America/New_York",
      address_line1: "",
      address_line2: "",
      city: "",
      state_or_region: "",
      postal_code: "",
      country_code: "us",
      complete: false
    });
    expect(parsed.country_code).toBe("US");
  });
});
