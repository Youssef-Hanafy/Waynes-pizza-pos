"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { StoreSettings } from "@/lib/content/schemas";
import { formatCents, type PublicMenu } from "@/lib/menu/schemas";
import { cartLineUnitCents, cartSubtotalCents, findMenuItem } from "@/lib/orders/cart";
import type { CartLine } from "@/lib/orders/schemas";
import { posCustomerSchema, posOrderCreatedSchema, type PosCustomer } from "@/lib/pos/schemas";
import { OpenOrdersPanel } from "./open-orders-panel";

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

  if (created) return <main className="grid min-h-screen place-items-center bg-stone-100 p-5"><section className="w-full max-w-xl rounded-3xl border border-wayne-border bg-white p-8 text-center shadow-xl"><p className="text-sm font-black uppercase tracking-[0.2em] text-green-700">Order submitted</p><h1 className="mt-3 text-5xl font-black">{created.order_number}</h1><p className="mt-4 text-2xl font-bold">{formatCents(created.total_cents)}</p><p className="mt-4 rounded-xl bg-amber-50 p-4 font-bold">TEST / MANUAL boundary — no card was processed.</p><Button className="mt-6 w-full text-lg" onClick={newTicket}>Start new ticket</Button></section></main>;

  return <div className="min-h-screen bg-stone-100">
    <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 bg-wayne-ink px-4 py-3 text-white"><div><strong className="text-xl">Wayne&apos;s Front POS</strong><span className="ml-3 text-sm text-stone-300">{staffName}</span></div><div className="flex flex-wrap gap-2">{canManageOrders ? <OpenOrdersPanel timeZone={settings.timezone} /> : null}{canOpenAdmin ? <Button asChild variant="secondary"><Link href="/admin">Admin</Link></Button> : null}<Button asChild variant="secondary"><Link href="/">Public site</Link></Button></div></header>
    <main className="grid min-h-[calc(100vh-4rem)] xl:grid-cols-[19rem_1fr_24rem]">
      <aside className="border-b border-wayne-border bg-white p-4 xl:border-b-0 xl:border-r">
        <h2 className="text-xl font-black">Order type</h2><div className="mt-3 grid grid-cols-2 gap-2"><Button className="px-3" onClick={chooseWalkIn} variant={customerMode === "walk_in" ? "primary" : "secondary"}>Walk-in</Button><Button className="px-3" onClick={choosePhone} variant={customerMode === "identified" ? "primary" : "secondary"}>Phone</Button></div>
        {customerMode === "walk_in" ? <div className="mt-5 rounded-xl bg-wayne-cream p-4"><strong>Anonymous walk-in</strong><p className="mt-1 text-sm text-wayne-muted">Pickup ticket with no customer profile.</p></div> : <div className="mt-5"><form className="flex gap-2" onSubmit={lookupCustomer}><label className="flex-1 text-sm font-bold">Find customer<input className="mt-2 min-h-12 w-full rounded-lg border border-wayne-border px-3 font-normal" onChange={(event) => setCustomerSearch(event.target.value)} placeholder="Phone, name, or order #" value={customerSearch} /></label><Button className="self-end px-3" disabled={customerBusy}>{customerBusy ? "…" : "Find"}</Button></form>{customerResults.length ? <div className="mt-3 grid gap-2">{customerResults.map((customer) => <button className="rounded-xl border border-wayne-border p-3 text-left" key={customer.id} onClick={() => selectCustomer(customer)}><strong>{customer.first_name} {customer.last_name}</strong><p className="text-sm">{customer.phone}</p><p className="text-xs text-wayne-muted">{customer.order_count} orders · {formatCents(customer.lifetime_spend_cents)} lifetime</p></button>)}</div> : null}<div className="mt-4 grid gap-3"><Input label="First name" onChange={(e) => { setFirstName(e.target.value); setSelectedCustomer(null); setAddressId(""); }} required value={firstName} /><Input label="Last name" onChange={(e) => { setLastName(e.target.value); setSelectedCustomer(null); setAddressId(""); }} required value={lastName} /><Input label="Phone" onChange={(e) => { setPhone(e.target.value); setSelectedCustomer(null); setAddressId(""); }} required type="tel" value={phone} /><Input label="Email (optional)" onChange={(e) => { setEmail(e.target.value); setSelectedCustomer(null); setAddressId(""); }} type="email" value={email} /></div></div>}
        <h2 className="mt-6 text-xl font-black">Fulfillment</h2><div className="mt-3 grid grid-cols-2 gap-2"><Button disabled={!settings.pickup_enabled} onClick={() => setFulfillment("pickup")} variant={fulfillment === "pickup" ? "primary" : "secondary"}>Pickup</Button><Button disabled={customerMode === "walk_in" || !settings.delivery_enabled} onClick={() => setFulfillment("delivery")} variant={fulfillment === "delivery" ? "primary" : "secondary"}>Delivery</Button></div>
        {fulfillment === "delivery" ? <AddressFields address={address} addressId={addressId} customer={selectedCustomer} onAddress={setAddress} onAddressId={setAddressId} /> : null}
      </aside>
      <section className="p-4 sm:p-6"><div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-3xl font-black">Add items</h1><input aria-label="Search menu" className="min-h-12 rounded-xl border border-wayne-border bg-white px-4" onChange={(event) => setItemSearch(event.target.value)} placeholder="Search menu" value={itemSearch} /></div><nav className="mt-4 flex gap-2 overflow-x-auto pb-2">{visibleMenu.map((category) => <a className="whitespace-nowrap rounded-full bg-white px-4 py-3 font-bold shadow-sm" href={`#pos-${category.id}`} key={category.id}>{category.name}</a>)}</nav><div className="mt-5 grid gap-8">{visibleMenu.map((category) => <section id={`pos-${category.id}`} key={category.id}><h2 className="text-2xl font-black">{category.name}</h2><div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-4">{category.items.map((item) => <button className="min-h-28 rounded-2xl border border-wayne-border bg-white p-4 text-left shadow-sm transition active:scale-95 disabled:opacity-50" disabled={item.sold_out} key={item.id} onClick={() => setSelectedItem(item)}><strong className="text-lg">{item.name}</strong><p className="mt-2 font-black text-wayne-red">{item.variants.length ? `From ${formatCents(Math.min(...item.variants.map((variant) => variant.price_cents)))}` : formatCents(item.base_price_cents)}</p>{item.sold_out ? <span className="text-sm font-bold">Sold out</span> : null}</button>)}</div></section>)}</div></section>
      <aside className="border-t border-wayne-border bg-white p-4 xl:border-l xl:border-t-0"><div className="sticky top-4"><div className="flex items-center justify-between"><h2 className="text-2xl font-black">Current ticket</h2><button className="text-sm font-bold text-wayne-red underline" onClick={newTicket}>Clear</button></div><div className="mt-4 max-h-[36vh] space-y-3 overflow-y-auto">{cart.length ? cart.map((line) => { const item = findMenuItem(menu, line.menu_item_id); const variant = item?.variants.find((candidate) => candidate.id === line.variant_id); const modifiers = line.modifiers.flatMap((modifier) => item?.modifier_groups.flatMap((group) => group.choices.filter((choice) => choice.id === modifier.choice_id).map((choice) => `${modifier.quantity > 1 ? `${modifier.quantity}× ` : ""}${choice.name}`)) ?? []); return <div className="rounded-xl bg-stone-50 p-3" key={line.line_id}><div className="flex justify-between gap-2"><div><strong>{line.quantity}× {item?.name}</strong>{variant ? <p className="text-sm text-wayne-muted">{variant.name}</p> : null}</div><strong>{formatCents(cartLineUnitCents(menu, line) * line.quantity)}</strong></div>{modifiers.length ? <p className="mt-1 text-sm text-wayne-muted">{modifiers.join(", ")}</p> : null}{line.special_instructions ? <p className="mt-1 text-sm">Note: {line.special_instructions}</p> : null}<div className="mt-2 flex gap-2"><button aria-label="Decrease item" className="h-10 w-10 rounded-lg border" onClick={() => setCart(updateQuantity(cart, line.line_id, line.quantity - 1))}>−</button><button aria-label="Increase item" className="h-10 w-10 rounded-lg border" onClick={() => setCart(updateQuantity(cart, line.line_id, line.quantity + 1))}>+</button><button className="text-sm font-bold underline" onClick={() => { if (item) { setEditingLine(line); setSelectedItem(item); } }}>Edit</button><button className="ml-auto text-sm font-bold text-wayne-red" onClick={() => setCart(cart.filter((candidate) => candidate.line_id !== line.line_id))}>Remove</button></div></div>; }) : <p className="rounded-xl bg-stone-50 p-5 text-center text-wayne-muted">Tap a menu item to begin.</p>}</div>
        <label className="mt-4 grid gap-2 text-sm font-bold">Order notes<textarea className="rounded-lg border border-wayne-border p-3 font-normal" maxLength={1500} onChange={(e) => setOrderNote(e.target.value)} rows={2} value={orderNote} /></label>
        <div className="mt-4 grid grid-cols-2 gap-2"><label className="text-sm font-bold">Promotion code<input className="mt-2 min-h-11 w-full rounded-lg border px-3 font-normal uppercase" disabled={Boolean(manualType)} onChange={(e) => setPromoCode(e.target.value)} value={promoCode} /></label><label className="text-sm font-bold">Payment<select className="mt-2 min-h-11 w-full rounded-lg border bg-white px-2 font-normal" onChange={(e) => setPaymentMethod(e.target.value as "test_manual" | "cash")} value={paymentMethod}><option value="test_manual">TEST / MANUAL</option><option value="cash">Cash (unpaid)</option></select></label></div>
        {canManageDiscount ? <details className="mt-4 rounded-xl border border-wayne-border p-3"><summary className="cursor-pointer font-bold">Manager manual discount</summary><div className="mt-3 grid gap-3"><select className="min-h-11 rounded-lg border bg-white px-3" disabled={Boolean(promoCode)} onChange={(e) => setManualType(e.target.value as "" | "fixed" | "percent")} value={manualType}><option value="">None</option><option value="fixed">Fixed dollars</option><option value="percent">Percent</option></select>{manualType ? <><Input label={manualType === "fixed" ? "Amount ($)" : "Percent (%)"} min="0" onChange={(e) => setManualValue(e.target.value)} step="0.01" type="number" value={manualValue} /><Input label="Required reason" onChange={(e) => setManualReason(e.target.value)} value={manualReason} /></> : null}</div></details> : null}
        <div className="mt-5 space-y-2"><Total label="Subtotal" value={subtotal} />{previewDiscount ? <Total label="Manual discount" value={-previewDiscount} /> : null}{deliveryFee ? <Total label="Delivery fee" value={deliveryFee} /> : null}<Total label="Estimated tax" value={tax} /><Total emphasis label={promoCode ? "Estimated total*" : "Total"} value={previewTotal} />{promoCode ? <p className="text-xs text-wayne-muted">*Promotion is validated and totaled securely at submit.</p> : null}</div>
        <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm font-bold">No card payment is available in Phase 4.</p>{error ? <p aria-live="polite" className="mt-3 rounded-xl bg-red-50 p-3 text-sm font-bold text-red-800">{error}</p> : null}<Button className="mt-4 min-h-14 w-full text-lg" disabled={submitting || !cart.length} onClick={submitOrder}>{submitting ? "Submitting…" : "Submit order"}</Button>
      </div></aside>
    </main>{selectedItem ? <ItemDialog initialLine={editingLine} item={selectedItem} onAdd={(line) => { setCart(editingLine ? cart.map((candidate) => candidate.line_id === editingLine.line_id ? line : candidate) : [...cart, line]); setEditingLine(null); setSelectedItem(null); }} onClose={() => { setEditingLine(null); setSelectedItem(null); }} /> : null}
  </div>;
}

