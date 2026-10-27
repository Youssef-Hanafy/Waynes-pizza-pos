import type { DraftAddress, PosDraft } from "@/lib/orders/drafts";
import { phoneDigits, type OrderKind } from "@/lib/orders/start-order";
import { posCustomerSchema, type PosCustomer, type PosSaveCustomer } from "@/lib/pos/schemas";

/**
 * Save the customer from the order screen (owner, 2026-10-27): by itself when
 * the order is started — test orders and orders never sent included — or from
 * the small Save button.  The server side is an upsert by phone, so a customer
 * is never saved twice.
 */

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** What to save for this ticket, or null when there is no full phone number yet. */
export function rememberPayload(draft: PosDraft, kind: OrderKind | null): PosSaveCustomer | null {
  const digits = phoneDigits(draft.phone);
  if (digits.length !== 10) return null;
  const street = draft.address.address1.trim();
  return {
    phone: digits,
    first_name: draft.firstName.trim(),
    last_name: draft.lastName.trim(),
    // A half-typed email is left out rather than blocking the save.
    email: EMAIL.test(draft.email.trim()) ? draft.email.trim() : "",
    // A typed delivery address is kept with the customer; a saved one picked from the list already is.
    ...(kind === "delivery" && !draft.addressId && street ? { address: { ...draft.address, address1: street } } : {}),
  };
}

/** Nothing new to save: the profile on the ticket already has this name, email and address. */
export function alreadySaved(draft: PosDraft, payload: PosSaveCustomer): boolean {
  const customer = draft.customer;
  if (!customer || payload.address) return false;
  if (phoneDigits(customer.phone) !== payload.phone && !customer.phones.some((extra) => phoneDigits(extra.phone) === payload.phone)) return false;
  const sameName = !payload.first_name || (customer.first_name.trim() === payload.first_name && customer.last_name.trim() === (payload.last_name ?? ""));
  const sameEmail = !payload.email || (customer.email ?? "").toLowerCase() === payload.email.toLowerCase();
  return sameName && sameEmail;
}

/** The saved address that matches the one typed, so the order uses it instead of adding it again. */
export function savedAddressId(customer: PosCustomer, address: DraftAddress): string {
  const street = address.address1.trim().toLowerCase();
  const unit = address.address2.trim().toLowerCase();
  return customer.addresses.find((saved) => saved.address1.trim().toLowerCase() === street && saved.address2.trim().toLowerCase() === unit)?.id ?? "";
}

export async function rememberCustomer(payload: PosSaveCustomer): Promise<PosCustomer> {
  const response = await fetch("/api/pos/customers/remember", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : "The customer could not be saved.");
  const parsed = posCustomerSchema.safeParse(body);
  if (!parsed.success) throw new Error("The saved customer was invalid.");
  return parsed.data;
}
