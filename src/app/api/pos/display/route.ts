import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { displayPublishResultSchema, displayReadSchema, displayRequestSchema } from "@/lib/pos/customer-display";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * The customer screen link (owner, 2026-10-11).
 *   GET  ?key=Front counter → what the screen should show (the screen polls this)
 *   GET  (no key)           → registers the screen can face
 *   POST publish            → the register sends what to show, gets the customer's answer back
 *   POST respond            → the screen sends the customer's tip / signature
 */
export async function GET(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  const key = new URL(request.url).searchParams.get("key")?.trim() ?? "";
  const supabase = await createServerSupabaseClient();
  if (!key) {
    const { data, error } = await supabase.rpc("wayne_display_list");
    if (error) return Response.json({ error: "Registers could not be listed." }, { status: 400 });
    return Response.json(Array.isArray(data) ? data : [], { headers: { "Cache-Control": "no-store" } });
  }
  const { data, error } = await supabase.rpc("wayne_display_read", { screen_key: key.slice(0, 60) });
  if (error) return Response.json({ error: "The register could not be reached." }, { status: 400 });
  const parsed = displayReadSchema.safeParse(data);
  if (!parsed.success) return Response.json({ error: "Invalid screen data." }, { status: 500 });
  return Response.json(parsed.data, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const parsed = displayRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid customer screen request." }, { status: 400 });
  const supabase = await createServerSupabaseClient();
  if (parsed.data.kind === "publish") {
    const { data, error } = await supabase.rpc("wayne_display_publish", { screen_key: parsed.data.key, screen_state: parsed.data.state });
    if (error) return Response.json({ error: "The customer screen could not be updated." }, { status: 400 });
    const result = displayPublishResultSchema.safeParse(data);
    return Response.json(result.success ? result.data : { response: {}, screen_online: false }, { headers: { "Cache-Control": "no-store" } });
  }
  const { data, error } = await supabase.rpc("wayne_display_respond", { screen_key: parsed.data.key, answer: parsed.data.answer });
  if (error) return Response.json({ error: "Your answer could not be sent. Ask the cashier." }, { status: 400 });
  return Response.json(data ?? { accepted: false }, { headers: { "Cache-Control": "no-store" } });
}
