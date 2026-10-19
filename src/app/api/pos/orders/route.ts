import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { posOrderCreatedSchema, posOrderInputSchema } from "@/lib/pos/schemas";
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  let input: unknown;
  try { input = await request.json(); } catch { return Response.json({ error: "Invalid POS order request." }, { status: 400 }); }
  const parsed = posOrderInputSchema.safeParse(input);
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Check the ticket." }, { status: 400 });
  if (parsed.data.manual_discount_type && !parsed.data.pos_discount_id && !hasPermission(access, "pos.discount.manage")) return Response.json({ error: "A manager must apply manual discounts." }, { status: 403 });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_create_pos_order", { payload: parsed.data });
  if (error) return Response.json({ error: safePosError(error.message) }, { status: error.code === "42501" ? 403 : 400 });
  const result = posOrderCreatedSchema.safeParse(data);
  if (!result.success) return Response.json({ error: "The ticket could not be confirmed." }, { status: 500 });
  // The day's ticket number (#1, #2 …) for the screen; the order is already saved either way.
  if (result.data.daily_number === null && access?.workspace_id) {
    const { data: numbered } = await createServiceSupabaseClient().from("orders").select("daily_number")
      .eq("id", result.data.id).eq("workspace_id", access.workspace_id).maybeSingle();
    if (typeof numbered?.daily_number === "number") result.data.daily_number = numbered.daily_number;
  }
  return Response.json(result.data, { status: result.data.duplicate ? 200 : 201, headers: { "Cache-Control": "no-store" } });
}

function safePosError(message: string) {
  const allowed = ["required", "valid", "unavailable", "minimum", "modifier", "variant", "Ticket", "quantity", "Promotion", "discount", "address", "customer", "TEST", "cash", "pickup", "delivery"];
  return allowed.some((part) => message.toLowerCase().includes(part.toLowerCase())) ? message : "The POS order could not be submitted.";
}
