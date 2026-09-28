import { describe, expect, it } from "vitest";
import { platformErrorMessage, platformMeSchema, setMemberInputSchema, setServiceInputSchema, setServiceResultSchema, startSupportInputSchema } from "./schemas";

describe("Platform Admin input", () => {
  it("requires a reason for every service change and normalises empty dates", () => {
    const parsed = setServiceInputSchema.parse({
      workspace: "waynes-pizza", service: "sms", status: "trial", source: "manual", starts_on: "", ends_on: "2026-11-01", reason: "Two week trial", confirmed: false,
    });
    expect(parsed.starts_on).toBeNull();
    expect(parsed.ends_on).toBe("2026-11-01");
    expect(setServiceInputSchema.safeParse({ ...parsed, starts_on: "", ends_on: "", reason: " " }).success).toBe(false);
    expect(setServiceInputSchema.safeParse({ ...parsed, starts_on: "", ends_on: "", workspace: "../admin" }).success).toBe(false);
  });

  it("only asks for a password when it is given, and then enforces the rules", () => {
    const base = { workspace: "waynes-pizza", email: " New@Example.com ", role: "cashier", status: "active", reason: "New cashier" };
    const withoutPassword = setMemberInputSchema.parse({ ...base, password: "", display_name: "" });
    expect(withoutPassword.email).toBe("new@example.com");
    expect(withoutPassword.password).toBeUndefined();
    expect(setMemberInputSchema.safeParse({ ...base, password: "short" }).success).toBe(false);
    expect(setMemberInputSchema.parse({ ...base, password: "Longenough123" }).password).toBe("Longenough123");
  });

  it("keeps support sessions between 15 minutes and 8 hours with a real reason", () => {
    expect(startSupportInputSchema.safeParse({ workspace: "waynes-pizza", reason: "Fix menu", minutes: "60" }).success).toBe(true);
    expect(startSupportInputSchema.safeParse({ workspace: "waynes-pizza", reason: "hi", minutes: "60" }).success).toBe(false);
    expect(startSupportInputSchema.safeParse({ workspace: "waynes-pizza", reason: "Fix menu", minutes: "600" }).success).toBe(false);
  });
});

describe("Platform Admin responses", () => {
  it("understands the confirmation answer from a business-critical service change", () => {
    const result = setServiceResultSchema.parse({ status: "needs_confirmation", warnings: ["The register stops working."] });
    expect(result.status).toBe("needs_confirmation");
    expect(setServiceResultSchema.parse({ status: "saved", effective: false })).toEqual({ status: "saved", effective: false });
  });

  it("rejects an unknown platform role instead of guessing", () => {
    const me = {
      auth_user_id: "97100000-0000-4000-8000-000000000001", email: "hanafymedia@gmail.com", display_name: "Youssef",
      platform_role: "platform_owner", can_manage: true, can_support: true, support_session: null,
    };
    expect(platformMeSchema.parse(me).platform_role).toBe("platform_owner");
    expect(platformMeSchema.safeParse({ ...me, platform_role: "owner" }).success).toBe(false);
  });

  it("shows our own database messages and hides anything else", () => {
    expect(platformErrorMessage("At least one active owner is required")).toBe("At least one active owner is required");
    expect(platformErrorMessage("SMS needs CRM turned on first")).toBe("SMS needs CRM turned on first");
    expect(platformErrorMessage('duplicate key value violates unique constraint "x"')).toBe("The change could not be saved. Refresh and try again.");
    expect(platformErrorMessage(undefined)).toBe("The change could not be saved. Refresh and try again.");
  });
});
