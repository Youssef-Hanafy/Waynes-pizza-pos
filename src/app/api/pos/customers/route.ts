import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { posCustomerSchema, posSaveCustomerSchema } from "@/lib/pos/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  const search = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (search.length < 2) return Response.json([]);
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_customer_search", { search_text: search.slice(0, 100) });
  if (error) return Response.json({ error: "Customer lookup failed." }, { status: 400 });
  const parsed = posCustomerSchema.array().safeParse(data);
  if (!parsed.success) return Response.json({ error: "Customer results were invalid." }, { status: 500 });
  return Response.json(parsed.data, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Create or update a customer from the POS (§8, §14).  Only ever called by a
 * person pressing a button — caller ID alone never creates a customer (§33).
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
  const { data, error } = await supabase.rpc("wayne_pos_save_customer", { payload: parsed.data });
  if (error) {
    const known = ["already exists", "valid 10-digit", "valid email", "name are required", "complete delivery address", "not found"];
    const message = known.some((part) => error.message.includes(part)) ? error.message : "The customer could not be saved.";
    return Response.json({ error: message }, { status: error.code === "23505" ? 409 : error.code === "42501" ? 403 : 400 });
  }
  const result = posCustomerSchema.safeParse(data);
  if (!result.success) return Response.json({ error: "The saved customer was invalid." }, { status: 500 });
  return Response.json(result.data, { status: 201, headers: { "Cache-Control": "no-store" } });
}
