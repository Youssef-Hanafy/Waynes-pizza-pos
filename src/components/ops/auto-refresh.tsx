"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";

type Props = {
  /** Fallback polling interval. Realtime (when the viewer can receive it) refreshes sooner. */
  intervalMs?: number;
  /** Subscribe to order activity through the kitchen ticket feed (owner/manager/kitchen only). */
  live?: boolean;
  label?: string;
};

/**
 * Keeps server-rendered admin and POS screens current without a manual reload. It
 * re-renders the server component (client state such as an open ticket is kept) when
 * an order changes, on an interval, and when the tab becomes visible again.
 */
export function AutoRefresh({ intervalMs = 30_000, live = false, label = "Updates automatically" }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState(live ? "Connecting…" : label);
  const pending = useRef<number | null>(null);

  useEffect(() => {
    const refresh = () => {
      if (pending.current !== null) return;
      // Coalesce bursts (an order insert touches several rows) into one refresh.
      pending.current = window.setTimeout(() => { pending.current = null; router.refresh(); }, 750);
    };
    const client = live ? createBrowserSupabaseClient() : null;
    const channel = client?.channel(`wayne-auto-refresh-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "kitchen_tickets" }, refresh)
      .subscribe((state) => setStatus(state === "SUBSCRIBED" ? "Live" : label));
    const timer = window.setInterval(refresh, intervalMs);
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(timer);
      if (pending.current !== null) window.clearTimeout(pending.current);
      document.removeEventListener("visibilitychange", visible);
      if (client && channel) void client.removeChannel(channel);
    };
  }, [intervalMs, label, live, router]);

  return <span className="inline-flex items-center gap-2 text-xs font-bold text-wayne-muted" role="status"><span aria-hidden="true" className={`h-2 w-2 rounded-full ${status === "Live" ? "bg-wayne-ok" : "bg-wayne-border-strong"}`} />{status}</span>;
}
