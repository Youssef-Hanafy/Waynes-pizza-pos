"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { elapsedLabel, kitchenBoardSchema, nextKitchenAction, type KitchenTicket } from "@/lib/kitchen/schemas";

type Props = { initialTickets: KitchenTicket[]; initialError: string; staffName: string; canOpenAdmin: boolean; canOpenPos: boolean };

export function KitchenBoard({ initialTickets, initialError, staffName, canOpenAdmin, canOpenPos }: Props) {
  const [tickets, setTickets] = useState(initialTickets);
  const [error, setError] = useState(initialError);
  const [connection, setConnection] = useState("Connecting");
  const [lastSynced, setLastSynced] = useState<number | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [filter, setFilter] = useState("active");
  const [station, setStation] = useState("");
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
          const response = await fetch("/api/kitchen", { cache: "no-store", signal: AbortSignal.timeout(8000) });
          if (!response.ok) throw new Error(response.status === 403 ? "Session expired or access changed. Sign in again." : "Connection interrupted. Displaying the last saved tickets.");
          const result = kitchenBoardSchema.parse(await response.json());
          if (mounted.current) { setTickets(result); setError(""); setLastSynced(Date.now()); }
        } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Unable to refresh tickets."); }
      } while (mounted.current && refreshAgain.current);
    };
    inFlight.current = run();
    try { await inFlight.current; } finally { inFlight.current = null; }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const client = createBrowserSupabaseClient();
    const channel = client?.channel("wayne-kitchen-board")
      .on("postgres_changes", { event: "*", schema: "public", table: "kitchen_tickets" }, () => { void refresh(); })
      .subscribe((status) => {
        if (!mounted.current) return;
        setConnection(status === "SUBSCRIBED" ? "Live" : "Reconnecting · backup refresh on");
        if (status === "SUBSCRIBED") void refresh();
      });
    const online = () => { setConnection("Reconnecting"); void refresh(); };
    const offline = () => { setConnection("Offline"); setError("Connection lost. Showing last saved tickets; actions are paused."); };
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    // Snapshot refresh heals missed events and covers a disconnected socket.
    const poll = window.setInterval(() => { void refresh(); }, 5000);
    window.addEventListener("online", online); window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", visible);
    void refresh();
    return () => {
      mounted.current = false; window.clearInterval(timer); window.clearInterval(poll);
      window.removeEventListener("online", online); window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", visible);
      if (client && channel) void client.removeChannel(channel);
    };
  }, [refresh]);

  async function transition(ticket: KitchenTicket) {
    if (busy.current || !(ticket.status in nextKitchenAction)) return;
    const action = nextKitchenAction[ticket.status as keyof typeof nextKitchenAction];
    busy.current = true; setPending(ticket.order_id);
    try {
      const response = await fetch("/api/kitchen", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id: ticket.order_id, expected_status: ticket.status, next_status: action.status }), signal: AbortSignal.timeout(10000) });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || "Action could not be saved."); }
      await refresh();
    } catch (cause) { await refresh(); setError(cause instanceof Error ? cause.message : "Check the saved state before retrying."); }
    finally { busy.current = false; setPending(null); }
  }

  const stations = [...new Set(tickets.flatMap((ticket) => ticket.payload.items.map((item) => item.station)))].sort();
  const shown = tickets.filter((ticket) => (filter === "all" || (filter === "ready" ? ticket.status === "ready" : ticket.status !== "ready"))
    && (!station || ticket.payload.items.some((item) => item.station === station)));
  const stale = lastSynced !== null && now !== null && now - lastSynced > 15000;

  return <div className="min-h-screen bg-stone-100">
    <header className="bg-wayne-ink px-5 py-4 text-white"><div className="flex flex-wrap items-center justify-between gap-4">
      <div><p className="text-sm font-bold text-amber-300">Wayne&apos;s Pizza</p><h1 className="text-3xl font-black">Kitchen</h1><p className="text-sm text-stone-300">{staffName}</p></div>
      <nav className="flex gap-2">{canOpenPos ? <Button asChild variant="secondary"><Link href="/pos">Front POS</Link></Button> : null}{canOpenAdmin ? <Button asChild variant="secondary"><Link href="/admin">Admin</Link></Button> : null}<Button asChild variant="secondary"><Link href="/login?next=%2Fkitchen">Switch account</Link></Button></nav>
    </div><div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm"><p role="status">{connection}{lastSynced && now ? ` · refreshed ${Math.max(0, Math.floor((now - lastSynced) / 1000))}s ago` : " · loading tickets"}</p><Button onClick={() => { void refresh(); }} variant="secondary">Refresh tickets</Button></div></header>
    <main className="p-4 sm:p-6">
      {error || stale ? <div role="alert" className="mb-5 rounded-xl border border-amber-400 bg-amber-50 p-4 font-bold">{error || "Tickets may be out of date. Reconnecting…"}</div> : null}
      <div className="mb-6 flex flex-wrap items-center gap-3"><div className="flex gap-2" aria-label="Ticket filters">{[["active", "To prepare"], ["ready", "Ready"], ["all", "All tickets"]].map(([value, label]) => <Button aria-pressed={filter === value} key={value} onClick={() => setFilter(value)} variant={filter === value ? "primary" : "secondary"}>{label} ({tickets.filter((ticket) => value === "all" || (value === "ready" ? ticket.status === "ready" : ticket.status !== "ready")).length})</Button>)}</div>
      <label className="ml-auto text-sm font-bold">Station <select className="min-h-12 rounded-lg border border-wayne-border bg-white px-4" value={station} onChange={(event) => setStation(event.target.value)}><option value="">All stations</option>{stations.map((value) => <option key={value}>{value}</option>)}</select></label></div>
      {station ? <p className="mb-4 text-sm text-wayne-muted">Showing orders containing {station} items. Actions apply to the entire order.</p> : null}
      <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{shown.map((ticket) => {
        const action = ticket.status in nextKitchenAction ? nextKitchenAction[ticket.status as keyof typeof nextKitchenAction] : null;
        return <article key={ticket.order_id} className="overflow-hidden rounded-2xl border border-wayne-border bg-white shadow-sm">
          <div className={`p-5 ${ticket.status === "ready" ? "bg-green-100" : ticket.payload.fulfillment_type === "delivery" ? "bg-blue-100" : "bg-amber-100"}`}>
            <div className="flex items-center justify-between gap-3"><h2 className="text-3xl font-black">{ticket.payload.order_number}</h2><strong className="rounded-full bg-white px-3 py-2 text-sm capitalize">{ticket.payload.fulfillment_type}</strong></div>
            <p className="mt-2 font-bold">{ticket.payload.customer_name} · <span className="capitalize">{ticket.payload.source}</span></p>
            <p className="mt-2 font-black capitalize">{ticket.status.replaceAll("_", " ")}</p>
            <p className="mt-1 font-mono text-sm">Placed {now ? elapsedLabel(ticket.placed_at, now) : "—"} ago{ticket.accepted_at && now ? ` · accepted ${elapsedLabel(ticket.accepted_at, now)} ago` : ""}</p>
          </div>
          <div className="p-5">{ticket.payload.instructions ? <p className="mb-4 whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50 p-3 font-bold">Order note: {ticket.payload.instructions}</p> : null}
            <ul className="divide-y divide-wayne-border">{ticket.payload.items.map((item) => <li className="py-3" key={item.id}><strong className="text-xl">{item.quantity}× {item.name}</strong>{item.variant ? <p className="font-bold">{item.variant}</p> : null}<p className="text-xs text-wayne-muted">Station: {item.station}</p>{item.modifiers.length ? <ul className="mt-2 space-y-1">{item.modifiers.map((modifier, index) => <li key={index}>{modifier.group}: {modifier.quantity}× {modifier.name}</li>)}</ul> : null}{item.instructions ? <p className="mt-2 whitespace-pre-wrap font-bold text-wayne-red">{item.instructions}</p> : null}</li>)}</ul>
            {action ? <Button className="mt-5 min-h-14 w-full text-lg" disabled={pending !== null || stale || Boolean(error)} onClick={() => { void transition(ticket); }}>{pending === ticket.order_id ? "Saving…" : action.label}</Button> : <p className="mt-5 rounded-xl bg-green-50 p-4 font-bold text-green-800">{ticket.payload.fulfillment_type === "delivery" ? "Ready for driver pickup" : "Ready at the counter"}</p>}
          </div>
        </article>;
      })}</div>
      {!shown.length ? <div className="rounded-2xl border border-dashed border-wayne-border bg-white p-12 text-center"><h2 className="text-2xl font-black">{initialError && !lastSynced ? "Waiting for kitchen connection" : "No tickets in this view"}</h2><p className="mt-3 text-wayne-muted">New orders appear automatically. Oldest orders appear first.</p></div> : null}
    </main>
  </div>;
}
