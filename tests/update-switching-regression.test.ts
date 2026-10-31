import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RELOADS_PER_HOUR, SETTLE_MS, STALL_MS, UPDATE_HISTORY, UpdateManager, type UpdateDependencies } from "../src/lib/pos/update-manager";
import type { Release } from "../src/lib/pos/release";

/**
 * Regression: the Elo switched between old and new screens after two quick
 * releases (owner, 2026-10-31).  Production evidence: three deployments went live
 * within six minutes (22:12, 22:13, 22:18Z), the Elo's update reload was followed by
 * 45 minutes of work with no update activity at all, and no register had ever
 * logged app.reload / app.update_confirmed.
 */
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 31, 22, 0) + minutes * 60_000).toISOString();
const release = (build: string, minutes: number): Release => ({ build, commit: "a".repeat(40), builtAt: at(minutes), contract: 1, minimumClient: 0, minimumBridge: 1 });
const A = release("A", -1440);

/** `stays`: the reload does not replace the page (stall scenarios). Otherwise the page goes away, like a real reload. */
function fixture(options: Partial<UpdateDependencies> & { stays?: boolean } = {}) {
  vi.useFakeTimers({ now: Date.parse(at(0)) });
  const local = new Map<string, string>();
  let next = release("B", 0);
  const reload = vi.fn(); const logs: { kind: string; detail: Record<string, unknown> }[] = [];
  const d: UpdateDependencies = {
    loaded: A, read: async () => next, safety: () => ({ blockers: [], revision: 0 }), serverSafety: async () => [], bridge: () => 1, persist: () => true,
    get: (key) => local.get(key) ?? null, put: (key, value) => { local.set(key, value); }, reload, changed: vi.fn(),
    log: (kind, detail) => { logs.push({ kind, detail }); }, ...options,
  };
  const manager = new UpdateManager(d);
  if (!options.stays) d.reload = (build) => { reload(build); manager.stop(); };
  /** Advance fake time the way the page does: a safety tick every second, a poll every minute. */
  const run = async (ms: number) => { for (let gone = 0; gone < ms; gone += 1000) { await vi.advanceTimersByTimeAsync(1000); manager.tick(); if (gone % 60_000 === 0) await manager.check(); } };
  return { manager, d, reload, logs, local, run, deploy: (r: Release) => { next = r; } };
}
afterEach(() => vi.useRealTimers());

