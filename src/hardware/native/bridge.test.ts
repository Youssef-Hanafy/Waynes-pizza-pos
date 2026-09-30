import { describe, expect, it } from "vitest";
import { createAndroidHardware, createPacketInterpreter, type WaynesAndroidInterface } from "./bridge";

const ring = (line: string, phase: "S" | "E", number: string) => `^^<U>000001<S>000002$${line} I ${phase} 0000 G A2 12/17 04:54 PM ${number} SMITH JOHN`;

describe("Android caller ID packets (build sheet §17, §52)", () => {
  it("turns a start record into a call, and keeps one id for repeated packets", () => {
    const interpret = createPacketInterpreter();
    const first = interpret(ring("01", "S", "508-555-1234"), "192.168.88.20", Date.parse("2026-09-20T22:42:00Z"));
    expect(first).toMatchObject({ line: 1, phoneNumber: "5085551234", callerName: "SMITH JOHN", deviceId: "1" });
    const repeat = interpret(ring("01", "S", "508-555-1234"), "192.168.88.20", Date.parse("2026-09-20T22:42:01Z"));
    expect(repeat!.id).toBe(first!.id);
  });

  it("gives a call back after hang-up its own id, and never pops an end record", () => {
    const interpret = createPacketInterpreter();
    const first = interpret(ring("02", "S", "5085551234"), "x", 0)!;
    expect(interpret(ring("02", "E", "5085551234"), "x", 1000)).toBeNull();
    const again = interpret(ring("02", "S", "5085551234"), "x", 20_000)!;
    expect(again.id).not.toBe(first.id);
  });

  it("ignores packets that are not caller ID records", () => {
    expect(createPacketInterpreter()("hello", "x", 0)).toBeNull();
  });

  it("adapts the Android app's callbacks to promises, keeping 'never connected' apart from other failures", async () => {
    const calls: string[] = [];
    const android: WaynesAndroidInterface = {
      info: () => "{}",
      printerSend: (id, host) => { calls.push(id); queueMicrotask(() => target.__waynesNativeResult?.(id, host === "10.10.10.161", host === "10.10.10.161" ? "" : "NOT_CONNECTED", "Printer is not answering.")); },
      callerIdStart: (id) => queueMicrotask(() => target.__waynesNativeResult?.(id, true, "", "")),
      callerIdStop: (id) => queueMicrotask(() => target.__waynesNativeResult?.(id, true, "", "")),
      callerIdStatus: () => JSON.stringify({ state: "listening", detail: "UDP 0.0.0.0:3520" }),
    };
    const target = {} as Window;
    const hardware = createAndroidHardware(android, target);
    await hardware.printer!.send({ host: "10.10.10.161", port: 9100, data: "AA==" });
    const failure = await hardware.printer!.send({ host: "10.10.10.99", port: 9100, data: "AA==" }).then(() => null, (error: Error & { code?: string }) => error);
    expect(failure?.code).toBe("NOT_CONNECTED");
    expect(failure?.message).toBe("Printer is not answering.");
    expect(new Set(calls).size).toBe(2);
    await hardware.callerId!.start({ port: 3520, bindAddress: "0.0.0.0" });
    expect(await hardware.callerId!.status()).toEqual({ state: "listening", detail: "UDP 0.0.0.0:3520" });
    const seen: string[] = [];
    const off = hardware.callerId!.onCall((call) => seen.push(call.phoneNumber));
    target.__waynesNativePacket?.(ring("01", "S", "508-555-1234"), "10.10.10.50", 0);
    off();
    target.__waynesNativePacket?.(ring("02", "S", "508-555-9999"), "10.10.10.50", 0);
    expect(seen).toEqual(["5085551234"]);
  });

  it("drives the Stripe M2: token from the page, prompts to the screen, the intent id back on approval", async () => {
    const tokens: [string, boolean, string][] = [];
    const android: WaynesAndroidInterface = {
      info: () => "{}",
      printerSend: () => undefined, callerIdStart: () => undefined, callerIdStop: () => undefined, callerIdStatus: () => "{}",
      stripeStatus: () => JSON.stringify({ state: "connected", serial: "STRM2-1", battery: 0.8 }),
      stripeConnect: (id, locationId) => queueMicrotask(() => target.__waynesNativeResult?.(id, locationId === "tml_1", "", "STRM2-1")),
      stripeCollect: (id, secret) => queueMicrotask(() => {
        target.__waynesStripeEvent?.("prompt", JSON.stringify({ text: "Tap, insert or swipe the card" }));
        if (secret === "pi_ok_secret_x") target.__waynesNativeResult?.(id, true, "", "pi_ok");
        else target.__waynesNativeResult?.(id, false, "DECLINED", "The card was declined. Try another card.");
      }),
      stripeCancel: (id) => queueMicrotask(() => target.__waynesNativeResult?.(id, true, "", "")),
      stripeDisconnect: (id) => queueMicrotask(() => target.__waynesNativeResult?.(id, true, "", "")),
      stripeTokenResult: (requestId, ok, value) => { tokens.push([requestId, ok, value]); },
    };
    const target = {} as Window;
    const stripe = createAndroidHardware(android, target).stripe!;
    expect(stripe.status()).toMatchObject({ state: "connected", serial: "STRM2-1" });
    expect(await stripe.connect({ locationId: "tml_1" })).toBe("STRM2-1");

    // The app asks for a connection token; the page answers with what the server gave it.
    target.__waynesStripeToken?.("r1");
    expect(tokens).toEqual([["r1", false, "The POS page is not ready to authorise the card reader."]]);
    stripe.setTokenSource(async () => "pst_live_secret");
    target.__waynesStripeToken?.("r2");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tokens[1]).toEqual(["r2", true, "pst_live_secret"]);

    const prompts: string[] = [];
    const off = stripe.onEvent((event) => { if (event.type === "prompt") prompts.push(event.text); });
    expect(await stripe.collect("pi_ok_secret_x")).toBe("pi_ok");
    const declined = await stripe.collect("pi_no_secret_y").then(() => null, (error: Error & { code?: string }) => error);
    off();
    expect(declined?.code).toBe("DECLINED");
    expect(prompts).toEqual(["Tap, insert or swipe the card", "Tap, insert or swipe the card"]);
  });

  it("leaves the card reader out for an older app without it", () => {
    const android: WaynesAndroidInterface = { info: () => "{}", printerSend: () => undefined, callerIdStart: () => undefined, callerIdStop: () => undefined, callerIdStatus: () => "{}" };
    expect(createAndroidHardware(android, {} as Window).stripe).toBeUndefined();
  });
});
