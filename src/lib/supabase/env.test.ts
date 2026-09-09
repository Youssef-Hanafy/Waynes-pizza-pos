import { afterEach, describe, expect, it } from "vitest";
import { getPublicSupabaseEnvironment } from "./env";

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
});
