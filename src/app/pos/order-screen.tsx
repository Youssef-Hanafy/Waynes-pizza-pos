"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { StoreSettings } from "@/lib/content/schemas";
import { formatCents, type PublicMenu } from "@/lib/menu/schemas";
import { cartLineUnitCents, cartSubtotalCents, describeLineModifiers, findMenuItem } from "@/lib/orders/cart";
import { draftLabel, type PosDraft } from "@/lib/orders/drafts";
import type { CartLine } from "@/lib/orders/schemas";
import type { OpenOrder } from "@/lib/orders/status";
import type { CheckoutPaymentConfig } from "@/lib/payments/schemas";
import { formatPhone } from "@/lib/phone/normalize";
import { draftSync, useSyncState } from "@/stores/draft-sync";
import { requestReceipt } from "@/lib/printing/request-receipt";
import { getHardwareRuntime } from "@/stores/hardware-store";
import { orderActions, paymentPromptStore, useActiveDraft, useDrafts } from "@/stores/order-store";
import { phoneActions } from "@/stores/phone-store";
import { PosItemDialog } from "./item-dialog";
import { PaymentPrompt } from "./payments-screen";
import { StartOrderCard } from "./start-order-card";

type MenuItem = PublicMenu[number]["items"][number];

type Props = {
  canManageDiscount: boolean;
  menu: PublicMenu;
  settings: StoreSettings;
  onOpenPhone: () => void;
  /** Stripe (online) connection for keyed-in cards; null when Stripe isn't connected. */
  keyedCardConfig: Extract<CheckoutPaymentConfig, { provider: "stripe" }> | null;
  /** Admin → Hardware → Payment terminal is the Stripe Reader M2. */
  stripeReader: boolean;
};

/**
 * The ordering screen (build sheet §10).  Everything about the ticket lives in
 * the active draft, so holding it, taking a second call and coming back leaves
 * it exactly as it was (§36), and a refresh does too (test 15).
 */
