import { describe, expect, it, vi } from "vitest";
import { startSignStep, startTipStep, tipRoute, type CustomerAnswer, type CustomerRequest } from "./checkout-steps";

/**
 * Customer-screen checkout (tip before the card, signature after it).  Every test
 * drives the real step logic with a fake customer screen and fake saves whose
 * answers arrive when the test says so: slow saves, failures, repeated taps.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

/** A customer screen request the test answers (or the step cancels). */
function fakeScreen() {
  const asks: Array<{ answer: (value: CustomerAnswer | null) => void; cancelled: boolean }> = [];
  const ask = vi.fn((): CustomerRequest => {
    const pending = deferred<CustomerAnswer | null>();
    const entry = { answer: pending.resolve, cancelled: false };
    asks.push(entry);
    return { answer: pending.promise, cancel: () => { entry.cancelled = true; pending.resolve(null); } };
  });
  return { ask, asks };
}

function tipHarness(orderTotalCents = 2000) {
  const screen = fakeScreen();
  const saves: Array<{ tip: number; reply: ReturnType<typeof deferred<{ total_cents: number }>> }> = [];
  const saveTip = vi.fn((tip: number) => { const reply = deferred<{ total_cents: number }>(); saves.push({ tip, reply }); return reply.promise; });
  const onDone = vi.fn();
  const showPay = vi.fn();
  const views: unknown[] = [];
  const step = startTipStep({ orderTotalCents, ask: screen.ask, saveTip, showPay, onDone, onView: (view) => views.push(view) });
  return { step, screen, saves, saveTip, onDone, showPay, views };
}

describe("tip on the customer screen", () => {
  it("a slow tip save and a Skip tap never complete the checkout twice or with two totals", async () => {
    const h = tipHarness(2000);
    h.screen.asks[0]!.answer({ request_id: "r1", kind: "tip", tip_cents: 500 });
    await flush();
    expect(h.saveTip).toHaveBeenCalledWith(500);
    h.step.skip(); // the cashier taps Skip tip while the tip is still being saved
    h.step.skip();
    h.saves[0]!.reply.resolve({ total_cents: 2500 }); // the delayed save lands
    await flush();
    expect(h.onDone).toHaveBeenCalledTimes(1);
    expect(h.onDone).toHaveBeenCalledWith(2500); // the order on the server is $25: the card is run for $25
  });

  it("Skip before the customer answers completes once at the order total and cancels the request", async () => {
    const h = tipHarness(2000);
    h.step.skip();
    h.step.skip();
    await flush();
    expect(h.onDone).toHaveBeenCalledTimes(1);
    expect(h.onDone).toHaveBeenCalledWith(2000);
    expect(h.screen.asks[0]!.cancelled).toBe(true);
    expect(h.saveTip).not.toHaveBeenCalled();
  });

  it("a failed tip save then 'Charge without the tip' sets the tip back to $0 on the server and uses the server's total", async () => {
    const h = tipHarness(2000);
    h.screen.asks[0]!.answer({ request_id: "r1", kind: "tip", tip_cents: 500 });
    await flush();
    h.saves[0]!.reply.reject(new Error("The tip could not be added."));
    await flush();
    expect(h.views.at(-1)).toMatchObject({ stage: "failed", tipCents: 500, error: "The tip could not be added." });
    h.step.chargeWithoutTip();
    await flush();
    // The first save timed out: it may have been written.  Never run the card while the server could still hold the $5.
    expect(h.saveTip).toHaveBeenLastCalledWith(0);
    expect(h.onDone).not.toHaveBeenCalled();
    h.saves[1]!.reply.resolve({ total_cents: 2000 });
    await flush();
    expect(h.onDone).toHaveBeenCalledTimes(1);
    expect(h.onDone).toHaveBeenCalledWith(2000);
  });

  it("a failed tip save can be tried again, and completes once with the saved total", async () => {
    const h = tipHarness(2000);
    h.screen.asks[0]!.answer({ request_id: "r1", kind: "tip", tip_cents: 300 });
    await flush();
    h.saves[0]!.reply.reject(new Error("offline"));
    await flush();
    h.step.retry();
    h.step.retry(); // repeated taps
    await flush();
    expect(h.saveTip).toHaveBeenCalledTimes(2);
    h.saves[1]!.reply.resolve({ total_cents: 2300 });
    await flush();
    expect(h.onDone).toHaveBeenCalledTimes(1);
    expect(h.onDone).toHaveBeenCalledWith(2300);
    expect(h.showPay).toHaveBeenCalledWith(2300, 300);
  });

  it("a $0 tip or a cancelled request completes once at the order total without a save", async () => {
    const h = tipHarness(1800);
    h.screen.asks[0]!.answer({ request_id: "r1", kind: "tip", tip_cents: 0 });
    await flush();
    expect(h.onDone).toHaveBeenCalledTimes(1);
    expect(h.onDone).toHaveBeenCalledWith(1800);
    expect(h.saveTip).not.toHaveBeenCalled();
  });

  it("a tip saved after the step was closed still reports the server's total (the order holds the tip)", async () => {
    const h = tipHarness(2000);
    h.screen.asks[0]!.answer({ request_id: "r1", kind: "tip", tip_cents: 500 });
    await flush();
    h.step.stop(); // the tip step left the screen (unmount)
    h.saves[0]!.reply.resolve({ total_cents: 2500 });
    await flush();
    expect(h.onDone).toHaveBeenCalledTimes(1);
    expect(h.onDone).toHaveBeenCalledWith(2500);
  });

  it("a customer answer arriving after the step was closed is ignored", async () => {
    const h = tipHarness(2000);
    h.step.stop();
    h.screen.asks[0]!.answer({ request_id: "r1", kind: "tip", tip_cents: 500 });
    await flush();
    expect(h.saveTip).not.toHaveBeenCalled();
    expect(h.onDone).not.toHaveBeenCalled();
  });
});

