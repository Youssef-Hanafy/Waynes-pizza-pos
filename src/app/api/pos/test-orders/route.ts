import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * Delete every test order (owner, 2026-10-11).  Test orders are practice
 * tickets: they print and can take a payment, but are kept out of sales and
 * the CRM; this removes them and everything attached to them.
 */
export async function DELETE(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_clear_test_orders");
  if (error) return Response.json({ error: "The test orders could not be deleted." }, { status: error.code === "42501" ? 403 : 400 });
  const removed = data && typeof data === "object" && "removed" in data ? Number((data as { removed: unknown }).removed) : 0;
  return Response.json({ removed }, { headers: { "Cache-Control": "no-store" } });
}
