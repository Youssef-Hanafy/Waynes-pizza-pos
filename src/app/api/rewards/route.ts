import { createHash } from "node:crypto";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { checkoutRateLimitKey } from "@/lib/orders/rate-limit";
import { parseRewardsSignup, WAYNE_REWARDS_CONSENT } from "@/lib/wayne/rewards";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "Please sign up from Wayne’s website." }, { status: 403 });
  let input: ReturnType<typeof parseRewardsSignup> & { firstName: string; lastName: string };
  try {
    const body = await request.json();
    const signup = parseRewardsSignup(body);
    if (typeof body.firstName !== "string" || typeof body.lastName !== "string" || !body.firstName.trim() || !body.lastName.trim() || body.firstName.length > 100 || body.lastName.length > 100) throw new Error("Enter your first and last name.");
    input = { ...signup, firstName: body.firstName.trim(), lastName: body.lastName.trim() };
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Check your signup details." }, { status: 400 }); }
  try {
    const db = createServiceSupabaseClient();
    const limit = await db.rpc("wayne_consume_public_order_rate_limit", { client_key: createHash("sha256").update(`rewards:${checkoutRateLimitKey(request.headers)}`).digest("hex") });
    if (limit.error || limit.data !== true) return Response.json({ error: "Please wait a few minutes before trying again." }, { status: 429, headers: { "Retry-After": "300" } });
    // Ignore a duplicate phone instead of overwriting an existing customer's identity or purchase history.
    const inserted = await db.from("customers").upsert({ first_name: input.firstName, last_name: input.lastName, phone_normalized: input.phone }, { onConflict: "phone_normalized", ignoreDuplicates: true });
    if (inserted.error) throw inserted.error;
    const customer = await db.from("customers").select("id,sms_marketing_opt_in").eq("phone_normalized", input.phone).single();
    if (customer.error) throw customer.error;
    const latest = await db.from("marketing_consents").select("status").eq("customer_id", customer.data.id).eq("channel", "sms").order("occurred_at", { ascending: false }).limit(1).maybeSingle();
    if (latest.error) throw latest.error;
    if (latest.data?.status === "opted_out") return Response.json({ error: "Please contact Wayne’s for help rejoining texts for this number." }, { status: 409 });
    // A stable consent ID makes a network retry idempotent. Persist proof before granting consent.
    const hash = createHash("sha256").update(`text-daily:${customer.data.id}:${input.consentVersion}`).digest("hex");
    const consentId = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
    const consent = await db.from("marketing_consents").upsert({ id: consentId, customer_id: customer.data.id, channel: "sms", status: "opted_in", source: "text_daily_website", consent_text_version: input.consentVersion, metadata: { consent_text: WAYNE_REWARDS_CONSENT, source_page: "/rewards" } }, { onConflict: "id", ignoreDuplicates: true });
    if (consent.error) throw consent.error;
    if (!customer.data.sms_marketing_opt_in) {
      // Existing database triggers update the Text Club segment and enqueue the signed Hanafy consent event.
      const updated = await db.from("customers").update({ sms_marketing_opt_in: true }).eq("id", customer.data.id).eq("sms_marketing_opt_in", false);
      if (updated.error) throw updated.error;
    }
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Text Daily signup is temporarily unavailable. Please try again later." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
