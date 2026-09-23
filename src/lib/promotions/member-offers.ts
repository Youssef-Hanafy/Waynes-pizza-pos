import { z } from "zod";

/**
 * What a member sees on their offers page — from the phone lookup
 * (/api/rewards/offers) or their personal link (/r/<key>).  Both come from the
 * same database function, so they always agree.
 */
export const memberOfferSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  description: z.string(),
  discount_type: z.enum(["fixed", "percent"]),
  discount_value: z.number().int(),
  minimum_order_cents: z.number().int(),
  fulfillment_type: z.enum(["pickup", "delivery"]).nullable(),
  ends_at: z.string().nullable(),
  personal: z.boolean(),
});

export const memberOffersSchema = z.object({
  member: z.boolean(),
  first_name: z.string().optional(),
  reason: z.string().optional(),
  link_key: z.string().nullable().optional(),
  offers: z.array(memberOfferSchema),
});

export type MemberOffer = z.infer<typeof memberOfferSchema>;
export type MemberOffersResult = z.infer<typeof memberOffersSchema>;

/** Checkout fills its promo box from here after "Use this code". */
export const SAVED_PROMO_STORAGE_KEY = "wayne-promo-code-v1";

export function memberOfferLinkPath(linkKey: string) {
  return `/r/${encodeURIComponent(linkKey)}`;
}
