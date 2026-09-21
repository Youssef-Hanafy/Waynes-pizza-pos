"use client";

import { FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/menu/schemas";
import { formatPhone } from "@/lib/phone/normalize";
import { posCustomerOrderSchema, posCustomerSchema, type PosCustomer, type PosCustomerOrder } from "@/lib/pos/schemas";
import { CustomerForm } from "./customer-form";

/**
 * The Customers section (§14): find a customer by phone, name, address, email
 * or order number; see their numbers, addresses and history; add a customer;
 * start an order for them.
 */
export function CustomersScreen({ focus, onStartOrder, timeZone }: { focus: PosCustomer | null; onStartOrder: (customer: PosCustomer) => void; timeZone: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PosCustomer[]>([]);
  const [selected, setSelected] = useState<PosCustomer | null>(focus);
  const [mode, setMode] = useState<"view" | "new" | "edit">("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function search(event: FormEvent) {
    event.preventDefault();
    if (query.trim().length < 2) { setError("Enter at least two characters."); return; }
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/pos/customers?q=${encodeURIComponent(query)}`, { cache: "no-store" });
      const parsed = posCustomerSchema.array().safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new Error("Customer search failed.");
      setResults(parsed.data);
      if (!parsed.data.length) setError("No customers match that search.");
    } catch (searchError) {
      setError(searchError instanceof TypeError ? "No connection. Try again when it is back." : searchError instanceof Error ? searchError.message : "Customer search failed.");
    } finally { setBusy(false); }
  }

  return <div className="grid min-h-0 flex-1 grid-cols-1 bg-wayne-cream-deep lg:grid-cols-[24rem_1fr]">
    <aside className="border-b border-wayne-border bg-white p-4 lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-r">
      <div className="flex items-center justify-between gap-2"><h1 className="text-2xl font-black">Customers</h1><Button onClick={() => { setMode("new"); setSelected(null); }} size="sm">New customer</Button></div>
      <form className="mt-4 flex gap-2" onSubmit={search}>
        <label className="sr-only" htmlFor="customer-search">Search customers</label>
        <input className="min-h-12 flex-1 rounded-xl border border-wayne-border px-3" id="customer-search" onChange={(event) => setQuery(event.target.value)} placeholder="Phone, name, address, email, order #" value={query} />
        <Button disabled={busy} type="submit">{busy ? "…" : "Find"}</Button>
      </form>
      {error ? <p className="mt-3 text-sm font-bold text-wayne-muted">{error}</p> : null}
      <ul className="mt-3 grid gap-2">{results.map((customer) => <li key={customer.id}><button className={`min-h-14 w-full rounded-xl border-2 p-3 text-left ${selected?.id === customer.id ? "border-wayne-green bg-wayne-green/5" : "border-wayne-border"}`} onClick={() => { setSelected(customer); setMode("view"); }} type="button"><strong>{customer.first_name} {customer.last_name}</strong><span className="block text-sm">{formatPhone(customer.phone)}</span><span className="block text-xs text-wayne-muted">{customer.order_count} orders · {formatCents(customer.lifetime_spend_cents)} lifetime</span></button></li>)}</ul>
    </aside>
    <section className="p-4 lg:min-h-0 lg:overflow-y-auto">
      {mode === "new" ? <div className="mx-auto max-w-2xl rounded-3xl bg-white p-5 shadow-sm"><h2 className="mb-4 text-2xl font-black">New customer</h2><CustomerForm onCancel={() => setMode("view")} onSaved={(customer) => { setSelected(customer); setResults((current) => [customer, ...current.filter((entry) => entry.id !== customer.id)]); setMode("view"); }} submitLabel="Save customer" /></div>
        : mode === "edit" && selected ? <div className="mx-auto max-w-2xl rounded-3xl bg-white p-5 shadow-sm"><h2 className="mb-4 text-2xl font-black">Edit {selected.first_name}</h2><CustomerForm customer={selected} onCancel={() => setMode("view")} onSaved={(customer) => { setSelected(customer); setResults((current) => current.map((entry) => (entry.id === customer.id ? customer : entry))); setMode("view"); }} submitLabel="Save changes" /></div>
        : selected ? <CustomerDetail customer={selected} onEdit={() => setMode("edit")} onStartOrder={onStartOrder} timeZone={timeZone} />
        : <p className="mx-auto mt-10 max-w-md text-center text-wayne-muted">Search for a customer, or add a new one.</p>}
    </section>
  </div>;
}

function CustomerDetail({ customer, onEdit, onStartOrder, timeZone }: { customer: PosCustomer; onEdit: () => void; onStartOrder: (customer: PosCustomer) => void; timeZone: string }) {
  const [orders, setOrders] = useState<PosCustomerOrder[] | null>(null);
  const [historyError, setHistoryError] = useState("");

  useEffect(() => {
    let active = true;
    fetch(`/api/pos/customers/${customer.id}/orders`, { cache: "no-store" })
      .then(async (response) => {
        const parsed = posCustomerOrderSchema.array().safeParse(await response.json());
        if (!active) return;
        if (response.ok && parsed.success) { setOrders(parsed.data); setHistoryError(""); }
        else setHistoryError("Order history is unavailable right now.");
      })
      .catch(() => { if (active) setHistoryError("Order history is unavailable right now."); });
    return () => { active = false; };
  }, [customer.id]);

  const date = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));

  return <div className="mx-auto grid max-w-4xl gap-4">
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-3xl bg-white p-5 shadow-sm">
      <div>
        <h2 className="text-3xl font-black">{customer.first_name} {customer.last_name}</h2>
        <p className="text-xl font-bold">{formatPhone(customer.phone)}</p>
        {customer.phones.map((extra) => <p className="text-sm text-wayne-muted" key={extra.phone}>{formatPhone(extra.phone)}{extra.label ? ` · ${extra.label}` : ""}</p>)}
        {customer.email ? <p className="text-sm">{customer.email}</p> : null}
      </div>
      <div className="flex flex-wrap gap-2"><Button onClick={() => onStartOrder(customer)} size="lg">Start order</Button><Button onClick={onEdit} size="lg" variant="secondary">Edit</Button></div>
    </div>
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {[["Orders", String(customer.order_count)], ["Lifetime", formatCents(customer.lifetime_spend_cents)], ["Average", formatCents(customer.average_order_value_cents)], ["Last order", customer.last_order_at ? date(customer.last_order_at) : "—"]].map(([label, value]) => <div className="rounded-2xl bg-white p-4 shadow-sm" key={label}><dt className="text-xs font-bold uppercase text-wayne-muted">{label}</dt><dd className="text-xl font-black">{value}</dd></div>)}
    </dl>
    <div className="rounded-3xl bg-white p-5 shadow-sm">
      <h3 className="text-sm font-black uppercase tracking-[0.14em] text-wayne-muted">Addresses</h3>
      {customer.addresses.length ? <ul className="mt-2 grid gap-2 sm:grid-cols-2">{customer.addresses.map((address) => <li className="rounded-xl border border-wayne-border p-3" key={address.id}><strong>{address.address1}{address.address2 ? `, ${address.address2}` : ""}</strong><span className="block text-sm">{address.city}, {address.state} {address.postal_code}</span>{address.delivery_instructions ? <span className="block text-sm text-wayne-muted">{address.delivery_instructions}</span> : null}{address.is_default ? <span className="mt-1 inline-block rounded bg-wayne-ok-soft px-1.5 text-xs font-bold text-wayne-ok">Default</span> : null}</li>)}</ul> : <p className="mt-2 text-sm text-wayne-muted">No address on file. Use Edit to add one.</p>}
      {customer.notes ? <p className="mt-3 text-sm"><strong>Notes:</strong> {customer.notes}</p> : null}
    </div>
    <div className="rounded-3xl bg-white p-5 shadow-sm">
      <h3 className="text-sm font-black uppercase tracking-[0.14em] text-wayne-muted">Order history</h3>
      {orders === null && !historyError ? <p className="mt-2 text-sm text-wayne-muted">Loading…</p> : null}
      {historyError ? <p className="mt-2 text-sm text-wayne-muted">{historyError}</p> : null}
      {orders?.length === 0 ? <p className="mt-2 text-sm text-wayne-muted">No orders yet.</p> : null}
      {orders?.length ? <ul className="mt-2 divide-y divide-wayne-border">{orders.map((order) => <li className="grid gap-1 py-2 sm:grid-cols-[8rem_7rem_1fr_6rem]" key={order.id}><span className="font-bold">{date(order.placed_at)}</span><span>{order.order_number}</span><span className="truncate text-sm text-wayne-muted">{order.source}{order.phone_line ? ` · Line ${order.phone_line}` : ""} · {order.fulfillment_type} · {order.items}</span><strong className="sm:text-right">{formatCents(order.total_cents)}</strong></li>)}</ul> : null}
    </div>
  </div>;
}
