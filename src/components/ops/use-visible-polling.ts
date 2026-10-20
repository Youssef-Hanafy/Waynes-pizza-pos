"use client";

import { useEffect, useRef } from "react";

/** Runs a reconciliation only while its screen is visible, plus on reconnect. */
export function useVisiblePolling(refresh: () => void | Promise<void>, intervalMs: number) {
  const inFlight = useRef(false);
  useEffect(() => {
    let timer: number | null = null;
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const run = async () => {
      if (document.visibilityState !== "visible" || inFlight.current) return;
      inFlight.current = true;
      try { await refresh(); } finally { inFlight.current = false; }
    };
    const start = () => {
      if (document.visibilityState !== "visible" || timer !== null) return;
      void run();
      timer = window.setInterval(() => { void run(); }, intervalMs);
    };
    const visibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", run);
    start();
    return () => {
      stop();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", run);
    };
  }, [intervalMs, refresh]);
}
