import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { phoneBoardSchema } from "@/lib/phone/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * Every line's live call and the recent-call list (§7, §35).  Fetched when
 * something changes — on start, on a Realtime notice, on reconnect — never on
 * a timer (§20).
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_phone_board");
  if (error) return Response.json({ error: "The phone lines could not be read." }, { status: 503 });
  const parsed = phoneBoardSchema.safeParse(data);
  if (!parsed.success) return Response.json({ error: "The phone line data was invalid." }, { status: 500 });
  return Response.json(parsed.data, { headers: { "Cache-Control": "no-store" } });
}
