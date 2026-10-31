import { CLIENT_CONTRACT, type Release } from "./release";
export type Safety = { blockers: string[]; revision: number };
export type UpdateState = { status: "checking" | "current" | "available" | "waiting" | "reloading" | "blocked" | "offline"; latest: Release | null; checkedAt: string; message: string; lastReload: { at: string; reason: string; target: string; confirmed?: boolean } | null };
type Journal = { target: string; at: string; reason: string; attempts: number; confirmed?: boolean };
export type UpdateDependencies = {
 loaded: Release; read: () => Promise<Release>; safety: () => Safety;
 serverSafety: () => Promise<string[]>; bridge: () => number; persist: () => boolean;
 get: (key: string) => string | null; put: (key: string, value: string) => void;
 reload: (build: string) => void; changed: (state: UpdateState) => void;
 /**
  * Put the target build's page and code on this device BEFORE leaving the running
  * one (the offline worker keeps them).  true = the target can open even if the
  * connection is slow or drops during the reload.  Never touches saved orders.
  */
 stage?: (release: Release) => Promise<boolean>;
 /** Diagnostics that must survive the reload (written durably, sent by the next page). */
 log?: (kind: string, detail: Record<string, unknown>) => void;
 now?: () => number;
 /** A deployment must stay live this long before a register moves to it (rapid pushes collapse into one change). */
 settleMs?: number;
 /** A reload that has not replaced this page after this long has stalled. */
 stallMs?: number;
};
export const UPDATE_JOURNAL = "wayne.pos.update-journal.v1";
export const UPDATE_HIGH_WATER = "wayne.pos.release-high-water.v1";
/** Every build this register has reloaded onto, across targets (localStorage). */
export const UPDATE_HISTORY = "wayne.pos.update-history.v1";
/** When this register first saw the current live build (localStorage). */
export const UPDATE_FIRST_SEEN = "wayne.pos.release-first-seen.v1";
export const SETTLE_MS = 2 * 60_000;
export const STALL_MS = 45_000;
/** Screen changes allowed per hour across ALL deployments (owner, 2026-10-31: no switching). */
export const MAX_RELOADS_PER_HOUR = 3;
const HOUR = 60 * 60_000;

/**
 * One owner of checking, scheduling, verification and reload. No draft data is changed.
 *
 * 2026-10-31 (Elo kept switching between old and new screens after two quick releases):
 *  • settle — a new deployment must stay the live one for SETTLE_MS before a register
 *    moves to it, so three pushes in six minutes are one screen change, not three;
 *  • cap    — at most MAX_RELOADS_PER_HOUR reloads per hour across every target;
 *  • stage  — the target page and code are saved on the device first, so a slow or
 *    dropped connection during the reload can't fall back to the OLD saved copy;
 *  • stall  — a reload that did not replace the page is detected and retried safely,
 *    instead of the register silently never checking for updates again.
 */