function AddressFields({ address, addressId, customer, onAddress, onAddressId }: { address: typeof blankAddress; addressId: string; customer: PosCustomer | null; onAddress: (value: typeof blankAddress) => void; onAddressId: (value: string) => void }) {
  return <div className="mt-4 grid gap-3">{customer?.addresses.length ? <label className="grid gap-2 text-sm font-bold">Saved address<select className="min-h-11 rounded-lg border bg-white px-3 font-normal" onChange={(e) => onAddressId(e.target.value)} value={addressId}><option value="">Enter a new address</option>{customer.addresses.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.address1}, {candidate.postal_code}</option>)}</select></label> : null}{!addressId ? <><Input label="Address" onChange={(e) => onAddress({ ...address, address1: e.target.value })} value={address.address1} /><Input label="Unit" onChange={(e) => onAddress({ ...address, address2: e.target.value })} value={address.address2} /><div className="grid grid-cols-2 gap-2"><Input label="City" onChange={(e) => onAddress({ ...address, city: e.target.value })} value={address.city} /><Input label="State" onChange={(e) => onAddress({ ...address, state: e.target.value })} value={address.state} /></div><Input label="ZIP" onChange={(e) => onAddress({ ...address, postal_code: e.target.value })} value={address.postal_code} /><Input label="Delivery instructions" onChange={(e) => onAddress({ ...address, delivery_instructions: e.target.value })} value={address.delivery_instructions} /></> : null}</div>;
}

