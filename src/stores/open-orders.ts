"use client";

import { useEffect } from "react";
import { openOrderSchema, type OpenOrder } from "@/lib/orders/status";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { getClientWorkspaceScope, workspaceRealtimeFilter } from "@/lib/tenancy/client-scope";
import { createStore, useStore } from "./create-store";

type State = { orders: OpenOrder[]; loaded: boolean; error: string; updatedAt: number };
const empty: State = { orders: [], loaded: false, error: "", updatedAt: 0 };

/** One request shared by alerts and every visible order list in this browser. */
export function createOpenOrdersFeed(read: () => Promise<OpenOrder[]>) {
  const store = createStore<State>(empty);
  let flight: Promise<void> | null = null;
  let revision = 0;
  function refresh(invalidate = false): Promise<void> {
    if (invalidate) revision++;
    if (flight) return flight;
    flight = (async () => {
      do {
        const started = revision;
        try {
          const orders = await read();
          store.set({ orders, loaded: true, error: "", updatedAt: Date.now() });
        } catch (cause) {
          store.set(current => ({ ...current, loaded: true, error: cause instanceof Error ? cause.message : "Open orders are unavailable." }));
        }
        // An action/event during a request must be followed by a fresh read.
        if (started === revision) break;
      } while (true);
    })().finally(() => { flight = null; });
    return flight;
  }
  return { ...store, refresh };
}

function makeBrowserFeed() {
  const feed = createOpenOrdersFeed(async () => {
    const response = await fetch("/api/pos/open-orders", { cache: "no-store", signal: AbortSignal.timeout(8000) });
    const parsed = openOrderSchema.array().safeParse(response.ok ? await response.json() : null);
    if (!parsed.success) throw new Error("Open orders are unavailable — retrying.");
    return parsed.data;
  });
  let users = 0;
  let stop: (() => void) | null = null;
  function acquire() {
    if (++users === 1) {
      const poll = () => { if (document.visibilityState === "visible") void feed.refresh(); };
      let soon: number | null = null;
      const changed = () => {
        if (soon === null) soon = window.setTimeout(() => { soon = null; if (document.visibilityState === "visible") void feed.refresh(true); }, 300);
      };
      poll();
      const timer = window.setInterval(poll, 60_000);
      const client = createBrowserSupabaseClient();
      const channel = client?.channel(`pos-orders-${Math.random().toString(36).slice(2)}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "kitchen_tickets", ...workspaceRealtimeFilter() }, changed)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "print_jobs", ...workspaceRealtimeFilter() }, changed)
        .subscribe(status => { if (status === "SUBSCRIBED") changed(); });
      document.addEventListener("visibilitychange", poll);
      window.addEventListener("online", changed);
      stop = () => {
        window.clearInterval(timer);
        if (soon !== null) window.clearTimeout(soon);
        document.removeEventListener("visibilitychange", poll);
        window.removeEventListener("online", changed);
        if (client && channel) void client.removeChannel(channel);
      };
    }
    return () => { if (--users === 0) { stop?.(); stop = null; } };
  }
  const refresh = () => feed.refresh(true);
  return { feed, acquire, refresh };
}
const feeds = new Map<string, ReturnType<typeof makeBrowserFeed>>();
function scopedFeed() {
  const scope = getClientWorkspaceScope();
  const key = `${scope.workspaceId}:${scope.locationId}`;
  let value = feeds.get(key);
  if (!value) { value = makeBrowserFeed(); feeds.set(key, value); }
  return value;
}
export function useOpenOrders(enabled = true) {
  const current = scopedFeed();
  const state = useStore(current.feed, value => enabled ? value : empty, empty);
  useEffect(() => enabled ? current.acquire() : undefined, [enabled, current]);
  return { ...state, refresh: current.refresh };
}
/** Call after an order/payment action so all mounted views receive the result. */
export function refreshOpenOrders() { return scopedFeed().refresh(); }
