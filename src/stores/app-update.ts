"use client";
import { currentRelease, parseRelease, CLIENT_CONTRACT } from "@/lib/pos/release";
import { UpdateManager, type UpdateState, UPDATE_HIGH_WATER } from "@/lib/pos/update-manager";
import { beginCriticalWork, markUncertainWork, noteRegisterActivity, registerUpdateGuard, resolveUncertainWork, updateSafety } from "@/lib/pos/update-activity";
import { createStore, useStore } from "./create-store";
import { appBuildStore, setLiveBuild } from "./app-build";
import { isPrintStationDevice } from "./print-station";
import { logDevice } from "@/lib/pos/device-log";

const initial: UpdateState = { status: "checking", latest: null, checkedAt: "", message: "Checking application version…", lastReload: null };
export const appUpdateStore = createStore<UpdateState>(initial);
let manager: UpdateManager | undefined;
let users = 0; let releaseRuntime: (() => void) | undefined;
function releaseUser() { users--; if (!users) { releaseRuntime?.(); releaseRuntime=undefined; } }
let manualCheck = () => {};
export function requestAppUpdate() { manualCheck(); }
export function useAppUpdateState() { return useStore(appUpdateStore,s=>s,initial); }
export function registerScreenSafety(key: string, safe: () => boolean) { return registerUpdateGuard(key, () => safe() ? [] : ["finish the active screen before updating"]); }
function bridgeVersion() {
 const native = window.WaynesAndroid;
 if (!native) return navigator.userAgent.includes("WaynesPOSAndroid/") ? 0 : Number.MAX_SAFE_INTEGER;
 return typeof native.printerSend === "function" && typeof native.stripeCollect === "function" ? 1 : 0;
}
export function retainAppUpdates() {
 users++;
 if (users > 1) return releaseUser;
 if (!currentRelease().build) return releaseUser;
 const nativeFetch = window.fetch.bind(window);
 const loaded = currentRelease();
 const opened = new URL(window.location.href);
 if (opened.searchParams.get("wayne_update") === loaded.build) { opened.searchParams.delete("wayne_update"); window.history.replaceState(window.history.state,"",opened); logDevice("app.update_confirmed", "Verified target loaded", {build:loaded.build}); }
 const browserGuard = registerUpdateGuard("browser", () => {
  const reasons = [];
  if (document.visibilityState !== "visible") reasons.push("the app is in the background");
  if (!navigator.onLine) reasons.push("the device is offline");
  const focused = document.activeElement;
  if (focused?.matches("input, textarea, select, [contenteditable=true]")) reasons.push("a field is being edited");
  if (document.querySelector('[role="dialog"]')) reasons.push("a dialog is open");
  return reasons;
 });
 const read = async () => {
  const r = await nativeFetch(`/api/version?check=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw Error("Version endpoint unavailable");
  const release = parseRelease(await r.json()); if (!release) throw Error("Version identity is not verifiable");
  return release;
 };
 manager = new UpdateManager({ loaded, read,
  safety: updateSafety, bridge: bridgeVersion,
  serverSafety: async () => {
   const r = await nativeFetch(`/api/pos/update-status?printing=${isPrintStationDevice() ? "1" : "0"}`, { cache: "no-store", signal: AbortSignal.timeout(10_000), headers: { "x-wayne-client-build": loaded.build, "x-wayne-client-contract": String(CLIENT_CONTRACT) } });
   if (!r.ok) throw Error("Pending operations could not be verified. Check sign-in.");
   const body = await r.json() as { blockers?: unknown; build?: unknown };
   if (!Array.isArray(body.blockers) || body.blockers.some(v=>typeof v!=="string") || body.build !== manager?.state.latest?.build) throw Error("Operation verification crossed a deployment");
   return body.blockers as string[];
  },
  persist: () => { try { window.localStorage.setItem("wayne.pos.storage-check", "ok"); window.localStorage.removeItem("wayne.pos.storage-check"); return true; } catch { return false; } },
  get: key => (key === UPDATE_HIGH_WATER ? window.localStorage : window.sessionStorage).getItem(key),
  put: (key,value) => (key === UPDATE_HIGH_WATER ? window.localStorage : window.sessionStorage).setItem(key,value),
  reload: target => {
   logDevice("app.reload", "Verified idle update", { from: loaded.build, to: target });
   const url = new URL(window.location.href); url.searchParams.set("wayne_update", target);
   window.history.replaceState(window.history.state,"",url); window.location.reload();
  },
  changed: state => { const previous=appUpdateStore.get(); if(previous.status!==state.status || previous.latest?.build!==state.latest?.build) logDevice("app.update_state",state.status,{loaded:loaded.build,latest:state.latest?.build ?? ""}); appUpdateStore.set(state); if (state.latest) setLiveBuild(state.latest.build); },
 });
 manualCheck = () => manager?.request("staff requested version verification");
 // All same-origin requests identify their client. A mismatched response requests
 // an update; it never retries or aborts an already-started financial operation.
 const trackedFetch: typeof fetch = async (input, init) => {
  const request = new Request(input,init); const url = new URL(request.url,window.location.href);
  const same = url.origin === window.location.origin;
  const mutating = request.method !== "GET" && request.method !== "HEAD" && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/rest/v1/rpc/")) && !url.pathname.includes("device-log") && !url.pathname.includes("wayne_display_");
  const financial = same && /payments|keyed-card|stripe-terminal\/(?:intent|collect|process)|\/tips(?:\/auto)?$|delivery\/cashout|refund/.test(url.pathname);
  const done = mutating ? beginCriticalWork(financial ? "payment request" : "saving register work") : () => {};
  const key = `http:${url.pathname}`;
  if (same && url.pathname.startsWith("/api/")) { request.headers.set("x-wayne-client-build",loaded.build); request.headers.set("x-wayne-client-contract",String(CLIENT_CONTRACT)); }
  try {
   const response = await nativeFetch(request);
   if (financial && response.status >= 500) markUncertainWork(key);
   if (financial && response.ok) resolveUncertainWork(key);
   const server = response.headers.get("x-wayne-server-build");
   if (same && server && server !== loaded.build) void manager?.check();
   return response;
  } catch (error) { if (financial) markUncertainWork(key); throw error; }
  finally { done(); }
 };
 window.fetch = trackedFetch;
 const check = () => { if (document.visibilityState === "visible") void manager?.check(); };
 const visibility = () => { noteRegisterActivity(); check(); };
 const assetError = (event: Event) => {
  const node = event.target;
  if (node instanceof HTMLScriptElement || (node instanceof HTMLLinkElement && node.rel === "stylesheet")) {
   logDevice("app.asset_load_failed", "Application asset unavailable", { build: loaded.build, kind: node.tagName });
   manager?.request("asset load failed");
  }
 };
 const chunkError = (event: PromiseRejectionEvent) => { if (/ChunkLoadError|Loading (?:chunk|CSS)|Failed to fetch dynamically imported module/.test(String(event.reason))) manager?.request("application chunk unavailable"); };
 const first = window.setTimeout(check,3000); const poll = window.setInterval(check,60000); const safe = window.setInterval(()=>manager?.tick(),1000);
 document.addEventListener("visibilitychange",visibility); window.addEventListener("online",check); window.addEventListener("wayne:reconnected",check); window.addEventListener("pageshow",visibility);
 window.addEventListener("pointerdown",noteRegisterActivity,true); window.addEventListener("keydown",noteRegisterActivity,true); window.addEventListener("error",assetError,true); window.addEventListener("unhandledrejection",chunkError);
 if (appBuildStore.get().offlineCopy) manager.request("opened from an offline copy");
 releaseRuntime = () => { manager?.stop(); browserGuard(); window.clearTimeout(first); window.clearInterval(poll); window.clearInterval(safe); document.removeEventListener("visibilitychange",visibility); window.removeEventListener("online",check); window.removeEventListener("wayne:reconnected",check); window.removeEventListener("pageshow",visibility); window.removeEventListener("pointerdown",noteRegisterActivity,true); window.removeEventListener("keydown",noteRegisterActivity,true); window.removeEventListener("error",assetError,true); window.removeEventListener("unhandledrejection",chunkError); if (window.fetch === trackedFetch) window.fetch = nativeFetch; manager=undefined; manualCheck=()=>{}; };
 return releaseUser;
}
