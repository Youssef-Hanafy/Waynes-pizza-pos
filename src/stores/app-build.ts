"use client";

import { createStore, useStore } from "./create-store";

/**
 * Which build of the POS this register is running, and what the server is on
 * (owner, 2026-10-28: "the POS would switch between older and newer versions").
 *
 *   current   — baked into this page when it was built (Vercel deploy id)
 *   commit    — the git commit of this page's build
 *   live      — what /api/version last said the server runs ("" = not known yet)
 *   offlineCopy — this page was opened from the copy the offline worker keeps
 *                 (public/pos-sw.js), because the server could not be reached;
 *                 savedAt is when that copy was saved
 */
export type AppBuild = {
  current: string;
  commit: string;
  builtAt: string;
  live: string;
  offlineCopy: boolean;
  savedAt: string;
  /** The offline worker's own version ("" until it answers). */
  worker: string;
};

const initial: AppBuild = {
  current: process.env.WAYNE_BUILD_ID ?? "",
  commit: process.env.WAYNE_COMMIT ?? "",
  builtAt: process.env.WAYNE_BUILT_AT ?? "",
  live: "",
  offlineCopy: false,
  savedAt: "",
  worker: "",
};

export const appBuildStore = createStore<AppBuild>(initial);

export function setLiveBuild(live: string) {
  if (appBuildStore.get().live !== live) appBuildStore.set({ ...appBuildStore.get(), live });
}

/** True once the server is known to run a different build than this page. */
export function isBehindServer(state: AppBuild = appBuildStore.get()) {
  return Boolean(state.current && state.live && state.live !== state.current);
}

let asked = false;

/** Ask the offline worker whether it opened this page from its saved copy (once per page). */
export function askOfflineWorker() {
  if (asked || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  asked = true;
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent<{ type?: string; offline?: boolean; savedAt?: string; version?: string }>) => {
    if (event.data?.type !== "wayne-offline-copy") return;
    appBuildStore.set({ ...appBuildStore.get(), offlineCopy: Boolean(event.data.offline), savedAt: event.data.savedAt ?? "", worker: event.data.version ?? "" });
  });
  const ask = () => navigator.serviceWorker.controller?.postMessage({ type: "wayne-ask-offline" });
  ask();
  // The worker may only take control a moment after the page starts.
  navigator.serviceWorker.addEventListener("controllerchange", ask);
}

export function useAppBuild() {
  return useStore(appBuildStore, (state) => state, initial);
}
