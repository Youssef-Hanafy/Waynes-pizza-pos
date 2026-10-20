"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PosAddressInput } from "@/components/checkout/google-address-input";
import type { StoreSettings } from "@/lib/content/schemas";
import { formatCents } from "@/lib/menu/schemas";
import type { DraftAddress, PosDraft } from "@/lib/orders/drafts";
import { formatPhone } from "@/lib/phone/normalize";
import type { PosCustomer } from "@/lib/pos/schemas";
import { orderActions } from "@/stores/order-store";
import { useCustomerSearch } from "./use-customer-search";
import { deliveryZip, orderKind, outsideDeliveryArea, phoneDigits, startProblem, type OrderKind } from "@/lib/orders/start-order";

type Props = {
  draft: PosDraft;
  settings: StoreSettings;
  /** Back to the phone lines (only for a ticket started from a call). */
  onOpenPhone?: () => void;
};

/**
 * The New Order card.  One screen, no scrolling, no extra "Start order" tap
 * (owner, 2026-10-13):
 *
 *   • Customer first — phone and name, with matching customers as you type
 *     (a ringing line fills the phone in by itself).
 *   • Then ONE tap on Walk-in, Pickup or Delivery opens the menu.
 *   • Delivery asks for a street only when there is no address yet; picking
 *     the address from the suggestions opens the menu by itself.
 *
 * Nothing here is lost: it is all on the draft, so holding the ticket or
 * refreshing the page keeps it.
 */
