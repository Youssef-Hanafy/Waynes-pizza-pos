import "server-only";

import { createClient } from "@supabase/supabase-js";
import { getPublicSupabaseEnvironment } from "@/lib/supabase/env";
import { publicOrderStatusSchema, type PublicOrderStatus } from "./schemas";
import { requestHost } from "@/lib/content/queries";

export async function getPublicOrderStatus(
  orderId: string,
  token: string,
): Promise<PublicOrderStatus | null> {
  const environment = getPublicSupabaseEnvironment();
  const supabase = createClient(
    environment.NEXT_PUBLIC_SUPABASE_URL,
    environment.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  // Only the business that owns this web address can show its order (Phase 13).
  const { data, error } = await supabase.rpc("hanafy_public_order_status", {
    target_hostname: await requestHost(),
    target_order_id: orderId,
    access_token: token,
  });
  if (error || data === null) return null;
  const parsed = publicOrderStatusSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