export function OrderScreen({ canManageDiscount, menu, settings, onOpenPhone, keyedCardConfig, stripeReader }: Props) {
  const draft = useActiveDraft();
  const { drafts, activeId } = useDrafts();
  const held = drafts.filter((candidate) => candidate.id !== activeId);
  const { remote } = useSyncState();
  const update = orderActions.update;

  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null);
  const [editingLine, setEditingLine] = useState<CartLine | null>(null);
  const [itemSearch, setItemSearch] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  /** The order just sent, shown with the payment prompt until it is paid or left to pay later. */
  const [created, setCreated] = useState<{ order: OpenOrder; duplicate: boolean; delivery: boolean } | null>(null);
  const [printNote, setPrintNote] = useState("");
  const paying = created !== null;
  useEffect(() => {
    paymentPromptStore.set(paying);
    return () => paymentPromptStore.set(false);
  }, [paying]);

  /** Through the printer layer only (§23): which printer, and how, is Admin → Hardware's business. */
  async function print(kind: "receipt" | "kitchen") {
    if (!created) return;
    if (kind === "receipt") {
      setPrintNote("Printing…");
      setPrintNote((await requestReceipt(created.order.id)).message);
      return;
    }
    const runtime = getHardwareRuntime();
    if (!runtime) { setPrintNote("Printing is still starting up. Try again in a moment."); return; }
    setPrintNote("Printing…");
    const result = await runtime.kitchenPrinter.printKitchenTicket(created.order.id);
    setPrintNote(result.ok ? (result.jobId === "print-dialog" ? "Sent to the print dialog." : "Sent to the printer.") : result.reason);
  }

  const [confirmClear, setConfirmClear] = useState(false);

  const visibleMenu = useMemo(() => menu.map((category) => ({ ...category, items: category.items.filter((item) => item.name.toLowerCase().includes(itemSearch.trim().toLowerCase())) })).filter((category) => category.items.length), [itemSearch, menu]);
  const cart = draft.cart;
  const noProfile = draft.customerMode === "walk_in";
  const subtotal = cartSubtotalCents(menu, cart);
  const manualInput = Number(draft.manualValue) || 0;
  const previewDiscount = draft.manualType === "fixed" ? Math.min(subtotal, Math.round(manualInput * 100)) : draft.manualType === "percent" ? Math.min(subtotal, Math.round(subtotal * manualInput / 100)) : 0;
  const deliveryFee = draft.fulfillment === "delivery" ? settings.delivery_fee_cents : 0;
  const tax = Math.round((subtotal - previewDiscount + deliveryFee) * settings.tax_rate_basis_points / 10_000);
  const previewTotal = subtotal - previewDiscount + deliveryFee + tax;

  function setCart(next: CartLine[]) { update({ cart: next }); }

  const fromCall = Boolean(draft.phoneCallKey);

  async function submitOrder() {
    if (!cart.length) { setError("Add at least one item to the ticket."); return; }
    if (submitting) return;
    setSubmitting(true); setError("");
    // Only a server answer counts as sent (§30). A dropped connection keeps the
    // ticket and resends it, with the same idempotency key, when it is back.
    // Walk-ins without a profile always go out as pickup (see draftToOrderPayload).
    const delivery = draft.fulfillment === "delivery" && !noProfile;
    const customerName = draft.customer ? `${draft.customer.first_name} ${draft.customer.last_name}` : `${draft.firstName} ${draft.lastName}`.trim();
    const source = draft.source;
    const result = await draftSync.submit(draft.id);
    setSubmitting(false);
    if (result.ok) {
      setPrintNote("");
      const now = new Date().toISOString();
      setCreated({
        duplicate: result.order.duplicate, delivery,
        order: {
          id: result.order.id, order_number: result.order.order_number, total_cents: result.order.total_cents,
          customer_name: customerName, fulfillment_type: delivery ? "delivery" : "pickup", source,
          status: "placed", payment_method: "", payment_status: "unpaid", placed_at: now, promised_at: null, ready_at: null,
        },
      });
      return;
    }
    setError(result.message);
  }

  async function takeOver(id: string) {
    setError("");
    const result = await draftSync.takeOver(id);
    if (!result.ok) setError(result.message);
  }

  function clearTicket() {
    if (draftHasWork(draft) && !confirmClear) { setConfirmClear(true); return; }
    setConfirmClear(false);
    if (draft.phoneCallKey) void phoneActions.releaseCall(draft.phoneCallKey);
    void draftSync.discard(draft);
    orderActions.clearActive(); setError("");
  }

  // Sent: ask for payment right away (owner, 2026-09-30).
  if (created) {
    const resumable = held.filter(isWorthResuming);
    return <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto bg-wayne-cream-deep p-3 sm:p-6">
      <section aria-label="Take payment" className="w-full max-w-4xl rounded-3xl border border-wayne-border bg-white p-5 shadow-xl sm:p-7">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-wayne-ok-soft px-4 py-3">
          <p className="font-black text-wayne-ok">✓ {created.duplicate ? "Already sent" : "Sent to the kitchen"} · {created.order.order_number}</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-wayne-muted">{created.delivery ? "Kitchen ticket + delivery receipt print automatically" : "Kitchen ticket prints automatically"}</span>
            <Button onClick={() => void print("receipt")} size="sm" variant="secondary">Print receipt</Button>
            <Button onClick={() => void print("kitchen")} size="sm" variant="secondary">Reprint kitchen</Button>
          </div>
        </div>
        {printNote ? <p aria-live="polite" className="-mt-3 mb-3 text-sm font-bold">{printNote}</p> : null}
        <h1 className="mb-4 text-3xl font-black">How are they paying?</h1>
        <PaymentPrompt key={created.order.id} keyedCardConfig={keyedCardConfig} onFinished={() => setCreated(null)} onPayLater={() => setCreated(null)} order={created.order} stripeReader={stripeReader} />
        {resumable.length ? <div className="mt-6 grid gap-2 border-t border-wayne-border pt-4"><p className="text-sm font-black uppercase tracking-[0.14em] text-wayne-muted">Tickets on hold</p><div className="flex flex-wrap gap-2">{resumable.map((candidate) => <Button key={candidate.id} onClick={() => { orderActions.resume(candidate.id); setCreated(null); }} size="sm" variant="secondary">Resume {draftLabel(candidate)} · {candidate.cart.length} item{candidate.cart.length === 1 ? "" : "s"}</Button>)}</div></div> : null}
      </section>
    </div>;
  }

  const summary = ticketSummary(draft, settings);
  const topBar = <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-wayne-border bg-white px-3 py-2">
    {draft.started ? <button aria-label="Edit order details" className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl px-2 text-left hover:bg-wayne-cream" onClick={() => update({ started: false })} type="button">
      <span aria-hidden className={`grid size-10 shrink-0 place-items-center rounded-xl text-xl ${draft.source === "phone" ? "bg-wayne-green text-white" : "bg-wayne-cream"}`}>{summary.icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-base font-black">{summary.title}</span>
        <span className="block truncate text-sm text-wayne-muted">{summary.detail}</span>
      </span>
      <span className="ml-auto shrink-0 rounded-lg border border-wayne-border px-3 py-1.5 text-sm font-bold">Edit</span>
    </button> : <p className="flex-1 text-sm font-black uppercase tracking-[0.12em] text-wayne-muted">{draft.cart.length ? "Editing order details" : "Starting a new order"}</p>}
    {remote.length ? <details className="relative"><summary className="flex min-h-11 cursor-pointer items-center rounded-full border border-dashed border-wayne-border-strong px-3 text-sm font-bold">Other registers ({remote.length})</summary><div className="absolute right-0 z-40 mt-1 grid w-80 gap-2 rounded-2xl border border-wayne-border bg-white p-3 shadow-xl">{remote.map((ticket) => <div className="rounded-xl border border-wayne-border p-2" key={ticket.id}><p className="text-sm font-bold">{ticket.label || "Ticket"}{ticket.item_count ? ` · ${ticket.item_count} item${ticket.item_count === 1 ? "" : "s"}` : ""}</p><p className="text-xs text-wayne-muted">{ticket.status === "held" ? "On hold" : "Open"} on {ticket.terminal || "another register"}{ticket.owner_name ? ` · ${ticket.owner_name}` : ""}</p><Button className="mt-2 w-full" onClick={() => void takeOver(ticket.id)} size="sm" variant="secondary">Take over here</Button></div>)}</div></details> : null}
    {held.length ? <div className="flex flex-wrap gap-1.5">{held.map((candidate) => <button className="min-h-11 rounded-full border border-wayne-border bg-wayne-cream px-3 text-sm font-bold" key={candidate.id} onClick={() => { orderActions.resume(candidate.id); setError(""); }} type="button">{candidate.submitPending ? "⟳ " : "⏸ "}{draftLabel(candidate)}{candidate.cart.length ? ` · ${candidate.cart.length}` : ""}{candidate.submitPending ? " · sending" : ""}</button>)}</div> : null}
    {draftHasWork(draft) ? <Button onClick={() => { orderActions.hold(); setError(""); }} size="sm" variant="secondary">＋ New order <span className="font-normal text-wayne-muted">(holds this one)</span></Button> : null}
  </div>;

  if (!draft.started) return <div className="flex min-h-0 flex-1 flex-col">
    {topBar}
    <StartOrderCard draft={draft} key={draft.id} onOpenPhone={fromCall ? onOpenPhone : undefined} settings={settings} />
  </div>;

  const shownCategories = itemSearch.trim() ? visibleMenu : visibleMenu.filter((category) => category.id === (categoryId ?? visibleMenu[0]?.id));

  return <div className="flex min-h-0 flex-1 flex-col">
    {topBar}
    <main className="grid flex-1 grid-cols-1 lg:min-h-0 lg:grid-cols-[1fr_22rem] 2xl:grid-cols-[1fr_26rem]">
      <section aria-label="Menu" className="flex flex-col p-3 lg:min-h-0">
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <input aria-label="Search menu" className="min-h-12 flex-1 rounded-xl border border-wayne-border bg-white px-4 text-base" onChange={(event) => setItemSearch(event.target.value)} placeholder="🔍  Search the menu" type="search" value={itemSearch} />
        </div>
        {!itemSearch.trim() ? <nav aria-label="Menu categories" className="mt-3 flex shrink-0 flex-wrap gap-1.5">{visibleMenu.map((category) => {
          const selected = category.id === (categoryId ?? visibleMenu[0]?.id);
          return <button aria-pressed={selected} className={`min-h-11 rounded-xl px-3.5 text-sm font-black transition ${selected ? "bg-wayne-green text-white shadow-sm" : "bg-white text-wayne-ink shadow-sm hover:bg-wayne-cream"}`} key={category.id} onClick={() => setCategoryId(category.id)} type="button">{category.name}</button>;
        })}</nav> : null}
        <div className="mt-3 grid flex-1 content-start gap-5 pr-1 lg:min-h-0 lg:overflow-y-auto">
          {shownCategories.map((category) => <section aria-label={category.name} key={category.id}>
            {itemSearch.trim() ? <h2 className="mb-2 text-lg font-black">{category.name}</h2> : null}
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">{category.items.map((item) => <button className="flex min-h-24 flex-col rounded-xl border border-wayne-border bg-white p-3 text-left shadow-sm transition active:scale-95 disabled:opacity-50" disabled={item.sold_out} key={item.id} onClick={() => setSelectedItem(item)} type="button"><strong className="block text-sm leading-tight">{item.name}</strong><span className="mt-auto pt-1 text-sm font-black text-wayne-red">{item.variants.length ? `From ${formatCents(Math.min(...item.variants.map((variant) => variant.price_cents)))}` : formatCents(item.base_price_cents)}</span>{item.sold_out ? <span className="text-xs font-bold">Sold out</span> : item.modifier_groups.length ? <span className="text-[0.65rem] font-bold text-wayne-ok">Customize</span> : <span className="text-[0.65rem] font-bold text-wayne-muted">Quick add</span>}</button>)}</div>
          </section>)}
          {!shownCategories.length ? <p className="rounded-xl bg-white p-6 text-center text-wayne-muted">Nothing on the menu matches “{itemSearch}”.</p> : null}
        </div>
      </section>
      <aside aria-label="Current ticket" className="flex flex-col border-t border-wayne-border bg-white p-3 lg:min-h-0 lg:border-l lg:border-t-0">
        <div className="flex shrink-0 items-center justify-between"><h2 className="text-xl font-black">Ticket{cart.length ? ` · ${cart.reduce((sum, line) => sum + line.quantity, 0)}` : ""}</h2><button className="min-h-11 px-2 text-sm font-bold text-wayne-red underline" onBlur={() => setConfirmClear(false)} onClick={clearTicket} type="button">{confirmClear ? "Tap again to clear" : "Clear"}</button></div>
        <div className="mt-2 flex-1 space-y-2 pr-1 lg:min-h-0 lg:overflow-y-auto">{cart.length ? cart.map((line) => { const item = findMenuItem(menu, line.menu_item_id); const variant = item?.variants.find((candidate) => candidate.id === line.variant_id); const modifiers = describeLineModifiers(item, line); return <div className="rounded-xl bg-wayne-cream p-3" key={line.line_id}><div className="flex justify-between gap-2"><div><strong>{line.quantity}× {item?.name ?? "Item no longer on the menu"}</strong>{variant ? <p className="text-sm text-wayne-muted">{variant.name}</p> : null}</div><strong>{formatCents(cartLineUnitCents(menu, line) * line.quantity)}</strong></div>{modifiers.length ? <p className="mt-1 flex flex-wrap gap-1 text-sm">{modifiers.map((note) => <span className={`rounded px-1.5 font-bold ${note.kind === "removed" ? "bg-wayne-red-soft text-wayne-red" : "bg-wayne-ok-soft text-wayne-ok"}`} key={note.label}>{note.label}</span>)}</p> : null}{line.special_instructions ? <p className="mt-1 text-sm">Note: {line.special_instructions}</p> : null}<div className="mt-2 flex gap-2"><button aria-label="Decrease item" className="h-11 w-11 rounded-lg border bg-white" onClick={() => setCart(updateQuantity(cart, line.line_id, line.quantity - 1))} type="button">−</button><button aria-label="Increase item" className="h-11 w-11 rounded-lg border bg-white" onClick={() => setCart(updateQuantity(cart, line.line_id, line.quantity + 1))} type="button">+</button><button className="min-h-11 px-1 text-sm font-bold underline" onClick={() => { if (item) { setEditingLine(line); setSelectedItem(item); } }} type="button">Edit</button><button className="ml-auto min-h-11 px-1 text-sm font-bold text-wayne-red" onClick={() => setCart(cart.filter((candidate) => candidate.line_id !== line.line_id))} type="button">Remove</button></div></div>; }) : <p className="rounded-xl bg-wayne-cream p-5 text-center text-wayne-muted">Tap a menu item to add it.</p>}</div>
        <div className="shrink-0 border-t border-wayne-border pt-3">
          <details className="rounded-xl border border-wayne-border p-2"><summary className="min-h-9 cursor-pointer text-sm font-bold">Notes, promo &amp; discount{draft.orderNote || draft.promoCode || draft.manualType ? " •" : ""}</summary><label className="mt-2 grid gap-2 text-sm font-bold">Order notes<textarea className="rounded-lg border border-wayne-border p-2 font-normal" maxLength={1500} onChange={(e) => update({ orderNote: e.target.value })} rows={2} value={draft.orderNote} /></label><div className="mt-2 grid grid-cols-2 gap-2"><label className="text-sm font-bold">Promotion code<input className="mt-1 min-h-11 w-full rounded-lg border px-2 font-normal uppercase" disabled={Boolean(draft.manualType)} onChange={(e) => update({ promoCode: e.target.value })} value={draft.promoCode} /></label><label className="text-sm font-bold">Payment<select className="mt-1 min-h-11 w-full rounded-lg border bg-white px-2 font-normal" onChange={(e) => update({ paymentMethod: e.target.value as "test_manual" | "cash" })} value={draft.paymentMethod}><option value="test_manual">TEST / MANUAL</option><option value="cash">Cash (unpaid)</option></select></label></div>{canManageDiscount ? <div className="mt-2 grid gap-2"><select className="min-h-11 rounded-lg border bg-white px-2" disabled={Boolean(draft.promoCode)} onChange={(e) => update({ manualType: e.target.value as "" | "fixed" | "percent" })} value={draft.manualType}><option value="">No manual discount</option><option value="fixed">Fixed dollars</option><option value="percent">Percent</option></select>{draft.manualType ? <><Input id="pos-manual-value" label={draft.manualType === "fixed" ? "Amount ($)" : "Percent (%)"} min="0" onChange={(e) => update({ manualValue: e.target.value })} step="0.01" type="number" value={draft.manualValue} /><Input id="pos-manual-reason" label="Required reason" onChange={(e) => update({ manualReason: e.target.value })} value={draft.manualReason} /></> : null}</div> : null}</details>
          <div className="mt-3 space-y-1"><Total label="Subtotal" value={subtotal} />{previewDiscount ? <Total label="Manual discount" value={-previewDiscount} /> : null}{deliveryFee ? <Total label="Delivery fee" value={deliveryFee} /> : null}<Total label="Estimated tax" value={tax} /><Total emphasis label={draft.promoCode ? "Estimated total*" : "Total"} value={previewTotal} /></div>
          {draft.submitPending ? <p aria-live="polite" className="mt-2 rounded-xl bg-wayne-warn-soft p-2 text-sm font-bold">Not sent yet — waiting for the connection. It sends by itself; pressing Submit again is safe.</p> : null}
          {error && !draft.submitPending ? <p aria-live="polite" className="mt-2 rounded-xl bg-wayne-alert-soft p-2 text-sm font-bold text-wayne-alert">{error}</p> : null}
          <Button className="mt-3 min-h-14 w-full text-lg" disabled={submitting || !cart.length} onClick={submitOrder}>{submitting ? "Submitting…" : draft.submitPending ? "Try sending now" : `Submit order · ${formatCents(previewTotal)}`}</Button>
        </div>
      </aside>
    </main>
    {selectedItem ? <PosItemDialog initialLine={editingLine} item={selectedItem} onAdd={(line) => { setCart(editingLine ? cart.map((candidate) => candidate.line_id === editingLine.line_id ? line : candidate) : [...cart, line]); setEditingLine(null); setSelectedItem(null); }} onClose={() => { setEditingLine(null); setSelectedItem(null); }} /> : null}
  </div>;
}

