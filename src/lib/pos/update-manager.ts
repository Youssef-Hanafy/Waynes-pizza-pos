import { CLIENT_CONTRACT, type Release } from "./release";
export type Safety = { blockers: string[]; revision: number };
export type UpdateState = { status: "checking" | "current" | "available" | "waiting" | "reloading" | "blocked" | "offline"; latest: Release | null; checkedAt: string; message: string; lastReload: { at: string; reason: string; target: string; confirmed?: boolean } | null };
type Journal = { target: string; at: string; reason: string; attempts: number; confirmed?: boolean };
export type UpdateDependencies = {
 loaded: Release; read: () => Promise<Release>; safety: () => Safety;
 serverSafety: () => Promise<string[]>; bridge: () => number; persist: () => boolean;
 get: (key: string) => string | null; put: (key: string, value: string) => void;
 reload: (build: string) => void; changed: (state: UpdateState) => void;
 now?: () => number;
};
export const UPDATE_JOURNAL = "wayne.pos.update-journal.v1";
export const UPDATE_HIGH_WATER = "wayne.pos.release-high-water.v1";
/** One owner of checking, scheduling, verification and reload. No draft data is changed. */
export class UpdateManager {
 state: UpdateState = { status: "checking", latest: null, checkedAt: "", message: "Checking application version…", lastReload: null };
 private timer: ReturnType<typeof setTimeout> | undefined;
 private checking = false; private preparing = false; private stopped = false; private departed = false;
 private generation = 0; private reason = "deployment";
 constructor(private d: UpdateDependencies) {
  const journal = this.journal();
  if (journal) {
   const confirmed = journal.target === d.loaded.build;
   this.state.lastReload = { at: journal.at, reason: journal.reason, target: journal.target, confirmed };
   if (confirmed) { try { d.put(UPDATE_JOURNAL, JSON.stringify({ ...journal, confirmed: true })); } catch { /* reported before another update */ } }
  }
 }
 private journal(): Journal | null { try { return JSON.parse(this.d.get(UPDATE_JOURNAL) || "null") as Journal | null; } catch { return null; } }
 private emit(status: UpdateState["status"], message: string) { this.state = { ...this.state, status, message }; this.d.changed(this.state); }
 private accept(release: Release): boolean {
  if (release.contract < CLIENT_CONTRACT || this.d.bridge() < release.minimumBridge) { this.emit("blocked", "Application or Android bridge is incompatible. Keep this screen open and contact the release operator."); return false; }
  let floor = Date.parse(this.d.loaded.builtAt) || 0;
  try { const highest = JSON.parse(this.d.get(UPDATE_HIGH_WATER) || "null") as Release | null; floor = Math.max(floor, highest ? Date.parse(highest.builtAt) || 0 : 0); } catch { /* old diagnostics are not authoritative */ }
  if (Date.parse(release.builtAt) < floor) { this.emit("blocked", "An older deployment was detected. Keep this screen open; the release operator must verify the live alias."); return false; }
  try { this.d.put(UPDATE_HIGH_WATER, JSON.stringify(release)); } catch { this.emit("blocked", "Browser storage is unavailable. Restore device storage before updating; saved orders have not been removed."); return false; }
  this.state = { ...this.state, latest: release, checkedAt: new Date(this.now()).toISOString() };
  return true;
 }
 private now() { return this.d.now?.() ?? Date.now(); }
 async check() {
  if (this.stopped || this.departed || this.checking || this.preparing) return;
  this.checking = true;
  try {
   const release = await this.d.read();
   if (this.stopped || !this.accept(release)) return;
   if (release.build === this.d.loaded.build && this.reason === "deployment") { this.cancel(); this.emit("current", "This register is on the verified live build."); return; }
   this.generation++; this.cancel(); this.emit("available", "Update available. It will load automatically when this register is safe."); this.schedule();
  } catch { if (!this.stopped) this.emit("offline", "Version check could not finish. Keep working; reconnect to check the update again."); }
  finally { this.checking = false; }
 }
 request(reason = "manual check") { this.reason = reason; void this.check(); }
 private cancel() { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }
 tick() { if (!this.timer && !this.preparing && this.state.latest && this.state.status !== "blocked" && this.state.status !== "offline" && this.state.status !== "current") this.schedule(); }
 private schedule() {
  if (this.stopped || this.departed || this.timer || this.preparing) return;
  const safety = this.d.safety();
  if (safety.blockers.length) { this.emit("waiting", `Update waiting: ${safety.blockers.join("; ")}.`); return; }
  const generation = this.generation;
  this.timer = setTimeout(() => { this.timer = undefined; void this.prepare(generation); }, 900);
 }
 private async prepare(generation: number) {
  if (this.stopped || this.departed || this.preparing || generation !== this.generation) return;
  const before = this.d.safety();
  if (before.blockers.length) { this.emit("waiting", `Update waiting: ${before.blockers.join("; ")}.`); return; }
  this.preparing = true;
  try {
   // Re-read the alias and authoritative pending work, rather than trusting the earlier poll.
   const verified = await this.d.read();
   if (this.stopped || !this.accept(verified)) return;
   const serverBlockers = await this.d.serverSafety();
   const final = this.d.safety();
   if (this.stopped || generation !== this.generation) return;
   if (serverBlockers.length || final.blockers.length || final.revision !== before.revision) { this.emit("waiting", `Update waiting: ${[...serverBlockers,...final.blockers, ...(final.revision !== before.revision ? ["register activity changed during verification"] : [])].join("; ")}.`); return; }
   if (!this.d.persist()) { this.emit("blocked", "Saved register state could not be verified. Restore device storage before updating."); return; }
   const previous = this.journal();
   const attempts = previous?.target === verified.build && this.now() - Date.parse(previous.at) < 30 * 60_000 ? previous.attempts + 1 : 1;
   if (attempts > 2) { this.emit("blocked", "The new build did not load after two attempts. Keep this screen open and contact the release operator; do not clear saved orders."); return; }
   const journal: Journal = { target: verified.build, attempts, at: new Date(this.now()).toISOString(), reason: this.reason };
   this.d.put(UPDATE_JOURNAL, JSON.stringify(journal));
   // No asynchronous work after this last safety check. A new payment cannot race the reload timer.
   const last = this.d.safety();
   if (last.blockers.length || last.revision !== final.revision) { this.emit("waiting", "Register activity changed. The update will wait."); return; }
   this.departed = true; this.state.lastReload = journal; this.emit("reloading", "Loading the verified application build…"); this.d.reload(verified.build);
  } catch { if (!this.stopped) this.emit("offline", "Update verification could not finish. Check the connection or sign-in; no reload was attempted."); }
  finally { this.preparing = false; }
 }
 stop() { this.stopped = true; this.generation++; this.cancel(); }
}
