"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/menu/schemas";
import { cancelStripeReaderCollect, collectWithStripeReader, connectStripeReader, describeNativeApp, startStripeReader, stripeReaderLabels, useStripeReader } from "@/stores/stripe-reader";
import { uuid } from "@/lib/uuid";
import { logDevice } from "@/lib/pos/device-log";

async function readError(response: Response, fallback: string) {
  const body: unknown = await response.json().catch(() => null);
  return body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : fallback;
}

const post = (path: string, body: unknown) => fetch(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(25_000),
});

function Battery({ level, charging }: { level?: number | null; charging?: boolean | null }) {
  if (level === null || level === undefined) return null;
  const percent = Math.round(level * 100);
  return <span className={`text-xs font-bold ${percent < 20 && !charging ? "text-wayne-alert" : "text-wayne-muted"}`}>🔋 {percent}%{charging ? " charging" : ""}</span>;
}

/** Reader status + Connect, for More → Hardware and the Payments screen. */
export function StripeReaderStatus({ compact = false }: { compact?: boolean }) {
  const reader = useStripeReader();
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!startStripeReader()) logDevice("reader.unavailable", "The page has no card reader bridge from the app.", describeNativeApp()); }, []);

  if (!reader.available) return <p className="text-sm text-wayne-muted">The Stripe Reader M2 connects to the <strong>Wayne&apos;s POS Android app</strong> on the counter tablet over Bluetooth. Open the POS in the app to use it.</p>;
  const state = reader.status.state;
  const ready = state === "connected" || state === "collecting";
  const working = busy || state === "discovering" || state === "connecting" || state === "updating";
  return <div className={compact ? "" : "grid gap-2"}>
    <div className="flex flex-wrap items-center gap-2">
      <span className={`inline-flex min-h-9 items-center gap-2 rounded-full px-3 text-sm font-black ${ready ? "bg-wayne-ok-soft text-wayne-ok" : working ? "bg-wayne-warn-soft text-wayne-warn" : "bg-wayne-alert-soft text-wayne-alert"}`}>
        <span aria-hidden className={`size-2.5 rounded-full ${ready ? "bg-wayne-ok" : working ? "animate-pulse bg-wayne-warn" : "bg-wayne-alert"}`} />
        Card reader: {stripeReaderLabels[state]}{state === "updating" && reader.status.updateProgress != null ? ` ${Math.round(reader.status.updateProgress * 100)}%` : ""}
      </span>
      {reader.status.serial ? <span className="text-xs text-wayne-muted">M2 · {reader.status.serial}</span> : null}
      <Battery charging={reader.status.charging} level={reader.status.battery} />
      {!ready ? <Button disabled={working} onClick={async () => { setBusy(true); await connectStripeReader(); setBusy(false); }} size="sm" variant={compact ? "secondary" : "brand"}>{working ? "Connecting…" : "Connect reader"}</Button> : null}
    </div>
    {state === "updating" ? <p className="text-sm font-bold">Keep the reader close and switched on until the update finishes (the battery must be over 50%).</p> : null}
    {reader.error && !ready ? <p className="text-sm font-bold text-wayne-alert" role="alert">{reader.error}</p> : null}
    {reader.status.detail && !ready && !reader.error ? <p className="text-sm text-wayne-muted">{reader.status.detail}</p> : null}
  </div>;
}

type Phase = "idle" | "preparing" | "waiting" | "confirming" | "declined";

/**
 * Charge an order on the Stripe M2 (Payments → Card).  The server opens a
 * card-present PaymentIntent, the app sends it to the reader, the customer
 * taps / inserts / swipes, and the server re-reads Stripe before the order is
 * marked paid.  A decline keeps the same payment open for the next card.
 */
