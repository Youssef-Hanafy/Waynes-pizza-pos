"use client";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { fetchPrintDocument } from "@/hardware/printers/provider";
import type { PrintDocument } from "@/lib/printing/document";
import { changeFulfillmentSchema, fulfillmentChangedSchema, type FulfillmentChanged } from "@/lib/orders/fulfillment";
import { formatCents } from "@/lib/menu/schemas";
import { uuid } from "@/lib/uuid";

type Address = NonNullable<PrintDocument["order"]["delivery_address"]>;
const emptyAddress: Address = { address1: "", address2: "", city: "", state: "MA", postal_code: "", delivery_instructions: "" };

/** Edits the server order, including the address, rather than just its badge. */
export function FulfillmentEditor({ orderId, onChanged }: { orderId: string; onChanged: (result: FulfillmentChanged) => void }) {
  const [open, setOpen] = useState(false);
  const [order, setOrder] = useState<PrintDocument["order"] | null>(null);
  const [type, setType] = useState<"pickup" | "delivery">("pickup");
  const [address, setAddress] = useState<Address>(emptyAddress);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [refundCash, setRefundCash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const pending = useRef<{ fingerprint: string; key: string } | null>(null);
  async function show() {
    setOpen(true); setRefundCash(false); setOrder(null); setError(""); setBusy(true);
    try {
      const current = (await fetchPrintDocument(orderId)).order;
      setOrder(current); setType(current.fulfillment_type === "delivery" ? "delivery" : "pickup");
      setAddress(current.delivery_address ?? emptyAddress); setName(current.customer_name); setPhone(current.customer_phone);
      pending.current = null;
    } catch { setError("The order could not be loaded. Close this box and try again."); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!order || busy) return;
    let shiftId: string | null = null;
    if (refundCash) {
      try {
        const response = await fetch("/api/pos/drawer", { cache: "no-store" });
        const drawer = await response.json();
        if (!response.ok || !drawer.shift?.id) throw new Error("Open your cash drawer before returning the fee.");
        shiftId = drawer.shift.id;
      } catch { setError("Open your cash drawer before returning the fee."); return; }
    }
    const body = { refund_cash: refundCash, refund_shift_id: shiftId, fulfillment_type: type, expected_fulfillment_type: order.fulfillment_type, expected_total_cents: order.total_cents,
      customer_name: name, customer_phone: phone, delivery_address: type === "delivery" ? address : null };
    const fingerprint = JSON.stringify(body);
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, key: uuid() };
    const input = changeFulfillmentSchema.safeParse({ ...body, idempotency_key: pending.current.key });
    if (!input.success) { setError(input.error.issues[0]?.message ?? "Check the delivery details."); return; }
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/pos/orders/${orderId}/fulfillment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.data), signal: AbortSignal.timeout(15_000) });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result && typeof result === "object" && "error" in result ? String(result.error) : "The order could not be changed.");
      const changed = fulfillmentChangedSchema.parse(result);
      onChanged(changed); setOpen(false); setSaved(`Saved as ${changed.fulfillment_type}. ${changed.payment_status === "unpaid" ? "Check Payments for the amount still owed." : "Payment is up to date."}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The change could not be confirmed. Tap Save again to check the same request."); }
    finally { setBusy(false); }
  }
  return <>
    <Button onClick={() => { void show(); }} size="sm" variant="secondary">Pickup / delivery</Button>
    {saved ? <p role="status" className="text-sm font-bold text-wayne-green">{saved}</p> : null}
    {open ? <div aria-label="Change pickup or delivery" aria-modal="true" role="dialog" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3">
      <form onSubmit={event => { event.preventDefault(); void save(); }} className="max-h-full w-full max-w-xl overflow-y-auto rounded-3xl bg-white p-5 shadow-xl">
        <h2 className="text-2xl font-black">Pickup or delivery</h2>
        {order ? <>
          <div className="mt-4 grid grid-cols-2 gap-3">{(["pickup", "delivery"] as const).map(value => <button type="button" key={value} disabled={busy} aria-pressed={type === value} onClick={() => setType(value)} className={`min-h-14 rounded-xl border-2 text-xl font-black ${type === value ? "border-wayne-green bg-wayne-green text-white" : "border-wayne-border"}`}>{value === "pickup" ? "Pickup" : "Delivery"}</button>)}</div>
          <p className="mt-3 text-sm font-bold text-wayne-muted">{"The delivery fee is added for delivery and removed for pickup. An extra fee goes to Take payment. A prepaid fee must be refunded before it is removed."}</p>
          {type === "pickup" && order.fulfillment_type === "delivery" && order.delivery_fee_cents > 0 && order.payment_method !== "cash" && ["paid", "authorized", "partially_refunded"].includes(order.payment_status) ? <a className="mt-3 block min-h-11 rounded-xl border-2 border-wayne-green p-3 font-black text-wayne-green" href={`/admin/orders/${orderId}?refund_amount=${(order.delivery_fee_cents / 100).toFixed(2)}&refund_reason=Delivery%20fee%20-%20changed%20to%20pickup`} target="_blank" rel="noreferrer">Refund delivery fee · {formatCents(order.delivery_fee_cents)} / manage card approval</a> : null}
          {type === "pickup" && order.fulfillment_type === "delivery" && order.delivery_fee_cents > 0 && order.payment_method === "cash" && order.payment_status === "paid" ? <label className="mt-3 flex min-h-12 items-center gap-3 font-bold"><input type="checkbox" checked={refundCash} onChange={e => setRefundCash(e.target.checked)} />I returned the delivery fee to the customer in cash. Record it on my open drawer.</label> : null}
          {type === "delivery" ? <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="font-bold">Customer name<input required className="mt-1 min-h-12 w-full rounded-xl border px-3" value={name} onChange={e => setName(e.target.value)} /></label>
            <label className="font-bold">Phone<input required type="tel" className="mt-1 min-h-12 w-full rounded-xl border px-3" value={phone} onChange={e => setPhone(e.target.value)} /></label>
            {([['address1','Street address'],['address2','Apartment / unit'],['city','City'],['state','State'],['postal_code','ZIP code'],['delivery_instructions','Delivery instructions']] as const).map(([field,label]) => <label className="font-bold" key={field}>{label}<input required={['address1','city','state'].includes(field)} className="mt-1 min-h-12 w-full rounded-xl border px-3" value={address[field]} onChange={e => setAddress(current => ({ ...current, [field]: e.target.value }))} /></label>)}
          </div> : null}
        </> : <p className="mt-4">{busy ? "Loading the order…" : "Order details are unavailable."}</p>}
        {error ? <p role="alert" className="mt-3 font-bold text-wayne-alert">{error}</p> : null}
        <div className="mt-5 grid grid-cols-2 gap-3"><Button type="button" disabled={busy} variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={busy || !order}>{busy ? "Saving…" : "Save order type"}</Button></div>
      </form>
    </div> : null}
  </>;
}
