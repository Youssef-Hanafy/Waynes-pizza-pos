"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { StoreSettings } from "@/lib/content/schemas";
import { formatCents, type PublicMenu } from "@/lib/menu/schemas";
import { cartLineUnitCents, cartSubtotalCents, choicePriceDeltaCents, findMenuItem } from "@/lib/orders/cart";
import type { CartLine } from "@/lib/orders/schemas";
import { posCustomerSchema, posOrderCreatedSchema, type PosCustomer } from "@/lib/pos/schemas";
import { DrawerPanel } from "./drawer-panel";
import { OpenOrdersPanel } from "./open-orders-panel";
import { PhonePanel } from "./phone-panel";

type MenuItem = PublicMenu[number]["items"][number];
type Props = { canManageDiscount: boolean; canManageOrders: boolean; canOpenAdmin: boolean; menu: PublicMenu; settings: StoreSettings; staffName: string };

const blankAddress = { address1: "", address2: "", city: "Worcester", state: "MA", postal_code: "", delivery_instructions: "" };

export function PosClient({ canManageDiscount, canManageOrders, canOpenAdmin, menu, settings, staffName }: Props) {
  const [customerMode, setCustomerMode] = useState<"walk_in" | "identified">("walk_in");
  const [fulfillment, setFulfillment] = useState<"pickup" | "delivery">("pickup");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null);
  const [editingLine, setEditingLine] = useState<CartLine | null>(null);
  const [itemSearch, setItemSearch] = useState("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerResults, setCustomerResults] = useState<PosCustomer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<PosCustomer | null>(null);
  const [customerBusy, setCustomerBusy] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [addressId, setAddressId] = useState("");
  const [address, setAddress] = useState(blankAddress);
  const [orderNote, setOrderNote] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"test_manual" | "cash">("test_manual");
  const [promoCode, setPromoCode] = useState("");
  const [manualType, setManualType] = useState<"" | "fixed" | "percent">("");
  const [manualValue, setManualValue] = useState("");
  const [manualReason, setManualReason] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<{ order_number: string; total_cents: number } | null>(null);
  const [ticketIdempotencyKey, setTicketIdempotencyKey] = useState(() => crypto.randomUUID());
  const [callerNotice, setCallerNotice] = useState("");

  const visibleMenu = useMemo(() => menu.map((category) => ({ ...category, items: category.items.filter((item) => item.name.toLowerCase().includes(itemSearch.trim().toLowerCase())) })).filter((category) => category.items.length), [itemSearch, menu]);
  const subtotal = cartSubtotalCents(menu, cart);
  const manualInput = Number(manualValue) || 0;
  const previewDiscount = manualType === "fixed" ? Math.min(subtotal, Math.round(manualInput * 100)) : manualType === "percent" ? Math.min(subtotal, Math.round(subtotal * manualInput / 100)) : 0;
  const deliveryFee = fulfillment === "delivery" ? settings.delivery_fee_cents : 0;
  const tax = Math.round((subtotal - previewDiscount + deliveryFee) * settings.tax_rate_basis_points / 10_000);
  const previewTotal = subtotal - previewDiscount + deliveryFee + tax;

  function chooseWalkIn() {
    setCustomerMode("walk_in"); setFulfillment("pickup"); setSelectedCustomer(null); setCustomerResults([]); setError("");
  }

  function choosePhone() { setCustomerMode("identified"); setError(""); }

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
    } catch (lookupError) { setError(lookupError instanceof Error ? lookupError.message : "Customer lookup failed."); }
    finally { setCustomerBusy(false); }
  }

  function selectCustomer(customer: PosCustomer) {
    setSelectedCustomer(customer); setFirstName(customer.first_name); setLastName(customer.last_name); setPhone(customer.phone); setEmail(customer.email ?? "");
    const preferred = customer.addresses.find((candidate) => candidate.is_default) ?? customer.addresses[0];
    setAddressId(preferred?.id ?? ""); setCustomerResults([]); setError("");
  }

  /**
   * The cashier tapped a ringing line.  Look the number up the same way the
   * search box does, so a known caller arrives complete — name, saved addresses,
   * order history — and an unknown one at least arrives with their number typed
   * in, which is the slow part of taking a phone order.
   */
  async function useCaller(callerPhone: string) {
    setCustomerMode("identified");
    setPhone(callerPhone);
    setCustomerBusy(true);
    setError("");
    setCallerNotice("");
    try {
      const response = await fetch(`/api/pos/customers?q=${encodeURIComponent(callerPhone)}`);
      const parsed = posCustomerSchema.array().safeParse(await response.json());
      const match = parsed.success ? parsed.data[0] : undefined;
      if (match) {
        selectCustomer(match);
        if (match.addresses.length) setFulfillment(settings.delivery_enabled ? "delivery" : "pickup");
        setCallerNotice("");
      } else {
        setSelectedCustomer(null);
        setCustomerResults([]);
        setFirstName("");
        setLastName("");
        setCallerNotice("No profile for this number yet — take their name and it will be saved.");
      }
    } catch {
      setCallerNotice("Could not look that number up. Search for them instead.");
    } finally {
      setCustomerBusy(false);
    }
  }

  async function submitOrder() {
    if (!cart.length) { setError("Add at least one item to the ticket."); return; }
    setSubmitting(true); setError("");
    const value = manualType === "percent" ? Math.round((Number(manualValue) || 0) * 100) : Math.round((Number(manualValue) || 0) * 100);
    const payload = {
      idempotency_key: ticketIdempotencyKey, customer_mode: customerMode, customer_id: selectedCustomer?.id ?? "",
      source: customerMode === "walk_in" ? "pos" : "phone", fulfillment_type: fulfillment, payment_method: paymentMethod,
      first_name: firstName, last_name: lastName, phone, email, address_id: addressId, address,
      promo_code: promoCode, manual_discount_type: manualType, manual_discount_value: value,
      manual_discount_reason: manualReason, tip_cents: 0, special_instructions: orderNote,
      items: cart.map((line) => ({ menu_item_id: line.menu_item_id, variant_id: line.variant_id, quantity: line.quantity, special_instructions: line.special_instructions, modifiers: line.modifiers })),
    };
    try {
      const response = await fetch("/api/pos/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body: unknown = await response.json();
      const parsed = posOrderCreatedSchema.safeParse(body);
      if (!response.ok || !parsed.success) throw new Error(body && typeof body === "object" && "error" in body ? String(body.error) : "The ticket could not be submitted.");
      setCreated(parsed.data); setCart([]);
    } catch (submitError) { setError(submitError instanceof Error ? submitError.message : "The ticket could not be submitted."); }
    finally { setSubmitting(false); }
  }

  function newTicket() {
    setCreated(null); setCart([]); setCustomerMode("walk_in"); setFulfillment("pickup"); setSelectedCustomer(null); setFirstName(""); setLastName(""); setPhone(""); setEmail(""); setAddressId(""); setAddress(blankAddress); setOrderNote(""); setPromoCode(""); setManualType(""); setManualValue(""); setManualReason(""); setPaymentMethod("test_manual"); setTicketIdempotencyKey(crypto.randomUUID()); setError("");
  }

  if (created) return <main className="grid min-h-screen place-items-center bg-wayne-cream-deep p-5"><section className="w-full max-w-xl rounded-3xl border border-wayne-border bg-white p-8 text-center shadow-xl"><p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-ok">Order submitted</p><h1 className="mt-3 text-5xl font-black">{created.order_number}</h1><p className="mt-4 text-2xl font-bold">{formatCents(created.total_cents)}</p><p className="mt-4 rounded-xl bg-wayne-warn-soft p-4 font-bold">TEST / MANUAL boundary — no card was processed.</p><Button className="mt-6 w-full text-lg" onClick={newTicket}>Start new ticket</Button></section></main>;

  return <div className="flex min-h-screen flex-col bg-wayne-cream-deep lg:h-screen lg:overflow-hidden">
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 bg-wayne-green px-3 text-wayne-cream"><div className="min-w-0"><strong className="text-lg">Wayne&apos;s Front POS</strong><span className="ml-3 hidden text-sm text-wayne-cream/70 sm:inline">{staffName}</span></div><div className="flex flex-wrap gap-2"><DrawerPanel timeZone={settings.timezone} />{canManageOrders ? <OpenOrdersPanel timeZone={settings.timezone} /> : null}{canOpenAdmin ? <Button asChild variant="secondary"><Link href="/admin">Admin</Link></Button> : null}<Button asChild variant="secondary"><Link href="/">Public site</Link></Button></div></header>
    {/* The register has to live inside one screen: a cashier with a customer at
        the counter cannot scroll the page to find the subs. Only the menu grid
        and the ticket scroll, and each does so inside its own column. */}
    <main className="grid flex-1 grid-cols-1 lg:min-h-0 lg:grid-cols-[16.5rem_1fr_19.5rem] 2xl:grid-cols-[19rem_1fr_23rem]">
      <aside className="border-b border-wayne-border bg-white p-3 lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-r">
        <h2 className="text-base font-black uppercase tracking-[0.16em]">Order type</h2><div className="mt-2 grid grid-cols-2 gap-2"><Button className="px-3" onClick={chooseWalkIn} variant={customerMode === "walk_in" ? "primary" : "secondary"}>Walk-in</Button><Button className="px-3" onClick={choosePhone} variant={customerMode === "identified" ? "primary" : "secondary"}>Phone</Button></div>
        {customerMode === "walk_in" ? <div className="mt-4 rounded-xl bg-wayne-cream p-3"><strong>Anonymous walk-in</strong><p className="mt-1 text-sm text-wayne-muted">Pickup ticket with no customer profile.</p></div> : <div className="mt-4 grid gap-4"><PhonePanel onPickCall={useCaller} />{callerNotice ? <p className="rounded-lg bg-wayne-warn-soft p-2 text-xs font-bold">{callerNotice}</p> : null}<form className="flex gap-2" onSubmit={lookupCustomer}><label className="flex-1 text-sm font-bold">Find customer<input className="mt-2 min-h-11 w-full rounded-lg border border-wayne-border px-3 font-normal" onChange={(event) => setCustomerSearch(event.target.value)} placeholder="Phone, name, or order #" value={customerSearch} /></label><Button className="self-end px-3" disabled={customerBusy}>{customerBusy ? "…" : "Find"}</Button></form>{customerResults.length ? <div className="grid gap-2">{customerResults.map((customer) => <button className="rounded-xl border border-wayne-border p-3 text-left" key={customer.id} onClick={() => selectCustomer(customer)}><strong>{customer.first_name} {customer.last_name}</strong><p className="text-sm">{customer.phone}</p><p className="text-xs text-wayne-muted">{customer.order_count} orders · {formatCents(customer.lifetime_spend_cents)} lifetime</p></button>)}</div> : null}{selectedCustomer ? <CustomerCard customer={selectedCustomer} /> : null}<div className="grid gap-3"><Input label="First name" onChange={(e) => { setFirstName(e.target.value); setSelectedCustomer(null); setAddressId(""); }} required value={firstName} /><Input label="Last name" onChange={(e) => { setLastName(e.target.value); setSelectedCustomer(null); setAddressId(""); }} required value={lastName} /><Input label="Phone" onChange={(e) => { setPhone(e.target.value); setSelectedCustomer(null); setAddressId(""); }} required type="tel" value={phone} /><Input label="Email (optional)" onChange={(e) => { setEmail(e.target.value); setSelectedCustomer(null); setAddressId(""); }} type="email" value={email} /></div></div>}
        <h2 className="mt-5 text-base font-black uppercase tracking-[0.16em]">Fulfillment</h2><div className="mt-2 grid grid-cols-2 gap-2"><Button disabled={!settings.pickup_enabled} onClick={() => setFulfillment("pickup")} variant={fulfillment === "pickup" ? "primary" : "secondary"}>Pickup</Button><Button disabled={customerMode === "walk_in" || !settings.delivery_enabled} onClick={() => setFulfillment("delivery")} variant={fulfillment === "delivery" ? "primary" : "secondary"}>Delivery</Button></div>
        {fulfillment === "delivery" ? <AddressFields address={address} addressId={addressId} customer={selectedCustomer} onAddress={setAddress} onAddressId={setAddressId} /> : null}
      </aside>
      <section className="flex flex-col p-3 lg:min-h-0">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-black">Add items</h1><input aria-label="Search menu" className="min-h-11 flex-1 rounded-xl border border-wayne-border bg-white px-4 sm:max-w-xs" onChange={(event) => setItemSearch(event.target.value)} placeholder="Search menu" value={itemSearch} /></div>
        <nav className="mt-3 flex max-h-28 shrink-0 flex-wrap gap-1.5 overflow-y-auto pb-2">{visibleMenu.map((category) => <a className="whitespace-nowrap rounded-full bg-white px-3 py-2 text-sm font-bold shadow-sm" href={`#pos-${category.id}`} key={category.id}>{category.name}</a>)}</nav>
        <div className="mt-2 grid flex-1 gap-6 pr-1 lg:min-h-0 lg:overflow-y-auto">{visibleMenu.map((category) => <section id={`pos-${category.id}`} key={category.id}><h2 className="text-xl font-black">{category.name}</h2><div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">{category.items.map((item) => <button className="min-h-24 rounded-xl border border-wayne-border bg-white p-3 text-left shadow-sm transition active:scale-95 disabled:opacity-50" disabled={item.sold_out} key={item.id} onClick={() => setSelectedItem(item)}><strong className="block text-sm leading-tight">{item.name}</strong><p className="mt-1 text-sm font-black text-wayne-red">{item.variants.length ? `From ${formatCents(Math.min(...item.variants.map((variant) => variant.price_cents)))}` : formatCents(item.base_price_cents)}</p>{item.modifier_groups.length ? <p className="mt-0.5 text-[0.65rem] font-bold text-wayne-ok">Customize</p> : <p className="mt-0.5 text-[0.65rem] font-bold text-wayne-muted">Quick add</p>}{item.sold_out ? <span className="text-xs font-bold">Sold out</span> : null}</button>)}</div></section>)}</div>
      </section>
      <aside className="flex flex-col border-t border-wayne-border bg-white p-3 lg:min-h-0 lg:border-l lg:border-t-0">
        <div className="flex shrink-0 items-center justify-between"><h2 className="text-xl font-black">Current ticket</h2><button className="text-sm font-bold text-wayne-red underline" onClick={newTicket}>Clear</button></div>
        <div className="mt-3 flex-1 space-y-2 pr-1 lg:min-h-0 lg:overflow-y-auto">{cart.length ? cart.map((line) => { const item = findMenuItem(menu, line.menu_item_id); const variant = item?.variants.find((candidate) => candidate.id === line.variant_id); const modifiers = line.modifiers.flatMap((modifier) => item?.modifier_groups.flatMap((group) => group.choices.filter((choice) => choice.id === modifier.choice_id).map((choice) => `${modifier.quantity > 1 ? `${modifier.quantity}× ` : ""}${choice.name}`)) ?? []); return <div className="rounded-xl bg-wayne-cream p-3" key={line.line_id}><div className="flex justify-between gap-2"><div><strong>{line.quantity}× {item?.name}</strong>{variant ? <p className="text-sm text-wayne-muted">{variant.name}</p> : null}</div><strong>{formatCents(cartLineUnitCents(menu, line) * line.quantity)}</strong></div>{modifiers.length ? <p className="mt-1 text-sm text-wayne-muted">{modifiers.join(", ")}</p> : null}{line.special_instructions ? <p className="mt-1 text-sm">Note: {line.special_instructions}</p> : null}<div className="mt-2 flex gap-2"><button aria-label="Decrease item" className="h-9 w-9 rounded-lg border" onClick={() => setCart(updateQuantity(cart, line.line_id, line.quantity - 1))}>−</button><button aria-label="Increase item" className="h-9 w-9 rounded-lg border" onClick={() => setCart(updateQuantity(cart, line.line_id, line.quantity + 1))}>+</button><button className="text-sm font-bold underline" onClick={() => { if (item) { setEditingLine(line); setSelectedItem(item); } }}>Edit</button><button className="ml-auto text-sm font-bold text-wayne-red" onClick={() => setCart(cart.filter((candidate) => candidate.line_id !== line.line_id))}>Remove</button></div></div>; }) : <p className="rounded-xl bg-wayne-cream p-5 text-center text-wayne-muted">Tap a menu item to begin.</p>}</div>
        <div className="shrink-0 border-t border-wayne-border pt-3">
          <details className="rounded-xl border border-wayne-border p-2"><summary className="cursor-pointer text-sm font-bold">Notes, promo &amp; discount</summary><label className="mt-2 grid gap-2 text-sm font-bold">Order notes<textarea className="rounded-lg border border-wayne-border p-2 font-normal" maxLength={1500} onChange={(e) => setOrderNote(e.target.value)} rows={2} value={orderNote} /></label><div className="mt-2 grid grid-cols-2 gap-2"><label className="text-sm font-bold">Promotion code<input className="mt-1 min-h-10 w-full rounded-lg border px-2 font-normal uppercase" disabled={Boolean(manualType)} onChange={(e) => setPromoCode(e.target.value)} value={promoCode} /></label><label className="text-sm font-bold">Payment<select className="mt-1 min-h-10 w-full rounded-lg border bg-white px-2 font-normal" onChange={(e) => setPaymentMethod(e.target.value as "test_manual" | "cash")} value={paymentMethod}><option value="test_manual">TEST / MANUAL</option><option value="cash">Cash (unpaid)</option></select></label></div>{canManageDiscount ? <div className="mt-2 grid gap-2"><select className="min-h-10 rounded-lg border bg-white px-2" disabled={Boolean(promoCode)} onChange={(e) => setManualType(e.target.value as "" | "fixed" | "percent")} value={manualType}><option value="">No manual discount</option><option value="fixed">Fixed dollars</option><option value="percent">Percent</option></select>{manualType ? <><Input label={manualType === "fixed" ? "Amount ($)" : "Percent (%)"} min="0" onChange={(e) => setManualValue(e.target.value)} step="0.01" type="number" value={manualValue} /><Input label="Required reason" onChange={(e) => setManualReason(e.target.value)} value={manualReason} /></> : null}</div> : null}</details>
          <div className="mt-3 space-y-1"><Total label="Subtotal" value={subtotal} />{previewDiscount ? <Total label="Manual discount" value={-previewDiscount} /> : null}{deliveryFee ? <Total label="Delivery fee" value={deliveryFee} /> : null}<Total label="Estimated tax" value={tax} /><Total emphasis label={promoCode ? "Estimated total*" : "Total"} value={previewTotal} /></div>
          {error ? <p aria-live="polite" className="mt-2 rounded-xl bg-wayne-alert-soft p-2 text-sm font-bold text-wayne-alert">{error}</p> : null}
          <Button className="mt-3 min-h-12 w-full text-lg" disabled={submitting || !cart.length} onClick={submitOrder}>{submitting ? "Submitting…" : "Submit order"}</Button>
        </div>
      </aside>
    </main>{selectedItem ? <PosItemDialog initialLine={editingLine} item={selectedItem} onAdd={(line) => { setCart(editingLine ? cart.map((candidate) => candidate.line_id === editingLine.line_id ? line : candidate) : [...cart, line]); setEditingLine(null); setSelectedItem(null); }} onClose={() => { setEditingLine(null); setSelectedItem(null); }} /> : null}
  </div>;
}

/** What the cashier needs on screen the moment a known caller is pulled up. */
function CustomerCard({ customer }: { customer: PosCustomer }) {
  const address = customer.addresses.find((candidate) => candidate.is_default) ?? customer.addresses[0];
  return <div className="rounded-xl border-2 border-wayne-ok bg-wayne-ok/5 p-3">
    <p className="text-[0.65rem] font-black uppercase tracking-[0.16em] text-wayne-ok">Customer</p>
    <strong className="mt-1 block text-lg leading-tight">{customer.first_name} {customer.last_name}</strong>
    <p className="text-sm font-bold">{customer.phone}</p>
    {address ? <p className="mt-2 text-sm">{address.address1}{address.address2 ? `, ${address.address2}` : ""}<br />{address.city}, {address.state} {address.postal_code}{address.delivery_instructions ? <><br /><span className="text-wayne-muted">{address.delivery_instructions}</span></> : null}</p> : <p className="mt-2 text-sm text-wayne-muted">No address on file.</p>}
    <p className="mt-2 text-xs font-bold text-wayne-muted">{customer.order_count} orders · {formatCents(customer.lifetime_spend_cents)} lifetime{customer.last_order_at ? ` · last ${new Date(customer.last_order_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}</p>
  </div>;
}

function AddressFields({ address, addressId, customer, onAddress, onAddressId }: { address: typeof blankAddress; addressId: string; customer: PosCustomer | null; onAddress: (value: typeof blankAddress) => void; onAddressId: (value: string) => void }) {
  return <div className="mt-4 grid gap-3">{customer?.addresses.length ? <label className="grid gap-2 text-sm font-bold">Saved address<select className="min-h-11 rounded-lg border bg-white px-3 font-normal" onChange={(e) => onAddressId(e.target.value)} value={addressId}><option value="">Enter a new address</option>{customer.addresses.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.address1}, {candidate.postal_code}</option>)}</select></label> : null}{!addressId ? <><Input label="Address" onChange={(e) => onAddress({ ...address, address1: e.target.value })} value={address.address1} /><Input label="Unit" onChange={(e) => onAddress({ ...address, address2: e.target.value })} value={address.address2} /><div className="grid grid-cols-2 gap-2"><Input label="City" onChange={(e) => onAddress({ ...address, city: e.target.value })} value={address.city} /><Input label="State" onChange={(e) => onAddress({ ...address, state: e.target.value })} value={address.state} /></div><Input label="ZIP" onChange={(e) => onAddress({ ...address, postal_code: e.target.value })} value={address.postal_code} /><Input label="Delivery instructions" onChange={(e) => onAddress({ ...address, delivery_instructions: e.target.value })} value={address.delivery_instructions} /></> : null}</div>;
}

/**
 * The front counter needs a fast, visual way to adjust a recipe.  The red and
 * green controls intentionally mirror the legacy terminal: red removes an
 * included portion, green adds another portion.  Quantity is carried through
 * to the order API, so configured per-portion prices are charged correctly.
 */
function PosItemDialog({ initialLine, item, onAdd, onClose }: { initialLine: CartLine | null; item: MenuItem; onAdd: (line: CartLine) => void; onClose: () => void }) {
  const [variantId, setVariantId] = useState<string | null>(initialLine?.variant_id ?? item.variants[0]?.id ?? null);
  const [selectedChoices, setSelectedChoices] = useState<Record<string, number>>(() => initialLine
    ? Object.fromEntries(initialLine.modifiers.map((modifier) => [modifier.choice_id, modifier.quantity]))
    : Object.fromEntries(item.modifier_groups.flatMap((group) => group.choices.filter((choice) => choice.default_selected).map((choice) => [choice.id, 1]))));
  const [quantity, setQuantity] = useState(initialLine?.quantity ?? 1);
  const [instructions, setInstructions] = useState(initialLine?.special_instructions ?? "");
  const [error, setError] = useState("");

  const draftLine: CartLine = {
    line_id: "draft",
    menu_item_id: item.id,
    variant_id: variantId,
    quantity,
    special_instructions: instructions,
    modifiers: Object.entries(selectedChoices).filter(([, count]) => count > 0).map(([choice_id, count]) => ({ choice_id, quantity: count })),
  };
  const draftMenu = [{ id: "00000000-0000-4000-8000-000000000000", name: "", description: "", image_path: null, image_alt: "", items: [item] }] as PublicMenu;

  function groupCount(group: MenuItem["modifier_groups"][number]) {
    return group.choices.reduce((total, choice) => total + (selectedChoices[choice.id] ?? 0), 0);
  }

  function setChoiceCount(group: MenuItem["modifier_groups"][number], choiceId: string, nextCount: number) {
    const currentCount = selectedChoices[choiceId] ?? 0;
    const othersCount = groupCount(group) - currentCount;
    const limit = Math.max(0, group.max_select - othersCount);
    const safeCount = Math.max(0, Math.min(group.allow_quantities ? nextCount : Number(nextCount > 0), limit));
    if (nextCount > currentCount && safeCount === currentCount) {
      setError(`You can choose up to ${group.max_select} in ${group.customer_label}. Remove one first to change it.`);
      return;
    }
    setError("");
    setSelectedChoices((current) => ({ ...current, [choiceId]: safeCount }));
  }

  function add() {
    for (const group of item.modifier_groups) {
      const count = groupCount(group);
      if (count < group.min_select || count > group.max_select || (group.required && !count)) {
        setError(`${group.customer_label}: choose ${group.min_select}–${group.max_select}.`);
        return;
      }
    }
    onAdd({ ...draftLine, line_id: initialLine?.line_id ?? crypto.randomUUID() });
  }

  return <div aria-modal="true" className="fixed inset-0 z-50 bg-black/60 p-3 sm:grid sm:place-items-center" role="dialog">
    <section className="mx-auto flex max-h-[96vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
      <div className="flex items-start justify-between gap-4 border-b border-wayne-border p-5">
        <div><p className="text-xs font-black uppercase tracking-[0.18em] text-wayne-ok">Front POS customizer</p><h2 className="mt-1 text-3xl font-black">{item.name}</h2><p className="mt-1 text-wayne-muted">{item.description}</p></div>
        <button aria-label="Close item" className="h-12 w-12 shrink-0 rounded-full border text-xl" onClick={onClose}>×</button>
      </div>
      <div className="overflow-y-auto p-5">
        <p className="rounded-xl border border-wayne-border bg-wayne-cream p-3 text-sm font-semibold"><span className="mr-2 inline-flex rounded bg-wayne-red px-2 py-1 text-white">− remove</span><span className="mr-2 inline-flex rounded bg-wayne-ok px-2 py-1 text-white">+ add</span> Included ingredients are already selected. Tap green again to add another portion; each configured portion price is added to the ticket.</p>
        {item.variants.length ? <fieldset className="mt-5"><legend className="font-black">Size</legend><div className="mt-2 grid gap-2 sm:grid-cols-3">{item.variants.map((variant) => <button className={`min-h-14 rounded-xl border p-3 text-left ${variantId === variant.id ? "border-wayne-ok bg-wayne-ok/10" : "border-wayne-border"}`} key={variant.id} onClick={() => setVariantId(variant.id)} type="button"><span className="block font-bold">{variant.name}</span><strong>{formatCents(variant.price_cents)}</strong></button>)}</div></fieldset> : null}
        {item.modifier_groups.length ? item.modifier_groups.map((group) => <fieldset className="mt-5" key={group.id}><legend className="font-black">{group.customer_label} <span className="font-normal text-wayne-muted">({group.min_select}–{group.max_select})</span></legend><div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-3">{group.choices.map((choice) => {
          const count = selectedChoices[choice.id] ?? 0;
          const delta = choicePriceDeltaCents(choice, variantId);
          const included = choice.default_selected;
          return <div className={`grid min-h-16 grid-cols-[3.25rem_1fr_3.25rem] overflow-hidden rounded-xl border ${count ? "border-wayne-ok bg-wayne-ok/10" : "border-wayne-border bg-white"}`} key={choice.id}>
            <button aria-label={`Remove ${choice.name}`} className="bg-wayne-red px-2 text-2xl font-black text-white disabled:cursor-not-allowed disabled:opacity-35" disabled={!count} onClick={() => setChoiceCount(group, choice.id, count - 1)} type="button">−</button>
            <div className="flex min-w-0 flex-col justify-center px-3"><strong className="truncate">{choice.name}</strong><span className="text-xs text-wayne-muted">{count ? `${count} portion${count === 1 ? "" : "s"}` : included ? "included" : "not selected"}{delta ? ` · ${delta > 0 ? "+" : ""}${formatCents(delta)} each` : ""}</span></div>
            <button aria-label={`Add ${choice.name}`} className="bg-wayne-ok px-2 text-2xl font-black text-white" onClick={() => setChoiceCount(group, choice.id, count + 1)} type="button">+</button>
          </div>;
        })}</div></fieldset>) : <div className="mt-5 rounded-xl border-2 border-dashed border-wayne-border bg-wayne-cream p-5"><strong>No modifier group is assigned to this item yet.</strong><p className="mt-1 text-sm text-wayne-muted">The menu configuration needs a customization group before ingredients can be adjusted. This screen will show it as soon as it is assigned.</p></div>}
        <label className="mt-5 grid gap-2 font-bold">Item notes<textarea className="rounded-xl border p-3 font-normal" maxLength={500} onChange={(event) => setInstructions(event.target.value)} rows={2} value={instructions} /></label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-wayne-border p-5"><div className="flex items-center gap-2"><button aria-label="Decrease item quantity" className="h-12 w-12 rounded-xl border" onClick={() => setQuantity(Math.max(1, quantity - 1))} type="button">−</button><strong>{quantity}</strong><button aria-label="Increase item quantity" className="h-12 w-12 rounded-xl border" onClick={() => setQuantity(Math.min(20, quantity + 1))} type="button">+</button></div><Button className="min-h-14" onClick={add}>{initialLine ? "Save changes" : "Add to ticket"} · {formatCents(cartLineUnitCents(draftMenu, draftLine) * quantity)}</Button></div>
      {error ? <p aria-live="polite" className="mx-5 mb-5 rounded-lg bg-wayne-alert-soft p-3 font-bold text-wayne-alert">{error}</p> : null}
    </section>
  </div>;
}

function Total({ emphasis, label, value }: { emphasis?: boolean; label: string; value: number }) { return <div className={`flex justify-between ${emphasis ? "border-t pt-3 text-xl font-black" : ""}`}><span>{label}</span><span>{formatCents(value)}</span></div>; }
function updateQuantity(cart: CartLine[], lineId: string, quantity: number) { return quantity < 1 ? cart.filter((line) => line.line_id !== lineId) : cart.map((line) => line.line_id === lineId ? { ...line, quantity: Math.min(20, quantity) } : line); }