describe("old/new switching regressions (2026-10-31)", () => {
  it("settle: a fresh deployment is not loaded until it has stayed live for the settle window", async () => {
    const f = fixture();
    await f.manager.check();
    await f.run(SETTLE_MS - 5_000);
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.manager.state.status).toBe("waiting");
    await f.run(10_000);
    expect(f.reload).toHaveBeenCalledExactlyOnceWith("B");
  });

  it("three deployments in six minutes are ONE screen change, straight to the newest", async () => {
    const f = fixture();
    await f.manager.check();
    await f.run(60_000); f.deploy(release("C", 1));
    await f.run(60_000); f.deploy(release("D", 6));
    await f.run(6 * 60_000);
    expect(f.reload.mock.calls).toEqual([["D"]]);
  });

  it("the alias moving on during verification never reloads onto the superseded build", async () => {
    const f = fixture({ settleMs: 0 });
    let reads = 0;
    f.d.read = async () => (++reads >= 2 ? release("C", 1) : release("B", 0));
    await f.manager.check();
    await vi.advanceTimersByTimeAsync(901);
    expect(f.reload).not.toHaveBeenCalled();
    f.manager.tick(); await vi.advanceTimersByTimeAsync(901);
    expect(f.reload).toHaveBeenCalledExactlyOnceWith("C");
  });

  it("a restart does not restart the settle clock for a build already seen", async () => {
    const f = fixture();
    await f.manager.check();
    await f.run(SETTLE_MS / 2);
    f.manager.stop();
    const restarted = new UpdateManager(f.d);
    await restarted.check();
    for (let i = 0; i < SETTLE_MS / 2 / 1000 + 5; i++) { await vi.advanceTimersByTimeAsync(1000); restarted.tick(); }
    expect(f.reload).toHaveBeenCalledExactlyOnceWith("B");
  });

  it("hourly cap: no more than MAX_RELOADS_PER_HOUR screen changes across different deployments", async () => {
    const f = fixture({ settleMs: 0 });
    const now = Date.now();
    f.local.set(UPDATE_HISTORY, JSON.stringify(Array.from({ length: MAX_RELOADS_PER_HOUR }, (_, i) => now - (10 - i) * 60_000)));
    await f.manager.check();
    await f.run(30_000);
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.manager.state.message).toMatch(/times this hour/);
    await f.run(55 * 60_000);
    expect(f.reload).toHaveBeenCalledExactlyOnceWith("B");
  });

  it("stage first: a target that cannot be saved on the device is not attempted, and no attempt is used up", async () => {
    let ok = false;
    const f = fixture({ settleMs: 0, stage: async () => ok });
    await f.manager.check();
    await f.run(5_000);
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.manager.state.message).toMatch(/could not be saved/);
    expect(f.local.get("wayne.pos.update-journal.v1")).toBeUndefined();
    ok = true;
    await f.run(5_000);
    expect(f.reload).toHaveBeenCalledExactlyOnceWith("B");
  });

  it("stage runs before the final safety check: work that starts while staging defers the reload", async () => {
    let busy = false;
    const f = fixture({ settleMs: 0, safety: () => ({ blockers: busy ? ["order open"] : [], revision: busy ? 1 : 0 }), stage: async () => { busy = true; return true; } });
    await f.manager.check();
    await vi.advanceTimersByTimeAsync(901);
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.manager.state.status).toBe("waiting");
  });

  it("stall: a reload that never replaced the page resumes checking (the Elo's silent dead end)", async () => {
    const f = fixture({ settleMs: 0, stays: true });
    await f.manager.check();
    await vi.advanceTimersByTimeAsync(901);
    expect(f.reload).toHaveBeenCalledTimes(1);
    expect(f.manager.state.status).toBe("reloading");
    await vi.advanceTimersByTimeAsync(STALL_MS + 10);
    expect(f.logs.map((l) => l.kind)).toContain("app.reload_stalled");
    expect(f.manager.state.status).not.toBe("reloading");
    f.manager.tick(); await vi.advanceTimersByTimeAsync(901);
    expect(f.reload).toHaveBeenCalledTimes(2);
    // Third stall → bounded: blocked, no third reload, and it says so.
    await vi.advanceTimersByTimeAsync(STALL_MS + 10);
    f.manager.tick(); await vi.advanceTimersByTimeAsync(901);
    expect(f.reload).toHaveBeenCalledTimes(2);
    expect(f.manager.state.status).toBe("blocked");
    expect(f.logs.map((l) => l.kind)).toContain("app.update_blocked");
  });

  it("blocked after two failed attempts recovers by itself after the 30-minute window (no permanent old build)", async () => {
    const f = fixture({ settleMs: 0, stays: true });
    await f.manager.check(); await vi.advanceTimersByTimeAsync(901);
    await vi.advanceTimersByTimeAsync(STALL_MS + 10); f.manager.tick(); await vi.advanceTimersByTimeAsync(901);
    await vi.advanceTimersByTimeAsync(STALL_MS + 10); f.manager.tick(); await vi.advanceTimersByTimeAsync(901);
    expect(f.manager.state.status).toBe("blocked");
    expect(f.reload).toHaveBeenCalledTimes(2);
    await f.run(31 * 60_000);
    expect(f.reload).toHaveBeenCalledTimes(3);
  });

  it("page shown again from the back/forward cache after leaving resumes instead of staying departed", async () => {
    const f = fixture({ settleMs: 0, stays: true });
    await f.manager.check(); await vi.advanceTimersByTimeAsync(901);
    f.manager.resume(undefined, "page restored from back/forward cache");
    expect(f.manager.state.status).not.toBe("reloading");
    expect(f.logs.at(-1)).toEqual({ kind: "app.reload_stalled", detail: expect.objectContaining({ cause: "page restored from back/forward cache" }) });
  });

  it("reload is logged durably BEFORE leaving the page", async () => {
    const order: string[] = [];
    const f = fixture({ settleMs: 0 });
    f.d.log = (kind) => order.push(kind);
    f.d.reload = () => order.push("reload");
    await f.manager.check(); await vi.advanceTimersByTimeAsync(901);
    expect(order).toEqual(["app.reload", "reload"]);
  });

  it("state does not churn on every server response for the same pending target", async () => {
    const changed = vi.fn();
    const f = fixture({ changed });
    await f.manager.check();
    const before = changed.mock.calls.length;
    for (let i = 0; i < 20; i++) await f.manager.check();
    expect(changed.mock.calls.length - before).toBeLessThanOrEqual(1);
  });
});
