import "server-only";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { dashboardSchema, setupStatusSchema } from "./schemas";

export async function getDashboard(from: string, through: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_admin_dashboard", { from_date: from, through_date: through });
  if (error) throw new Error(`Dashboard failed: ${error.message}`);
  return dashboardSchema.parse(data);
}

export async function getSetupStatus() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_admin_setup_status");
  if (error) throw new Error(`Setup status failed: ${error.message}`);
  return setupStatusSchema.parse(data);
}
