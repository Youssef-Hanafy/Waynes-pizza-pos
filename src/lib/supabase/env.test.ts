import { afterEach, describe, expect, it } from "vitest";
import { getPublicSupabaseEnvironment, getServerSupabaseEnvironment, tryGetServerSupabaseEnvironment } from "./env";

const original = { ...process.env };

describe("Supabase environment validation", () => {
  afterEach(() => {
    process.env = { ...original };
  });

  it("accepts a complete public configuration", () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "a".repeat(20);
    expect(getPublicSupabaseEnvironment().NEXT_PUBLIC_SUPABASE_URL).toBe("http://127.0.0.1:54321");
  });

  it("fails closed when credentials are missing", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    expect(() => getPublicSupabaseEnvironment()).toThrow();
  });

  it("builds the server configuration used by checkout and background workers", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://orders.example.com";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "a".repeat(20);
    process.env.SUPABASE_SERVICE_ROLE_KEY = "s".repeat(20);
    expect(getServerSupabaseEnvironment().SUPABASE_SERVICE_ROLE_KEY).toBe("s".repeat(20));
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(tryGetServerSupabaseEnvironment()).toBeNull();
  });
});
