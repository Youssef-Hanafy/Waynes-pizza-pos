"use client";

import { PrinterDrawerProvider } from "@/hardware/drawer/provider";
import { createPrinterProvider, nativePrinter, printerConfigFrom } from "@/hardware/printers/provider";
import type { StoreSettings } from "@/lib/content/schemas";
import type { HardwareSettings } from "@/lib/hardware/schemas";
import { formatCents, type PublicMenu } from "@/lib/menu/schemas";
import { cartLineUnitCents, cartSubtotalCents, describeLineModifiers, findMenuItem } from "@/lib/orders/cart";
import { activeDraft, blankDraft, draftToOrderPayload, updateDraft, type OfflineOrder, type OfflinePayment, type PosDraft } from "@/lib/orders/drafts";
import { buildKitchenTicket, buildReceipt, type PrintDocument } from "@/lib/printing/document";
import { posOrderCreatedSchema } from "@/lib/pos/schemas";
import { workspaceStorageKey } from "@/lib/tenancy/active-workspace";
import { getClientWorkspaceScope } from "@/lib/tenancy/client-scope";
import { logDevice } from "@/lib/pos/device-log";
import { isNoAnswer, isServerReachable, reportNetworkFailure, reportServerOk } from "./connectivity";
import { useStore } from "./create-store";
import { getDeviceId, notify } from "./draft-sync";
import { orderStore } from "./order-store";
import { phoneActions } from "./phone-store";
import { acknowledgeForwardedCard, forwardedOfflineCards, onForwardedOfflineCard } from "./stripe-reader";

/**
 * ORDERS TAKEN OFFLINE (owner, 2026-10-24: "even when not connected to wifi
 * it'll work and once it reconnects it'll put everything that happened
 * online").
 *
 * When the register cannot reach the server, Take payment still works:
 *   1. the ticket stays on this register as an offline order ("O1", "O2" …)
 *   2. it is paid here — cash (change shown, drawer opened straight through the
 *      receipt printer), the Stripe M2 (the reader stores the card and sends it
 *      to Stripe when it can), or Pay later / Cash at the door
 *   3. its kitchen ticket (and a delivery's receipt) prints here, straight to
 *      the printers on the store network — the same slips as always
 *   4. when the server answers again it is sent with its own idempotency key
 *      (never twice), then its payment; the server is told the counter already
 *      printed it, so nothing prints or pops the drawer a second time
 *
 * Everything lives in the ticket store, which is saved on the device, so a
 * closed app or a reboot loses nothing.  Online, none of this runs.
 */

type Context = { hardware: HardwareSettings; settings: StoreSettings; menu: PublicMenu; staffName: string };
let context: Context | null = null;

/** The POS shell hands over what printing and totals need (and refreshes it with the menu). */
export function configureOfflineOrders(next: Context) {
  context = next;
}

// ---- Totals (the same arithmetic as the ticket on screen and the database) ----

export function offlineTotals(draft: PosDraft, menu: PublicMenu, settings: StoreSettings) {
  const subtotal = cartSubtotalCents(menu, draft.cart);
  const manualInput = Number(draft.manualValue) || 0;
  const discount = draft.manualType === "fixed" ? Math.min(subtotal, Math.round(manualInput * 100))
    : draft.manualType === "percent" ? Math.min(subtotal, Math.round(subtotal * manualInput / 100)) : 0;
  const delivery = draft.fulfillment === "delivery" && draft.customerMode !== "walk_in";
  const deliveryFee = delivery ? settings.delivery_fee_cents : 0;
  // The delivery fee is not taxed (owner, 2026-10-11).
  const tax = Math.round((subtotal - discount) * settings.tax_rate_basis_points / 10_000);
  return { subtotal, discount, deliveryFee, tax, total: subtotal - discount + deliveryFee + tax, delivery };
}

/** Why this ticket can't be finished offline, or "" when it can. */
export function offlineProblem(draft: PosDraft) {
  if (draft.addTo) return "Adding items to an order already sent needs the connection. Try again when it is back.";
  if (draft.promoCode.trim()) return "Promotion codes can't be checked offline. Take the code off (or use Discount), or wait for the connection.";
  if (!draft.cart.length) return "Add at least one item to the ticket.";
  return "";
}

