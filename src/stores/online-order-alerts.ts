"use client";

import { useEffect, useRef, useState } from "react";
import { openOrderSchema, type OpenOrder } from "@/lib/orders/status";

/**
 * New online orders on the POS (owner, 2026-09-30): a chime and a banner the
 * moment one arrives, repeated until someone taps it, so an order from the
 * website is never missed while the cashier is on another screen.
 *
 * Only orders that are real are announced: an online card order still
 * waiting for its payment ("payment_pending") chimes once the card goes
 * through.  Orders already open when the POS starts are not announced.
 */

const CHIME_KEY = "pos.online-order-chime.v1";
const POLL_MS = 8_000;
const REPEAT_MS = 30_000;

export function getOnlineChimeEnabled() {
  try { return window.localStorage.getItem(CHIME_KEY) !== "off"; } catch { return true; }
}

export function setOnlineChimeEnabled(on: boolean) {
  try { window.localStorage.setItem(CHIME_KEY, on ? "on" : "off"); } catch { /* private mode: stays on for this session */ }
}

/** Which of these orders should be announced (pure, tested). */
export function newOnlineOrders(orders: OpenOrder[], seen: Set<string>): OpenOrder[] {
  return orders.filter((order) => order.source === "online" && !seen.has(order.id)
    && order.status !== "payment_pending" && order.status !== "cancelled");
}

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  context ??= new Ctor();
  return context;
}

/** Browsers only allow sound after the first tap on the page; the POS gets one within seconds. */
function unlockOnFirstTap() {
  const unlock = () => { void audio()?.resume(); };
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });
}

/** A bright three-note "ding-ding-ding", made in the browser (no sound file to load). */
export function playOrderChime() {
  const ctx = audio();
  if (!ctx) return;
  void ctx.resume();
  const start = ctx.currentTime + 0.02;
  [880, 1175, 1568].forEach((frequency, index) => {
    const at = start + index * 0.18;
    const tone = ctx.createOscillator();
    const volume = ctx.createGain();
    tone.type = "sine";
    tone.frequency.setValueAtTime(frequency, at);
    volume.gain.setValueAtTime(0.0001, at);
    volume.gain.exponentialRampToValueAtTime(0.5, at + 0.02);
    volume.gain.exponentialRampToValueAtTime(0.0001, at + 0.55);
    tone.connect(volume).connect(ctx.destination);
    tone.start(at);
    tone.stop(at + 0.6);
  });
}

/** Watches the open orders and returns the online ones nobody has acknowledged yet. */
export function useOnlineOrderAlerts(enabled: boolean) {
  const [alerts, setAlerts] = useState<OpenOrder[]>([]);
  const seen = useRef<Set<string> | null>(null);
  const pending = useRef<OpenOrder[]>([]);

  useEffect(() => { pending.current = alerts; }, [alerts]);

  useEffect(() => {
    if (!enabled) return;
    unlockOnFirstTap();
    let stopped = false;
    async function poll() {
      try {
        const response = await fetch("/api/pos/open-orders", { cache: "no-store", signal: AbortSignal.timeout(8000) });
        const parsed = openOrderSchema.array().safeParse(response.ok ? await response.json() : null);
        if (!parsed.success || stopped) return;
        if (!seen.current) {
          // First look: whatever is already open was there before this register started.
          seen.current = new Set(parsed.data.filter((order) => order.status !== "payment_pending").map((order) => order.id));
          return;
        }
        const fresh = newOnlineOrders(parsed.data, seen.current);
        if (!fresh.length) return;
        for (const order of fresh) seen.current.add(order.id);
        setAlerts((current) => [...current, ...fresh]);
        if (getOnlineChimeEnabled()) playOrderChime();
      } catch { /* offline: the header already says so; try again next round */ }
    }
    void poll();
    const pollTimer = window.setInterval(() => { void poll(); }, POLL_MS);
    // Keep chiming until someone acknowledges it (like the old system's printer beep).
    const repeatTimer = window.setInterval(() => { if (pending.current.length && getOnlineChimeEnabled()) playOrderChime(); }, REPEAT_MS);
    return () => { stopped = true; window.clearInterval(pollTimer); window.clearInterval(repeatTimer); };
  }, [enabled]);

  return { alerts, acknowledge: () => setAlerts([]) };
}
