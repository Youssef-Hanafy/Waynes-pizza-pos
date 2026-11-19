"use client";

import { useCallback, useRef, useState } from "react";
import { PayarcCardField } from "./payarc-card-field";
import type { Tokenizer } from "./square-card-field";
import type { CheckoutPaymentConfig } from "@/lib/payments/schemas";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/menu/schemas";
import { uuid } from "@/lib/uuid";

/** One immutable payment submission. An uncertain result can only be checked/replayed. */
export function PayarcKeyedTender({ config, orderId, customerName, totalCents, splitCents, allowTip, busy, setBusy, onLock, onError, onPaid, onTotalChanged }: {
  config: Extract<CheckoutPaymentConfig, { provider: "payarc" }>;
  orderId: string; customerName: string; totalCents: number; splitCents?: number; allowTip: boolean;
  busy: boolean; setBusy: (value: boolean) => void; onLock?: (value: boolean) => void;
  onError: (message: string) => void; onPaid: (totalCents: number) => void; onTotalChanged: (totalCents: number) => void;
}) {
  const tokenize = useRef<Tokenizer | null>(null);
  const submission = useRef<Record<string, unknown> | null>(null);
  const paymentId = useRef<string | null>(null);
  const requestKey = useRef(`payarc-keyed-${uuid()}`);
  const [unknown, setUnknown] = useState(false);
  const [tip, setTip] = useState("0");
  const [baseCents, setBaseCents] = useState(totalCents);
  const payableCents = useRef(totalCents);
  const [ready, setReady] = useState(false);
  const onReady = useCallback((value: Tokenizer | null) => { tokenize.current = value; setReady(Boolean(value)); }, []);
  const onStatus = useCallback((message: string) => onError(message), [onError]);

  async function submit() {
    setBusy(true); onError("");
    try {
      if (!submission.current && !paymentId.current) {
        if (!tokenize.current) throw new Error("Wait for secure card entry to load.");
        if (allowTip) {
          if (!/^\d+(\.\d{1,2})?$/.test(tip)) throw new Error("Enter a tip such as 5.00, or 0.");
          const tipCents = Math.round(Number(tip) * 100);
          if (tipCents > 100_000) throw new Error("That tip is too large.");
          const tipped = await fetch(`/api/pos/orders/${orderId}/tip`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tip_cents: tipCents }), signal: AbortSignal.timeout(12_000) });
          const result = await tipped.json().catch(() => null) as { total_cents?: number; tip_cents?: number; error?: string } | null;
          if (!tipped.ok || typeof result?.total_cents !== "number" || result.tip_cents !== tipCents) throw new Error(result?.error ?? "The tip could not be confirmed.");
          payableCents.current = result.total_cents;
          onTotalChanged(result.total_cents);
          setBaseCents(result.total_cents - tipCents);
          if (result.total_cents !== baseCents + tipCents) throw new Error("The order total changed. Review the updated total before charging.");
        }
        const card = await tokenize.current({ amountCents: payableCents.current });
        submission.current = { order_id: orderId, source_id: card.token, idempotency_key: requestKey.current, expected_amount_cents: payableCents.current, ...(splitCents !== undefined ? { amount_cents: splitCents } : {}) };
      }
      onLock?.(true); setUnknown(true);
      const response = await fetch("/api/pos/keyed-card/payarc", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(paymentId.current ? { payment_id: paymentId.current } : submission.current), signal: AbortSignal.timeout(45_000),
      });
      const body = await response.json().catch(() => null) as { payment_id?: string; payment_status?: string; error?: string } | null;
      if (body?.payment_id) paymentId.current = body.payment_id;
      if (body?.payment_status === "captured") { submission.current = null; onLock?.(false); setUnknown(false); onPaid(payableCents.current); return; }
      if (body?.payment_status === "failed" || body?.payment_status === "voided") {
        submission.current = null; paymentId.current = null; requestKey.current = `payarc-keyed-${uuid()}`; onLock?.(false); setUnknown(false);
        throw new Error(body.error ?? "The card did not complete. Review the card details before trying again.");
      }
      throw new Error(body?.error ?? "The card is still being checked. Do not enter another card; check this payment again.");
    } catch (error) { onError(error instanceof Error ? error.message : "Check the payment before charging again."); }
    finally { setBusy(false); }
  }
  return <div className="rounded-2xl border-2 border-wayne-green p-4">
    <h2 className="text-xl font-black">Key in the card · Payarc</h2>
    <p className="mt-1 text-sm text-wayne-muted">{customerName} · charged now with the tip entered below. An extra tip from the signed slip can be added in Tips or driver cash-out before Payarc batches the charge.</p>
    {allowTip ? <Input disabled={busy || unknown} label="Tip before payment ($)" name="payarc_tip" inputMode="decimal" value={tip} onChange={(event) => setTip(event.target.value)} /> : null}
    <div className={unknown ? "pointer-events-none mt-3 opacity-50" : "mt-3"}><PayarcCardField config={config} onReady={onReady} onStatus={onStatus} /></div>
    <Button className="mt-3 w-full text-xl" disabled={busy || (!ready && !unknown)} onClick={() => { void submit(); }} size="lg">{busy ? "Checking Payarc…" : unknown ? "Check this payment again" : `Charge ${formatCents(baseCents + (allowTip && /^\d+(\.\d{1,2})?$/.test(tip) ? Math.round(Number(tip) * 100) : 0))}`}</Button>
  </div>;
}