export function StartOrderCard({ draft, settings, onOpenPhone }: Props) {
  const update = orderActions.update;
  const fromCall = Boolean(draft.phoneCallKey);
  const [kind, setKind] = useState<OrderKind | null>(() => (draft.cart.length || draft.started || draft.customer || draft.firstName.trim() ? orderKind(draft) : null));
  const [error, setError] = useState("");
  // "In the store" chosen on purpose for a pickup / delivery (otherwise it's a phone order).
  const [sourceTouched, setSourceTouched] = useState(draft.started || draft.cart.length > 0);
  const shownSource: "phone" | "pos" = fromCall ? "phone" : sourceTouched && draft.source === "pos" ? "pos" : "phone";

  const searchText = draft.customer ? "" : phoneDigits(draft.phone).length >= 3 ? draft.phone : `${draft.firstName} ${draft.lastName}`.trim();
  const search = useCustomerSearch(searchText, { enabled: !(fromCall && kind === "walkin") });
  const matches = search.results.slice(0, 6);

  /** One tap: set the order type and, when nothing is missing, open the menu. */
  function choose(next: OrderKind) {
    setError("");
    setKind(next);
    if (next === "walkin") {
      // A walk-in keeps only a first name on the ticket.
      if (fromCall) update({ customerMode: "walk_in", fulfillment: "pickup", started: true });
      else update({ source: "pos", customerMode: "walk_in", fulfillment: "pickup", customer: null, lastName: "", phone: "", email: "", addressId: "", started: true });
      return;
    }
    // A pickup or delivery is a phone order unless the cashier says it's in the store.
    const source = shownSource;
    const patch: Partial<PosDraft> = { customerMode: "identified", fulfillment: next, source };
    const problem = startProblem({ ...draft, ...patch }, next, settings);
    if (!problem) { update({ ...patch, started: true }); return; }
    update(patch);
    // Delivery with no address yet: the street box appears right under the tiles, no error.
    const streetOnly = next === "delivery" && settings.delivery_enabled && !problem.startsWith("Enter a 10-digit");
    if (!streetOnly) setError(problem);
    else window.setTimeout(() => document.getElementById("start-address1")?.focus(), 50);
  }

  function selectCustomer(customer: PosCustomer) {
    const preferred = customer.addresses.find((candidate) => candidate.is_default) ?? customer.addresses[0];
    update({ customerMode: "identified", customer, firstName: customer.first_name, lastName: customer.last_name, phone: customer.phone, email: customer.email ?? "", addressId: preferred?.id ?? "" });
    setError("");
  }

  /** Changing who the customer is lets go of the saved profile. */
  function editIdentity(patch: Partial<PosDraft>) {
    update(draft.customer ? { ...patch, customer: null, addressId: "" } : patch);
  }

  function start() {
    const problem = startProblem(draft, kind, settings);
    if (problem) { setError(problem); return; }
    update({ started: true });
  }

  const zip = kind === "delivery" ? deliveryZip(draft) : "";
  const outsideArea = kind === "delivery" && outsideDeliveryArea(zip, settings.delivery_postal_codes);
  const editing = draft.cart.length > 0;

  const tile = (value: OrderKind, icon: string, title: string, note: string, disabled = false) => (
    <button aria-pressed={kind === value} className={`flex min-h-24 flex-col items-center justify-center rounded-2xl border-2 p-3 text-center transition active:scale-[0.98] disabled:opacity-40 ${kind === value ? "border-wayne-green bg-wayne-green text-white shadow-md" : "border-wayne-border bg-wayne-cream hover:border-wayne-green"}`} disabled={disabled} key={value} onClick={() => choose(value)} type="button">
      <span aria-hidden className="text-3xl leading-none">{icon}</span>
      <strong className="mt-1.5 text-xl font-black">{title}</strong>
      <span className={`text-xs font-bold ${kind === value ? "text-white/80" : "text-wayne-muted"}`}>{note}</span>
    </button>
  );

  /*
   * The delivery address step stays open once it has opened (owner,
   * 2026-10-20: "as soon as you press the first letter it closes it out").
   * It used to show only while the street was empty, so the first letter
   * typed counted as "address entered" and the whole step — box, keyboard
   * focus and suggestions — vanished.  Now it closes only when the ticket
   * starts (an address is picked from the list or "Go to the menu" is
   * tapped), or the cashier switches to Walk-in / Pickup.
   */
  const missingStreet = kind === "delivery" && !draft.started && settings.delivery_enabled && Boolean(startProblem(draft, "delivery", settings));
  const [streetOpen, setStreetOpen] = useState(missingStreet);
  if (missingStreet && !streetOpen) setStreetOpen(true);
  if (kind !== "delivery" && streetOpen) setStreetOpen(false);
  const needsStreet = kind === "delivery" && !draft.started && settings.delivery_enabled && (missingStreet || streetOpen);

  return <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto bg-wayne-cream-deep p-2 sm:p-4">
    <section aria-labelledby="start-order-title" className="w-full min-w-0 max-w-4xl rounded-3xl border border-wayne-border bg-white p-4 shadow-xl sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black" id="start-order-title">{editing ? "Order details" : "New order"}</h1>
          <p className="text-sm font-bold text-wayne-muted">{editing ? "Change the customer or tap a type — the items stay on the ticket." : "Customer if you have it, then tap the order type. That's it."}</p>
        </div>
        {fromCall ? <div className="rounded-2xl border-2 border-wayne-green bg-wayne-green/5 px-4 py-2 text-right">
          <p className="text-[0.65rem] font-black uppercase tracking-[0.16em] text-wayne-green">Phone call{draft.phoneLine ? ` · Line ${draft.phoneLine}` : ""}</p>
          <p className="text-lg font-black">{formatPhone(draft.phone)}</p>
          {draft.callerName ? <p className="text-xs font-bold text-wayne-muted">Caller ID: {draft.callerName}</p> : null}
          {onOpenPhone ? <button className="min-h-9 text-xs font-bold underline" onClick={onOpenPhone} type="button">Back to phone lines</button> : null}
        </div> : null}
      </div>

      <Step n={1} title="Customer (optional)">
        {draft.customer ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border-2 border-wayne-ok bg-wayne-ok-soft p-3">
          <div>
            <p className="text-lg font-black">✓ {draft.customer.first_name} {draft.customer.last_name}</p>
            <p className="text-sm font-bold">{formatPhone(draft.customer.phone)}{draft.customer.email ? ` · ${draft.customer.email}` : ""}</p>
            <p className="text-xs font-bold text-wayne-muted">{draft.customer.order_count} orders · {formatCents(draft.customer.lifetime_spend_cents)} lifetime{draft.customer.last_order_at ? ` · last ${new Date(draft.customer.last_order_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}</p>
          </div>
          <Button onClick={() => update({ customer: null, addressId: "" })} size="sm" variant="secondary">Not them</Button>
        </div> : <>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <Input autoComplete="off" id="start-phone" inputMode="tel" label="Phone" onChange={(event) => editIdentity({ phone: event.target.value })} placeholder="(508) 555-0123" type="tel" value={draft.phone} />
            <Input autoComplete="off" id="start-first" label="First name" onChange={(event) => editIdentity({ firstName: event.target.value })} value={draft.firstName} />
            <Input autoComplete="off" id="start-last" label="Last name" onChange={(event) => editIdentity({ lastName: event.target.value })} value={draft.lastName} />
          </div>
          <div aria-live="polite" className="mt-1 min-h-5">
            {search.busy && !matches.length ? <p className="text-sm font-bold text-wayne-muted">Looking…</p> : null}
            {search.error ? <p className="text-sm font-bold text-wayne-alert">{search.error}</p> : null}
            {!search.busy && !search.error && search.searched && !matches.length ? <p className="text-sm font-bold text-wayne-muted">{phoneDigits(draft.phone).length === 10 ? "New customer — they'll be saved with this order." : "No match. Add a phone to save them, or just tap the order type."}</p> : null}
          </div>
          {matches.length ? <ul aria-label="Matching customers" className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            {matches.map((customer) => {
              const address = customer.addresses.find((candidate) => candidate.is_default) ?? customer.addresses[0];
              return <li key={customer.id}><button className="min-h-14 w-full rounded-xl border-2 border-wayne-border bg-white p-2.5 text-left transition hover:border-wayne-green active:scale-[0.99]" onClick={() => selectCustomer(customer)} type="button">
                <span className="flex items-baseline justify-between gap-2"><strong className="text-base">{customer.first_name} {customer.last_name}</strong><span className="text-sm font-bold">{formatPhone(customer.phone)}</span></span>
                <span className="block truncate text-xs text-wayne-muted">{address ? `${address.address1}${address.address2 ? `, ${address.address2}` : ""}, ${address.city}` : "No address on file"} · {customer.order_count} orders</span>
              </button></li>;
            })}
          </ul> : null}
        </>}
      </Step>

      <Step n={2} title={editing ? "Order type" : "Tap to start"}>
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          {tile("walkin", "🚶", fromCall ? "No profile" : "Walk-in", fromCall ? "Pickup, name only" : "At the counter")}
          {tile("pickup", "🛍️", "Pickup", "Opens the menu")}
          {tile("delivery", "🚗", "Delivery", settings.delivery_enabled ? `+${formatCents(settings.delivery_fee_cents)} fee` : "Switched off", !settings.delivery_enabled)}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {!fromCall ? <div aria-label="How they ordered" className="inline-flex rounded-xl bg-wayne-cream p-1" role="group">
            {(["phone", "pos"] as const).map((source) => <button aria-pressed={shownSource === source} className={`min-h-10 rounded-lg px-3 text-sm font-black ${shownSource === source ? "bg-white text-wayne-ink shadow-sm" : "text-wayne-muted"}`} key={source} onClick={() => { setSourceTouched(true); update({ source }); }} type="button">{source === "phone" ? "📞 On the phone" : "🏪 In the store"}</button>)}
          </div> : null}
          <label className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border-2 px-3 ${draft.isTest ? "border-wayne-gold bg-wayne-gold/20" : "border-wayne-border bg-white"}`}>
            <input checked={draft.isTest} className="size-5 accent-wayne-green" onChange={(event) => update({ isTest: event.target.checked })} type="checkbox" />
            <span className="text-sm font-black">🧪 Test order</span>
          </label>
        </div>
      </Step>

      {needsStreet ? <Step n={3} title="Delivery address — pick it and the menu opens">
        <AddressPicker address={draft.address} addressId={draft.addressId} customer={draft.customer} onAddress={(address) => update({ address })} onAddressId={(addressId) => update({ addressId })}
          onPicked={(patch) => { setError(""); update({ ...patch, ...(startProblem({ ...draft, ...patch }, "delivery", settings) ? {} : { started: true }) }); }} />
        {outsideArea ? <p className="mt-3 rounded-xl bg-wayne-warn-soft p-3 text-sm font-bold">⚠ ZIP {zip} is outside the delivery area set in Admin → Settings. Check with the manager before sending a driver.</p> : null}
        <Button className="mt-3 min-h-14 w-full text-lg" onClick={start} size="lg">Go to the menu →</Button>
      </Step> : null}

      {error ? <p className="mt-4 rounded-xl bg-wayne-alert-soft p-3 text-sm font-bold text-wayne-alert" role="alert">{error}</p> : null}
      {editing && !needsStreet ? <Button className="mt-4 min-h-14 w-full text-lg" onClick={start} size="lg">Back to the order →</Button> : null}
    </section>
  </div>;
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return <div className="mt-4 min-w-0">
    <h2 className="mb-2 flex items-center gap-2 text-sm font-black uppercase tracking-[0.16em] text-wayne-muted"><span className="grid size-6 place-items-center rounded-full bg-wayne-green text-xs text-white">{n}</span>{title}</h2>
    {children}
  </div>;
}

function AddressPicker({ address, addressId, customer, onAddress, onAddressId, onPicked }: { address: DraftAddress; addressId: string; customer: PosCustomer | null; onAddress: (value: DraftAddress) => void; onAddressId: (value: string) => void; onPicked: (patch: Partial<PosDraft>) => void }) {
  const saved = customer?.addresses ?? [];
  return <div className="grid min-w-0 gap-3">
    {saved.length ? <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {saved.map((candidate) => <button aria-pressed={addressId === candidate.id} className={`min-h-16 rounded-xl border-2 p-3 text-left ${addressId === candidate.id ? "border-wayne-green bg-wayne-green/5" : "border-wayne-border bg-white"}`} key={candidate.id} onClick={() => onPicked({ addressId: candidate.id })} type="button">
        <strong className="block">{candidate.address1}{candidate.address2 ? `, ${candidate.address2}` : ""}</strong>
        <span className="block text-sm">{candidate.city}, {candidate.state} {candidate.postal_code}</span>
        {candidate.delivery_instructions ? <span className="block truncate text-xs text-wayne-muted">{candidate.delivery_instructions}</span> : null}
      </button>)}
      <button aria-pressed={!addressId} className={`min-h-16 rounded-xl border-2 border-dashed p-3 text-left font-bold ${!addressId ? "border-wayne-green bg-wayne-green/5" : "border-wayne-border-strong bg-white"}`} onClick={() => onAddressId("")} type="button">＋ A different address</button>
    </div> : null}
    {!addressId ? <div className="grid min-w-0 gap-3">
      {/* Wrapped: the address field spans two columns when it sits in a form grid, which here would split this list into two columns. */}
      <div className="pos-address min-w-0"><PosAddressInput id="start-address1" label="Street address" name="start-address1" onAddressSelect={(selected) => onPicked({ address: { ...address, ...selected }, addressId: "" })} onChange={(address1) => onAddress({ ...address, address1 })} placeholder="Start typing the address" value={address.address1} /></div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_5rem_7rem]">
        <Input id="start-address2" label="Apt / unit" onChange={(event) => onAddress({ ...address, address2: event.target.value })} value={address.address2} />
        <Input id="start-city" label="City (optional)" onChange={(event) => onAddress({ ...address, city: event.target.value })} value={address.city} />
        <Input id="start-state" label="State" maxLength={2} onChange={(event) => onAddress({ ...address, state: event.target.value.toUpperCase() })} value={address.state} />
        <Input id="start-zip" inputMode="numeric" label="ZIP (optional)" maxLength={10} onChange={(event) => onAddress({ ...address, postal_code: event.target.value })} value={address.postal_code} />
      </div>
      <Input id="start-delivery-instructions" label="Delivery instructions (optional)" onChange={(event) => onAddress({ ...address, delivery_instructions: event.target.value })} placeholder="Side door, ring bell, 2nd floor…" value={address.delivery_instructions} />
    </div> : null}
  </div>;
}