// ---- The day's offline numbers: O1, O2 … ----

function nextLocalNumber(timeZone: string) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const key = workspaceStorageKey(getClientWorkspaceScope().workspaceId, "pos-offline-number");
  let next = 1;
  try {
    const saved = JSON.parse(window.localStorage.getItem(key) ?? "null") as { day?: string; n?: number } | null;
    if (saved?.day === day && typeof saved.n === "number") next = saved.n + 1;
    window.localStorage.setItem(key, JSON.stringify({ day, n: next }));
  } catch {
    next = Math.max(1, offlineDrafts().length + 1);
  }
  return `O${next}`;
}

// ---- The store side ----

export function offlineDrafts(): PosDraft[] {
  return orderStore.get().drafts.filter((draft) => draft.offline !== null);
}

function patchOffline(id: string, patch: Partial<OfflineOrder>) {
  orderStore.set((state) => updateDraft(state, id, (draft) => (draft.offline ? { offline: { ...draft.offline, ...patch }, submitPending: true } : {})));
}

function findDraft(id: string) {
  return orderStore.get().drafts.find((draft) => draft.id === id);
}

/** The ticket on screen could not be sent: make it an offline order (once). */
export function beginOfflineOrder(id: string): OfflineOrder | null {
  const draft = findDraft(id);
  if (!draft || !context) return null;
  if (draft.offline) return draft.offline;
  const offline: OfflineOrder = {
    takenAt: new Date().toISOString(), localNumber: nextLocalNumber(context.settings.timezone),
    totalCents: offlineTotals(draft, context.menu, context.settings).total, printed: false, payment: null,
    orderId: null, orderNumber: null, dailyNumber: null, paymentRecorded: false, problem: "",
  };
  orderStore.set((state) => updateDraft(state, id, { offline, submitPending: true }));
  logDevice("offline.order_taken", offline.localNumber, { total: offline.totalCents });
  return offline;
}

/** Back to editing (the cashier tapped Back before any payment). */
export function cancelOfflineOrder(id: string) {
  const draft = findDraft(id);
  if (!draft?.offline || draft.offline.payment) return;
  orderStore.set((state) => updateDraft(state, id, { offline: null, submitPending: false }));
}

/**
 * Paid (or Pay later): print the kitchen ticket here, open the drawer for
 * cash, put the order aside to be sent, and leave a fresh ticket on screen.
 */
export async function finishOfflineOrder(id: string, payment: OfflinePayment): Promise<{ printed: boolean; message: string }> {
  patchOffline(id, { payment });
  // A fresh ticket on screen straight away (the paid order must not sit there editable while it prints);
  // the offline order stays saved on this register until it is sent.
  orderStore.set((state) => {
    if (state.activeId !== id) return state;
    const fresh = blankDraft();
    return { activeId: fresh.id, drafts: [...state.drafts.map((draft) => (draft.id === id ? { ...draft, held: true } : draft)), fresh] };
  });
  // The drawer first (the cash is in hand), then the slips.
  if (payment.kind === "cash") await openDrawerHere();
  const printed = await printOfflineOrder(id);
  void flushOfflineOrders();
  return printed;
}

/** Remove an offline order whose problem someone has dealt with. */
export function dismissOfflineOrder(id: string) {
  orderStore.set((state) => {
    const drafts = state.drafts.filter((draft) => draft.id !== id);
    if (drafts.length && state.activeId !== id) return { ...state, drafts };
    const fresh = blankDraft();
    return { activeId: fresh.id, drafts: [...drafts, fresh] };
  });
}

// ---- Printing and the drawer, straight to the store network ----

