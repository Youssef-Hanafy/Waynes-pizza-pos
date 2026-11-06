import { describe, expect, it, vi } from "vitest";
import type { OpenOrder } from "@/lib/orders/status";
import { createOpenOrdersFeed } from "./open-orders";

const order = { id: "first" } as OpenOrder;
describe("shared open-order feed", () => {
  it("deduplicates concurrent readers and delivers one result to every subscriber", async () => {
    let resolve!: (value: OpenOrder[]) => void;
    const read = vi.fn(() => new Promise<OpenOrder[]>(done => { resolve = done; }));
    const feed = createOpenOrdersFeed(read);
    const first = vi.fn(), second = vi.fn();
    feed.subscribe(first); feed.subscribe(second);
    const a = feed.refresh(), b = feed.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    resolve([order]); await Promise.all([a, b]);
    expect(feed.get().orders).toEqual([order]);
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
  });
  it("reads again when an action changes orders during an in-flight read", async () => {
    let resolve!: (value: OpenOrder[]) => void;
    const updated = { ...order, id: "updated" };
    const read = vi.fn().mockImplementationOnce(() => new Promise<OpenOrder[]>(done => { resolve = done; })).mockResolvedValue([updated]);
    const feed = createOpenOrdersFeed(read);
    const first = feed.refresh();
    const action = feed.refresh(true);
    resolve([order]); await Promise.all([first, action]);
    expect(read).toHaveBeenCalledTimes(2); expect(feed.get().orders).toEqual([updated]);
  });
  it("keeps the previous orders on failure, then recovers without losing subscriptions", async () => {
    const read = vi.fn().mockResolvedValueOnce([order]).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([]);
    const feed = createOpenOrdersFeed(read);
    await feed.refresh(); await feed.refresh();
    expect(feed.get()).toMatchObject({ orders: [order], loaded: true, error: "offline" });
    await feed.refresh(); expect(feed.get()).toMatchObject({ orders: [], loaded: true, error: "" });
  });
});
