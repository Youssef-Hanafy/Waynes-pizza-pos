import { z } from "zod";
import { zonedLocalToUtcIso } from "@/lib/time/zoned";

export const promotionSchema = z.object({
  id: z.uuid(), code: z.string(), description: z.string(), discount_type: z.enum(["fixed", "percent"]), discount_value: z.number().int(),
  minimum_order_cents: z.number().int(), fulfillment_type: z.enum(["pickup", "delivery"]).nullable(), starts_at: z.string().nullable(), ends_at: z.string().nullable(),
  total_usage_limit: z.number().int().nullable(), per_customer_limit: z.number().int().nullable(), uses_count: z.number().int(), active: z.boolean(), members_only: z.boolean(), archived_at: z.string().nullable(), created_at: z.string(),
});
export type Promotion = z.infer<typeof promotionSchema>;

const optionalCount = z.union([z.literal("").transform(() => null), z.coerce.number().int().min(1).max(1_000_000)]);
const money = z.coerce.number().min(0).max(10_000);

/** Form values → a promotions row. Money is entered in dollars, percents as whole percents. */
export function parsePromotionForm(values: Record<string, FormDataEntryValue | null>, timeZone: string) {
  const parsed = z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,40}$/, "Codes are 2–40 letters, numbers, dashes, or underscores."),
    description: z.string().trim().max(500),
    discount_type: z.enum(["fixed", "percent"]),
    discount_amount: z.coerce.number().positive("Enter a discount greater than zero."),
    minimum_order: money,
    fulfillment_type: z.enum(["", "pickup", "delivery"]),
    starts_at: z.string(), ends_at: z.string(),
    total_usage_limit: optionalCount, per_customer_limit: optionalCount,
    active: z.boolean(),
    members_only: z.boolean(),
  }).safeParse({ ...values, active: values.active === "on", members_only: values.members_only === "on", description: values.description ?? "", starts_at: values.starts_at ?? "", ends_at: values.ends_at ?? "", fulfillment_type: values.fulfillment_type ?? "" });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the promotion details." } as const;
  const input = parsed.data;
  if (input.discount_type === "percent" && input.discount_amount > 100) return { ok: false, error: "A percent discount cannot exceed 100%." } as const;
  const starts = input.starts_at ? zonedLocalToUtcIso(input.starts_at, timeZone) : null;
  const ends = input.ends_at ? zonedLocalToUtcIso(input.ends_at, timeZone) : null;
  if ((input.starts_at && !starts) || (input.ends_at && !ends)) return { ok: false, error: "Enter valid start and end times." } as const;
  if (starts && ends && ends <= starts) return { ok: false, error: "The end time must be after the start time." } as const;
  return { ok: true, row: {
    code: input.code, description: input.description, discount_type: input.discount_type,
    // Both checkout functions read fixed discounts as cents and percents as basis points.
    discount_value: Math.round(input.discount_amount * 100),
    minimum_order_cents: Math.round(input.minimum_order * 100),
    fulfillment_type: input.fulfillment_type || null, starts_at: starts, ends_at: ends,
    total_usage_limit: input.total_usage_limit, per_customer_limit: input.per_customer_limit, active: input.active,
    // A members-only offer is a Wayne's Rewards offer: hidden from the public
    // deals list and refused at checkout for anyone who has not joined.
    members_only: input.members_only,
  } } as const;
}

export function describeDiscount(promotion: Pick<Promotion, "discount_type" | "discount_value">) {
  return promotion.discount_type === "percent" ? `${promotion.discount_value / 100}% off` : `$${(promotion.discount_value / 100).toFixed(2)} off`;
}

export function promotionState(promotion: Promotion, now: number) {
  if (promotion.archived_at) return "Archived";
  if (!promotion.active) return "Paused";
  if (promotion.ends_at && Date.parse(promotion.ends_at) <= now) return "Ended";
  if (promotion.starts_at && Date.parse(promotion.starts_at) > now) return "Scheduled";
  if (promotion.total_usage_limit !== null && promotion.uses_count >= promotion.total_usage_limit) return "Used up";
  return "Live";
}