function draftHasWork(draft: PosDraft) {
  return draft.cart.length > 0 || draft.source === "phone" || Boolean(draft.customer || draft.firstName || draft.orderNote);
}

function isWorthResuming(draft: PosDraft) {
  return draftHasWork(draft);
}

/** One line saying what this ticket is, for the bar above the menu. */
function ticketSummary(draft: PosDraft, settings: StoreSettings) {
  const who = draft.customer ? `${draft.customer.first_name} ${draft.customer.last_name}` : `${draft.firstName} ${draft.lastName}`.trim();
  const how = draft.source === "phone" ? `Phone${draft.phoneLine ? ` · Line ${draft.phoneLine}` : ""}` : "In store";
  if (draft.customerMode === "walk_in") {
    return { icon: "🚶", title: `${draft.source === "phone" ? "Pickup (no profile)" : "Walk-in"}${who ? ` · ${who}` : ""}`, detail: `${how}${draft.phone && draft.source === "phone" ? ` · ${formatPhone(draft.phone)}` : ""} · tap to change` };
  }
  const phone = draft.phone ? formatPhone(draft.phone) : "";
  if (draft.fulfillment === "delivery") {
    const saved = draft.customer?.addresses.find((address) => address.id === draft.addressId);
    const address = saved ? `${saved.address1}${saved.address2 ? `, ${saved.address2}` : ""}, ${saved.city}` : [draft.address.address1, draft.address.address2, draft.address.city].filter(Boolean).join(", ");
    return { icon: "🚗", title: `Delivery · ${who || "Customer"}`, detail: [phone, address, `+${formatCents(settings.delivery_fee_cents)} delivery`].filter(Boolean).join(" · ") };
  }
  return { icon: "🛍️", title: `Pickup · ${who || "Customer"}`, detail: [phone, how].filter(Boolean).join(" · ") };
}

function Total({ emphasis, label, value }: { emphasis?: boolean; label: string; value: number }) { return <div className={`flex justify-between ${emphasis ? "border-t pt-3 text-xl font-black" : ""}`}><span>{label}</span><span>{formatCents(value)}</span></div>; }
function updateQuantity(cart: CartLine[], lineId: string, quantity: number) { return quantity < 1 ? cart.filter((line) => line.line_id !== lineId) : cart.map((line) => line.line_id === lineId ? { ...line, quantity: Math.min(20, quantity) } : line); }
