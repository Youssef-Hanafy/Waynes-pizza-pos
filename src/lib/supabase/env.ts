import { z } from "zod";

const publicEnvironmentSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20)
});

const serverEnvironmentSchema = publicEnvironmentSchema.extend({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20)
});

export function getPublicSupabaseEnvironment() {
  return publicEnvironmentSchema.parse({
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  });
}

function readServerEnvironment() {
  return {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY
  };
}

export function getServerSupabaseEnvironment() {
  return serverEnvironmentSchema.parse(readServerEnvironment());
}

/** Returns null instead of throwing when server credentials are not configured. */
export function tryGetServerSupabaseEnvironment() {
  const parsed = serverEnvironmentSchema.safeParse(readServerEnvironment());
  return parsed.success ? parsed.data : null;
}