function ItemDialog({ initialLine, item, onAdd, onClose }: { initialLine: CartLine | null; item: MenuItem; onAdd: (line: CartLine) => void; onClose: () => void }) {
  const [variantId, setVariantId] = useState<string | null>(initialLine?.variant_id ?? item.variants[0]?.id ?? null);
  const [selectedChoices, setSelectedChoices] = useState<Record<string, number>>(() => initialLine ? Object.fromEntries(initialLine.modifiers.map((modifier) => [modifier.choice_id, modifier.quantity])) : Object.fromEntries(item.modifier_groups.flatMap((group) => group.choices.filter((choice) => choice.default_selected).map((choice) => [choice.id, 1]))));
  const [quantity, setQuantity] = useState(initialLine?.quantity ?? 1); const [instructions, setInstructions] = useState(initialLine?.special_instructions ?? ""); const [error, setError] = useState("");
  const draftLine: CartLine = { line_id: "draft", menu_item_id: item.id, variant_id: variantId, quantity, special_instructions: instructions, modifiers: Object.entries(selectedChoices).filter(([, count]) => count > 0).map(([choice_id, count]) => ({ choice_id, quantity: count })) };
  const draftMenu = [{ id: "00000000-0000-4000-8000-000000000000", name: "", description: "", image_path: null, image_alt: "", items: [item] }] as PublicMenu;
  function add() { for (const group of item.modifier_groups) { const count = group.choices.reduce((sum, choice) => sum + (selectedChoices[choice.id] ?? 0), 0); if (count < group.min_select || count > group.max_select || (group.required && !count)) { setError(`${group.customer_label}: choose ${group.min_select}–${group.max_select}.`); return; } } onAdd({ ...draftLine, line_id: initialLine?.line_id ?? crypto.randomUUID() }); }
  return <div aria-modal="true" className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-3" role="dialog"><section className="max-h-[95vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl"><div className="flex justify-between gap-4"><div><h2 className="text-3xl font-black">{item.name}</h2><p className="text-wayne-muted">{item.description}</p></div><button aria-label="Close item" className="h-12 w-12 rounded-full border text-xl" onClick={onClose}>×</button></div>{item.variants.length ? <fieldset className="mt-5"><legend className="font-black">Size</legend><div className="mt-2 grid grid-cols-2 gap-2">{item.variants.map((variant) => <label className="flex min-h-14 items-center justify-between rounded-xl border p-3" key={variant.id}><span><input checked={variantId === variant.id} className="mr-2" name="variant" onChange={() => setVariantId(variant.id)} type="radio" />{variant.name}</span><strong>{formatCents(variant.price_cents)}</strong></label>)}</div></fieldset> : null}{item.modifier_groups.map((group) => <fieldset className="mt-5" key={group.id}><legend className="font-black">{group.customer_label} <span className="font-normal text-wayne-muted">({group.min_select}–{group.max_select})</span></legend><div className="mt-2 grid gap-2 sm:grid-cols-2">{group.choices.map((choice) => { const count = selectedChoices[choice.id] ?? 0; return <div className="flex min-h-14 items-center rounded-xl border p-3" key={choice.id}><label className="flex flex-1 items-center"><input checked={count > 0} className="mr-2" onChange={(e) => setSelectedChoices({ ...selectedChoices, [choice.id]: e.target.checked ? 1 : 0 })} type="checkbox" />{choice.name} {choice.price_delta_cents ? <small className="ml-1">+{formatCents(choice.price_delta_cents)}</small> : null}</label>{group.allow_quantities && count ? <div className="flex items-center gap-2"><button className="h-9 w-9 rounded border" onClick={() => setSelectedChoices({ ...selectedChoices, [choice.id]: Math.max(0, count - 1) })}>−</button><strong>{count}</strong><button className="h-9 w-9 rounded border" onClick={() => setSelectedChoices({ ...selectedChoices, [choice.id]: Math.min(20, count + 1) })}>+</button></div> : null}</div>; })}</div></fieldset>)}<label className="mt-5 grid gap-2 font-bold">Item notes<textarea className="rounded-xl border p-3 font-normal" maxLength={500} onChange={(e) => setInstructions(e.target.value)} rows={2} value={instructions} /></label><div className="mt-5 flex items-center justify-between gap-4"><div className="flex items-center gap-2"><button className="h-12 w-12 rounded-xl border" onClick={() => setQuantity(Math.max(1, quantity - 1))}>−</button><strong>{quantity}</strong><button className="h-12 w-12 rounded-xl border" onClick={() => setQuantity(Math.min(20, quantity + 1))}>+</button></div><Button className="min-h-14" onClick={add}>{initialLine ? "Save changes" : "Add"} · {formatCents(cartLineUnitCents(draftMenu, draftLine) * quantity)}</Button></div>{error ? <p className="mt-3 rounded-lg bg-red-50 p-3 font-bold text-red-800">{error}</p> : null}</section></div>;
}

function Total({ emphasis, label, value }: { emphasis?: boolean; label: string; value: number }) { return <div className={`flex justify-between ${emphasis ? "border-t pt-3 text-xl font-black" : ""}`}><span>{label}</span><span>{formatCents(value)}</span></div>; }
function updateQuantity(cart: CartLine[], lineId: string, quantity: number) { return quantity < 1 ? cart.filter((line) => line.line_id !== lineId) : cart.map((line) => line.line_id === lineId ? { ...line, quantity: Math.min(20, quantity) } : line); }
