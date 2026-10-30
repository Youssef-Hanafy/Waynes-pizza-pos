import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The register's link to the customer screen, driven with a fake clock and a
 * fake server: dropped heartbeats, another register taking the screen, and the
 * "Thank you" timer running into the next order.
 */
const { publish } = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock("@/lib/pos/customer-display-client", () => ({ publishCustomerDisplay: publish }));
vi.mock("@/stores/phone-store", () => ({ getTerminalLabel: () => "Register 1" }));

type Link = typeof import("./customer-display-link");
let link: Link;
let now = 0;
let timers: Array<{ at: number; fn: () => void; every?: number }> = [];

const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
/** Move the fake clock forward, running the register's timers (heartbeat every 500 ms) as it goes. */
async function advance(ms: number) {
  const end = now + ms;
  for (;;) {
    const next = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!next) break;
    now = next.at;
    if (next.every) next.at += next.every; else timers = timers.filter((timer) => timer !== next);
    next.fn();
    await flush();
  }
  now = end;
}
const online = (extra: Record<string, unknown> = {}) => ({ response: {}, screen_online: true, ...extra });
const lastState = () => (publish.mock.calls.at(-1)![0] as { state: Record<string, unknown> }).state;

beforeEach(async () => {
  now = 1_000_000;
  timers = [];
  publish.mockReset().mockResolvedValue(online());
  const fakeWindow = {
    setInterval: (fn: () => void, ms: number) => { timers.push({ at: now + ms, fn, every: ms }); return timers.length; },
    clearInterval: () => { timers = timers.filter((timer) => !timer.every); },
    setTimeout: (fn: () => void, ms: number) => { timers.push({ at: now + ms, fn }); return timers.length; },
    clearTimeout: () => undefined,
  };
  Object.assign(globalThis, { window: fakeWindow, document: { visibilityState: "visible" } });
  Date.now = () => now;
  vi.resetModules();
  link = await import("./customer-display-link");
  link.startCustomerDisplayLink();
  await flush();
});

describe("customer screen connection", () => {
  it("one dropped heartbeat does not mark the customer screen offline", async () => {
    expect(link.customerScreenSnapshot().screenOnline).toBe(true);
    publish.mockRejectedValueOnce(new Error("The customer screen could not be updated."));
    await advance(4_500);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(link.customerScreenSnapshot().screenOnline).toBe(true);
  });

  it("a register that can't reach the screen for a while does mark it offline, and remembers it was online", async () => {
    publish.mockRejectedValue(new Error("offline"));
    await advance(30_000);
    expect(link.customerScreenSnapshot().screenOnline).toBe(false);
    expect(link.customerScreenRecentlyOnline()).toBe(true);
    await advance(5 * 60_000);
    expect(link.customerScreenRecentlyOnline()).toBe(false);
  });

  it("the server saying the screen isn't polling is believed at once", async () => {
    publish.mockResolvedValue(online({ screen_online: false }));
    await advance(4_500);
    expect(link.customerScreenSnapshot().screenOnline).toBe(false);
  });

  it("a request still waiting is re-sent once the register reconnects, and its answer is delivered", async () => {
    const request = link.askCustomer({ phase: "tip", total_cents: 2000 });
    publish.mockRejectedValue(new Error("offline"));
    await advance(3_000);
    const requestId = lastState().request_id as string;
    publish.mockResolvedValue(online({ response: { request_id: requestId, kind: "tip", tip_cents: 300 } }));
    await advance(1_500);
    expect(lastState()).toMatchObject({ phase: "tip", request_id: requestId });
    await expect(request.answer).resolves.toMatchObject({ tip_cents: 300 });
  });
});

describe("two registers with the same name", () => {
  it("the register is told when another register has taken over its customer screen", async () => {
    link.askCustomer({ phase: "tip", total_cents: 2000 });
    publish.mockResolvedValue(online({ showing: false }));
    await advance(1_500);
    expect(link.customerScreenSnapshot().showing).toBe(false);
  });

  it("taking the screen back re-sends the waiting request as a real change", async () => {
    link.askCustomer({ phase: "sign", total_cents: 2000 });
    publish.mockResolvedValue(online({ showing: false }));
    await advance(1_500);
    publish.mockResolvedValue(online({ showing: true }));
    link.reclaimCustomerScreen();
    await advance(600);
    expect(publish.mock.calls.at(-1)![0]).toMatchObject({ changed: true, state: { phase: "sign" } });
    expect(link.customerScreenSnapshot().showing).toBe(true);
  });
});

describe("screen transitions", () => {
  it("the 'Thank you' timer never blanks the next order's ticket", async () => {
    link.thankCustomer(null);
    await advance(600);
    expect(lastState()).toMatchObject({ phase: "thanks" });
    link.showOnCustomerScreen({ phase: "order", order_number: "37", total_cents: 1500 });
    await advance(9_000); // the old thank-you timer fires in here
    expect(lastState()).toMatchObject({ phase: "order", order_number: "37" });
  });

  it("the 'Thank you' screen still returns to the welcome screen when nothing else happened", async () => {
    link.thankCustomer(250);
    await advance(9_000);
    expect(lastState()).toMatchObject({ phase: "idle" });
  });
});
