/**
 * The customer-screen steps of a card checkout (owner, 2026-10-11): a tip before
 * the card is run, a signature after it is approved.  Kept free of React so the
 * order of events (customer answers, slow saves, cashier taps) can be tested.
 */

export type CustomerAnswer = Record<string, unknown>;

export type TipRoute = "screen" | "card";
export type TipRouteInput = {
  screenOnline: boolean;
  /** A screen answered this register in the last couple of minutes: it is reconnecting, not missing. */
  recentlyOnline: boolean;
  tipAsked: boolean;
  paidBefore: number;
  /** The route this checkout already took. It is kept until the tip is settled. */
  current: TipRoute | null;
};

/**
 * Card reader checkout: ask for the tip on the customer screen first, or go
 * straight to the card.  Decided once per checkout (owner, 2026-10-29: a
 * connection blip must never skip a tip the customer hasn't answered, and a
 * card already on the reader is never swapped back for the tip screen).
 */
export function tipRoute(input: TipRouteInput): TipRoute {
  if (input.tipAsked || input.paidBefore) return "card";
  if (input.current) return input.current;
  return input.screenOnline || input.recentlyOnline ? "screen" : "card";
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
  /** The tip step is over: the card is run for this total. Called at most once. */
  onDone: (totalCents: number) => void;
  onView: (view: TipView) => void;
};

export type TipStep = { skip: () => void; chargeWithoutTip: () => void; retry: () => void; stop: () => void };

/**
 * The tip step settles exactly once (owner, 2026-10-29: a slow tip save and a
 * Skip tap completed one checkout at $20 and again at $25).  While a tip is
 * being saved nothing else can settle it, and once a save has been tried the
 * total comes from the server: going on without the tip first sets it to $0
 * there, because a save that timed out may still have been written.
 */
export function startTipStep(options: TipStepOptions): TipStep {
  let settled = false;
  let alive = true;
  let saving = false;
  let lastTried: number | null = null;
  const request = options.ask();

  const settle = (totalCents: number, payTipCents: number | null) => {
    if (settled) return;
    settled = true;
    request.cancel();
    if (payTipCents !== null) options.showPay(totalCents, payTipCents);
    options.onDone(totalCents);
  };

  const save = async (tip: number) => {
    if (settled || saving) return;
    saving = true;
    lastTried = tip;
    options.onView({ stage: "saving", tipCents: tip });
    try {
      const body = await options.saveTip(tip);
      saving = false;
      // Settled even if the step has left the screen: the order on the server now holds this total.
      settle(body.total_cents, tip);
    } catch (cause) {
      saving = false;
      if (settled) return;
      options.onView({ stage: "failed", tipCents: tip, error: cause instanceof Error ? cause.message : "The tip could not be added." });
    }
  };

  /** Go on with no tip.  Before any save was tried the order total is still right; after one, confirm $0 with the server. */
  const withoutTip = () => {
    if (settled || saving) return;
    if (lastTried !== null) { void save(0); return; }
    settle(options.orderTotalCents, 0);
  };

  void request.answer.then((answer) => {
    if (!alive || settled || saving || lastTried !== null) return;
    if (!answer || typeof answer.tip_cents !== "number") { settle(options.orderTotalCents, null); return; }
    const tip = Math.max(0, Math.round(answer.tip_cents));
    if (tip === 0) { settle(options.orderTotalCents, null); return; }
    void save(tip);
  });

  return {
    skip: withoutTip,
    chargeWithoutTip: withoutTip,
    retry() { if (lastTried !== null) void save(lastTried); },
    stop() { alive = false; request.cancel(); },
  };
}

export type SignView = { stage: "waiting" } | { stage: "saving" } | { stage: "failed"; error: string };

export type SignStepOptions = {
  ask: () => CustomerRequest;
  /** Saves the signature with the order; must throw when it was not saved. */
  saveSignature: (svg: string) => Promise<unknown>;
  /** "Thank you" on the customer screen. */
  thank: () => void;
  /** The checkout is over (the card was already approved before this step). Called at most once. */
  onFinished: () => void;
  onView: (view: SignView) => void;
};

export type SignStep = { skip: () => void; retry: () => void; stop: () => void };

/**
 * The signature step (owner, 2026-10-29: a signature save answered 503 and the
 * checkout still said Thank you).  A failed save is shown to the cashier, who
 * can save the same signature again or finish without it.  The card was
 * approved before this step: nothing here charges it again.
 */
export function startSignStep(options: SignStepOptions): SignStep {
  let finished = false;
  let alive = true;
  let saving = false;
  let signature: string | null = null;
  const request = options.ask();

  const finish = () => {
    if (finished) return;
    finished = true;
    request.cancel();
    options.thank();
    options.onFinished();
  };

  const save = async () => {
    if (!signature || finished || saving) return;
    saving = true;
    options.onView({ stage: "saving" });
    try {
      await options.saveSignature(signature);
      saving = false;
      // Left the screen meanwhile (the cashier moved on): the signature is kept, but nothing is finished from here.
      if (alive) finish();
    } catch (cause) {
      saving = false;
      if (!alive || finished) return;
      options.onView({ stage: "failed", error: cause instanceof Error ? cause.message : "The signature could not be saved." });
    }
  };

  void request.answer.then((answer) => {
    if (!alive || finished || signature) return;
    if (answer && typeof answer.signature_svg === "string") { signature = answer.signature_svg; void save(); return; }
    finish();
  });

  return {
    skip() { if (!saving) finish(); },
    retry() { void save(); },
    stop() { alive = false; request.cancel(); },
  };
}