export function StripeReaderTender({ orderId, totalCents, busy, setBusy, onError, onPaid }: {
  orderId: string; totalCents: number; busy: boolean;
  setBusy: (value: boolean) => void; onError: (message: string) => void; onPaid: (card: { brand: string | null; last4: string | null }) => void;
}) {
  const reader = useStripeReader();
  const [phase, setPhase] = useState<Phase>("idle");
  const [note, setNote] = useState("");
  const paymentId = useRef<string | null>(null);
  const finished = useRef(false);
  useEffect(() => { startStripeReader(); }, []);

  // Leaving the order (or switching to cash) lets go of a card payment that never completed,
  // so the order can be paid another way.
  useEffect(() => () => {
    if (finished.current || !paymentId.current) return;
    const id = paymentId.current;
    void cancelStripeReaderCollect().finally(() => { void post("/api/pos/stripe-terminal/cancel", { payment_id: id }).catch(() => undefined); });
  }, []);

  async function confirm(id: string): Promise<boolean> {
    setPhase("confirming"); setNote("Checking with Stripe…");
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await post("/api/pos/stripe-terminal/confirm", { payment_id: id });
      if (!response.ok) throw new Error(await readError(response, "Stripe could not be checked. Do not charge again — check Payments in a moment."));
      const body = await response.json() as { state?: string; card_brand?: string | null; card_last4?: string | null; message?: string | null };
      if (body.state === "captured") { finished.current = true; onPaid({ brand: body.card_brand ?? null, last4: body.card_last4 ?? null }); return true; }
      if (body.state === "open") { setPhase("declined"); onError(body.message || "The card was declined. Try another card."); return false; }
      if (body.state === "canceled") { paymentId.current = null; setPhase("idle"); onError("The payment was cancelled."); return false; }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error("Stripe is still processing this card. Do not charge again — check Payments in a moment.");
  }

  async function charge() {
    onError(""); setBusy(true); setNote("");
    try {
      if (reader.status.state !== "connected") {
        setPhase("preparing"); setNote("Connecting the card reader…");
        if (!(await connectStripeReader())) throw new Error("The card reader isn't connected. Turn it on (press the button once), keep it near the tablet, then try again.");
      }
      setPhase("preparing"); setNote("Sending the total to the reader…");
      const response = await post("/api/pos/stripe-terminal/intent", { order_id: orderId, idempotency_key: `pos-m2-${orderId}-${uuid()}` });
      const body = await response.json().catch(() => ({})) as { payment_id?: string; client_secret?: string; state?: string; error?: string };
      if (body.state === "captured") { finished.current = true; onPaid({ brand: null, last4: null }); return; }
      if (!response.ok || !body.payment_id || !body.client_secret) {
        logDevice("reader.intent_failed", body.error || `HTTP ${response.status}`, { status: response.status, order_id: orderId });
        throw new Error(body.error || "The card payment could not be prepared.");
      }
      logDevice("reader.intent_ok", body.payment_id, { order_id: orderId, total_cents: totalCents });
      paymentId.current = body.payment_id;

      setPhase("waiting"); setNote("");
      const outcome = await collectWithStripeReader(body.client_secret);
      if (outcome.ok) { await confirm(body.payment_id); return; }
      if (outcome.code === "DECLINED") { setPhase("declined"); onError(outcome.message); return; }
      if (outcome.code === "CANCELED") { setPhase("idle"); return; }
      // Unknown outcome (the app or the connection dropped): Stripe decides whether money moved.
      if (!(await confirm(body.payment_id).catch(() => false))) {
        setPhase((current) => (current === "declined" ? current : "idle"));
        onError(outcome.message);
      }
    } catch (cause) {
      setPhase("idle");
      logDevice("reader.charge_failed", cause instanceof Error ? cause.message : String(cause), { order_id: orderId });
      onError(cause instanceof Error ? cause.message : "The card reader did not finish.");
    } finally {
      setBusy(false); setNote("");
    }
  }

  async function cancel() {
    const id = paymentId.current;
    await cancelStripeReaderCollect();
    if (!id) { setPhase("idle"); return; }
    setBusy(true);
    try {
      const response = await post("/api/pos/stripe-terminal/cancel", { payment_id: id });
      const body = await response.json().catch(() => ({})) as { state?: string; error?: string };
      if (body.state === "captured") { finished.current = true; onPaid({ brand: null, last4: null }); return; }
      if (!response.ok) throw new Error(body.error || "The card payment could not be cancelled.");
      paymentId.current = null; setPhase("idle"); onError("");
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "The card payment could not be cancelled.");
    } finally {
      setBusy(false);
    }
  }

  const waiting = phase === "waiting";
  return <div className="rounded-2xl border-2 border-wayne-green p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-xl font-black">Card reader (Stripe M2)</h2><StripeReaderStatus compact /></div>
    {waiting ? <div aria-live="assertive" className="mt-4 rounded-2xl bg-wayne-green p-6 text-center text-white">
      <p className="text-sm font-black uppercase tracking-[0.2em] text-white/80">{formatCents(totalCents)}</p>
      <p className="mt-2 text-3xl font-black">{reader.prompt || "Tap, insert or swipe the card"}</p>
      <p className="mt-2 text-sm text-white/80">Hand the reader to the customer.</p>
    </div> : null}
    {note ? <p aria-live="polite" className="mt-3 text-lg font-bold">{note}</p> : null}
    {phase === "declined" ? <p className="mt-3 text-sm font-bold">The customer can try another card, or you can cancel and take cash.</p> : null}
    <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]">
      {!waiting && phase !== "confirming" ? <Button className="text-xl" disabled={busy || !reader.available} onClick={() => { void charge(); }} size="lg">{phase === "declined" ? `Try another card · ${formatCents(totalCents)}` : `Charge ${formatCents(totalCents)} on the reader`}</Button> : null}
      {waiting || phase === "declined" ? <Button disabled={busy && !waiting} onClick={() => { void cancel(); }} size="lg" variant="secondary">Cancel card payment</Button> : null}
    </div>
  </div>;
}
