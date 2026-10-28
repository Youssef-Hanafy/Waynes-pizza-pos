"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { appBuildStore, isBehindServer } from "@/stores/app-build";
import { isServerReachable, probeServer } from "@/stores/connectivity";
import { logDevice } from "@/lib/pos/device-log";

/**
 * The POS's background refresh of the menu, prices and settings (every 3 minutes).
 *
 * 2026-10-28 (owner: tips went missing; old screens came back): this used to be
 * the shared <AutoRefresh>, which calls router.refresh() whatever is on screen.
 * When that refresh can't complete — the connection drops for a moment, or a
 * new deploy went live — Next.js falls back to reloading the whole page, so the
 * register reloaded in the middle of Tips, Deliveries, a customer form or a
 * payment, and with no connection the reload opened the offline copy (which
 * can be the build from before the last deploy).
 *
 * Now it only refreshes when it can't hurt:
 *   • the register is idle (isSafe: an empty New Order, or an order list)
 *   • the server answered a tiny check just before (no refresh into a drop)
 *   • this page is the build the server runs (otherwise use-app-update reloads
 *     it onto the new build when idle — a refresh would only force that reload)
 *   • the page is not the offline copy (it reloads properly instead)
 * A refresh that comes due while the register is busy waits until it is idle.
 */
export function PosAutoRefresh({ isSafe, intervalMs = 180_000 }: { isSafe: () => boolean; intervalMs?: number }) {
  const router = useRouter();
  const safeRef = useRef(isSafe);
  useEffect(() => { safeRef.current = isSafe; }, [isSafe]);

  useEffect(() => {
    let last = Date.now();
    let running = false;
    const due = () => Date.now() - last >= intervalMs;
    const tryRefresh = async (force = false) => {
      if (running || document.visibilityState !== "visible") return;
      if (!force && !due()) return;
      const build = appBuildStore.get();
      if (build.offlineCopy || isBehindServer(build) || !isServerReachable() || !safeRef.current()) return;
      running = true;
      try {
        if (!(await probeServer())) return;
        // Still idle after the check?
        if (!safeRef.current() || isBehindServer()) return;
        last = Date.now();
        router.refresh();
      } catch (error) {
        logDevice("pos.refresh_skipped", error instanceof Error ? error.message : String(error));
      } finally {
        running = false;
      }
    };
    const tick = window.setInterval(() => { void tryRefresh(); }, 15_000);
    const visible = () => { if (document.visibilityState === "visible") void tryRefresh(Date.now() - last > 30_000); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [intervalMs, router]);

  return null;
}
