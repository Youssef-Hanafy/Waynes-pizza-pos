/**
 * Screen-stability browser fixture (2026-10-31).  This is NOT app code: it is a
 * minimal POS document that runs the REAL production update lifecycle
 * (src/stores/app-update.ts → src/lib/pos/update-manager.ts) and the REAL
 * offline worker (public/pos-sw.js) against e2e/stability-fixture/server.ts,
 * which can "deploy" builds, slow down or break navigations, exactly like a
 * Vercel production alias seen from the Elo.
 */
import { registerScreenSafety, retainAppUpdates } from "@/stores/app-update";
import { askOfflineWorker, appBuildStore } from "@/stores/app-build";

declare global { interface Window { __fixture: { busy: boolean; build: string } } }

const build = process.env.WAYNE_BUILD_ID ?? "";
window.__fixture = { busy: false, build };
document.getElementById("design")!.textContent = `design ${build}`;
void fetch("/__control/loaded", { method: "POST", body: JSON.stringify({ build, url: location.href, at: Date.now() }) }).catch(() => undefined);
appBuildStore.subscribe(() => {
  const state = appBuildStore.get();
  if (state.offlineCopy) void fetch("/__control/loaded", { method: "POST", body: JSON.stringify({ build, url: location.href, offline: true, at: Date.now() }) }).catch(() => undefined);
});
registerScreenSafety("fixture-order", () => !window.__fixture.busy);
retainAppUpdates();
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/pos-sw.js", { scope: "/pos" }).catch(() => undefined);
askOfflineWorker();
