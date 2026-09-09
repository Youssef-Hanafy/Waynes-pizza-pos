import "server-only";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { kitchenBoardSchema } from "./schemas";

export async function getKitchenBoard() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_kitchen_board");
  if (error) throw new Error("Kitchen data could not be loaded. Check the database connection and migrations.");
  return kitchenBoardSchema.parse(data);
}
