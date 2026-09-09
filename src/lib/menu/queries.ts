import "server-only";

import { cache } from "react";
import { createClient } from "@supabase/supabase-js";
import { getPublicSupabaseEnvironment } from "@/lib/supabase/env";
import { publicMenuSchema, type PublicMenu } from "./schemas";

export const getPublicMenu = cache(async (): Promise<PublicMenu> => {
  const environment = getPublicSupabaseEnvironment();
  const supabase = createClient(environment.NEXT_PUBLIC_SUPABASE_URL, environment.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const { data, error } = await supabase.rpc("wayne_public_menu");
  if (error || data === null) return [];
  const parsed = publicMenuSchema.safeParse(data);
  return parsed.success ? parsed.data : [];
});
