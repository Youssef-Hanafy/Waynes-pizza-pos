"use client";

import { useEffect, useState, type ReactNode } from "react";
import { uuid } from "@/lib/uuid";

const CHANNEL = "wayne-pos-one-tab";

/**
 * Only one copy of the POS runs per computer / tablet (owner, 2026-10-11).
 *
 * Two tabs of the POS in the same browser share the saved tickets, so each
 * one kept "correcting" the other — the ticket on screen flipped between the
 * order and a blank New Order card many times a second (the screen looked like
 * it was shaking), and both talked to the customer screen as the same register.
 *
 * The newest tab wins; any older tab shows a cover with "Use the POS here",
 * which takes it back.  Nothing in the covered tab runs (no ticket syncing, no
 * customer screen, no phone pop-ups) while it is covered.
 */
export function OneTab({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(true);
  const [channel, setChannel] = useState<BroadcastChannel | null>(null);
  const [id] = useState(() => (typeof window === "undefined" ? "" : uuid()));

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const next = new BroadcastChannel(CHANNEL);
    next.onmessage = (event: MessageEvent<{ type?: string; id?: string }>) => {
      if (event.data?.type === "claim" && event.data.id !== id) setActive(false);
    };
    next.postMessage({ type: "claim", id });
    const timer = window.setTimeout(() => setChannel(next), 0);
    return () => { window.clearTimeout(timer); next.close(); };
  }, [id]);

  if (active) return <>{children}</>;
  return <div className="fixed inset-0 z-[200] flex items-center justify-center bg-wayne-cream-deep p-6">
    <section className="w-full max-w-lg rounded-3xl bg-white p-6 text-center shadow-xl">
      <p className="text-5xl" aria-hidden>🖥</p>
      <h1 className="mt-3 text-3xl font-black">The POS is open in another tab</h1>
      <p className="mt-2 text-wayne-muted">Only one tab or window can run the register on this device, or the tickets fight each other. Close this tab, or use the POS here instead.</p>
      <button className="mt-5 min-h-14 w-full rounded-2xl bg-wayne-green text-xl font-black text-white" onClick={() => { channel?.postMessage({ type: "claim", id }); window.location.reload(); }} type="button">Use the POS here</button>
    </section>
  </div>;
}
