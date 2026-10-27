import type { PosCustomer } from "@/lib/pos/schemas";
import { formatPhone } from "./normalize";

/**
 * What a ringing line shows, like a saved contact on a cell phone (owner,
 * 2026-10-27): "once I save my dad's number every time he calls it shows his
 * name — for the POS I want the phone number and address to pop up too, so you
 * only ever save a customer once."
 *
 * The same rules live in SQL (public.wayne_caller_id_person_name) so a customer
 * saved without a typed name takes the caller ID name instead of "Customer".
 */

/** "Customer" / "Phone caller" / blank: a profile saved before anyone typed a name. */
export function isPlaceholderName(first: string | null | undefined, last: string | null | undefined): boolean {
  const full = `${first ?? ""} ${last ?? ""}`.trim().toLowerCase();
  return full === "" || full === "customer" || full === "phone caller" || full === "walk-in";
}

/** The customer's name, or "" when the profile only has a placeholder. */
export function customerName(customer: Pick<PosCustomer, "first_name" | "last_name"> | null | undefined): string {
  if (!customer || isPlaceholderName(customer.first_name, customer.last_name)) return "";
  return `${customer.first_name} ${customer.last_name}`.trim();
}

const NOT_A_PERSON = /^(WIRELESS CALLER|WIRELESS|CELL PHONE|CELLULAR|UNKNOWN|UNKNOWN CALLER|UNKNOWN NAME|UNAVAILABLE|NAME UNAVAILABLE|NOT AVAILABLE|PRIVATE|PRIVATE CALLER|PRIVATE NUMBER|ANONYMOUS|RESTRICTED|BLOCKED|TOLL FREE|TOLL FREE CALLER|OUT OF AREA|O|P)$/;

/**
 * The phone company's caller ID name when it reads as a person or business
 * ("DAVID STRUB" → "David Strub"); null for "WIRELESS CALLER", a town and
 * state ("NORTHFIELD MA"), or anything with digits.
 */
export function callerIdPersonName(raw: string | null | undefined): string | null {
  const text = (raw ?? "").replace(/[_\s]+/g, " ").trim().toUpperCase();
  if (text.replace(/[^A-Z]/g, "").length < 2) return null;
  if (/\d/.test(text) || NOT_A_PERSON.test(text)) return null;
  // Carriers send "CITY ST" when they have no name for the number.
  if (/ (A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])$/.test(text)) return null;
  // "PEREZ,KEVIN" / "BOTSIS, JOHN": the carrier's LAST,FIRST order.
  const comma = text.indexOf(",");
  const ordered = comma >= 0 ? `${text.slice(comma + 1).replace(/,/g, " ").trim()} ${text.slice(0, comma).trim()}`.trim() : text;
  // Capitalised the way Postgres initcap() does, so the screen and the saved profile agree.
  return ordered.toLowerCase().replace(/(^|[^a-z0-9'])([a-z])/g, (_, before: string, letter: string) => before + letter.toUpperCase()).slice(0, 100);
}

export type CallerCardInfo = {
  /** The big line: the customer's name, else the caller ID name, else what to do. */
  name: string;
  phone: string;
  /** One line of the default address, when the customer has one. */
  address: string | null;
  /** "Returning customer · 4 orders · last Oct 24", "New caller", … */
  detail: string;
  known: boolean;
};

type CallLike = {
  phoneNumber: string;
  callerName: string;
  lookup: "pending" | "done" | "failed";
  matches: PosCustomer[];
};

export function addressLine(customer: PosCustomer | null | undefined): string | null {
  const address = customer?.addresses.find((candidate) => candidate.is_default) ?? customer?.addresses[0];
  if (!address) return null;
  return `${address.address1}${address.address2 ? `, ${address.address2}` : ""}, ${address.city}`;
}

export function callerCardInfo(call: CallLike): CallerCardInfo {
  const phone = formatPhone(call.phoneNumber) || "No number";
  const callerId = callerIdPersonName(call.callerName);
  if (call.matches.length > 1) {
    return { name: `${call.matches.length} customers use this number`, phone, address: null, detail: "Pick who is calling", known: true };
  }
  const customer = call.matches[0] ?? null;
  if (customer) {
    const last = customer.last_order_at ? ` · last ${new Date(customer.last_order_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "";
    return {
      name: customerName(customer) || callerId || "Returning customer",
      phone,
      address: addressLine(customer),
      detail: `Returning customer · ${customer.order_count} order${customer.order_count === 1 ? "" : "s"}${last}`,
      known: true,
    };
  }
  if (call.lookup === "pending") return { name: callerId || "Looking up…", phone, address: null, detail: "Looking up customer…", known: false };
  if (call.lookup === "failed") return { name: callerId || "Caller", phone, address: null, detail: "Could not look up — you can still take the order", known: false };
  return { name: callerId || "New caller", phone, address: null, detail: "New caller — saved with their first order", known: false };
}
