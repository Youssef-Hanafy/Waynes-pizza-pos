import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { phoneLineBoardSchema } from "@/lib/phone/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** The POS phone panel polls this: every line, and whoever is on it right now. */
export const dynamic = "force-dynamic";

export async function GET() {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) {
    return Response.json({ error: "POS access required." }, { status: 403 });
  }
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_phone_line_board");
  if (error) return Response.json({ error: "The phone lines could not be read." }, { status: 400 });
  const parsed = phoneLineBoardSchema.safeParse(data);
  if (!parsed.success) return Response.json({ error: "The phone line data was invalid." }, { status: 500 });
  return Response.json(parsed.data, { headers: { "Cache-Control": "no-store" } });
}
