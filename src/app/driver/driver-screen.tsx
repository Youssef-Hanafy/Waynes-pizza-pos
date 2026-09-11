"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  driverBoardSchema, driverStepLabels, formatAddress, minutesBetween, navigationUrl,
  nextDriverAction, parseCashInput, telephoneUrl,
  type DriverAssignment, type DriverBoard,
} from "@/lib/delivery/schemas";
import { formatCents } from "@/lib/menu/schemas";

type Props = { initialBoard: DriverBoard; initialError: string; staffName: string; canOpenAdmin: boolean; canOpenPos: boolean };

/**
 * One-thumb driver screen. Every delivery shows exactly one next action, the address
 * opens the phone's map app, and cash owed at the door must be recorded before the
 * delivery can be closed. Card-at-door is intentionally absent until Phase 11.
 */
export function DriverScreen({ initialBoard, initialError, staffName, canOpenAdmin, canOpenPos }: Props) {
  const [board, setBoard] = useState(initialBoard);
  const [error, setError] = useState(initialError);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [lastSynced, setLastSynced] = useState<number | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [cashOpen, setCashOpen] = useState<string | null>(null);
  const [cash, setCash] = useState("");
  const [note, setNote] = useState("");
  const busy = useRef(false);
  const mounted = useRef(true);
  const inFlight = useRef<Promise<void> | null>(null);
  const refreshAgain = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) { refreshAgain.current = true; return inFlight.current; }
    const run = async () => {
      do {
        refreshAgain.current = false;
        try {
          const response = await fetch("/api/driver", { cache: "no-store", signal: AbortSignal.timeout(8000) });
          if (!response.ok) throw new Error(response.status === 403 ? "Session expired or access changed. Sign in again." : "Connection interrupted. Showing the last saved deliveries.");
          const result = driverBoardSchema.parse(await response.json());
          if (mounted.current) { setBoard(result); setError(""); setLastSynced(Date.now()); }
        } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Unable to refresh deliveries."); }
      } while (mounted.current && refreshAgain.current);
    };
    inFlight.current = run();
    try { await inFlight.current; } finally { inFlight.current = null; }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(() => { void refresh(); }, 10_000);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    const offline = () => setError("No signal. Showing the last saved deliveries; actions are paused until you reconnect.");
    const online = () => { void refresh(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    void refresh();
    return () => {
      mounted.current = false;
      window.clearInterval(clock); window.clearInterval(poll);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [refresh]);

  async function send(orderId: string, body: Record<string, unknown>, success: string) {
    if (busy.current) return false;
    busy.current = true; setPending(orderId); setNotice("");
    try {
      const response = await fetch("/api/driver", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id: orderId, ...body }), signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error || "The delivery could not be updated."); }
      setNotice(success); setError("");
      await refresh();
      return true;
    } catch (cause) {
      await refresh();
      setError(cause instanceof Error ? cause.message : "Check the delivery before retrying.");
      return false;
    } finally { busy.current = false; setPending(null); }
  }

  async function completeDelivery(assignment: DriverAssignment) {
    const due = assignment.amount_due_cents;
    let cents = 0;
    if (due > 0) {
      const parsed = parseCashInput(cash);
      if (!parsed.ok) { setError(parsed.error); return; }
      cents = parsed.cents;
    }
    const saved = await send(assignment.order_id, { action: "delivered", cash_collected_cents: cents, note }, `${assignment.order_number} delivered.`);
    if (saved) { setCashOpen(null); setCash(""); setNote(""); }
  }

  const stale = lastSynced !== null && now !== null && now - lastSynced > 30_000;
  const active = board.assignments.filter((assignment) => assignment.assignment_status !== "delivered");
  const finished = board.assignments.filter((assignment) => assignment.assignment_status === "delivered");

  return <div className="min-h-screen bg-stone-100 pb-16">
    <header className="bg-wayne-ink px-5 py-4 text-white">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div><p className="text-sm font-bold text-amber-300">Wayne&apos;s Pizza</p><h1 className="text-3xl font-black">Deliveries</h1><p className="text-sm text-stone-300">{staffName}</p></div>
        <nav className="flex flex-wrap gap-2">
          {canOpenPos ? <Button asChild variant="secondary"><Link href="/pos">Front POS</Link></Button> : null}
          {canOpenAdmin ? <Button asChild variant="secondary"><Link href="/admin/delivery">Dispatch</Link></Button> : null}
          <Button asChild variant="secondary"><Link href="/login?next=%2Fdriver">Switch account</Link></Button>
        </nav>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
        <p role="status">{lastSynced && now ? `Refreshed ${Math.max(0, Math.floor((now - lastSynced) / 1000))}s ago` : "Loading deliveries…"}</p>
        <Button onClick={() => { void refresh(); }} variant="secondary">Refresh</Button>
      </div>
    </header>

    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      {error ? <div role="alert" className="mb-5 rounded-xl border border-red-400 bg-red-50 p-4 font-bold text-red-900">{error}</div> : null}
      {!error && stale ? <div role="status" className="mb-5 rounded-xl border border-amber-400 bg-amber-50 p-4 font-bold">Deliveries may be out of date. Reconnecting…</div> : null}
      {notice ? <div role="status" className="mb-5 rounded-xl border border-green-500 bg-green-50 p-4 font-bold text-green-900">{notice}</div> : null}

      <h2 className="text-2xl font-black">Your deliveries ({active.length})</h2>
      <div className="mt-4 grid gap-4">
        {active.map((assignment) => {
          const step = nextDriverAction(assignment.assignment_status, assignment.status);
          const address = formatAddress(assignment.address);
          const map = navigationUrl(assignment.address);
          const phone = telephoneUrl(assignment.customer_phone);
          const showCash = cashOpen === assignment.order_id;
          return <article className="overflow-hidden rounded-2xl border border-wayne-border bg-white shadow-sm" key={assignment.order_id}>
            <div className={`p-5 ${assignment.assignment_status === "picked_up" ? "bg-blue-100" : "bg-amber-100"}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-3xl font-black">{assignment.order_number}</h3>
                <strong className="rounded-full bg-white px-3 py-2 text-sm">{driverStepLabels[assignment.assignment_status]}</strong>
              </div>
              <p className="mt-2 text-xl font-black">{assignment.customer_name}</p>
              {phone ? <a className="mt-1 inline-block text-lg font-bold underline" href={phone}>{assignment.customer_phone}</a> : <p className="mt-1 text-lg font-bold">{assignment.customer_phone}</p>}
            </div>
            <div className="p-5">
              <p className="text-lg font-bold">{address || "No address on this order — call the store."}</p>
              {assignment.delivery_instructions ? <p className="mt-2 whitespace-pre-wrap rounded-lg border border-amber-300 bg-amber-50 p-3 font-bold">Door note: {assignment.delivery_instructions}</p> : null}
              {assignment.order_instructions ? <p className="mt-2 whitespace-pre-wrap rounded-lg border border-wayne-border bg-stone-50 p-3">Order note: {assignment.order_instructions}</p> : null}

              <dl className="mt-4 grid grid-cols-2 gap-3">
                <div><dt className="text-sm font-bold text-wayne-muted">Order total</dt><dd className="text-xl font-black">{formatCents(assignment.total_cents)}</dd></div>
                <div><dt className="text-sm font-bold text-wayne-muted">Collect at the door</dt><dd className={`text-xl font-black ${assignment.amount_due_cents > 0 ? "text-wayne-red" : "text-green-700"}`}>{assignment.amount_due_cents > 0 ? `${formatCents(assignment.amount_due_cents)} cash` : "Nothing — already paid"}</dd></div>
              </dl>
              {assignment.items.length ? <ul className="mt-4 divide-y divide-wayne-border text-sm">{assignment.items.map((item, index) => <li className="py-2 font-bold" key={`${assignment.order_id}-${index}`}>{item.quantity}× {item.name}{item.variant ? ` · ${item.variant}` : ""}</li>)}</ul> : null}
              <p className="mt-3 text-sm text-wayne-muted">Kitchen status: <span className="capitalize">{assignment.status.replaceAll("_", " ")}</span>{assignment.picked_up_at && now ? ` · picked up ${minutesBetween(assignment.picked_up_at, new Date(now).toISOString())} min ago` : ""}</p>

              {map ? <Button asChild className="mt-4 min-h-14 w-full text-lg" variant="secondary"><a href={map} rel="noreferrer" target="_blank">Open navigation</a></Button> : null}

              {step && !showCash ? <Button
                className="mt-3 min-h-14 w-full text-lg"
                disabled={pending !== null || !step.ready || Boolean(error)}
                onClick={() => { if (step.action === "delivered") { setCashOpen(assignment.order_id); setCash(assignment.amount_due_cents > 0 ? (assignment.amount_due_cents / 100).toFixed(2) : "0"); setNote(""); } else { void send(assignment.order_id, { action: step.action }, `${assignment.order_number} ${step.action === "accept" ? "accepted" : "picked up"}.`); } }}
              >{pending === assignment.order_id ? "Saving…" : step.label}</Button> : null}
              {step && !step.ready ? <p className="mt-2 text-sm font-bold text-wayne-muted">Waiting for the kitchen to mark this order ready.</p> : null}

              {showCash ? <div className="mt-4 rounded-xl border border-wayne-border bg-stone-50 p-4">
                <h4 className="text-lg font-black">Close out {assignment.order_number}</h4>
                <p className="mt-1 text-sm text-wayne-muted">{assignment.amount_due_cents > 0 ? `Cash owed at the door: ${formatCents(assignment.amount_due_cents)}. Card payment at the door is not available yet.` : "This order is already paid. Do not collect cash."}</p>
                {assignment.amount_due_cents > 0 ? <label className="mt-3 grid gap-2 text-sm font-bold">Cash collected
                  <input className="min-h-14 rounded-lg border border-wayne-border bg-white px-4 text-xl font-black" inputMode="decimal" onChange={(event) => setCash(event.target.value)} value={cash} />
                </label> : null}
                <label className="mt-3 grid gap-2 text-sm font-bold">Note (optional)
                  <input className="min-h-12 rounded-lg border border-wayne-border bg-white px-4" maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="Left with the customer" value={note} />
                </label>
                <div className="mt-4 flex flex-wrap gap-3">
                  <Button className="min-h-14 flex-1 text-lg" disabled={pending !== null} onClick={() => { void completeDelivery(assignment); }}>{pending === assignment.order_id ? "Saving…" : "Confirm delivered"}</Button>
                  <Button className="min-h-14" disabled={pending !== null} onClick={() => { setCashOpen(null); setError(""); }} variant="secondary">Cancel</Button>
                </div>
              </div> : null}
            </div>
          </article>;
        })}
        {!active.length ? <div className="rounded-2xl border border-dashed border-wayne-border bg-white p-10 text-center"><h3 className="text-xl font-black">No deliveries assigned to you</h3><p className="mt-2 text-wayne-muted">New assignments appear here automatically.</p></div> : null}
      </div>

      {board.available.length ? <section className="mt-10">
        <h2 className="text-2xl font-black">Ready and unassigned ({board.available.length})</h2>
        <p className="mt-1 text-sm text-wayne-muted">Take one and the full address and phone number appear above.</p>
        <div className="mt-4 grid gap-3">
          {board.available.map((order) => <article className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-wayne-border bg-white p-5 shadow-sm" key={order.order_id}>
            <div><h3 className="text-2xl font-black">{order.order_number}</h3><p className="font-bold">{order.customer_name}</p><p className="text-sm text-wayne-muted">{[order.city, order.postal_code].filter(Boolean).join(" ")} · {order.amount_due_cents > 0 ? `${formatCents(order.amount_due_cents)} cash due` : "Already paid"}</p></div>
            <Button className="min-h-14" disabled={pending !== null || Boolean(error)} onClick={() => { void send(order.order_id, { action: "claim" }, `${order.order_number} is yours.`); }}>{pending === order.order_id ? "Saving…" : "Take this delivery"}</Button>
          </article>)}
        </div>
      </section> : null}

      {finished.length ? <section className="mt-10">
        <h2 className="text-2xl font-black">Delivered in the last few hours</h2>
        <div className="mt-4 grid gap-3">
          {finished.map((assignment) => <article className="rounded-2xl border border-wayne-border bg-white p-5" key={assignment.order_id}>
            <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-xl font-black">{assignment.order_number}</h3><strong className="text-green-800">Delivered</strong></div>
            <p className="mt-1 text-sm text-wayne-muted">{assignment.customer_name} · cash collected {formatCents(assignment.cash_collected_cents)} of {formatCents(assignment.amount_due_cents)}{assignment.delivery_note ? ` · ${assignment.delivery_note}` : ""}</p>
          </article>)}
        </div>
      </section> : null}
    </main>
  </div>;
}
