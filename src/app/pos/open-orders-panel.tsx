"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/menu/schemas";
import { nextHandOff, openOrderSchema, type OpenOrder } from "@/lib/orders/status";
import { z } from "zod";

const terminalSchema = z.object({ id: z.uuid(), label: z.string() });
type Terminal = z.infer<typeof terminalSchema>;

const labels: Record<string, string> = { placed: "New", accepted: "Accepted", in_kitchen: "Cooking", ready: "Ready", out_for_delivery: "Out for delivery" };

/** Counter view of today's open orders so staff can hand food off and close tickets. */
export function OpenOrdersPanel({ timeZone }: { timeZone: string }) {
  const [open, setOpen] = useState(false);
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [terminalId, setTerminalId] = useState("");
  const [charging, setCharging] = useState<string | null>(null);
  const [chargeNote, setChargeNote] = useState("");
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/pos/open-orders", { cache: "no-store", signal: AbortSignal.timeout(8000) });
      const body: unknown = await response.json();
      const parsed = openOrderSchema.array().safeParse(body);
      if (!response.ok || !parsed.success) throw new Error(body && typeof body === "object" && "error" in body ? String(body.error) : "Open orders are unavailable.");
      if (mounted.current) { setOrders(parsed.data); setError(""); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Open orders are unavailable."); }
  }, []);

  useEffect(() => {
    // Readers are only listed when the owner has switched reader payment on.
    fetch("/api/pos/terminal", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : []))
      .then((body: unknown) => {
        const parsed = terminalSchema.array().safeParse(body);
        if (mounted.current && parsed.success) {
          setTerminals(parsed.data);
          setTerminalId((current) => current || (parsed.data[0]?.id ?? ""));
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const first = window.setTimeout(() => { void load(); }, 0);
    const timer = window.setInterval(() => { void load(); }, 10_000);
    return () => { mounted.current = false; window.clearTimeout(first); window.clearInterval(timer); };
  }, [load]);

  async function move(order: OpenOrder, nextStatus: "completed" | "out_for_delivery") {
    if (pending) return;
    setPending(order.id); setError("");
    try {
      const response = await fetch("/api/orders/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order_id: order.id, expected_status: order.status, next_status: nextStatus }), signal: AbortSignal.timeout(10000) });
      if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || "The order could not be updated."); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The order could not be updated."); }
    finally { setPending(null); await load(); }
  }

  /** Ask the reader for the card, then poll until it answers. */
  async function chargeCard(order: OpenOrder) {
    if (charging || !terminalId) return;
    setCharging(order.id); setError(""); setChargeNote("Sending the total to the reader…");
    const idempotencyKey = `pos-terminal-${order.id}-${Date.now()}`;
    try {
      const start = await fetch("/api/pos/terminal", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id: order.id, terminal_id: terminalId, idempotency_key: idempotencyKey, action: "start" }),
        signal: AbortSignal.timeout(20_000),
      });
      const startBody = await start.json().catch(() => ({}));
      if (!start.ok) throw new Error(startBody.error || "The card reader could not be reached.");
      setChargeNote("Waiting for the customer to tap, dip or swipe…");

      const deadline = Date.now() + 5 * 60_000;
      while (mounted.current && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const poll = await fetch("/api/pos/terminal", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order_id: order.id, terminal_id: terminalId, idempotency_key: idempotencyKey, action: "status" }),
          signal: AbortSignal.timeout(15_000),
        });
        const body = await poll.json().catch(() => ({}));
        if (!poll.ok) throw new Error(body.error || "The card reader could not be reached.");
        if (body.state === "captured") { setChargeNote("Card payment taken."); await load(); return; }
        if (body.state === "voided") { setChargeNote(""); throw new Error("The customer cancelled at the reader."); }
        if (body.state === "failed") { setChargeNote(""); throw new Error("The card was declined at the reader."); }
      }
      setChargeNote("");
      throw new Error("The reader did not answer in time. Check it before charging again.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The card reader could not be reached.");
      setChargeNote("");
      await load();
    } finally {
      if (mounted.current) setCharging(null);
    }
  }

  async function cancelCharge(order: OpenOrder) {
    try {
      await fetch("/api/pos/terminal", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id: order.id, terminal_id: terminalId, idempotency_key: `pos-terminal-cancel-${order.id}-${Date.now()}`, action: "cancel" }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch { /* the poll loop reports whatever the reader ends up saying */ }
  }

  const readyCount = orders.filter((order) => order.status === "ready").length;
  const time = (value: string) => new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(value));

  return <>
    <Button onClick={() => setOpen(true)} variant="secondary">Open orders ({orders.length}){readyCount ? ` · ${readyCount} ready` : ""}</Button>
    {open ? <div aria-modal="true" className="fixed inset-0 z-50 flex justify-end bg-black/50" role="dialog" aria-label="Open orders">
      <section className="h-full w-full max-w-xl overflow-y-auto bg-white p-5 text-wayne-ink shadow-2xl">
        <div className="flex items-center justify-between gap-3"><div><h2 className="text-2xl font-black">Open orders</h2><p className="text-sm text-wayne-muted">Today&apos;s tickets that are not yet picked up or delivered. Updates every 10 seconds.</p></div><Button onClick={() => setOpen(false)} variant="secondary">Close</Button></div>
        {error ? <p className="mt-4 rounded-xl bg-red-50 p-3 text-sm font-bold text-red-800" role="alert">{error}</p> : null}
        {terminals.length > 1 ? <label className="mt-4 grid gap-2 text-sm font-bold">Card reader
          <select className="min-h-11 rounded-lg border border-wayne-border bg-white px-3" onChange={(event) => setTerminalId(event.target.value)} value={terminalId}>
            {terminals.map((terminal) => <option key={terminal.id} value={terminal.id}>{terminal.label}</option>)}
          </select>
        </label> : null}
        <ul className="mt-5 grid gap-3">{orders.map((order) => {
          const handOff = nextHandOff(order.status, order.fulfillment_type);
          return <li className={`rounded-xl border p-4 ${order.status === "ready" ? "border-green-300 bg-green-50" : "border-wayne-border"}`} key={order.id}>
            <div className="flex flex-wrap items-start justify-between gap-3"><div><strong className="text-xl">{order.order_number}</strong><p className="font-bold">{order.customer_name}</p><p className="text-sm capitalize text-wayne-muted">{order.fulfillment_type} · {order.source} · placed {time(order.placed_at)}{order.promised_at ? ` · promised ${time(order.promised_at)}` : ""}</p></div><div className="text-right"><span className="rounded-full bg-white px-3 py-1 text-sm font-black">{labels[order.status] ?? order.status}</span><p className="mt-2 font-black">{formatCents(order.total_cents)}</p><p className="text-xs capitalize text-wayne-muted">{order.payment_method.replace("_", " ")} · {order.payment_status}</p></div></div>
            <div className="mt-3 flex flex-wrap items-center gap-2">{handOff ? <Button disabled={pending !== null} onClick={() => { void move(order, handOff.status); }}>{pending === order.id ? "Saving…" : handOff.label}</Button> : <Button disabled={pending !== null} onClick={() => { void move(order, "completed"); }} variant="secondary">{pending === order.id ? "Saving…" : "Complete now (skip kitchen)"}</Button>}
              {terminals.length && order.payment_status === "unpaid" ? (charging === order.id
                ? <><span className="text-sm font-bold">{chargeNote || "Charging…"}</span><Button onClick={() => { void cancelCharge(order); }} variant="secondary">Cancel on reader</Button></>
                : <Button disabled={charging !== null} onClick={() => { void chargeCard(order); }} variant="secondary">Take card payment</Button>) : null}
            </div>
          </li>;
        })}</ul>
        {!orders.length && !error ? <p className="mt-6 rounded-xl border border-dashed border-wayne-border p-8 text-center text-wayne-muted">No open orders right now.</p> : null}
        <p className="mt-6 text-xs text-wayne-muted">Cancelling an order needs a manager: open it in Admin → Orders and use Cancel with a reason.</p>
      </section>
    </div> : null}
  </>;
}
