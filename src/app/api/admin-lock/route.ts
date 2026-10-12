import { cookies } from "next/headers";
import { ADMIN_UNLOCK_COOKIE } from "@/lib/auth/admin-lock";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** The POS calls this when it opens: leaving Admin for the register locks it. */
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const store = await cookies();
  if (store.get(ADMIN_UNLOCK_COOKIE)) {
    store.delete(ADMIN_UNLOCK_COOKIE);
    const supabase = await createServerSupabaseClient();
    await supabase.rpc("wayne_admin_lock");
  }
  return Response.json({ locked: true }, { headers: { "Cache-Control": "no-store" } });
}
