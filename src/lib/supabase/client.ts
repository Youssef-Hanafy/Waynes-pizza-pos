import { createBrowserClient } from "@supabase/ssr";
import { getPublicSupabaseEnvironment } from "./env";

export function createBrowserSupabaseClient() {
  try {
    const environment = getPublicSupabaseEnvironment();
    return createBrowserClient(environment.NEXT_PUBLIC_SUPABASE_URL, environment.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  } catch {
    return null;
  }
}
