import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { posCustomerSchema } from "@/lib/pos/schemas";
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