function documentFor(draft: PosDraft, ctx: Context): PrintDocument {
  const offline = draft.offline!;
  const totals = offlineTotals(draft, ctx.menu, ctx.settings);
  const payment = offline.payment;
  const paid = payment?.kind === "cash" || payment?.kind === "card";
  const saved = draft.customer?.addresses.find((address) => address.id === draft.addressId);
  const address = saved ?? draft.address;
  const promised = new Date(Date.parse(offline.takenAt) + (totals.delivery ? ctx.settings.delivery_estimate_minutes : ctx.settings.pickup_prep_minutes) * 60_000).toISOString();
  return {
    store: {
      name: ctx.settings.store_name, address_line1: ctx.settings.address_line1, address_line2: ctx.settings.address_line2,
      city: ctx.settings.city, state: ctx.settings.state, postal_code: ctx.settings.postal_code, phone: ctx.settings.public_phone, timezone: ctx.settings.timezone,
    },
    order: {
      id: draft.id, order_number: offline.localNumber, daily_number: null, add_on_to: null, source: draft.source,
      fulfillment_type: totals.delivery ? "delivery" : "pickup", status: "placed",
      payment_status: paid ? "paid" : "unpaid",
      payment_method: payment?.kind === "card" ? "card" : payment?.kind === "cash" || draft.paymentMethod === "cash" || totals.delivery ? "cash" : "",
      placed_at: offline.takenAt, promised_at: promised, phone_line: draft.source === "phone" ? draft.phoneLine : null,
      customer_name: `${draft.firstName} ${draft.lastName}`.trim() || (draft.source === "phone" ? "Phone caller" : "Walk-in"),
      customer_phone: draft.customerMode === "walk_in" && draft.source === "pos" ? "" : draft.phone.replace(/\D/g, ""),
      delivery_address: totals.delivery ? {
        address1: address.address1, address2: address.address2 ?? "", city: address.city, state: address.state,
        postal_code: address.postal_code, delivery_instructions: address.delivery_instructions ?? "",
      } : null,
      special_instructions: draft.orderNote.trim(),
      subtotal_cents: totals.subtotal, discount_cents: totals.discount, delivery_fee_cents: totals.deliveryFee,
      tax_cents: totals.tax, tip_cents: 0, total_cents: totals.total, taken_by: ctx.staffName || null,
    },
    items: draft.cart.map((line) => {
      const item = findMenuItem(ctx.menu, line.menu_item_id);
      const variant = item?.variants.find((candidate) => candidate.id === line.variant_id);
      const category = ctx.menu.find((candidate) => candidate.items.some((entry) => entry.id === line.menu_item_id));
      return {
        id: line.line_id, name: line.open_item ? line.open_item.name : item?.name ?? "Item", variant: line.open_item ? null : variant?.name ?? null,
        category: line.open_item ? "Open food" : category?.name ?? null, station: "kitchen", quantity: line.quantity,
        line_total_cents: cartLineUnitCents(ctx.menu, line) * line.quantity, instructions: line.special_instructions.trim(),
        modifiers: line.open_item ? [] : describeLineModifiers(item, line).map((note) => ({ name: note.label, group: "", quantity: 1 })),
      };
    }),
  };
}

/** Print an offline order's kitchen ticket (and a delivery's receipt) on the store's printers. */
export async function printOfflineOrder(id: string): Promise<{ printed: boolean; message: string }> {
  const draft = findDraft(id);
  const ctx = context;
  if (!draft?.offline || !ctx) return { printed: false, message: "That order is no longer on this register." };
  const doc = documentFor(draft, ctx);
  const kitchenConfig = printerConfigFrom(ctx.hardware.kitchen_printers[0], "kitchen");
  const ticket = buildKitchenTicket(doc, kitchenConfig.routingCategories);
  let printed = true;
  let message = "Kitchen ticket printed.";
  if (ticket) {
    try {
      const result = await createPrinterProvider("kitchen", kitchenConfig).printLayout(ticket);
      if (!result.ok) { printed = false; message = `Kitchen ticket did not print: ${result.reason} Read the order to the kitchen.`; }
    } catch (error) {
      printed = false;
      message = `Kitchen ticket did not print: ${error instanceof Error ? error.message : "the kitchen printer did not answer."} Read the order to the kitchen.`;
    }
  }
  // A delivery's receipt goes out with the driver, as it does online (Admin → Hardware decides).
  const receiptRaw = ctx.hardware.receipt_printer as Record<string, unknown>;
  if (doc.order.fulfillment_type === "delivery" && receiptRaw.auto_delivery_receipts !== false && nativePrinter()) {
    try {
      const result = await createPrinterProvider("receipt", printerConfigFrom(receiptRaw)).printLayout(buildReceipt(doc));
      if (!result.ok) message += ` The delivery receipt did not print (${result.reason}).`;
    } catch {
      message += " The delivery receipt did not print.";
    }
  }
  if (printed) patchOffline(id, { printed: true });
  logDevice("offline.print", message, { local: draft.offline.localNumber, printed });
  return { printed, message };
}

