import "server-only";

import { cache } from "react";
import { createClient } from "@supabase/supabase-js";
import { getPublicSupabaseEnvironment } from "@/lib/supabase/env";
import { publicMenuSchema, type PublicMenu } from "./schemas";
import { logger } from "@/lib/logging/logger";

export const getPublicMenu = cache(async (): Promise<PublicMenu> => {
  const environment = getPublicSupabaseEnvironment();
  const supabase = createClient(environment.NEXT_PUBLIC_SUPABASE_URL, environment.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const { data, error } = await supabase.rpc("wayne_public_menu");
  if (error) {
    logger.error("menu.public_menu_failed", error);
    return [];
  }
  if (data === null) return [];
  const parsed = publicMenuSchema.safeParse(data);
  if (!parsed.success) {
    // Falling back to an empty menu keeps the page up, but silently showing
    // customers "no menu" is how a broken menu goes unnoticed for a day. Say so.
    logger.error("menu.public_menu_invalid", { issue: parsed.error.issues[0]?.message, path: parsed.error.issues[0]?.path.join(".") });
    return [];
  }
  return parsed.data;
});
