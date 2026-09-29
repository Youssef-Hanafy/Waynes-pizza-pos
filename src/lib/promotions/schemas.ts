import { z } from "zod";
import { zonedLocalToUtcIso } from "@/lib/time/zoned";

export const promotionSchema = z.object({
  id: z.uuid(), code: z.string(), description: z.string(), discount_type: z.enum(["fixed", "percent"]), discount_value: z.number().int(),
  minimum_order_cents: z.number().int(), fulfillment_type: z.enum(["pickup", "delivery"]).nullable(), starts_at: z.string().nullable(), ends_at: z.string().nullable(),
  total_usage_limit: z.number().int().nullable(), per_customer_limit: z.number().int().nullable(), uses_count: z.number().int(), active: z.boolean(), members_only: z.boolean(), archived_at: z.string().nullable(), created_at: z.string(),
  code_mode: z.enum(["public", "personal"]), delivery: z.enum(["publish", "segment_entered"]), audience_segment_id: z.uuid().nullable(),
  code_valid_days: z.number().int().nullable(), reissue_after_days: z.number().int().nullable(), crm_event_name: z.string().nullable(),
  published_at: z.string().nullable(), texts_queued: z.number().int(),
});
export type Promotion = z.infer<typeof promotionSchema>;

const optionalCount = z.union([z.literal("").transform(() => null), z.coerce.number().int().min(1).max(1_000_000)]);
const optionalDays = (max: number) => z.union([z.literal("").transform(() => null), z.coerce.number().int().min(1).max(max)]);
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
    code_mode: z.enum(["public", "personal"]),
    delivery: z.enum(["publish", "segment_entered"]),
    audience_segment_id: z.union([z.literal(""), z.uuid()]),
    code_valid_days: optionalDays(365),
    reissue_after_days: optionalDays(3650),
    crm_event_name: z.string().trim().toLowerCase(),
  }).safeParse({
    ...values, active: values.active === "on", members_only: values.members_only === "on", description: values.description ?? "", starts_at: values.starts_at ?? "", ends_at: values.ends_at ?? "", fulfillment_type: values.fulfillment_type ?? "",
    code_mode: values.code_mode || "public", delivery: values.delivery || "publish", audience_segment_id: values.audience_segment_id ?? "",
    code_valid_days: values.code_valid_days ?? "", reissue_after_days: values.reissue_after_days ?? "", crm_event_name: values.crm_event_name ?? "",
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the promotion details." } as const;
  const input = parsed.data;
  if (input.discount_type === "percent" && input.discount_amount > 100) return { ok: false, error: "A percent discount cannot exceed 100%." } as const;
  const starts = input.starts_at ? zonedLocalToUtcIso(input.starts_at, timeZone) : null;
  const ends = input.ends_at ? zonedLocalToUtcIso(input.ends_at, timeZone) : null;
  if ((input.starts_at && !starts) || (input.ends_at && !ends)) return { ok: false, error: "Enter valid start and end times." } as const;
  if (starts && ends && ends <= starts) return { ok: false, error: "The end time must be after the start time." } as const;
  const personal = input.code_mode === "personal";
  // Only a personal offer can be automatic: it needs a code per customer to track.
  const automatic = personal && input.delivery === "segment_entered";
  if (personal && input.code.length > 30) return { ok: false, error: "Personal offer codes are at most 30 characters (each customer's code adds -XXXXXX)." } as const;
  if (automatic && !input.audience_segment_id) return { ok: false, error: "Choose the segment that sends this offer (for win-back: 30-day inactive)." } as const;
  const eventName = automatic ? (input.crm_event_name || input.code.toLowerCase()).replace(/[^a-z_]/g, "_").replace(/^_+/, "").slice(0, 40) : null;
  if (automatic && (!eventName || !/^[a-z][a-z_]{1,39}$/.test(eventName) || ["redeemed", "issued", "published"].includes(eventName))) {
    return { ok: false, error: "The CRM event name is 2–40 lowercase letters or underscores, e.g. winback." } as const;
  }
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
    // A personal offer is a template: its own code never works at checkout and
    // never shows on the public deals list — each customer gets their own.
    code_mode: input.code_mode,
    // Left alone for public codes so editing a private code (a welcome code) never publishes it.
    private: personal ? true : undefined,
    delivery: automatic ? "segment_entered" as const : "publish" as const,
    audience_segment_id: input.audience_segment_id || null,
    code_valid_days: personal ? input.code_valid_days : null,
    reissue_after_days: automatic ? input.reissue_after_days : null,
    crm_event_name: eventName,
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

export function describeCodeMode(promotion: Pick<Promotion, "code_mode" | "delivery">) {
  if (promotion.code_mode === "public") return "Public code — the same code for everyone";
  return promotion.delivery === "segment_entered"
    ? "Personal codes — sent automatically when a customer enters the segment"
    : "Personal codes — each member gets their own when you publish";
}