async function openDrawerHere() {
  const ctx = context;
  if (!ctx) return;
  try {
    await new PrinterDrawerProvider(printerConfigFrom(ctx.hardware.receipt_printer as Record<string, unknown>)).open();
  } catch (error) {
    notify(`The cash drawer did not open by itself (${error instanceof Error ? error.message : "no printer"}). Use the key.`, "warn");
  }
}

// ---- Sending it all when the connection is back ----

async function postJson(url: string, body: unknown, timeoutMs = 15_000) {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (isNoAnswer(error)) reportNetworkFailure();
    throw error;
  }
  reportServerOk();
  const data: unknown = await response.json().catch(() => null);
  return { response, data };
}

function errorText(data: unknown, fallback: string) {
  return data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : fallback;
}

let flushing = false;

/** Send every offline order that is ready, in the order they were taken. Safe to call any time. */
export async function flushOfflineOrders() {
  if (flushing || typeof window === "undefined" || !isServerReachable()) return;
  flushing = true;
  try {
    for (const listed of offlineDrafts()) {
      const draft = findDraft(listed.id);
      const offline = draft?.offline;
      if (!draft || !offline || offline.problem || !offline.payment) continue;
      const label = offline.localNumber;

      // 1. The order (same idempotency key every time: it can only ever be created once).
      if (!offline.orderId) {
        let sent: Awaited<ReturnType<typeof postJson>>;
        try { sent = await postJson("/api/pos/orders", draftToOrderPayload(draft)); } catch { return; }
        const parsed = posOrderCreatedSchema.safeParse(sent.data);
        if (!sent.response.ok || !parsed.success) {
          if (sent.response.status >= 500) return; // the server is having trouble: try again later
          const reason = errorText(sent.data, "The server refused it.");
          patchOffline(draft.id, { problem: `Offline order ${label} could not be sent: ${reason} Enter it again as a new order${offline.payment.kind === "later" ? "" : " (it was already paid — don't charge again)"}.` });
          notify(`Offline order ${label} could not be sent: ${reason}`, "warn");
          logDevice("offline.order_refused", reason, { local: label });
          continue;
        }
        patchOffline(draft.id, { orderId: parsed.data.id, orderNumber: parsed.data.order_number, dailyNumber: parsed.data.daily_number ?? null });
        if (draft.phoneCallKey) phoneActions.clearCompletedCall(draft.phoneCallKey);
        void postJson(`/api/pos/drafts/${draft.id}/close`, { device_id: getDeviceId(), outcome: "submitted" }).catch(() => undefined);
        logDevice("offline.order_sent", parsed.data.order_number, { local: label, duplicate: parsed.data.duplicate });
      }

      // 2. Its payment.
      const current = findDraft(draft.id)?.offline;
      if (!current?.orderId) continue;
      const number = current.dailyNumber ? `#${current.dailyNumber}` : current.orderNumber ?? "";
      if (!current.paymentRecorded && current.payment) {
        const payment = current.payment;
        if (payment.kind === "cash") {
          let sent: Awaited<ReturnType<typeof postJson>>;
          try {
            sent = await postJson("/api/pos/drawer", {
              action: "cash_payment", shift_id: "", order_id: current.orderId, tendered_cents: payment.tenderedCents,
              idempotency_key: `pos-offline-cash-${draft.id}`, offline: true, offline_taken_at: payment.at,
            });
          } catch { return; }
          if (!sent.response.ok) {
            if (sent.response.status >= 500) return;
            const reason = errorText(sent.data, "it was refused");
            patchOffline(draft.id, { problem: `Order ${number} (offline ${label}) was sent, but its ${formatCents(payment.amountCents)} cash could not be recorded: ${reason} Record the cash in Payments.` });
            notify(`Cash for ${number} could not be recorded: ${reason}`, "warn");
            continue;
          }
        } else if (payment.kind === "card") {
          if (!payment.intentId) continue; // the reader has not handed it to Stripe yet
          let sent: Awaited<ReturnType<typeof postJson>>;
          try {
            sent = await postJson("/api/pos/stripe-terminal/offline-settle", { order_id: current.orderId, intent_id: payment.intentId, offline_id: payment.offlineKey }, 30_000);
          } catch { return; }
          const body = (sent.data ?? {}) as { state?: string; message?: string };
          if (!sent.response.ok) {
            if (sent.response.status >= 500) continue; // Stripe busy: next round
            const reason = errorText(sent.data, "it was refused");
            patchOffline(draft.id, { problem: `Order ${number} (offline ${label}) was sent, but its card could not be recorded: ${reason} Check Payments.` });
            continue;
          }
          acknowledgeForwardedCard(payment.offlineKey);
          if (body.state !== "captured" && body.state !== "authorized") {
            patchOffline(draft.id, { paymentRecorded: true, problem: `The card taken offline for order ${number} (${label}) was DECLINED when it reached Stripe: ${body.message ?? "not approved"}. The order is unpaid — collect ${formatCents(payment.amountCents)} from the customer.` });
            notify(`Card for ${number} (offline ${label}) was declined by Stripe — collect payment.`, "warn");
            continue;
          }
        }
        patchOffline(draft.id, { paymentRecorded: true });
      }

      // 3. Done: it is a normal order on the server now.
      const finished = findDraft(draft.id)?.offline;
      if (finished?.orderId && finished.paymentRecorded && !finished.problem) {
        dismissOfflineOrder(draft.id);
        notify(`Offline order ${label} is on the server now as ${number}.`);
      }
    }
  } finally {
    flushing = false;
  }
}

