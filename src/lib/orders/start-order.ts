import type { StoreSettings } from "@/lib/content/schemas";
import type { PosDraft } from "./drafts";

/**
 * The rules behind the POS New Order card (src/app/pos/start-order-card.tsx),
 * kept pure so they can be tested.  They mirror what /api/pos/orders refuses,
 * so a cashier finds out on the card, not after building the whole ticket.
 */
export type OrderKind = "walkin" | "pickup" | "delivery";

/** The kind a ticket already is, or null while the cashier hasn't chosen yet. */
export function orderKind(draft: PosDraft): OrderKind {
  if (draft.customerMode === "walk_in") return "walkin";
  return draft.fulfillment === "delivery" ? "delivery" : "pickup";
}

export function phoneDigits(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

/** Everything the server will refuse, checked before the cashier reaches the menu. */
export function startProblem(draft: PosDraft, kind: OrderKind | null, settings: StoreSettings): string {
  if (!kind) return "Choose Walk-in, Pickup or Delivery.";
  if (kind === "walkin") return "";
  if (!draft.firstName.trim() || !draft.lastName.trim()) return "Enter the customer's first and last name, or pick them from the matches.";
  if (phoneDigits(draft.phone).length !== 10) return "Enter a 10-digit phone number.";
  if (kind === "delivery") {
    if (!settings.delivery_enabled) return "Delivery is switched off in Admin → Settings.";
    if (!draft.addressId) {
      const address = draft.address;
      if (!address.address1.trim() || !address.city.trim() || !address.state.trim() || !address.postal_code.trim()) return "Pick a saved address or enter the street, city, state and ZIP.";
    }
  }
  return "";
}

/** ZIP of the address the ticket will deliver to. */
export function deliveryZip(draft: PosDraft) {
  const saved = draft.customer?.addresses.find((address) => address.id === draft.addressId);
  return (saved?.postal_code ?? draft.address.postal_code).trim().slice(0, 5);
}

/** True when the store limits delivery to some ZIP codes and this one isn't among them. */
export function outsideDeliveryArea(zip: string, deliveryPostalCodes: string[]) {
  const five = zip.trim().slice(0, 5);
  return five.length === 5 && deliveryPostalCodes.length > 0 && !deliveryPostalCodes.some((code) => code.trim().slice(0, 5) === five);
}
