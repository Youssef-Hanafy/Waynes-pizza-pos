import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { posCustomerSchema, posSaveCustomerSchema } from "@/lib/pos/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * Save the customer on the order screen the moment their details are in —
 * automatically when the order is started, or from the small Save button —
 * even when the order is a test or never sent (owner, 2026-10-27).
 *
 * An upsert by phone: a number already saved updates that profile (a blank
 * name never wipes it), so this can run on every order without ever making a
 * second profile for the same customer.
 */
export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send JSON." }, { status: 400 });
  }
  const parsed = posSaveCustomerSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Check the customer details." }, { status: 400 });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_remember_customer", { payload: parsed.data });
  if (error) {
    const message = error.message.includes("valid 10-digit") ? error.message : "The customer could not be saved.";
    return Response.json({ error: message }, { status: error.code === "42501" ? 403 : 400 });
  }
  const result = posCustomerSchema.safeParse(data);
  if (!result.success) return Response.json({ error: "The saved customer was invalid." }, { status: 500 });
  return Response.json(result.data, { headers: { "Cache-Control": "no-store" } });
}
