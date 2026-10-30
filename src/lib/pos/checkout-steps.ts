/**
 * The customer-screen steps of a card checkout (owner, 2026-10-11): a tip before
 * the card is run, a signature after it is approved.  Kept free of React so the
 * order of events (customer answers, slow saves, cashier taps) can be tested.
 */

export type CustomerAnswer = Record<string, unknown>;

export type TipRouteInput = { screenOnline: boolean; tipAsked: boolean; paidBefore: number };

/** Card reader checkout: ask for the tip on the customer screen first, or go straight to the card. */
export function tipRoute(input: TipRouteInput): "screen" | "card" {
  return input.screenOnline && !input.tipAsked && !input.paidBefore ? "screen" : "card";
}
export type CustomerRequest = { answer: Promise<CustomerAnswer | null>; cancel: () => void };

export type TipView =
  | { stage: "waiting" }
  | { stage: "saving"; tipCents: number }
  | { stage: "failed"; tipCents: number; error: string };

export type TipStepOptions = {
  orderTotalCents: number;
  /** Shows the tip choice on the customer screen. */
  ask: () => CustomerRequest;
  /** Saves the tip on the order; resolves with the order's new total. */
  saveTip: (tipCents: number) => Promise<{ total_cents: number }>;
  /** Puts "please pay" (and the total) on the customer screen. */
  showPay: (totalCents: number, tipCents: number) => void;
  /** The tip step is over: the card is run for this total. */
  onDone: (totalCents: number) => void;
  onView: (view: TipView) => void;
};

export type TipStep = { skip: () => void; chargeWithoutTip: () => void; stop: () => void };

export function startTipStep(options: TipStepOptions): TipStep {
  const total = options.orderTotalCents;
  let done = false;
  let alive = true;
  const request = options.ask();
  void request.answer.then(async (answer) => {
    if (!alive || done) return;
    if (!answer || typeof answer.tip_cents !== "number") { done = true; options.onDone(total); return; }
    const tip = Math.max(0, Math.round(answer.tip_cents));
    if (tip === 0) { done = true; options.onDone(total); return; }
    options.onView({ stage: "saving", tipCents: tip });
    try {
      const body = await options.saveTip(tip);
      options.showPay(body.total_cents, tip);
      done = true;
      options.onDone(body.total_cents);
    } catch (cause) {
      options.onView({ stage: "failed", tipCents: tip, error: cause instanceof Error ? cause.message : "The tip could not be added." });
    }
  });
  return {
    skip() { done = true; request.cancel(); options.showPay(total, 0); options.onDone(total); },
    chargeWithoutTip() { done = true; options.onDone(total); },
    stop() { alive = false; request.cancel(); },
  };
}

export type SignView = { stage: "waiting" } | { stage: "saving" };

export type SignStepOptions = {
  ask: () => CustomerRequest;
  saveSignature: (svg: string) => Promise<unknown>;
  /** "Thank you" on the customer screen. */
  thank: () => void;
  /** The checkout is over (the card was already approved before this step). */
  onFinished: () => void;
  onView: (view: SignView) => void;
};

export type SignStep = { skip: () => void; stop: () => void };

export function startSignStep(options: SignStepOptions): SignStep {
  let finished = false;
  let alive = true;
  const request = options.ask();
  void request.answer.then(async (answer) => {
    if (!alive || finished) return;
    if (answer && typeof answer.signature_svg === "string") {
      options.onView({ stage: "saving" });
      await options.saveSignature(answer.signature_svg).catch(() => undefined);
    }
    finished = true;
    options.thank();
    options.onFinished();
  });
  return {
    skip() { finished = true; request.cancel(); options.thank(); options.onFinished(); },
    stop() { alive = false; request.cancel(); },
  };
}
