import "server-only";

import { cache } from "react";
import { createClient } from "@supabase/supabase-js";
import { getPublicSupabaseEnvironment } from "@/lib/supabase/env";
import { publicMenuSchema, type PublicMenu } from "./schemas";
import { logger } from "@/lib/logging/logger";
import { requestHost } from "@/lib/content/queries";

/**
 * The menu of the business that owns the request host (Phase 13).  The host
 * is the cache key, and an unknown host gets an empty menu — never another
 * business's.
 */
export async function getPublicMenu(): Promise<PublicMenu> {
  return getPublicMenuForHost(await requestHost());
}

const getPublicMenuForHost = cache(async (host: string): Promise<PublicMenu> => {
  const environment = getPublicSupabaseEnvironment();
  const supabase = createClient(environment.NEXT_PUBLIC_SUPABASE_URL, environment.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const { data, error } = await supabase.rpc("hanafy_public_menu", { target_hostname: host });
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
