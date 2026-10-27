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
import { orderActions, orderStore } from "@/stores/order-store";
import { alreadySaved, rememberCustomer, rememberPayload, savedAddressId } from "@/lib/pos/remember-customer";
import { draftFromCall } from "@/lib/orders/drafts";
import { callerCardInfo, customerName } from "@/lib/phone/caller-display";
import { callOnLine, type PhoneCallView } from "@/lib/phone/phone-state";
import { phoneActions, usePhoneState } from "@/stores/phone-store";
import { useCustomerSearch } from "./use-customer-search";
import { customerDetailsPatch, deliveryZip, editCustomerDetails, orderKind, orderTypePatch, outsideDeliveryArea, phoneDigits, startProblem, type OrderKind } from "@/lib/orders/start-order";

type Props = {
  draft: PosDraft;
  settings: StoreSettings;
  /** Back to the phone lines (only for a ticket started from a call). */
  onOpenPhone?: () => void;
};

export function StartOrderCard({ draft, settings, onOpenPhone }: Props) {
  const update = orderActions.update;
  const fromCall = Boolean(draft.phoneCallKey);
  const [kind, setKind] = useState<OrderKind | null>(() => (draft.orderKind || draft.cart.length || draft.started || draft.customer || draft.firstName.trim() ? orderKind(draft) : null));
  const [error, setError] = useState("");
  const [searchField, setSearchField] = useState<"phone" | "name">(() => phoneDigits(draft.phone).length >= 3 ? "phone" : "name");
  // "In the store" chosen on purpose for a pickup / delivery (otherwise it's a phone order).
  const [sourceTouched, setSourceTouched] = useState(draft.started || draft.cart.length > 0);
  const shownSource: "phone" | "pos" = fromCall ? "phone" : sourceTouched && draft.source === "pos" ? "pos" : "phone";

  // A phone order started from Pickup / Delivery instead of the ringing line
  // still gets the caller's number (owner, 2026-10-27: 20 phone orders had been
  // saved with no number, so those customers came up as new every time).
  const phone = usePhoneState();
  const waitingCallers = fromCall || draft.customer || phoneDigits(draft.phone).length || shownSource !== "phone" || kind === "walkin" ? []
    : phone.lines.map((line) => callOnLine(phone, line.line))
      .filter((call): call is PhoneCallView => call !== null && (call.status === "incoming" || call.status === "selected"));

  function takeCaller(call: PhoneCallView) {
    setError("");
    const customer = call.matches.length === 1 ? call.matches[0]! : null;
    // The order type already picked stays; only who is calling comes from the line.
    const patch = draftFromCall({
      callKey: call.key, callId: call.serverId, line: call.line, phoneNumber: call.phoneNumber, callerName: call.callerName, customer,
    });
    delete patch.fulfillment; delete patch.orderKind; delete patch.started;
    update(patch);
    void phoneActions.startOrderFromCall(call.key);
  }

  const searchText = draft.customer ? "" : searchField === "phone" ? draft.phone : `${draft.firstName} ${draft.lastName}`.trim();
  const search = useCustomerSearch(searchText);
  const matches = search.results.slice(0, 6);

  function choose(next: OrderKind) {
    setError("");
    setKind(next);
    update(orderTypePatch(draft, next, shownSource));
  }

  function selectCustomer(customer: PosCustomer) {
    update(customerDetailsPatch(customer));
    setError("");
  }

  function editIdentity(patch: Partial<PosDraft>) {
    setError("");
    if (patch.phone !== undefined) setSearchField("phone");
    else if (patch.firstName !== undefined || patch.lastName !== undefined) setSearchField("name");
    update(editCustomerDetails(draft, patch));
  }

  function start(jump = false) {
    const nextKind = kind ?? (jump ? fromCall ? "pickup" : "walkin" : null);
    const patch = nextKind ? orderTypePatch(draft, nextKind, shownSource) : {};
    const problem = startProblem({ ...draft, ...patch }, nextKind, settings);
    if (problem) { setError(problem); return; }
    update({ ...patch, started: true });
    // Saved the moment the order starts — even a test order or one never sent (owner, 2026-10-27).
    void saveCustomer({ ...draft, ...patch }, nextKind, true);
  }

  /**
   * Save the customer now (owner, 2026-10-27).  By itself when the order
   * starts; from the small Save button when just adding someone.  The server
   * matches by phone, so the same customer is never saved twice.
   */
  const [saveNote, setSaveNote] = useState<{ tone: "ok" | "busy" | "bad"; text: string } | null>(null);
  async function saveCustomer(target: PosDraft, targetKind: OrderKind | null, auto: boolean) {
    const payload = rememberPayload(target, targetKind);
    if (!payload) {
      if (!auto) setSaveNote({ tone: "bad", text: "Type the 10-digit phone number to save the customer." });
      return;
    }
    if (auto && alreadySaved(target, payload)) return;
    if (!auto) setSaveNote({ tone: "busy", text: "Saving…" });
    try {
      const saved = await rememberCustomer(payload);
      // The ticket uses the saved profile (and its saved address), so sending the order never adds them again.
      if (orderStore.get().activeId === target.id) {
        const addressId = payload.address ? savedAddressId(saved, target.address) : "";
        orderActions.update(addressId ? { customer: saved, addressId } : { customer: saved });
      }
      setSaveNote({ tone: "ok", text: `✓ Saved ${customerName(saved) || formatPhone(saved.phone)}` });
    } catch (cause) {
      // Offline or a hiccup: the order itself still saves the customer when it is sent.
      if (!auto) setSaveNote({ tone: "bad", text: cause instanceof Error ? cause.message : "The customer could not be saved." });
    }
  }

  const zip = kind === "delivery" ? deliveryZip(draft) : "";
  const outsideArea = kind === "delivery" && outsideDeliveryArea(zip, settings.delivery_postal_codes);
  const editing = draft.cart.length > 0;

  const tile = (value: OrderKind, icon: string, title: string, note: string, disabled = false) => (
    <button aria-pressed={kind === value} className={`flex min-h-[4.5rem] flex-col items-center justify-center rounded-2xl border-2 p-2 text-center transition active:scale-[0.98] disabled:opacity-40 ${kind === value ? "border-wayne-green bg-wayne-green text-white shadow-md" : "border-wayne-border bg-wayne-cream hover:border-wayne-green"}`} disabled={disabled} key={value} onClick={() => choose(value)} type="button">
      <span aria-hidden className="text-2xl leading-none">{icon}</span>
      <strong className="mt-1 text-xl font-black">{title}</strong>
      <span className={`text-xs font-bold ${kind === value ? "text-white/80" : "text-wayne-muted"}`}>{note}</span>
    </button>
  );

  /*
   * Delivery: the address step shows the whole time a delivery is being set
   * up — never only "while the street is empty" (owner, 2026-10-20: "as soon
   * as you press the first letter it closes it out").  That rule hid the step,
   * and the box being typed in, the moment one letter was typed.  It also means
   * Edit on a delivery ticket brings the address back to change it.
   */
  const needsStreet = kind === "delivery" && !draft.started && settings.delivery_enabled;

  return <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto bg-wayne-cream-deep p-2">
    <section aria-labelledby="start-order-title" className={`w-full min-w-0 rounded-3xl border border-wayne-border bg-white p-3 shadow-xl sm:px-5 sm:py-3 ${needsStreet ? "max-w-6xl" : "max-w-4xl"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black" id="start-order-title">{editing ? "Order details" : "New order"}</h1>
        </div>
        <Button onClick={() => start(true)} size="sm" variant="ghost">Jump to take order →</Button>
        {fromCall ? <div className="rounded-2xl border-2 border-wayne-green bg-wayne-green/5 px-4 py-2 text-right">
          <p className="text-[0.65rem] font-black uppercase tracking-[0.16em] text-wayne-green">Phone call{draft.phoneLine ? ` · Line ${draft.phoneLine}` : ""}</p>
          <p className="text-lg font-black">{formatPhone(draft.phone)}</p>
          {draft.callerName ? <p className="text-xs font-bold text-wayne-muted">Caller ID: {draft.callerName}</p> : null}
          {onOpenPhone ? <button className="min-h-9 text-xs font-bold underline" onClick={onOpenPhone} type="button">Back to phone lines</button> : null}
        </div> : null}
      </div>

      {/* Delivery: customer + type on the left, the address on the right, so the whole card fits on one screen (owner: no scrolling). */}
      <div className={needsStreet ? "grid min-w-0 gap-x-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : "min-w-0"}>
      <div className="min-w-0">
      <Step n={1} title="Customer details (optional)">
        {waitingCallers.length ? <div className="mb-2 grid gap-2 sm:grid-cols-2">
          {waitingCallers.map((call) => {
            const info = callerCardInfo(call);
            return <button className="min-h-14 rounded-xl border-2 border-wayne-ok bg-wayne-ok-soft p-2.5 text-left active:scale-[0.99]" key={call.key} onClick={() => takeCaller(call)} type="button">
              <span className="block text-xs font-black uppercase tracking-wider text-wayne-ok">☎ Line {call.line} — tap to use this caller</span>
              <strong className="block text-base">{info.name} · {info.phone}</strong>
              {info.address ? <span className="block truncate text-xs font-bold">{info.address}</span> : null}
            </button>;
          })}
        </div> : null}
        {draft.customer ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border-2 border-wayne-ok bg-wayne-ok-soft p-3">
          <div>
            <p className="text-sm font-black">✓ Returning customer — details are editable below</p>
            <p className="text-xs font-bold text-wayne-muted">{draft.customer.order_count} orders · {formatCents(draft.customer.lifetime_spend_cents)} lifetime{draft.customer.last_order_at ? ` · last ${new Date(draft.customer.last_order_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}</p>
          </div>
          <Button onClick={() => { update({ customer: null, addressId: "" }); setSearchField("phone"); }} size="sm" variant="secondary">Find someone else</Button>
        </div> : null}
        <>
          {/* Phone, names and email on one row (two rows beside a delivery address) so the card fits the screen with no scrolling (owner, 2026-10-21). */}
          <div className={`grid gap-2 sm:gap-3 ${needsStreet ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)]"}`}>
            <Input autoComplete="off" id="start-phone" inputMode="tel" label="Phone" onChange={(event) => editIdentity({ phone: event.target.value })} placeholder="(508) 555-0123" type="tel" value={draft.phone} />
            <Input autoComplete="off" id="start-first" label="First name" onChange={(event) => editIdentity({ firstName: event.target.value })} value={draft.firstName} />
            <Input autoComplete="off" id="start-last" label="Last name" onChange={(event) => editIdentity({ lastName: event.target.value })} value={draft.lastName} />
            <Input autoComplete="off" id="start-email" inputMode="email" label="Email (optional)" onChange={(event) => editIdentity({ email: event.target.value })} value={draft.email} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Button disabled={phoneDigits(draft.phone).length !== 10 || saveNote?.tone === "busy"} onClick={() => void saveCustomer(draft, kind, false)} size="sm" variant="secondary">💾 Save customer</Button>
            {saveNote ? <span aria-live="polite" className={`text-sm font-bold ${saveNote.tone === "ok" ? "text-wayne-ok" : saveNote.tone === "bad" ? "text-wayne-alert" : "text-wayne-muted"}`}>{saveNote.text}</span> : null}
          </div>
          <div aria-live="polite" className="mt-1 min-h-5">
            {search.busy && !matches.length ? <p className="text-sm font-bold text-wayne-muted">Looking…</p> : null}
            {search.error ? <p className="text-sm font-bold text-wayne-alert">{search.error}</p> : null}
            {!search.busy && !search.error && search.searched && !matches.length ? <p className="text-sm font-bold text-wayne-muted">{phoneDigits(draft.phone).length === 10 ? "New customer — they'll be saved with this order." : "No match. Add a phone to save their visit history, or continue without one."}</p> : null}
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
        </>
      </Step>

      <Step n={2} title="Order type">
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          {tile("walkin", "🚶", "Walk-in", "At the counter")}
          {tile("pickup", "🛍️", "Pickup", "Collecting the order")}
          {tile("delivery", "🚗", "Delivery", settings.delivery_enabled ? `+${formatCents(settings.delivery_fee_cents)} fee` : "Switched off", !settings.delivery_enabled)}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {!fromCall && kind !== "walkin" ? <div aria-label="How they ordered" className="inline-flex rounded-xl bg-wayne-cream p-1" role="group">
            {(["phone", "pos"] as const).map((source) => <button aria-pressed={shownSource === source} className={`min-h-10 rounded-lg px-3 text-sm font-black ${shownSource === source ? "bg-white text-wayne-ink shadow-sm" : "text-wayne-muted"}`} key={source} onClick={() => { setSourceTouched(true); update({ source }); }} type="button">{source === "phone" ? "📞 On the phone" : "🏪 In the store"}</button>)}
          </div> : null}
          <label className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border-2 px-3 ${draft.isTest ? "border-wayne-gold bg-wayne-gold/20" : "border-wayne-border bg-white"}`}>
            <input checked={draft.isTest} className="size-5 accent-wayne-green" onChange={(event) => update({ isTest: event.target.checked })} type="checkbox" />
            <span className="text-sm font-black">🧪 Test order</span>
          </label>
        </div>
      </Step>

      </div>
      {needsStreet ? <Step n={3} title="Delivery address">
        <AddressPicker address={draft.address} addressId={draft.addressId} customer={draft.customer} onAddress={(address) => update({ address, addressId: "" })} onAddressId={(addressId) => update({ addressId })}
          onPicked={(patch) => { setError(""); update(patch); }} />
        {outsideArea ? <p className="mt-2 rounded-xl bg-wayne-warn-soft p-2 text-sm font-bold">⚠ ZIP {zip} is outside the delivery area set in Admin → Settings. Check with the manager before sending a driver.</p> : null}
      </Step> : null}
      </div>

      {error ? <p className="mt-3 rounded-xl bg-wayne-alert-soft p-2.5 text-sm font-bold text-wayne-alert" role="alert">{error}</p> : null}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-wayne-border pt-3">
        <p className="max-w-md text-xs text-wayne-muted">Customer details are saved with the order. A phone number links their orders and visit history.</p>
        <Button onClick={() => start()} size="lg">{editing ? "Back to the order →" : "Continue to take order →"}</Button>
      </div>
    </section>
  </div>;
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return <div className="mt-3 min-w-0">
    <h2 className="mb-1.5 flex items-center gap-2 text-sm font-black uppercase tracking-[0.16em] text-wayne-muted"><span className="grid size-6 place-items-center rounded-full bg-wayne-green text-xs text-white">{n}</span>{title}</h2>
    {children}
  </div>;
}

function AddressPicker({ address, addressId, customer, onAddress, onAddressId, onPicked }: { address: DraftAddress; addressId: string; customer: PosCustomer | null; onAddress: (value: DraftAddress) => void; onAddressId: (value: string) => void; onPicked: (patch: Partial<PosDraft>) => void }) {
  const saved = customer?.addresses ?? [];
  return <div className="grid min-w-0 gap-2">
    {/* Saved addresses side by side (as many per row as fit), so the card stays on one screen. */}
    {saved.length ? <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(10rem, 1fr))" }}>
      {saved.map((candidate) => <button aria-pressed={addressId === candidate.id} className={`min-h-14 rounded-xl border-2 p-2.5 text-left ${addressId === candidate.id ? "border-wayne-green bg-wayne-green/5" : "border-wayne-border bg-white"}`} key={candidate.id} onClick={() => onPicked({ addressId: candidate.id, address: { address1: candidate.address1, address2: candidate.address2, city: candidate.city, state: candidate.state, postal_code: candidate.postal_code, delivery_instructions: candidate.delivery_instructions } })} type="button">
        <strong className="block">{candidate.address1}{candidate.address2 ? `, ${candidate.address2}` : ""}</strong>
        <span className="block text-sm">{candidate.city}, {candidate.state} {candidate.postal_code}</span>
        {candidate.delivery_instructions ? <span className="block truncate text-xs text-wayne-muted">{candidate.delivery_instructions}</span> : null}
      </button>)}
      <button aria-pressed={!addressId} className={`min-h-14 rounded-xl border-2 border-dashed p-2.5 text-left font-bold ${!addressId ? "border-wayne-green bg-wayne-green/5" : "border-wayne-border-strong bg-white"}`} onClick={() => onAddressId("")} type="button">＋ A different address</button>
    </div> : null}
    <div className="grid min-w-0 gap-2">
      {/* Wrapped: the address field spans two columns when it sits in a form grid, which here would split this list into two columns. */}
      <div className="pos-address min-w-0"><PosAddressInput id="start-address1" label="Street address" name="start-address1" onAddressSelect={(selected) => onPicked({ address: { ...address, ...selected }, addressId: "" })} onChange={(address1) => onAddress({ ...address, address1 })} placeholder="Start typing — pick it from the list" value={address.address1} /></div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_3.75rem_5.5rem] gap-2">
        <Input id="start-address2" label="Apt / unit" onChange={(event) => onAddress({ ...address, address2: event.target.value })} value={address.address2} />
        <Input id="start-city" label="City" onChange={(event) => onAddress({ ...address, city: event.target.value })} value={address.city} />
        <Input id="start-state" label="State" maxLength={2} onChange={(event) => onAddress({ ...address, state: event.target.value.toUpperCase() })} value={address.state} />
        <Input id="start-zip" inputMode="numeric" label="ZIP" maxLength={10} onChange={(event) => onAddress({ ...address, postal_code: event.target.value })} value={address.postal_code} />
      </div>
      <Input id="start-delivery-instructions" label="Delivery instructions (optional)" onChange={(event) => onAddress({ ...address, delivery_instructions: event.target.value })} placeholder="Side door, ring bell, 2nd floor…" value={address.delivery_instructions} />
    </div>
  </div>;
}
