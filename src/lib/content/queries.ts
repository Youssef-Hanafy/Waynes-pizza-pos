import "server-only";

import { cache } from "react";
import { createClient } from "@supabase/supabase-js";
import { getPublicSupabaseEnvironment } from "@/lib/supabase/env";
import { defaultSettings, storeSettingsSchema } from "./schemas";

function createAnonymousClient() {
  const environment = getPublicSupabaseEnvironment();
  return createClient(environment.NEXT_PUBLIC_SUPABASE_URL, environment.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

export const getStoreSettings = cache(async () => {
  const { data, error } = await createAnonymousClient().rpc("wayne_public_store_settings");
  if (error || data === null) return defaultSettings;
  const parsed = storeSettingsSchema.safeParse(data);
  return parsed.success ? parsed.data : defaultSettings;
});
