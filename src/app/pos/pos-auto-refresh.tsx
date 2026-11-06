"use client";
import { useEffect, useLayoutEffect, useRef } from "react";
import { watchPosRefresh } from "@/lib/pos/refresh-signals";
import type { PosRuntime } from "@/lib/pos/runtime";
import { currentRelease } from "@/lib/pos/release";
import { updateSafety } from "@/lib/pos/update-activity";
import { requestAppUpdate } from "@/stores/app-update";

/** Refresh data only. RSC refresh can hard-navigate on skew, so it is never used in a running register. */
export function PosAutoRefresh({ isSafe, onData, intervalMs = 900_000 }: { isSafe: () => boolean; onData: (data: PosRuntime) => void; intervalMs?: number }) {
  const safe = useRef(isSafe), apply = useRef(onData);
  useLayoutEffect(() => { safe.current = isSafe; apply.current = onData; });
  useEffect(() => {
    let stopped = false, running = false, last = Date.now(), requested = 0, applied = 0;
    let soon: number | null = null;
    let nextAttempt = 0;
    const check = async () => {
      if (document.visibilityState !== "visible" || stopped || running || Date.now() < nextAttempt || (requested === applied && Date.now() - last < intervalMs) || !safe.current()) return;
      const before = updateSafety();
      if (before.blockers.length) return;
      running = true;
      nextAttempt = Date.now() + 15_000;
      const revision = requested;
      try {
        const response = await fetch("/api/pos/runtime", { cache: "no-store", signal: AbortSignal.timeout(15000) });
        if (!response.ok) return;
        const body = await response.json() as { build: string; data: PosRuntime };
        if (body.build !== currentRelease().build) { requestAppUpdate(); return; }
        const after = updateSafety();
        if (!stopped && safe.current() && !after.blockers.length && before.revision === after.revision) {
          apply.current(body.data); last = Date.now(); applied = revision;
        }
      } catch { /* offline: preserve the loaded menu and retry, never navigate */ }
      finally { running = false; }
    };
    const changed = () => {
      requested++;
      // A single menu save can change many rows in one transaction.
      if (soon === null) soon = window.setTimeout(() => { soon = null; void check(); }, 300);
    };
    const stop = watchPosRefresh("runtime", "", changed);
    const visible = () => { if (document.visibilityState === "visible") changed(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", changed);
    // Local eligibility check only: pending edits apply as soon as checkout is safe.
    const timer = window.setInterval(() => { void check(); }, 1000);
    return () => {
      stopped = true; stop(); window.clearInterval(timer);
      if (soon !== null) window.clearTimeout(soon);
      document.removeEventListener("visibilitychange", visible); window.removeEventListener("online", changed);
    };
  }, [intervalMs]);
  return null;
}
