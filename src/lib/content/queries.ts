import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import { getPublicSupabaseEnvironment } from "@/lib/supabase/env";
import { defaultSettings, storeSettingsSchema } from "./schemas";

function createAnonymousClient() {
  const environment = getPublicSupabaseEnvironment();
  return createClient(environment.NEXT_PUBLIC_SUPABASE_URL, environment.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

const getStoreSettingsForHost = cache(async (host: string) => {
  const { data, error } = await createAnonymousClient().rpc("hanafy_public_store_settings", { target_hostname: host });
  if (error || data === null) return defaultSettings;
  const parsed = storeSettingsSchema.safeParse(data);
  return parsed.success ? parsed.data : defaultSettings;
});

/** Host is part of the cache key, preventing storefront cross-tenant leakage. */
export async function getStoreSettings() {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "";
  return getStoreSettingsForHost(host);
}