/** A stored card reached Stripe: note its PaymentIntent on its order, then send. */
function cardForwarded(card: { offline_key: string; intent_id: string | null; status: string; error: string | null }) {
  const draft = offlineDrafts().find((candidate) => candidate.offline?.payment?.kind === "card" && candidate.offline.payment.offlineKey === card.offline_key);
  if (!draft?.offline || draft.offline.payment?.kind !== "card") return;
  if (!card.intent_id) {
    patchOffline(draft.id, { problem: `The card stored for offline order ${draft.offline.localNumber} could not be sent to Stripe: ${card.error ?? "unknown error"}. Collect payment for it again.` });
    acknowledgeForwardedCard(card.offline_key);
    return;
  }
  if (draft.offline.payment.intentId === card.intent_id) return;
  patchOffline(draft.id, { payment: { ...draft.offline.payment, intentId: card.intent_id } });
  void flushOfflineOrders();
}

let running = false;

/** Start watching for the connection (once, from the POS shell). */
export function startOfflineOrders() {
  if (running || typeof window === "undefined") return;
  running = true;
  const kick = () => { void flushOfflineOrders(); };
  window.addEventListener("wayne:reconnected", kick);
  window.addEventListener("online", kick);
  window.setInterval(() => { if (offlineDrafts().some((draft) => draft.offline?.payment && !draft.offline.problem)) kick(); }, 30_000);
  // Kitchen tickets that could not print (printer off, network down) keep trying here, for 30 minutes.
  window.setInterval(() => {
    for (const draft of offlineDrafts()) {
      const offline = draft.offline!;
      if (offline.payment && !offline.printed && Date.now() - Date.parse(offline.takenAt) < 30 * 60_000) void printOfflineOrder(draft.id).then((result) => { if (result.printed) notify(`Offline order ${offline.localNumber}: kitchen ticket printed now.`); });
    }
  }, 20_000);
  onForwardedOfflineCard(cardForwarded);
  for (const card of forwardedOfflineCards()) cardForwarded(card);
  kick();
}

const noDrafts = { activeId: "", drafts: [] as PosDraft[] };
let lastState: unknown = null;
let lastList: PosDraft[] = [];

/** Offline orders waiting to be sent (not the one still on the payment screen). The same array until it changes. */
function selectOffline(state: { activeId: string; drafts: PosDraft[] }) {
  if (state === lastState) return lastList;
  const next = state.drafts.filter((draft) => draft.offline !== null && (draft.offline.payment !== null || draft.id !== state.activeId));
  lastState = state;
  lastList = next.length === lastList.length && next.every((draft, index) => draft === lastList[index]) ? lastList : next;
  return lastList;
}

export function useOfflineOrders() {
  return useStore(orderStore, selectOffline, noDrafts);
}

export function isActiveOffline() {
  return activeDraft(orderStore.get()).offline !== null;
}
