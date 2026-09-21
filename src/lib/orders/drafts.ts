import { z } from "zod";
import { cartLineSchema, type CartLine } from "@/lib/orders/schemas";
import { posCustomerSchema, type PosCustomer } from "@/lib/pos/schemas";

/**
 * Tickets in progress at this register (build sheet §13, §36, test 15).
 *
 * Every ticket is a draft with its own idempotency key.  Drafts survive a
 * refresh (they are saved to the device), several can be on hold at once, and
 * a submit that fails keeps the draft — and its key — so retrying can never
 * create a second order (§30).
 *
 * Pure functions: the order store wraps these and saves the result.
 */

export const draftAddressSchema = z.object({
  address1: z.string(), address2: z.string(), city: z.string(), state: z.string(),
  postal_code: z.string(), delivery_instructions: z.string(),
});
export type DraftAddress = z.infer<typeof draftAddressSchema>;

export const blankAddress: DraftAddress = { address1: "", address2: "", city: "Worcester", state: "MA", postal_code: "", delivery_instructions: "" };

export const posDraftSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(16),
  createdAt: z.string(),
  updatedAt: z.string(),
  held: z.boolean(),
  source: z.enum(["pos", "phone"]),
  /** Phone orders remember the physical line and the ring they came from (§11). */
  phoneLine: z.number().int().min(1).max(8).nullable(),
  phoneCallId: z.string().nullable(),
  phoneCallKey: z.string().nullable(),
  callerName: z.string(),
  customerMode: z.enum(["walk_in", "identified"]),
  fulfillment: z.enum(["pickup", "delivery"]),
  customer: posCustomerSchema.nullable(),
  firstName: z.string(),
  lastName: z.string(),
  phone: z.string(),
  email: z.string(),
  addressId: z.string(),
  address: draftAddressSchema,
  cart: z.array(cartLineSchema),
  orderNote: z.string(),
  promoCode: z.string(),
  manualType: z.enum(["", "fixed", "percent"]),
  manualValue: z.string(),
  manualReason: z.string(),
  paymentMethod: z.enum(["test_manual", "cash"]),
  /** Server copy (Phase 6): the version last saved, and when. Never part of the ticket itself. */
  syncedVersion: z.number().int().nullable().optional().default(null),
  syncedAt: z.string().nullable().optional().default(null),
  /** Submit failed for lack of a connection; resent automatically with the same key (§30). */
  submitPending: z.boolean().optional().default(false),
});
export type PosDraft = z.infer<typeof posDraftSchema>;

export type DraftsState = { activeId: string; drafts: PosDraft[] };

function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function blankDraft(patch: Partial<PosDraft> = {}, now = new Date().toISOString()): PosDraft {
  return {
    id: newId(),
    idempotencyKey: newId(),
    createdAt: now,
    updatedAt: now,
    held: false,
    source: "pos",
    phoneLine: null,
    phoneCallId: null,
    phoneCallKey: null,
    callerName: "",
    customerMode: "walk_in",
    fulfillment: "pickup",
    customer: null,
    firstName: "",
    lastName: "",
    phone: "",
    email: "",
    addressId: "",
    address: blankAddress,
    cart: [],
    orderNote: "",
    promoCode: "",
    manualType: "",
    manualValue: "",
    manualReason: "",
    paymentMethod: "test_manual",
    syncedVersion: null,
    syncedAt: null,
    submitPending: false,
    ...patch,
  };
}

/** Anything a cashier would be upset to lose. */
export function draftHasContent(draft: PosDraft): boolean {
  return draft.cart.length > 0 || draft.source === "phone" || Boolean(draft.customer || draft.firstName || draft.lastName || draft.phone || draft.orderNote);
}

export function initialDrafts(): DraftsState {
  const draft = blankDraft();
  return { activeId: draft.id, drafts: [draft] };
}