export class UpdateManager {
 state: UpdateState = { status: "checking", latest: null, checkedAt: "", message: "Checking application version…", lastReload: null };
 private timer: ReturnType<typeof setTimeout> | undefined;
 private stallTimer: ReturnType<typeof setTimeout> | undefined;
 private checking = false; private preparing = false; private stopped = false; private departed = false;
 private generation = 0; private reason = "deployment";
 constructor(private d: UpdateDependencies) {
  const journal = this.journal();
  if (journal) {
   const confirmed = journal.target === d.loaded.build;
   this.state.lastReload = { at: journal.at, reason: journal.reason, target: journal.target, confirmed };
   if (confirmed && !journal.confirmed) { try { d.put(UPDATE_JOURNAL, JSON.stringify({ ...journal, confirmed: true })); } catch { /* reported before another update */ } }
  }
 }
 private journal(): Journal | null { try { return JSON.parse(this.d.get(UPDATE_JOURNAL) || "null") as Journal | null; } catch { return null; } }
 private emit(status: UpdateState["status"], message: string) { this.state = { ...this.state, status, message }; this.d.changed(this.state); }
 private log(kind: string, detail: Record<string, unknown>) { try { this.d.log?.(kind, detail); } catch { /* diagnostics never block */ } }
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
 /** When this register first saw `build` live (kept across restarts, so a restart never re-waits). */
 private firstSeen(build: string): number {
  try { const seen = JSON.parse(this.d.get(UPDATE_FIRST_SEEN) || "null") as { build: string; at: number } | null; if (seen?.build === build && Number.isFinite(seen.at)) return seen.at; } catch { /* rewritten below */ }
  const at = this.now(); try { this.d.put(UPDATE_FIRST_SEEN, JSON.stringify({ build, at })); } catch { /* best effort */ }
  return at;
 }
 /** Milliseconds until `build` has been live long enough. Deployment-driven updates only. */
 private settling(build: string) {
  if (this.reason !== "deployment") return 0;
  return Math.max(0, this.firstSeen(build) + (this.d.settleMs ?? SETTLE_MS) - this.now());
 }
 private history(): number[] { try { const list = JSON.parse(this.d.get(UPDATE_HISTORY) || "[]") as unknown; return Array.isArray(list) ? list.filter((n): n is number => Number.isFinite(n)) : []; } catch { return []; } }
 /** Milliseconds until another reload is allowed by the hourly cap. */
 private capped() { const recent = this.history().filter(at => this.now() - at < HOUR).sort((a,b)=>a-b); return recent.length < MAX_RELOADS_PER_HOUR ? 0 : recent[0]! + HOUR - this.now(); }
 async check() {
  if (this.stopped || this.departed || this.checking || this.preparing) return;
  this.checking = true;
  try {
   const release = await this.d.read();
   if (this.stopped || !this.accept(release)) return;
   if (release.build === this.d.loaded.build && this.reason === "deployment") { this.cancel(); this.emit("current", "This register is on the verified live build."); return; }
   this.firstSeen(release.build);
   // A target that already failed twice stays blocked for the 30-minute window, then is retried.
   if (this.blocked?.build === release.build && this.now() < this.blocked.until) { if (this.state.status !== "blocked") this.emit("blocked", this.blocked.message); return; }
   this.blocked = undefined;
   // Same target already pending: keep the schedule (no state churn on every server response).
   if (this.state.latest?.build === release.build && (this.state.status === "available" || this.state.status === "waiting") && this.known === release.build) { this.schedule(); return; }
   this.known = release.build;
   this.generation++; this.cancel(); this.emit("available", "Update available. It will load automatically when this register is safe."); this.schedule();
  } catch { if (!this.stopped) this.emit("offline", "Version check could not finish. Keep working; reconnect to check the update again."); }
  finally { this.checking = false; }
 }
 private blocked: { build: string; until: number; message: string } | undefined;
 private known: string | undefined;
 request(reason = "manual check") { this.reason = reason; this.blocked = undefined; this.known = undefined; void this.check(); }
 private cancel() { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }
 tick() { if (!this.timer && !this.preparing && !this.departed && this.state.latest && this.state.status !== "blocked" && this.state.status !== "offline" && this.state.status !== "current") this.schedule(); }
 private schedule() {
  if (this.stopped || this.departed || this.timer || this.preparing || !this.state.latest) return;
  const target = this.state.latest.build;
  const settle = this.settling(target);
  if (settle > 0) { if (this.state.status !== "waiting") this.emit("waiting", `Update waiting: the new version must stay live for ${Math.ceil(settle / 1000)} more seconds before this register changes screens.`); return; }
  const cap = this.capped();
  if (cap > 0) { if (this.state.status !== "waiting") this.emit("waiting", `Update waiting: this register already changed versions ${MAX_RELOADS_PER_HOUR} times this hour; next allowed in ${Math.ceil(cap / 60_000)} min.`); return; }
  const safety = this.d.safety();
  if (safety.blockers.length) { this.emit("waiting", `Update waiting: ${safety.blockers.join("; ")}.`); return; }
  const generation = this.generation;
  this.timer = setTimeout(() => { this.timer = undefined; void this.prepare(generation); }, 900);
 }
 private async prepare(generation: number) {
  if (this.stopped || this.departed || this.preparing || generation !== this.generation || !this.state.latest) return;
  const scheduled = this.state.latest.build;
  const before = this.d.safety();
  if (before.blockers.length) { this.emit("waiting", `Update waiting: ${before.blockers.join("; ")}.`); return; }
  this.preparing = true;
  try {
   // Re-read the alias and authoritative pending work, rather than trusting the earlier poll.
   const verified = await this.d.read();
   if (this.stopped || !this.accept(verified)) return;
   if (verified.build !== scheduled) { this.firstSeen(verified.build); this.known = verified.build; this.generation++; this.emit("available", "A newer deployment went live during verification. It will load once it has settled."); return; }
   const serverBlockers = await this.d.serverSafety();
   const previous = this.journal();
   const attempts = previous?.target === verified.build && this.now() - Date.parse(previous.at) < 30 * 60_000 ? previous.attempts + 1 : 1;
   if (attempts > 2) {
    const message = "The new build did not load after two attempts. This register keeps working on its current version and retries in 30 minutes; do not clear saved orders.";
    this.blocked = { build: verified.build, until: Date.parse(previous!.at) + 30 * 60_000, message };
    this.emit("blocked", message); this.log("app.update_blocked", { target: verified.build, attempts: attempts - 1 }); return;
   }
   // Stage the target on the device while the register keeps working.  A target that
   // cannot be staged is not attempted: the register stays on its current build.
   if (this.d.stage && !(await this.d.stage(verified))) { if (!this.stopped) this.emit("waiting", "Update waiting: the new version could not be saved on this register yet (connection). It will try again."); return; }
   const final = this.d.safety();
   if (this.stopped || generation !== this.generation) return;
   if (serverBlockers.length || final.blockers.length || final.revision !== before.revision) { this.emit("waiting", `Update waiting: ${[...serverBlockers,...final.blockers, ...(final.revision !== before.revision ? ["register activity changed during verification"] : [])].join("; ")}.`); return; }
   if (!this.d.persist()) { this.emit("blocked", "Saved register state could not be verified. Restore device storage before updating."); return; }
   const journal: Journal = { target: verified.build, attempts, at: new Date(this.now()).toISOString(), reason: this.reason };
   this.d.put(UPDATE_JOURNAL, JSON.stringify(journal));
   // No asynchronous work after this last safety check. A new payment cannot race the reload timer.
   const last = this.d.safety();
   if (last.blockers.length || last.revision !== final.revision) { this.emit("waiting", "Register activity changed. The update will wait."); return; }
   try { this.d.put(UPDATE_HISTORY, JSON.stringify([...this.history().filter(at => this.now() - at < HOUR), this.now()])); } catch { /* the cap is best effort; the journal still bounds attempts */ }
   this.departed = true; this.state.lastReload = journal; this.emit("reloading", "Loading the verified application build…");
   this.log("app.reload", { from: this.d.loaded.build, to: verified.build, attempt: attempts, reason: this.reason });
   this.armStall(verified.build);
   this.d.reload(verified.build);
  } catch { if (!this.stopped) this.emit("offline", "Update verification could not finish. Check the connection or sign-in; no reload was attempted."); }
  finally { this.preparing = false; }
 }
 /** The page should be gone by now. If it isn't, the reload stalled: resume checking (attempts stay bounded). */
 private armStall(target: string) {
  if (this.stallTimer !== undefined) clearTimeout(this.stallTimer);
  this.stallTimer = setTimeout(() => { this.stallTimer = undefined; this.resume(target, "timeout"); }, this.d.stallMs ?? STALL_MS);
 }
 /** Called on a stall timeout, or when this same page is shown again (back/forward cache). */
 resume(target = this.state.lastReload?.target ?? "", cause = "page shown again") {
  if (this.stopped || !this.departed) return;
  this.departed = false;
  if (this.stallTimer !== undefined) { clearTimeout(this.stallTimer); this.stallTimer = undefined; }
  this.log("app.reload_stalled", { target, loaded: this.d.loaded.build, cause });
  this.known = undefined;
  this.emit("available", "The update did not finish loading. This register keeps working and will retry when it is safe.");
  void this.check();
 }
 stop() { this.stopped = true; this.generation++; this.cancel(); if (this.stallTimer !== undefined) clearTimeout(this.stallTimer); }
}
