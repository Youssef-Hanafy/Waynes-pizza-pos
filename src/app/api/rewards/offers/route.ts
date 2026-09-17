import { createHash } from "node:crypto";
import { z } from "zod";
import { checkoutRateLimitKey } from "@/lib/orders/rate-limit";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

/**
 * "What have I got this week?"
 *
 * A member types the number their Wayne's texts go to and gets back this week's
 * member offers plus any personal code still unspent.  Everything is decided in
 * the database function, which checks the number really is an opted-in member
 * before it returns a single code — otherwise this would be a way to harvest
 * offers by guessing phone numbers.
 *
 * A number that is not a member gets `member: false` and nothing else, which is
 * what lets the card invite them to join instead of guessing.
 */
export const dynamic = "force-dynamic";

const bodySchema = z.object({ phone: z.string().trim().min(7).max(24) });

const memberOffersSchema = z.object({
  member: z.boolean(),
  first_name: z.string().optional(),
  reason: z.string().optional(),
  offers: z.array(
    z.object({
      id: z.uuid(),
      code: z.string(),
      description: z.string(),
      discount_type: z.enum(["fixed", "percent"]),
      discount_value: z.number().int(),
      minimum_order_cents: z.number().int(),
      fulfillment_type: z.enum(["pickup", "delivery"]).nullable(),
      ends_at: z.string().nullable(),
      personal: z.boolean(),
    }),
  ),
});

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: "Please check your offers from Wayne’s website." }, { status: 403 });
  }
  let phone: string;
  try {
    phone = bodySchema.parse(await request.json()).phone;
  } catch {
    return Response.json({ error: "Enter the mobile number on your Wayne’s Rewards account." }, { status: 400 });
  }

  const db = createServiceSupabaseClient();
  // Guessing numbers to find codes is the only real abuse here, so the lookup
  // shares the storefront's existing limiter.
  const limit = await db.rpc("wayne_consume_public_order_rate_limit", {
    client_key: createHash("sha256").update(`offers:${checkoutRateLimitKey(request.headers)}`).digest("hex"),
  });
  if (limit.error || limit.data !== true) {
    return Response.json({ error: "Please wait a few minutes before checking again." }, { status: 429, headers: { "Retry-After": "300" } });
  }

  const { data, error } = await db.rpc("wayne_member_offers", { phone_text: phone });
  if (error) return Response.json({ error: "Offers are unavailable right now. Please try again." }, { status: 503 });
  const parsed = memberOffersSchema.safeParse(data);
  if (!parsed.success) return Response.json({ error: "Offers are unavailable right now. Please try again." }, { status: 503 });
  return Response.json(parsed.data, { headers: { "Cache-Control": "no-store" } });
}
