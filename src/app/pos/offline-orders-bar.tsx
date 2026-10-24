"use client";

import { useState } from "react";
import { formatCents } from "@/lib/menu/schemas";
import { dismissOfflineOrder, flushOfflineOrders, printOfflineOrder, useOfflineOrders } from "@/stores/offline-orders";

/**
 * Orders taken while offline, waiting to go to the server (owner,
 * 2026-10-24).  Each one shows how it was paid and whether its kitchen ticket
 * printed; one the server refused (or a stored card it declined) stays here
 * with what to do until someone taps Done.
 */
export function OfflineOrdersBar() {
  const orders = useOfflineOrders();
  const [note, setNote] = useState("");
  if (!orders.length) return null;
  return <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-wayne-border bg-wayne-warn-soft px-3 py-1.5 text-sm" role="status">
    <strong className="font-black">Offline orders ({orders.length}):</strong>
    {orders.map((draft) => {
      const offline = draft.offline!;
      const paid = offline.payment?.kind === "cash" ? "cash" : offline.payment?.kind === "card" ? (offline.payment.intentId ? "card" : "card stored") : "unpaid";
      const sent = offline.orderId ? `sent as ${offline.dailyNumber ? `#${offline.dailyNumber}` : offline.orderNumber}` : "waiting to send";
      return <span className={`inline-flex flex-wrap items-center gap-1.5 rounded-full border px-2 py-1 ${offline.problem ? "border-wayne-alert bg-wayne-alert-soft text-wayne-alert" : "border-wayne-border bg-white"}`} key={draft.id}>
        <span className="font-black">{offline.localNumber}</span>
        <span>{formatCents(offline.totalCents)} · {paid} · {offline.problem ? "needs attention" : sent}{offline.printed ? "" : " · ⚠ kitchen ticket not printed"}</span>
        {!offline.printed ? <button className="min-h-8 rounded-full border border-wayne-border bg-white px-2 font-bold" onClick={() => { setNote("Printing…"); void printOfflineOrder(draft.id).then((result) => setNote(result.message)); }} type="button">Print ticket</button> : null}
        {offline.problem ? <>
          <span className="basis-full font-bold">{offline.problem}</span>
          <button className="min-h-8 rounded-full bg-wayne-alert px-3 font-black text-white" onClick={() => dismissOfflineOrder(draft.id)} type="button">Done — I dealt with it</button>
        </> : null}
      </span>;
    })}
    <button className="min-h-8 rounded-full border border-wayne-border bg-white px-3 font-bold" onClick={() => { setNote(""); void flushOfflineOrders(); }} type="button">Send now</button>
    {note ? <span className="font-bold">{note}</span> : null}
  </div>;
}
