"use client";

import { useEffect } from "react";

/** Runs a reconciliation only while its screen is visible, plus on reconnect. */
export function useVisiblePolling(refresh: () => void | Promise<void>, intervalMs: number) {
  useEffect(() => {
    let timer: number | null = null;
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const run = () => { void refresh(); };
    const start = () => {
      if (document.visibilityState !== "visible" || timer !== null) return;
      run();
      timer = window.setInterval(run, intervalMs);
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