export function activeDraft(state: DraftsState): PosDraft {
  return state.drafts.find((draft) => draft.id === state.activeId) ?? state.drafts[0]!;
}

export function heldDrafts(state: DraftsState): PosDraft[] {
  return state.drafts.filter((draft) => draft.id !== state.activeId);
}

/** A short name for a draft on the hold tray. */
export function draftLabel(draft: PosDraft): string {
  const who = draft.customer ? `${draft.customer.first_name} ${draft.customer.last_name}`.trim() : `${draft.firstName} ${draft.lastName}`.trim() || draft.callerName;
  const origin = draft.source === "phone" ? (draft.phoneLine ? `Line ${draft.phoneLine}` : "Phone") : "Walk-in";
  return who ? `${origin} · ${who}` : origin;
}

/** Put the current ticket aside and leave a fresh one on screen. */
function parkActive(state: DraftsState, now: string): PosDraft[] {
  const current = activeDraft(state);
  if (!draftHasContent(current)) return state.drafts.filter((draft) => draft.id !== current.id);
  return state.drafts.map((draft) => (draft.id === current.id ? { ...draft, held: true, updatedAt: now } : draft));
}

/** Hold (§36): the current ticket is kept intact and a new one starts. */
export function holdActive(state: DraftsState, now = new Date().toISOString()): DraftsState {
  const fresh = blankDraft({}, now);
  return { activeId: fresh.id, drafts: [...parkActive(state, now), fresh] };
}

/** Start a new ticket (e.g. from a phone call) without losing the one on screen. */
export function startDraft(state: DraftsState, patch: Partial<PosDraft>, now = new Date().toISOString()): DraftsState {
  const fresh = blankDraft(patch, now);
  return { activeId: fresh.id, drafts: [...parkActive(state, now), fresh] };
}

/** Resume a held ticket; the one on screen is held in its place. */
export function resumeDraft(state: DraftsState, id: string, now = new Date().toISOString()): DraftsState {
  if (id === state.activeId || !state.drafts.some((draft) => draft.id === id)) return state;
  const drafts = parkActive(state, now).map((draft) => (draft.id === id ? { ...draft, held: false, updatedAt: now } : draft));
  return { activeId: id, drafts };
}

export function updateDraft(state: DraftsState, id: string, patch: Partial<PosDraft> | ((draft: PosDraft) => Partial<PosDraft>), now = new Date().toISOString()): DraftsState {
  return {
    ...state,
    drafts: state.drafts.map((draft) => (draft.id === id ? { ...draft, ...(typeof patch === "function" ? patch(draft) : patch), updatedAt: now } : draft)),
  };
}

/** Drop a ticket (submitted, or cleared on purpose). Always leaves one on screen. */
export function removeDraft(state: DraftsState, id: string, now = new Date().toISOString()): DraftsState {
  const drafts = state.drafts.filter((draft) => draft.id !== id);
  if (id !== state.activeId && drafts.length) return { ...state, drafts };
  const fresh = blankDraft({}, now);
  return { activeId: fresh.id, drafts: [...drafts, fresh] };
}

export function findDraftForCall(state: DraftsState, callKey: string): PosDraft | undefined {
  return state.drafts.find((draft) => draft.phoneCallKey === callKey);
}

/** Load saved drafts; anything unreadable is dropped rather than crashing the register. */
export function parseSavedDrafts(raw: string | null): DraftsState | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const record = value as { activeId?: unknown; drafts?: unknown };
    if (!Array.isArray(record.drafts)) return null;
    const drafts = record.drafts.flatMap((entry) => {
      const parsed = posDraftSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
    if (!drafts.length) return null;
    const activeId = typeof record.activeId === "string" && drafts.some((draft) => draft.id === record.activeId) ? record.activeId : drafts[drafts.length - 1]!.id;
    return { activeId, drafts };
  } catch {
    return null;
  }
}

