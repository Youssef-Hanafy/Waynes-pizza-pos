import "server-only";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { deliveryMetricsSchema, dispatchBoardSchema, driverBoardSchema } from "./schemas";

export async function getDriverBoard() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_driver_board");
  if (error) throw new Error("Deliveries could not be loaded. Check the connection and try again.");
  return driverBoardSchema.parse(data);
}

export async function getDispatchBoard() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_delivery_dispatch");
  if (error) throw new Error("The dispatch board could not be loaded. Check the database connection and migrations.");
  return dispatchBoardSchema.parse(data);
}

export async function getDeliveryMetrics(from: string, through: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_delivery_metrics", { from_date: from, through_date: through });
  if (error) throw new Error(`Delivery analytics failed: ${error.message}`);
  return deliveryMetricsSchema.parse(data);
}