describe("which step the card reader checkout shows", () => {
  it("a tip request already on the customer screen stays there through a connection blip", () => {
    const shown = tipRoute({ screenOnline: true, recentlyOnline: true, tipAsked: false, paidBefore: 0, current: null });
    expect(shown).toBe("screen");
    // The next render after one failed heartbeat: the tip must not be bypassed silently.
    expect(tipRoute({ screenOnline: false, recentlyOnline: true, tipAsked: false, paidBefore: 0, current: shown })).toBe("screen");
  });

  it("a card step already running is never swapped for the tip screen when the screen comes back", () => {
    const shown = tipRoute({ screenOnline: false, recentlyOnline: false, tipAsked: false, paidBefore: 0, current: null });
    expect(shown).toBe("card");
    expect(tipRoute({ screenOnline: true, recentlyOnline: true, tipAsked: false, paidBefore: 0, current: shown })).toBe("card");
  });

  it("a screen that was online moments ago still gets the tip step (it is reconnecting)", () => {
    expect(tipRoute({ screenOnline: false, recentlyOnline: true, tipAsked: false, paidBefore: 0, current: null })).toBe("screen");
  });

  it("no customer screen at all, a tip already chosen, or a balance after a payment go straight to the card", () => {
    expect(tipRoute({ screenOnline: false, recentlyOnline: false, tipAsked: false, paidBefore: 0, current: null })).toBe("card");
    expect(tipRoute({ screenOnline: true, recentlyOnline: true, tipAsked: true, paidBefore: 0, current: "screen" })).toBe("card");
    expect(tipRoute({ screenOnline: true, recentlyOnline: true, tipAsked: false, paidBefore: 500, current: null })).toBe("card");
  });
});

function signHarness() {
  const screen = fakeScreen();
  const saves: Array<{ svg: string; reply: ReturnType<typeof deferred<unknown>> }> = [];
  const saveSignature = vi.fn((svg: string) => { const reply = deferred<unknown>(); saves.push({ svg, reply }); return reply.promise; });
  const thank = vi.fn();
  const onFinished = vi.fn();
  const views: unknown[] = [];
  const step = startSignStep({ ask: screen.ask, saveSignature, thank, onFinished, onView: (view) => views.push(view) });
  return { step, screen, saves, saveSignature, thank, onFinished, views };
}
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1L9 9"/></svg>';

describe("signature on the customer screen", () => {
  it("a signature save that fails (HTTP 503) is reported, and the checkout does not say Thank you", async () => {
    const h = signHarness();
    h.screen.asks[0]!.answer({ request_id: "s1", kind: "signature", signature_svg: SVG });
    await flush();
    h.saves[0]!.reply.reject(new Error("The signature could not be saved. (503)"));
    await flush();
    expect(h.thank).not.toHaveBeenCalled();
    expect(h.onFinished).not.toHaveBeenCalled();
    expect(h.views.at(-1)).toMatchObject({ stage: "failed", error: "The signature could not be saved. (503)" });
  });

  it("retrying a failed signature saves the same signature again and finishes once; nothing else is sent", async () => {
    const h = signHarness();
    h.screen.asks[0]!.answer({ request_id: "s1", kind: "signature", signature_svg: SVG });
    await flush();
    h.saves[0]!.reply.reject(new Error("503"));
    await flush();
    h.step.retry();
    h.step.retry(); // repeated taps
    await flush();
    expect(h.saveSignature).toHaveBeenCalledTimes(2);
    expect(h.saves[1]!.svg).toBe(SVG);
    h.saves[1]!.reply.resolve({ saved: true });
    await flush();
    expect(h.thank).toHaveBeenCalledTimes(1);
    expect(h.onFinished).toHaveBeenCalledTimes(1);
    expect(h.screen.ask).toHaveBeenCalledTimes(1); // the customer isn't asked to sign again
  });

  it("finishing without a saved signature is an explicit cashier choice, once", async () => {
    const h = signHarness();
    h.screen.asks[0]!.answer({ request_id: "s1", kind: "signature", signature_svg: SVG });
    await flush();
    h.saves[0]!.reply.reject(new Error("503"));
    await flush();
    h.step.skip();
    h.step.skip();
    await flush();
    expect(h.onFinished).toHaveBeenCalledTimes(1);
    expect(h.thank).toHaveBeenCalledTimes(1);
  });

  it("Skip signature while the signature is being saved never finishes the checkout twice", async () => {
    const h = signHarness();
    h.screen.asks[0]!.answer({ request_id: "s1", kind: "signature", signature_svg: SVG });
    await flush();
    h.step.skip();
    h.saves[0]!.reply.resolve({ saved: true });
    await flush();
    expect(h.onFinished).toHaveBeenCalledTimes(1);
    expect(h.thank).toHaveBeenCalledTimes(1);
  });

  it("a saved signature thanks the customer and finishes once", async () => {
    const h = signHarness();
    h.screen.asks[0]!.answer({ request_id: "s1", kind: "signature", signature_svg: SVG });
    await flush();
    h.saves[0]!.reply.resolve({ saved: true });
    await flush();
    expect(h.thank).toHaveBeenCalledTimes(1);
    expect(h.onFinished).toHaveBeenCalledTimes(1);
  });

  it("closing the step while a signature is saving finishes nothing afterwards", async () => {
    const h = signHarness();
    h.screen.asks[0]!.answer({ request_id: "s1", kind: "signature", signature_svg: SVG });
    await flush();
    h.step.stop();
    h.saves[0]!.reply.resolve({ saved: true });
    await flush();
    expect(h.onFinished).not.toHaveBeenCalled();
  });
});
