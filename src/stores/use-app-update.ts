"use client";

import { useEffect, useRef } from "react";
import { logDevice } from "@/lib/pos/device-log";
import { reportNetworkFailure, reportServerOk } from "./connectivity";
import { appBuildStore, setLiveBuild } from "./app-build";

/**
 * Keeps a register on the newest build (owner, 2026-10-20).
 *
 * The POS never navigates, so a deploy used to leave the counter tablet on
 * the old screens — talking to the new server — until the app was
 * force-closed: the old and the new changes "fighting".  This checks
 * /api/version once a minute (and whenever the screen comes back) and, once a
 * newer build is live, reloads the page the moment `isSafe()` says the
 * register is idle (nothing being typed, no ticket, no payment on screen).
 * Tickets are saved on the device, so even then nothing could be lost.
 *
 * Never loops: one reload per new build per 10 minutes, even if the tablet
 * comes back on the old copy.
 *
 * 2026-10-28 (old screens coming back): the first check now runs 3 seconds
 * after the page opens (was 15) and again the moment the server answers after
 * a drop, so a register that had to open the offline copy (possibly from
 * before the last deploy) is back on the current build within seconds, not
 * minutes.  A page opened from the offline copy is reloaded once the server is
 * back even when the build looks the same, so it gets fresh data too.
 */
const CURRENT = process.env.WAYNE_BUILD_ID ?? "";
const CHECK_EVERY_MS = 60_000;
const SAFE_CHECK_MS = 5_000;
const GUARD_KEY = "wayne-app-update";

function recentlyReloadedFor(build: string) {
  try {
    const raw = window.sessionStorage.getItem(GUARD_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw) as { build?: string; at?: number };
    return saved.build === build && typeof saved.at === "number" && Date.now() - saved.at < 10 * 60_000;
  } catch {
    return false;
  }
}

export function useAppUpdate(isSafe: () => boolean) {
  const safeRef = useRef(isSafe);
  useEffect(() => { safeRef.current = isSafe; }, [isSafe]);

  useEffect(() => {
    if (!CURRENT) return; // only on Vercel deploys (local builds have no deploy id)
    let waitingFor = "";
    let stopped = false;

    const reloadIfSafe = () => {
      if (stopped || !waitingFor || recentlyReloadedFor(waitingFor)) return;
      const focused = document.activeElement;
      const typing = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement || focused instanceof HTMLSelectElement;
      if (typing || !safeRef.current()) return;
      try { window.sessionStorage.setItem(GUARD_KEY, JSON.stringify({ build: waitingFor, at: Date.now() })); } catch { /* reload anyway */ }
      logDevice("app.update", `reloading for build ${waitingFor}`, { from: CURRENT, to: waitingFor });
      // Give the log a moment to leave, then load the new screens.
      window.setTimeout(() => window.location.reload(), 900);
      stopped = true;
    };

    const check = async () => {
      if (stopped) return;
      try {
        const response = await fetch("/api/version", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
        reportServerOk();
        const body = (await response.json().catch(() => null)) as { build?: unknown } | null;
        const live = typeof body?.build === "string" ? body.build : "";
        if (response.ok && live) setLiveBuild(live);
        if (response.ok && live && live !== CURRENT) waitingFor = live;
        // Opened from the offline copy and the server answers again: load the real page when idle.
        else if (response.ok && appBuildStore.get().offlineCopy) waitingFor = live || "offline-copy";
      } catch {
        // Offline: try again next time (and the POS knows it is offline).
        reportNetworkFailure();
      }
      reloadIfSafe();
    };

    const first = window.setTimeout(() => { void check(); }, 3_000);
    const poll = window.setInterval(() => { void check(); }, CHECK_EVERY_MS);
    const safePoll = window.setInterval(reloadIfSafe, SAFE_CHECK_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    window.addEventListener("wayne:reconnected", onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(first);
      window.clearInterval(poll);
      window.clearInterval(safePoll);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      window.removeEventListener("wayne:reconnected", onVisible);
    };
  }, []);
}