/** The ticket as /api/pos/orders expects it. */
export function draftToOrderPayload(draft: PosDraft) {
  const manual = Math.round((Number(draft.manualValue) || 0) * 100);
  const noProfile = draft.customerMode === "walk_in";
  return {
    idempotency_key: draft.idempotencyKey,
    customer_mode: draft.customerMode,
    customer_id: draft.customer?.id ?? "",
    source: draft.source,
    phone_call_id: draft.source === "phone" ? draft.phoneCallId ?? "" : "",
    phone_line: draft.source === "phone" ? draft.phoneLine : null,
    fulfillment_type: noProfile ? "pickup" : draft.fulfillment,
    payment_method: draft.paymentMethod,
    first_name: draft.firstName,
    last_name: draft.lastName,
    phone: noProfile && draft.source === "pos" ? "" : draft.phone,
    email: noProfile ? "" : draft.email,
    address_id: draft.addressId,
    address: draft.address,
    promo_code: draft.promoCode,
    manual_discount_type: draft.manualType,
    manual_discount_value: draft.manualType ? manual : 0,
    manual_discount_reason: draft.manualReason,
    tip_cents: 0,
    special_instructions: draft.orderNote,
    items: draft.cart.map((line: CartLine) => ({
      menu_item_id: line.menu_item_id, variant_id: line.variant_id, quantity: line.quantity,
      special_instructions: line.special_instructions, modifiers: line.modifiers, lists_included: true,
    })),
  };
}

/** Everything a phone order carries in from the call (§9, §32). */
export function draftFromCall(input: {
  callKey: string; callId: string | null; line: number; phoneNumber: string; callerName: string;
  customer: PosCustomer | null; withoutProfile?: boolean;
}): Partial<PosDraft> {
  const { customer } = input;
  const preferred = customer?.addresses.find((address) => address.is_default) ?? customer?.addresses[0];
  return {
    source: "phone",
    phoneLine: input.line,
    phoneCallId: input.callId,
    phoneCallKey: input.callKey,
    callerName: input.callerName,
    customerMode: input.withoutProfile ? "walk_in" : "identified",
    fulfillment: "pickup",
    customer,
    firstName: customer?.first_name ?? "",
    lastName: customer?.last_name ?? "",
    // The employee never retypes the number (§9).
    phone: customer?.phone ?? input.phoneNumber,
    email: customer?.email ?? "",
    // Ready for Delivery the moment the cashier switches to it (§9).
    addressId: preferred?.id ?? "",
  };
}

/** Held drafts and the one on screen that another register should be able to see. */
export function draftNeedsSync(draft: PosDraft): boolean {
  if (!draftHasContent(draft)) return false;
  return draft.syncedAt === null || Date.parse(draft.updatedAt) > Date.parse(draft.syncedAt);
}

/** Record a server save without touching updatedAt (which would trigger another save). */
export function markSynced(state: DraftsState, id: string, version: number, syncedAt: string): DraftsState {
  return { ...state, drafts: state.drafts.map((draft) => (draft.id === id ? { ...draft, syncedVersion: version, syncedAt } : draft)) };
}

/** A ticket taken over from another register becomes the one on screen here. */
export function adoptDraft(state: DraftsState, draft: PosDraft, now = new Date().toISOString()): DraftsState {
  const others = state.drafts.filter((candidate) => candidate.id !== draft.id);
  const current = activeDraft(state);
  const parked = current.id === draft.id ? others : (draftHasContent(current) ? others.map((candidate) => (candidate.id === current.id ? { ...candidate, held: true } : candidate)) : others.filter((candidate) => candidate.id !== current.id));
  return { activeId: draft.id, drafts: [...parked, { ...draft, held: false, updatedAt: now }] };
}

/** The ticket body stored on the server: everything but this register's sync bookkeeping. */
export function draftBody(draft: PosDraft) {
  const { syncedVersion: _version, syncedAt: _syncedAt, submitPending: _pending, ...body } = draft;
  void _version; void _syncedAt; void _pending;
  return body;
}
