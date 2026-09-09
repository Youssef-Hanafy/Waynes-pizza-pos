import "server-only";

import { publicMenuSchema } from "@/lib/menu/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function getPosMenu() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_menu");
  if (error) throw new Error(`POS menu failed: ${error.message}`);
  return publicMenuSchema.parse(data);
}
