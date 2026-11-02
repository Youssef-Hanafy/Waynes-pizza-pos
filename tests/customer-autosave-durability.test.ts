import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ remember: vi.fn(), notify: vi.fn() }));
vi.mock("@/lib/pos/remember-customer", () => ({ rememberCustomer: mocks.remember }));
vi.mock("@/stores/draft-sync", () => ({ notify: mocks.notify }));
const key = "wayne.pos.pendingCustomerSaves.v1";
const payload = { phone: "5085550101", first_name: "First", last_name: "", email: "" };
let values: Map<string, string>;
beforeEach(() => {
  vi.resetModules(); mocks.remember.mockReset(); mocks.notify.mockReset();
  values = new Map();
  vi.stubGlobal("window", { localStorage: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v) }, addEventListener: vi.fn(), setInterval: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe("durable customer save coordination", () => {
  it("retains an unsaved customer through a long outage and saves after restart", async () => {
    values.set(key, JSON.stringify([{ payload, queuedAt: Date.now() - 7 * 24 * 60 * 60_000 }]));
    const store = await import("@/stores/customer-autosave");
    expect(store.readPendingSaves()).toHaveLength(1);
    mocks.remember.mockResolvedValue({ first_name: "First" });
    await store.flushCustomerSaves();
    expect(mocks.remember).toHaveBeenCalledWith(payload);
    expect(store.readPendingSaves()).toEqual([]);
  });

  it("persists before sending and serializes newer typing after an unacknowledged save", async () => {
    let finish!: (value: unknown) => void;
    mocks.remember.mockImplementationOnce(() => {
      expect(JSON.parse(values.get(key)!)[0].payload).toEqual(payload);
      return new Promise(resolve => { finish = resolve; });
    }).mockResolvedValueOnce({ first_name: "Latest" });
    const { saveCustomerQuietly, flushCustomerSaves, readPendingSaves } = await import("@/stores/customer-autosave");
    const first = saveCustomerQuietly(payload);
    const latest = saveCustomerQuietly({ ...payload, first_name: "Latest" });
    const flushing = flushCustomerSaves();
    expect(mocks.remember).toHaveBeenCalledTimes(1);
    expect(readPendingSaves()[0].payload.first_name).toBe("Latest");
    finish({ first_name: "First" });
    await Promise.all([first, latest, flushing]);
    expect(mocks.remember.mock.calls.map(([p]) => p.first_name)).toEqual(["First", "Latest"]);
    expect(readPendingSaves()).toEqual([]);
  });

  it("a failed older request retains the newer payload across a page restart", async () => {
    let fail!: (reason: Error) => void;
    mocks.remember.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    const store = await import("@/stores/customer-autosave");
    const first = store.saveCustomerQuietly(payload);
    store.saveCustomerQuietly({ ...payload, first_name: "Latest" });
    fail(new Error("offline")); await first;
    vi.resetModules();
    const restarted = await import("@/stores/customer-autosave");
    expect(restarted.readPendingSaves()[0].payload.first_name).toBe("Latest");
    mocks.remember.mockResolvedValue({ first_name: "Latest" });
    await restarted.flushCustomerSaves();
    expect(restarted.readPendingSaves()).toEqual([]);
  });
});
