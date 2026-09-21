"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/menu/schemas";
import { formatPhone } from "@/lib/phone/normalize";
import { callOnLine, matchOutcome, type PhoneCallView } from "@/lib/phone/phone-state";
import type { RecentCall } from "@/lib/phone/schemas";
import { posCustomerOrderSchema, type PosCustomer, type PosCustomerOrder } from "@/lib/pos/schemas";
import { phoneActions, usePhoneState } from "@/stores/phone-store";
import { CustomerForm } from "./customer-form";
import { SimulatorPanel } from "./simulator-panel";

export type StartPhoneOrder = (call: PhoneCallView, customer: PosCustomer | null, options?: { withoutProfile?: boolean; force?: boolean }) => Promise<{ ok: true } | { ok: false; message: string; claimed?: boolean }>;

type Props = {
  profileId: string;
  timeZone: string;
  simulatorAvailable: boolean;
  onStartOrder: StartPhoneOrder;
  onOpenCustomer: (customer: PosCustomer) => void;
};

function useClock(intervalMs = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function since(iso: string, now: number) {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

function callerTitle(call: PhoneCallView) {
  const outcome = matchOutcome(call);
  if (outcome === "existing") return `${call.matches[0]!.first_name} ${call.matches[0]!.last_name}`;
  if (outcome === "choose") return `${call.matches.length} customers use this number`;
  if (outcome === "looking_up") return call.callerName || "Looking up customer…";
  return call.lookup === "failed" ? (call.callerName || "Caller") : "New caller";
}

/**
 * The Phone section (§7, §8, §35).  One card per physical line, never merged
 * (§16).  Opening a line claims it for this register (§22); the detail shows
 * the customer, or the new-caller choices, and starts the order (§9).
 */
export function PhoneScreen({ profileId, timeZone, simulatorAvailable, onStartOrder, onOpenCustomer }: Props) {
  const state = usePhoneState();
  const now = useClock();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const openCall = openKey ? state.calls[openKey] ?? null : null;

  async function openLine(call: PhoneCallView) {
    setOpenKey(call.key);
    if (call.status === "incoming") await phoneActions.selectCall(call.key);
  }

  return <div className="min-h-0 flex-1 overflow-y-auto bg-wayne-cream-deep p-3 sm:p-4">
    {openCall ? <LineDetail call={openCall} onBack={() => setOpenKey(null)} onOpenCustomer={onOpenCustomer} onStartOrder={onStartOrder} profileId={profileId} /> : <>
      <h1 className="text-sm font-black uppercase tracking-[0.18em] text-wayne-muted">Active</h1>
      <div className="mt-2 grid gap-3 md:grid-cols-2">
        {state.lines.map((line) => {
          const call = callOnLine(state, line.line);
          return <LineCard call={call} key={line.line} label={line.label} line={line.line} now={now} onOpen={openLine} profileId={profileId} />;
        })}
      </div>
      <RecentCalls now={now} recent={state.recent} timeZone={timeZone} />
      {simulatorAvailable ? <details className="mt-6 rounded-2xl border border-dashed border-wayne-border-strong bg-white p-3"><summary className="min-h-11 cursor-pointer content-center text-sm font-black uppercase tracking-[0.14em] text-wayne-muted">Test calls (simulator)</summary><div className="mt-3"><SimulatorPanel lineCount={state.lines.length} /></div></details> : null}
    </>}
  </div>;
}

function statusChip(call: PhoneCallView | null, profileId: string) {
  if (!call) return { text: "Available", tone: "bg-wayne-cream text-wayne-muted", dot: "○" };
  const mine = call.claimedById === profileId;
  if (call.status === "order_started") return { text: mine ? "Taking order — you" : `Taking order — ${call.claimedTerminal || "another register"}`, tone: "bg-wayne-green text-white", dot: "●" };
  if (call.status === "selected") return { text: mine ? "Open on this register" : `Answered — ${call.claimedTerminal || "another register"}`, tone: "bg-wayne-warn-soft text-wayne-ink", dot: "●" };
  return { text: "Incoming", tone: "bg-wayne-ok text-white", dot: "●" };
}

function LineCard({ call, label, line, now, onOpen, profileId }: { call: PhoneCallView | null; label: string; line: number; now: number; onOpen: (call: PhoneCallView) => void; profileId: string }) {
  const chip = statusChip(call, profileId);
  const ringing = call?.status === "incoming";
  return <section aria-label={label} className={`flex min-h-56 flex-col rounded-2xl border-2 bg-white p-4 shadow-sm ${ringing ? "border-wayne-ok ring-4 ring-wayne-ok/25" : call ? "border-wayne-green" : "border-wayne-border"}`}>
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-xl font-black uppercase tracking-[0.1em]">{label}</h2>
      <span className={`rounded-full px-3 py-1 text-xs font-black uppercase tracking-wider ${chip.tone}`}>{chip.dot} {chip.text}</span>
    </div>
    {call ? <>
      <p className="mt-4 text-2xl font-black leading-tight">{callerTitle(call)}</p>
      <p className="text-xl font-bold">{formatPhone(call.phoneNumber)}</p>
      <p className="mt-2 text-sm font-bold text-wayne-muted">
        {matchOutcome(call) === "existing" ? `Existing customer · ${call.matches[0]!.order_count} orders` : matchOutcome(call) === "choose" ? "Choose the right customer" : matchOutcome(call) === "new_caller" ? "No customer found" : call.lookup === "failed" ? "Could not look up — you can still take the order" : "Looking up…"}
        {" · "}{since(call.surfacedAt, now)}
        {call.endedAt ? " · call ended" : ""}
        {call.simulated ? " · TEST" : ""}
      </p>
      {call.syncError ? <p className="mt-1 text-xs font-bold text-wayne-alert">Not synced: {call.syncError}</p> : null}
      <Button className="mt-auto w-full text-lg" onClick={() => onOpen(call)} size="lg" variant={ringing ? "primary" : "brand"}>Open {label}</Button>
    </> : <p className="mt-6 text-lg text-wayne-muted">No active caller</p>}
    {!call ? <span className="sr-only">Line {line} is free</span> : null}
  </section>;
}

function LineDetail({ call, onBack, onOpenCustomer, onStartOrder, profileId }: { call: PhoneCallView; onBack: () => void; onOpenCustomer: (customer: PosCustomer) => void; onStartOrder: StartPhoneOrder; profileId: string }) {
  const outcome = matchOutcome(call);
  const [chosenId, setChosenId] = useState<string | null>(outcome === "existing" ? call.matches[0]!.id : null);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState("");
  const [claimedMessage, setClaimedMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const chosen = call.matches.find((match) => match.id === chosenId) ?? (outcome === "existing" ? call.matches[0]! : null);
  const heldElsewhere = Boolean(call.claimedById && call.claimedById !== profileId && (call.status === "selected" || call.status === "order_started"));
  const closed = !["incoming", "selected", "order_started"].includes(call.status);

  async function start(customer: PosCustomer | null, withoutProfile = false, force = false) {
    setBusy(true); setMessage(""); setClaimedMessage("");
    const result = await onStartOrder(call, customer, { withoutProfile, force });
    setBusy(false);
    if (!result.ok) (result.claimed ? setClaimedMessage : setMessage)(result.message);
  }

  async function dismiss(force = false) {
    setBusy(true);
    const result = await phoneActions.dismissCall(call.key, force);
    setBusy(false);
    if (!result.ok && result.reason === "claimed") { setClaimedMessage(result.message); return; }
    if (!result.ok) { setMessage(result.message); return; }
    onBack();
  }

  async function back() {
    // Stepping back without starting an order hands the call back to the line.
    if (call.status === "selected" && call.claimedById === profileId) await phoneActions.releaseCall(call.key);
    onBack();
  }

  return <section className="mx-auto max-w-3xl rounded-3xl border-2 border-wayne-green bg-white p-5 shadow-lg">
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-green">Line {call.line}{call.simulated ? " · Test call" : ""}</p>
        <h1 className="mt-1 text-3xl font-black leading-tight">{outcome === "existing" || chosen ? `${chosen!.first_name} ${chosen!.last_name}` : outcome === "choose" ? "Which customer is calling?" : outcome === "looking_up" ? "Looking up customer…" : "New caller"}</h1>
        <p className="text-2xl font-bold">{formatPhone(call.phoneNumber)}</p>
        {call.callerName ? <p className="text-sm text-wayne-muted">Caller ID name: {call.callerName} (not always the customer&apos;s name)</p> : null}
      </div>
      <Button onClick={() => void back()} variant="secondary">Back</Button>
    </div>

    {heldElsewhere ? <div className="mt-4 rounded-2xl bg-wayne-warn-soft p-4" role="status"><p className="text-lg font-black uppercase">Taking order — {call.claimedTerminal || "another register"}</p><p className="text-sm font-bold">{call.claimedByName ? `${call.claimedByName} has this call.` : "Someone else has this call."} Only take it over if they have stopped.</p></div> : null}
    {claimedMessage ? <div className="mt-4 rounded-2xl bg-wayne-warn-soft p-4" role="alert"><p className="font-bold">{claimedMessage}</p><Button className="mt-3" disabled={busy} onClick={() => void start(chosen, false, true)} variant="secondary">Take over this call</Button></div> : null}
    {closed ? <p className="mt-4 rounded-2xl bg-wayne-cream p-4 font-bold">This call is {call.status === "completed" ? `finished${call.orderNumber ? ` — order ${call.orderNumber}` : ""}` : call.status}.</p> : null}

    {outcome === "choose" && !chosen ? <div className="mt-5 grid gap-2">
      <p className="text-sm font-bold text-wayne-muted">This number belongs to more than one customer. Ask who is calling.</p>
      {call.matches.map((match) => <button className="min-h-16 rounded-2xl border-2 border-wayne-border p-4 text-left hover:border-wayne-green" key={match.id} onClick={() => setChosenId(match.id)} type="button"><strong className="text-lg">{match.first_name} {match.last_name}</strong><p className="text-sm text-wayne-muted">{match.order_count} orders{match.addresses[0] ? ` · ${match.addresses[0].address1}` : ""}</p></button>)}
      <Button onClick={() => setCreating(true)} variant="secondary">Someone else — new customer</Button>
    </div> : null}

    {chosen && !creating ? <CustomerSummary customer={chosen} /> : null}
    {chosen && outcome === "choose" ? <button className="mt-2 min-h-11 text-sm font-bold underline" onClick={() => setChosenId(null)} type="button">Choose a different customer</button> : null}

    {(outcome === "new_caller" || call.lookup === "failed") && !creating ? <p className="mt-5 rounded-2xl bg-wayne-cream p-4 text-lg font-bold">{call.lookup === "failed" ? "The customer lookup could not finish. You can still take the order." : "No customer found for this number."}</p> : null}

    {creating ? <div className="mt-5"><h2 className="mb-3 text-xl font-black">New customer</h2><CustomerForm initialPhone={call.phoneNumber} onCancel={() => setCreating(false)} onSaved={(customer) => void start(customer)} submitLabel="Create customer + start order" /></div> : null}

    {message ? <p aria-live="polite" className="mt-4 rounded-xl bg-wayne-alert-soft p-3 font-bold text-wayne-alert">{message}</p> : null}

    {!creating && !closed ? <div className="mt-6 grid gap-2 sm:grid-cols-2">
      {chosen ? <>
        <Button className="text-lg sm:col-span-2" disabled={busy || (heldElsewhere && !claimedMessage)} onClick={() => void start(chosen)} size="lg">{call.status === "order_started" && call.claimedById === profileId ? "Resume phone order" : "Start phone order"}</Button>
        <Button onClick={() => onOpenCustomer(chosen)} size="lg" variant="secondary">Order history &amp; details</Button>
      </> : outcome !== "choose" && outcome !== "looking_up" ? <>
        <Button className="text-lg sm:col-span-2" disabled={busy} onClick={() => setCreating(true)} size="lg">Create customer + start order</Button>
        <Button disabled={busy} onClick={() => void start(null, true)} size="lg" variant="secondary">Start order without profile</Button>
      </> : null}
      <Button disabled={busy} onClick={() => void dismiss(heldElsewhere && Boolean(claimedMessage))} size="lg" variant="ghost">Dismiss</Button>
    </div> : null}
  </section>;
}

function CustomerSummary({ customer }: { customer: PosCustomer }) {
  const address = customer.addresses.find((candidate) => candidate.is_default) ?? customer.addresses[0];
  const [orders, setOrders] = useState<PosCustomerOrder[] | null>(null);
  const [historyError, setHistoryError] = useState("");

  useEffect(() => {
    let active = true;
    fetch(`/api/pos/customers/${customer.id}/orders`, { cache: "no-store" })
      .then(async (response) => {
        const parsed = posCustomerOrderSchema.array().safeParse(await response.json());
        if (!active) return;
        if (response.ok && parsed.success) setOrders(parsed.data);
        else setHistoryError("Order history is unavailable right now.");
      })
      .catch(() => { if (active) setHistoryError("Order history is unavailable right now."); });
    return () => { active = false; };
  }, [customer.id]);

  return <div className="mt-5 grid gap-4 sm:grid-cols-2">
    <div className="rounded-2xl bg-wayne-cream p-4">
      {address ? <p className="text-lg font-bold">{address.address1}{address.address2 ? `, ${address.address2}` : ""}<br />{address.city}, {address.state} {address.postal_code}</p> : <p className="font-bold text-wayne-muted">No address on file</p>}
      {address?.delivery_instructions ? <p className="mt-1 text-sm text-wayne-muted">{address.delivery_instructions}</p> : null}
      {customer.notes ? <p className="mt-2 text-sm"><strong>Notes:</strong> {customer.notes}</p> : null}
    </div>
    <dl className="grid grid-cols-3 gap-2 rounded-2xl bg-wayne-cream p-4 text-center">
      <div><dt className="text-xs font-bold uppercase text-wayne-muted">Orders</dt><dd className="text-2xl font-black">{customer.order_count}</dd></div>
      <div><dt className="text-xs font-bold uppercase text-wayne-muted">Last order</dt><dd className="text-lg font-black">{customer.last_order_at ? new Date(customer.last_order_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}</dd></div>
      <div><dt className="text-xs font-bold uppercase text-wayne-muted">Average</dt><dd className="text-lg font-black">{formatCents(customer.average_order_value_cents)}</dd></div>
    </dl>
    <div className="sm:col-span-2">
      <h2 className="text-sm font-black uppercase tracking-[0.14em] text-wayne-muted">Recent orders</h2>
      {orders === null && !historyError ? <p className="mt-2 text-sm text-wayne-muted">Loading…</p> : null}
      {historyError ? <p className="mt-2 text-sm text-wayne-muted">{historyError}</p> : null}
      {orders?.length === 0 ? <p className="mt-2 text-sm text-wayne-muted">No orders yet.</p> : null}
      {orders?.length ? <ul className="mt-2 grid gap-1.5">{orders.slice(0, 4).map((order) => <li className="rounded-xl border border-wayne-border p-2 text-sm" key={order.id}><strong>{new Date(order.placed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · {order.order_number} · {formatCents(order.total_cents)}</strong><span className="block truncate text-wayne-muted">{order.fulfillment_type} · {order.items}</span></li>)}</ul> : null}
    </div>
  </div>;
}

function RecentCalls({ recent, now, timeZone }: { recent: RecentCall[]; now: number; timeZone: string }) {
  const time = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  const outcome: Record<string, string> = { incoming: "Ringing", selected: "Answered", order_started: "Taking order", dismissed: "Dismissed", expired: "Missed", completed: "Order" };
  return <section className="mt-6">
    <h2 className="text-sm font-black uppercase tracking-[0.18em] text-wayne-muted">Recent calls</h2>
    {recent.length ? <ul className="mt-2 divide-y divide-wayne-border overflow-hidden rounded-2xl border border-wayne-border bg-white">
      {recent.map((call) => <li className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2" key={call.id}>
        <span className="w-20 font-black">{time(call.started_at)}</span>
        <span className="min-w-0 flex-1 truncate font-bold">{call.customer_name || formatPhone(call.caller_number ?? call.caller_number_raw)}{call.simulated ? <span className="ml-2 text-xs text-wayne-muted">TEST</span> : null}</span>
        <span className="text-sm text-wayne-muted">Line {call.line_number}</span>
        <span className="text-sm font-bold">{call.order_number ? `Order ${call.order_number}` : outcome[call.status] ?? call.status}</span>
        {call.status === "dismissed" || call.status === "expired" ? <Button onClick={() => void phoneActions.reopenCall(call.event_key)} size="sm" variant="secondary">Reopen</Button> : null}
        <span className="sr-only">{since(call.started_at, now)}</span>
      </li>)}
    </ul> : <p className="mt-2 rounded-2xl bg-white p-4 text-sm text-wayne-muted">No calls in the last 12 hours.</p>}
  </section>;
}
