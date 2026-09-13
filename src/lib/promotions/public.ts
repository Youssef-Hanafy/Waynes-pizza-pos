import "server-only";

import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { getPublicSupabaseEnvironment } from "@/lib/supabase/env";
import { logger } from "@/lib/logging/logger";

/** Only what a customer needs to decide. Usage counts and limits stay private. */
export const publicPromotionSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  description: z.string(),
  discount_type: z.enum(["fixed", "percent"]),
  discount_value: z.number().int(),
  minimum_order_cents: z.number().int(),
  fulfillment_type: z.enum(["pickup", "delivery"]).nullable(),
  ends_at: z.string().nullable(),
});
export const publicPromotionsSchema = z.array(publicPromotionSchema);
export type PublicPromotion = z.infer<typeof publicPromotionSchema>;

/** "$5.00 off", "10% off" — the number a customer scans for, on its own line. */
export function dealHeadline(promotion: Pick<PublicPromotion, "discount_type" | "discount_value">) {
  return promotion.discount_type === "percent"
    ? `${promotion.discount_value / 100}% off`
    : `$${(promotion.discount_value / 100).toFixed(2)} off`;
}

/** The one condition that decides whether the deal is for them. */
export function dealCondition(promotion: Pick<PublicPromotion, "minimum_order_cents" | "fulfillment_type">) {
  const parts: string[] = [];
  if (promotion.minimum_order_cents > 0) parts.push(`on orders over $${(promotion.minimum_order_cents / 100).toFixed(2)}`);
  if (promotion.fulfillment_type) parts.push(`${promotion.fulfillment_type} only`);
  return parts.join(" · ");
}

export async function getPublicPromotions(): Promise<PublicPromotion[]> {
  const environment = getPublicSupabaseEnvironment();
  const supabase = createClient(environment.NEXT_PUBLIC_SUPABASE_URL, environment.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await supabase.rpc("wayne_public_promotions");
  if (error) {
    // A storefront with no deals still sells pizza, so this never takes the page
    // down — but it is written down rather than vanishing.
    logger.error("promotions.public_failed", error);
    return [];
  }
  const parsed = publicPromotionsSchema.safeParse(data);
  if (!parsed.success) {
    logger.error("promotions.public_invalid", { issue: parsed.error.issues[0]?.message });
    return [];
  }
  return parsed.data;
}
