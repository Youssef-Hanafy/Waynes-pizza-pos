import "server-only";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { cashCloseoutSchema, posDrawerSchema, registerSchema } from "./schemas";

export async function getPosDrawer() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_drawer");
  if (error) throw new Error("The drawer could not be loaded. Check the connection and try again.");
  return posDrawerSchema.parse(data);
}

export async function getCashCloseout(from: string, through: string) {
  const supabase = await createServerSupabaseClient();
  const [closeout, deliveryCash] = await Promise.all([
    supabase.rpc("wayne_cash_closeout", { from_date: from, through_date: through }),
    supabase.rpc("wayne_delivery_cash_totals", { from_date: from, through_date: through }),
  ]);
  const { data, error } = closeout;
  if (error) throw new Error(`The closeout report failed: ${error.message}`);
  if (deliveryCash.error || !deliveryCash.data || typeof deliveryCash.data !== "object") throw new Error("The delivery cash total could not be loaded.");
  return cashCloseoutSchema.parse({
    ...data as object,
    totals: { ...(data as { totals: object }).totals, ...deliveryCash.data as object },
  });
}

/** Every register, including inactive ones, for the admin screen. */
export async function getRegisters() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("registers")
    .select("id, label, location_note, active, created_at")
    .order("label");
  if (error || !data) return [];
  return data.map((row) => ({
    ...registerSchema.omit({ open: true }).parse({ id: row.id, label: row.label }),
    location_note: row.location_note as string,
    active: row.active as boolean,
  }));
}
