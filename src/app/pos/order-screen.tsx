"use client";

import { FormEvent, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { StoreSettings } from "@/lib/content/schemas";
import { formatCents, type PublicMenu } from "@/lib/menu/schemas";
import { cartLineUnitCents, cartSubtotalCents, describeLineModifiers, findMenuItem } from "@/lib/orders/cart";
import { draftLabel, type DraftAddress, type PosDraft } from "@/lib/orders/drafts";
import type { CartLine } from "@/lib/orders/schemas";
import { formatPhone } from "@/lib/phone/normalize";
import { posCustomerSchema, type PosCustomer } from "@/lib/pos/schemas";
import { draftSync, useSyncState } from "@/stores/draft-sync";
import { requestReceipt } from "@/lib/printing/request-receipt";
import { getHardwareRuntime } from "@/stores/hardware-store";
import { orderActions, useActiveDraft, useDrafts } from "@/stores/order-store";
import { phoneActions } from "@/stores/phone-store";
import { PosItemDialog } from "./item-dialog";

type MenuItem = PublicMenu[number]["items"][number];

type Props = {
  canManageDiscount: boolean;
  menu: PublicMenu;
  settings: StoreSettings;
  onOpenPhone: () => void;
};

/**
 * The ordering screen (build sheet §10).  Everything about the ticket lives in
 * the active draft, so holding it, taking a second call and coming back leaves
 * it exactly as it was (§36), and a refresh does too (test 15).
 */
export function OrderScreen({ canManageDiscount, menu, settings, onOpenPhone }: Props) {
  const draft = useActiveDraft();
  const { drafts, activeId } = useDrafts();
  const held = drafts.filter((candidate) => candidate.id !== activeId);
  const { remote } = useSyncState();
  const update = orderActions.update;

  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null);
  const [editingLine, setEditingLine] = useState<CartLine | null>(null);
  const [itemSearch, setItemSearch] = useState("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerResults, setCustomerResults] = useState<PosCustomer[]>([]);
  const [customerBusy, setCustomerBusy] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<{ id: string; order_number: string; total_cents: number; duplicate: boolean; delivery?: boolean } | null>(null);
  const [printNote, setPrintNote] = useState("");

  /** Through the printer layer only (§23): which printer, and how, is Admin → Hardware's business. */
  async function print(kind: "receipt" | "kitchen") {
    if (!created) return;
    if (kind === "receipt") {
      setPrintNote("Printing…");
      setPrintNote((await requestReceipt(created.id)).message);
      return;
    }
    const runtime = getHardwareRuntime();
    if (!runtime) { setPrintNote("Printing is still starting up. Try again in a moment."); return; }
    setPrintNote("Printing…");
    const result = await runtime.kitchenPrinter.printKitchenTicket(created.id);
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

  function chooseWalkIn() {
    if (fromCall) return;
    update({ source: "pos", customerMode: "walk_in", fulfillment: "pickup", customer: null, firstName: "", lastName: "", phone: "", email: "", addressId: "" });
    setCustomerResults([]); setError("");
  }

  /** A phone order typed by hand (caller ID down, or a call nobody's box saw). */
  function choosePhone() { update({ source: "phone", customerMode: "identified" }); setError(""); }

  async function lookupCustomer(event: FormEvent) {
    event.preventDefault();
    if (customerSearch.trim().length < 2) { setError("Enter at least two characters to search."); return; }
    setCustomerBusy(true); setError("");
    try {
      const response = await fetch(`/api/pos/customers?q=${encodeURIComponent(customerSearch)}`);
      const body: unknown = await response.json();
      const parsed = posCustomerSchema.array().safeParse(body);
      if (!response.ok || !parsed.success) throw new Error(!Array.isArray(body) && body && typeof body === "object" && "error" in body ? String(body.error) : "Customer lookup failed.");
      setCustomerResults(parsed.data);
      if (!parsed.data.length) setError("No customer found. Type their details below and they will be saved with the order.");
    } catch (lookupError) { setError(lookupError instanceof Error ? lookupError.message : "Customer lookup failed."); }
    finally { setCustomerBusy(false); }
  }

  function selectCustomer(customer: PosCustomer) {
    const preferred = customer.addresses.find((candidate) => candidate.is_default) ?? customer.addresses[0];
    update({ customerMode: "identified", customer, firstName: customer.first_name, lastName: customer.last_name, phone: customer.phone, email: customer.email ?? "", addressId: preferred?.id ?? "" });
    setCustomerResults([]); setError("");
  }

  /** Editing a field that identifies the customer detaches the saved profile. */
  function editIdentity(patch: Partial<PosDraft>) {
    update({ ...patch, customer: null, addressId: "" });
  }

  async function submitOrder() {
    if (!cart.length) { setError("Add at least one item to the ticket."); return; }
    if (submitting) return;
    setSubmitting(true); setError("");
    // Only a server answer counts as sent (§30). A dropped connection keeps the
    // ticket and resends it, with the same idempotency key, when it is back.
    // Walk-ins without a profile always go out as pickup (see draftToOrderPayload).
    const delivery = draft.fulfillment === "delivery" && !noProfile;
    const result = await draftSync.submit(draft.id);
    setSubmitting(false);
    if (result.ok) { setPrintNote(""); setCreated({ ...result.order, delivery }); return; }
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
    orderActions.clearActive(); setError(""); setCustomerResults([]);
  }

  const contextParts = ["New order", draft.source === "phone" ? "Phone" : noProfile ? "Walk-in" : "Counter", draft.phoneLine ? `Line ${draft.phoneLine}` : "", draft.customer ? `${draft.customer.first_name} ${draft.customer.last_name}` : `${draft.firstName} ${draft.lastName}`.trim() || draft.callerName].filter(Boolean);

  if (created) return <div className="grid min-h-0 flex-1 place-items-center bg-wayne-cream-deep p-5"><section className="w-full max-w-xl rounded-3xl border border-wayne-border bg-white p-8 text-center shadow-xl">
    <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-ok">{created.duplicate ? "Already submitted" : "Order submitted"}</p>
    <h1 className="mt-3 text-5xl font-black">{created.order_number}</h1><p className="mt-4 text-2xl font-bold">{formatCents(created.total_cents)}</p>
    <p className="mt-4 text-sm font-bold text-wayne-muted">{created.delivery ? "Kitchen ticket and delivery receipt print automatically." : "Kitchen ticket prints automatically. Print a receipt only if the customer asks."}</p>
    <div className="mt-3 grid grid-cols-2 gap-2"><Button onClick={() => void print("receipt")} variant="secondary">{created.delivery ? "Print another receipt" : "Print receipt"}</Button><Button onClick={() => void print("kitchen")} variant="secondary">Reprint kitchen ticket</Button></div>
    {printNote ? <p aria-live="polite" className="mt-2 text-sm font-bold">{printNote}</p> : null}
    <p className="mt-4 rounded-xl bg-wayne-warn-soft p-4 font-bold">TEST / MANUAL boundary — no card was processed.</p>
    <Button className="mt-6 w-full text-lg" onClick={() => setCreated(null)}>{held.some(isWorthResuming) ? "Back to tickets" : "Start new ticket"}</Button>
    {held.filter(isWorthResuming).length ? <div className="mt-4 grid gap-2 text-left"><p className="text-sm font-black uppercase tracking-[0.14em] text-wayne-muted">Tickets on hold</p>{held.filter(isWorthResuming).map((candidate) => <Button key={candidate.id} onClick={() => { orderActions.resume(candidate.id); setCreated(null); }} variant="secondary">Resume {draftLabel(candidate)} · {candidate.cart.length} item{candidate.cart.length === 1 ? "" : "s"}</Button>)}</div> : null}
  </section></div>;

  return <div className="flex min-h-0 flex-1 flex-col">
    {/* The ticket's context, always visible: which line, which caller (§9). */}
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-wayne-border bg-white px-3 py-2">
      <p className="min-w-0 flex-1 truncate text-sm font-black uppercase tracking-[0.12em]"><span className={draft.source === "phone" ? "text-wayne-green" : ""}>{contextParts.join(" • ")}</span>{draft.phone && draft.source === "phone" ? <span className="ml-2 font-bold normal-case tracking-normal text-wayne-muted">{formatPhone(draft.phone)}</span> : null}</p>
      {remote.length ? <details className="relative"><summary className="flex min-h-11 cursor-pointer items-center rounded-full border border-dashed border-wayne-border-strong px-3 text-sm font-bold">Other registers ({remote.length})</summary><div className="absolute right-0 z-40 mt-1 grid w-80 gap-2 rounded-2xl border border-wayne-border bg-white p-3 shadow-xl">{remote.map((ticket) => <div className="rounded-xl border border-wayne-border p-2" key={ticket.id}><p className="text-sm font-bold">{ticket.label || "Ticket"}{ticket.item_count ? ` · ${ticket.item_count} item${ticket.item_count === 1 ? "" : "s"}` : ""}</p><p className="text-xs text-wayne-muted">{ticket.status === "held" ? "On hold" : "Open"} on {ticket.terminal || "another register"}{ticket.owner_name ? ` · ${ticket.owner_name}` : ""}</p><Button className="mt-2 w-full" onClick={() => void takeOver(ticket.id)} size="sm" variant="secondary">Take over here</Button></div>)}</div></details> : null}
      {held.length ? <div className="flex flex-wrap gap-1.5">{held.map((candidate) => <button className="min-h-11 rounded-full border border-wayne-border bg-wayne-cream px-3 text-sm font-bold" key={candidate.id} onClick={() => { orderActions.resume(candidate.id); setError(""); }} type="button">{candidate.submitPending ? "⟳ " : "⏸ "}{draftLabel(candidate)}{candidate.cart.length ? ` · ${candidate.cart.length}` : ""}{candidate.submitPending ? " · sending" : ""}</button>)}</div> : null}
      <Button disabled={!draftHasWork(draft)} onClick={() => { orderActions.hold(); setError(""); setCustomerResults([]); }} size="sm" variant="secondary">Hold ticket</Button>
    </div>
    <main className="grid flex-1 grid-cols-1 lg:min-h-0 lg:grid-cols-[16.5rem_1fr_19.5rem] 2xl:grid-cols-[19rem_1fr_23rem]">
      <aside className="border-b border-wayne-border bg-white p-3 lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-r">
        {fromCall ? <PhoneContext draft={draft} onOpenPhone={onOpenPhone} /> : <>
          <h2 className="text-base font-black uppercase tracking-[0.16em]">Order type</h2>
          <div className="mt-2 grid grid-cols-2 gap-2"><Button className="px-3" onClick={chooseWalkIn} variant={draft.source === "pos" && noProfile ? "primary" : "secondary"}>Walk-in order</Button><Button className="px-3" onClick={choosePhone} variant={draft.source === "phone" ? "primary" : "secondary"}>Phone order</Button></div>
          {draft.source === "pos" && !noProfile ? <p className="mt-2 text-xs font-bold text-wayne-muted">Counter order for a saved customer.</p> : null}
        </>}
        {draft.source === "pos" && noProfile ? <div className="mt-4 rounded-xl bg-wayne-cream p-3"><strong>Anonymous walk-in</strong><p className="mt-1 text-sm text-wayne-muted">Pickup ticket with no customer profile.</p></div> : null}
        {fromCall && noProfile ? <div className="mt-4 grid gap-3 rounded-xl bg-wayne-cream p-3"><strong>No profile</strong><p className="text-sm text-wayne-muted">Pickup only. Add a name for the ticket if they gave one.</p><Input id="pos-ticket-name" label="Name for the ticket" onChange={(e) => update({ firstName: e.target.value, lastName: "" })} value={draft.firstName} /><Button onClick={() => update({ customerMode: "identified" })} size="sm" variant="secondary">Save them as a customer instead</Button></div> : null}
        {!noProfile ? <div className="mt-4 grid gap-4">
          <form className="flex gap-2" onSubmit={lookupCustomer}><label className="flex-1 text-sm font-bold">Find customer<input className="mt-2 min-h-11 w-full rounded-lg border border-wayne-border px-3 font-normal" onChange={(event) => setCustomerSearch(event.target.value)} placeholder="Phone, name, address, or order #" value={customerSearch} /></label><Button className="self-end px-3" disabled={customerBusy}>{customerBusy ? "…" : "Find"}</Button></form>
          {customerResults.length ? <div className="grid gap-2">{customerResults.map((customer) => <button className="min-h-11 rounded-xl border border-wayne-border p-3 text-left" key={customer.id} onClick={() => selectCustomer(customer)} type="button"><strong>{customer.first_name} {customer.last_name}</strong><p className="text-sm">{formatPhone(customer.phone)}</p><p className="text-xs text-wayne-muted">{customer.order_count} orders · {formatCents(customer.lifetime_spend_cents)} lifetime</p></button>)}</div> : null}
          {draft.customer ? <CustomerCard customer={draft.customer} /> : null}
          <div className="grid gap-3"><Input id="pos-first-name" label="First name" onChange={(e) => editIdentity({ firstName: e.target.value })} required value={draft.firstName} /><Input id="pos-last-name" label="Last name" onChange={(e) => editIdentity({ lastName: e.target.value })} required value={draft.lastName} /><Input id="pos-phone" label="Phone" onChange={(e) => editIdentity({ phone: e.target.value })} required type="tel" value={draft.phone} /><Input id="pos-email" label="Email (optional)" onChange={(e) => editIdentity({ email: e.target.value })} type="email" value={draft.email} /></div>
        </div> : null}
        <h2 className="mt-5 text-base font-black uppercase tracking-[0.16em]">Fulfillment</h2>
        <div className="mt-2 grid grid-cols-2 gap-2"><Button disabled={!settings.pickup_enabled} onClick={() => update({ fulfillment: "pickup" })} variant={draft.fulfillment === "pickup" ? "primary" : "secondary"}>Pickup</Button><Button disabled={noProfile || !settings.delivery_enabled} onClick={() => update({ fulfillment: "delivery" })} variant={draft.fulfillment === "delivery" ? "primary" : "secondary"}>Delivery</Button></div>
        {noProfile && settings.delivery_enabled ? <p className="mt-2 text-xs text-wayne-muted">Delivery needs a customer profile with an address.</p> : null}
        {draft.fulfillment === "delivery" && !noProfile ? <AddressFields address={draft.address} addressId={draft.addressId} customer={draft.customer} onAddress={(address) => update({ address })} onAddressId={(addressId) => update({ addressId })} /> : null}
      </aside>
      <section className="flex flex-col p-3 lg:min-h-0">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-black">Add items</h1><input aria-label="Search menu" className="min-h-11 flex-1 rounded-xl border border-wayne-border bg-white px-4 sm:max-w-xs" onChange={(event) => setItemSearch(event.target.value)} placeholder="Search menu" value={itemSearch} /></div>
        <nav className="mt-3 flex max-h-28 shrink-0 flex-wrap gap-1.5 overflow-y-auto pb-2">{visibleMenu.map((category) => <a className="inline-flex min-h-11 items-center whitespace-nowrap rounded-full bg-white px-3 text-sm font-bold shadow-sm" href={`#pos-${category.id}`} key={category.id}>{category.name}</a>)}</nav>
        <div className="mt-2 grid flex-1 gap-6 pr-1 lg:min-h-0 lg:overflow-y-auto">{visibleMenu.map((category) => <section id={`pos-${category.id}`} key={category.id}><h2 className="text-xl font-black">{category.name}</h2><div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">{category.items.map((item) => <button className="min-h-24 rounded-xl border border-wayne-border bg-white p-3 text-left shadow-sm transition active:scale-95 disabled:opacity-50" disabled={item.sold_out} key={item.id} onClick={() => setSelectedItem(item)} type="button"><strong className="block text-sm leading-tight">{item.name}</strong><p className="mt-1 text-sm font-black text-wayne-red">{item.variants.length ? `From ${formatCents(Math.min(...item.variants.map((variant) => variant.price_cents)))}` : formatCents(item.base_price_cents)}</p>{item.modifier_groups.length ? <p className="mt-0.5 text-[0.65rem] font-bold text-wayne-ok">Customize</p> : <p className="mt-0.5 text-[0.65rem] font-bold text-wayne-muted">Quick add</p>}{item.sold_out ? <span className="text-xs font-bold">Sold out</span> : null}</button>)}</div></section>)}</div>
      </section>
      <aside className="flex flex-col border-t border-wayne-border bg-white p-3 lg:min-h-0 lg:border-l lg:border-t-0">
        <div className="flex shrink-0 items-center justify-between"><h2 className="text-xl font-black">Current ticket</h2><button className="min-h-11 px-2 text-sm font-bold text-wayne-red underline" onBlur={() => setConfirmClear(false)} onClick={clearTicket} type="button">{confirmClear ? "Tap again to clear" : "Clear"}</button></div>
        <div className="mt-3 flex-1 space-y-2 pr-1 lg:min-h-0 lg:overflow-y-auto">{cart.length ? cart.map((line) => { const item = findMenuItem(menu, line.menu_item_id); const variant = item?.variants.find((candidate) => candidate.id === line.variant_id); const modifiers = describeLineModifiers(item, line); return <div className="rounded-xl bg-wayne-cream p-3" key={line.line_id}><div className="flex justify-between gap-2"><div><strong>{line.quantity}× {item?.name ?? "Item no longer on the menu"}</strong>{variant ? <p className="text-sm text-wayne-muted">{variant.name}</p> : null}</div><strong>{formatCents(cartLineUnitCents(menu, line) * line.quantity)}</strong></div>{modifiers.length ? <p className="mt-1 flex flex-wrap gap-1 text-sm">{modifiers.map((note) => <span className={`rounded px-1.5 font-bold ${note.kind === "removed" ? "bg-wayne-red-soft text-wayne-red" : "bg-wayne-ok-soft text-wayne-ok"}`} key={note.label}>{note.label}</span>)}</p> : null}{line.special_instructions ? <p className="mt-1 text-sm">Note: {line.special_instructions}</p> : null}<div className="mt-2 flex gap-2"><button aria-label="Decrease item" className="h-11 w-11 rounded-lg border" onClick={() => setCart(updateQuantity(cart, line.line_id, line.quantity - 1))} type="button">−</button><button aria-label="Increase item" className="h-11 w-11 rounded-lg border" onClick={() => setCart(updateQuantity(cart, line.line_id, line.quantity + 1))} type="button">+</button><button className="min-h-11 px-1 text-sm font-bold underline" onClick={() => { if (item) { setEditingLine(line); setSelectedItem(item); } }} type="button">Edit</button><button className="ml-auto min-h-11 px-1 text-sm font-bold text-wayne-red" onClick={() => setCart(cart.filter((candidate) => candidate.line_id !== line.line_id))} type="button">Remove</button></div></div>; }) : <p className="rounded-xl bg-wayne-cream p-5 text-center text-wayne-muted">Tap a menu item to begin.</p>}</div>
        <div className="shrink-0 border-t border-wayne-border pt-3">
          <details className="rounded-xl border border-wayne-border p-2"><summary className="min-h-9 cursor-pointer text-sm font-bold">Notes, promo &amp; discount{draft.orderNote || draft.promoCode || draft.manualType ? " •" : ""}</summary><label className="mt-2 grid gap-2 text-sm font-bold">Order notes<textarea className="rounded-lg border border-wayne-border p-2 font-normal" maxLength={1500} onChange={(e) => update({ orderNote: e.target.value })} rows={2} value={draft.orderNote} /></label><div className="mt-2 grid grid-cols-2 gap-2"><label className="text-sm font-bold">Promotion code<input className="mt-1 min-h-11 w-full rounded-lg border px-2 font-normal uppercase" disabled={Boolean(draft.manualType)} onChange={(e) => update({ promoCode: e.target.value })} value={draft.promoCode} /></label><label className="text-sm font-bold">Payment<select className="mt-1 min-h-11 w-full rounded-lg border bg-white px-2 font-normal" onChange={(e) => update({ paymentMethod: e.target.value as "test_manual" | "cash" })} value={draft.paymentMethod}><option value="test_manual">TEST / MANUAL</option><option value="cash">Cash (unpaid)</option></select></label></div>{canManageDiscount ? <div className="mt-2 grid gap-2"><select className="min-h-11 rounded-lg border bg-white px-2" disabled={Boolean(draft.promoCode)} onChange={(e) => update({ manualType: e.target.value as "" | "fixed" | "percent" })} value={draft.manualType}><option value="">No manual discount</option><option value="fixed">Fixed dollars</option><option value="percent">Percent</option></select>{draft.manualType ? <><Input id="pos-manual-value" label={draft.manualType === "fixed" ? "Amount ($)" : "Percent (%)"} min="0" onChange={(e) => update({ manualValue: e.target.value })} step="0.01" type="number" value={draft.manualValue} /><Input id="pos-manual-reason" label="Required reason" onChange={(e) => update({ manualReason: e.target.value })} value={draft.manualReason} /></> : null}</div> : null}</details>
          <div className="mt-3 space-y-1"><Total label="Subtotal" value={subtotal} />{previewDiscount ? <Total label="Manual discount" value={-previewDiscount} /> : null}{deliveryFee ? <Total label="Delivery fee" value={deliveryFee} /> : null}<Total label="Estimated tax" value={tax} /><Total emphasis label={draft.promoCode ? "Estimated total*" : "Total"} value={previewTotal} /></div>
          {draft.submitPending ? <p aria-live="polite" className="mt-2 rounded-xl bg-wayne-warn-soft p-2 text-sm font-bold">Not sent yet — waiting for the connection. It sends by itself; pressing Submit again is safe.</p> : null}
          {error && !draft.submitPending ? <p aria-live="polite" className="mt-2 rounded-xl bg-wayne-alert-soft p-2 text-sm font-bold text-wayne-alert">{error}</p> : null}
          <Button className="mt-3 min-h-12 w-full text-lg" disabled={submitting || !cart.length} onClick={submitOrder}>{submitting ? "Submitting…" : draft.submitPending ? "Try sending now" : "Submit order"}</Button>
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

/** The call this ticket came from, carried in automatically (§9). */
function PhoneContext({ draft, onOpenPhone }: { draft: PosDraft; onOpenPhone: () => void }) {
  return <div className="rounded-xl border-2 border-wayne-green bg-wayne-green/5 p-3">
    <p className="text-[0.65rem] font-black uppercase tracking-[0.16em] text-wayne-green">Phone order{draft.phoneLine ? ` · Line ${draft.phoneLine}` : ""}</p>
    <strong className="mt-1 block text-lg leading-tight">{formatPhone(draft.phone)}</strong>
    {draft.callerName ? <p className="text-xs font-bold text-wayne-muted">Caller ID: {draft.callerName}</p> : null}
    <button className="mt-2 min-h-11 text-sm font-bold underline" onClick={onOpenPhone} type="button">Back to phone lines</button>
  </div>;
}

/** What the cashier needs on screen the moment a known caller is pulled up. */
function CustomerCard({ customer }: { customer: PosCustomer }) {
  const address = customer.addresses.find((candidate) => candidate.is_default) ?? customer.addresses[0];
  return <div className="rounded-xl border-2 border-wayne-ok bg-wayne-ok/5 p-3">
    <p className="text-[0.65rem] font-black uppercase tracking-[0.16em] text-wayne-ok">Customer</p>
    <strong className="mt-1 block text-lg leading-tight">{customer.first_name} {customer.last_name}</strong>
    <p className="text-sm font-bold">{formatPhone(customer.phone)}</p>
    {address ? <p className="mt-2 text-sm">{address.address1}{address.address2 ? `, ${address.address2}` : ""}<br />{address.city}, {address.state} {address.postal_code}{address.delivery_instructions ? <><br /><span className="text-wayne-muted">{address.delivery_instructions}</span></> : null}</p> : <p className="mt-2 text-sm text-wayne-muted">No address on file.</p>}
    <p className="mt-2 text-xs font-bold text-wayne-muted">{customer.order_count} orders · {formatCents(customer.lifetime_spend_cents)} lifetime{customer.last_order_at ? ` · last ${new Date(customer.last_order_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}</p>
  </div>;
}

function AddressFields({ address, addressId, customer, onAddress, onAddressId }: { address: DraftAddress; addressId: string; customer: PosCustomer | null; onAddress: (value: DraftAddress) => void; onAddressId: (value: string) => void }) {
  return <div className="mt-4 grid gap-3">{customer?.addresses.length ? <label className="grid gap-2 text-sm font-bold">Saved address<select className="min-h-11 rounded-lg border bg-white px-3 font-normal" onChange={(e) => onAddressId(e.target.value)} value={addressId}><option value="">Enter a new address</option>{customer.addresses.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.address1}, {candidate.postal_code}</option>)}</select></label> : null}{!addressId ? <><Input id="pos-address1" label="Address" onChange={(e) => onAddress({ ...address, address1: e.target.value })} value={address.address1} /><Input id="pos-address2" label="Unit" onChange={(e) => onAddress({ ...address, address2: e.target.value })} value={address.address2} /><div className="grid grid-cols-2 gap-2"><Input id="pos-city" label="City" onChange={(e) => onAddress({ ...address, city: e.target.value })} value={address.city} /><Input id="pos-state" label="State" onChange={(e) => onAddress({ ...address, state: e.target.value })} value={address.state} /></div><Input id="pos-zip" label="ZIP" onChange={(e) => onAddress({ ...address, postal_code: e.target.value })} value={address.postal_code} /><Input id="pos-delivery-instructions" label="Delivery instructions" onChange={(e) => onAddress({ ...address, delivery_instructions: e.target.value })} value={address.delivery_instructions} /></> : null}</div>;
}

function Total({ emphasis, label, value }: { emphasis?: boolean; label: string; value: number }) { return <div className={`flex justify-between ${emphasis ? "border-t pt-3 text-xl font-black" : ""}`}><span>{label}</span><span>{formatCents(value)}</span></div>; }
function updateQuantity(cart: CartLine[], lineId: string, quantity: number) { return quantity < 1 ? cart.filter((line) => line.line_id !== lineId) : cart.map((line) => line.line_id === lineId ? { ...line, quantity: Math.min(20, quantity) } : line); }
