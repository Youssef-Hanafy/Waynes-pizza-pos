import { describe, expect, it } from "vitest";
import { SimulatedCallerIdProvider } from "./caller-id/simulated-provider";
import { UnconfiguredCashDrawerProvider } from "./drawer/provider";
import { createHardwareEventBus } from "./event-bus";
import { ManualExternalTerminalProvider } from "./payments/provider";
import { UnconfiguredPrinterProvider } from "./printers/provider";
import type { HardwareEvent } from "./types";

describe("hardware layer (build sheet §4, §5, §18)", () => {
  it("delivers a simulated ring through the provider and the event bus", async () => {
    const bus = createHardwareEventBus();
    const provider = new SimulatedCallerIdProvider({ lineCount: 2 });
    provider.onIncomingCall((event) => bus.emit({ type: "caller.incoming", payload: event }));
    const received: HardwareEvent[] = [];
    bus.on("caller.incoming", (event) => received.push(event));
    await provider.start();
    const event = provider.simulate({ line: 1, phoneNumber: " 5085551111 ", callerName: "John Test" });
    expect(received).toEqual([{ type: "caller.incoming", payload: event }]);
    expect(event).toMatchObject({ line: 1, phoneNumber: "5085551111", callerName: "John Test", source: "simulated" });
    expect((await provider.getStatus()).state).toBe("simulated");
  });

  it("refuses a line the store does not have, and rings nothing while stopped", async () => {
    const provider = new SimulatedCallerIdProvider({ lineCount: 2 });
    expect(() => provider.simulate({ line: 1, phoneNumber: "5085551111" })).toThrow(/Start/);
    await provider.start();
    expect(() => provider.simulate({ line: 3, phoneNumber: "5085551111" })).toThrow(/not one of the store's 2 lines/);
  });

  it("keeps delivering to other listeners when one throws", () => {
    const bus = createHardwareEventBus();
    const seen: string[] = [];
    bus.subscribe(() => { throw new Error("broken screen"); });
    bus.subscribe((event) => seen.push(event.type));
    const original = console.error;
    console.error = () => undefined;
    bus.emit({ type: "caller.changed", payload: { serverCallId: null } });
    console.error = original;
    expect(seen).toEqual(["caller.changed"]);
  });

  it("never reports a print, a drawer kick or a card charge that did not happen", async () => {
    await expect(new UnconfiguredPrinterProvider("Receipt printer").printReceipt()).resolves.toEqual({ ok: false, reason: "Receipt printer is not configured.", notSent: true });
    await expect(new UnconfiguredCashDrawerProvider().open()).rejects.toThrow(/not connected/);
    const payment = await new ManualExternalTerminalProvider().beginPayment({ orderId: "o", orderNumber: "W000123", amountCents: 3284 });
    expect(payment).toEqual({ state: "awaiting_manual_confirmation", amountCents: 3284, instructions: "Run $32.84 on the card terminal for order W000123." });
  });
});
