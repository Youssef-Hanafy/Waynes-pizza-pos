import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** Clock a staff member in or out by PIN (it flips whatever they are now). */
export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ ok: false, error: "POS access required." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ ok: false, error: "Invalid request origin." }, { status: 403 });
  const body: unknown = await request.json().catch(() => null);
  const pin = body && typeof body === "object" && "pin" in body ? String((body as { pin: unknown }).pin) : "";
  if (!/^\d{4,6}$/.test(pin)) return Response.json({ ok: false, error: "Wrong PIN." });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_pin_clock", { pin_value: pin });
  if (error || !data) return Response.json({ ok: false, error: "The PIN could not be checked. Try again." }, { status: 400 });
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
