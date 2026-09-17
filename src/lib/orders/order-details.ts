import { z } from "zod";

/**
 * What we ask for before someone starts ordering.
 *
 * Delivery and pickup need different things, and asking for the wrong ones is
 * how an order gets abandoned.  Delivery needs somewhere to drive to — and
 * whether it is a house or an apartment, because "third floor, buzzer 2B" is the
 * difference between a hot pizza and a cold one.  Pickup needs a name to call
 * out.  Nothing else is asked at this point.
 *
 * The answers live in the browser and are handed to checkout pre-filled, so the
 * customer types their address once per order rather than twice.
 */

export const ORDER_DETAILS_STORAGE_KEY = "wayne-order-details-v1";

export const residenceTypes = ["house", "apartment", "business", "dorm", "other"] as const;
export type ResidenceType = (typeof residenceTypes)[number];

export const residenceLabels: Record<ResidenceType, string> = {
  house: "House",
  apartment: "Apartment / condo",
  business: "Business",
  dorm: "Dorm",
  other: "Somewhere else",
};

/** Only these need the unit line, so only these are asked for it. */
export const residenceNeedsUnit: Record<ResidenceType, boolean> = {
  house: false,
  apartment: true,
  business: true,
  dorm: true,
  other: false,
};

export const orderDetailsSchema = z.object({
  fulfillment: z.enum(["pickup", "delivery"]),
  first_name: z.string().trim().max(100).default(""),
  last_name: z.string().trim().max(100).default(""),
  phone: z.string().trim().max(24).default(""),
  residence_type: z.enum(residenceTypes).default("house"),
  address1: z.string().trim().max(200).default(""),
  address2: z.string().trim().max(200).default(""),
  city: z.string().trim().max(120).default(""),
  state: z.string().trim().max(80).default(""),
  postal_code: z.string().trim().max(20).default(""),
  delivery_instructions: z.string().trim().max(1000).default(""),
});

export type OrderDetails = z.infer<typeof orderDetailsSchema>;

export function readOrderDetails(raw: string | null): OrderDetails | null {
  if (!raw) return null;
  try {
    const parsed = orderDetailsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** True when we have everything that fulfillment actually needs. */
export function orderDetailsComplete(details: OrderDetails | null, fulfillment: "pickup" | "delivery") {
  if (!details || details.fulfillment !== fulfillment) return false;
  if (!details.first_name) return false;
  if (fulfillment === "pickup") return true;
  if (!details.address1 || !details.city || !details.state || !details.postal_code) return false;
  return !(residenceNeedsUnit[details.residence_type] && !details.address2);
}

/**
 * "About 45 minutes" is a promise; "40–45 minutes" is an answer.  The number
 * comes from Admin -> Website settings, so the owner moves it on a snowy night
 * without anybody touching the code.
 */
export function estimateRange(minutes: number) {
  const low = Math.max(5, minutes - 5);
  return low === minutes ? `${minutes} min` : `${low}–${minutes} min`;
}
