"use client";

import { useCallback, useMemo, useState } from "react";
import { ticketNumber } from "@/lib/orders/ticket-number";
import { useVisiblePolling } from "@/components/ops/use-visible-polling";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/menu/schemas";
import { heldCardSchema, parseTipInput, tipRoom, type HeldCard } from "@/lib/tips/schemas";

const brandNames: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "Amex", american_express: "Amex", discover: "Discover", test: "Test card" };
const sourceNames: Record<string, string> = { pos: "Counter", phone: "Phone", online: "Online" };

function when(iso: string) {
  return new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/**
 * Tips from the signed slips (owner, 2026-10-13).
 *
 * Every card — the M2 at the counter, a card keyed in over the phone, an
 * online order — is approved for the order and held.  At the end of the night
 * the slips come out, the tip written on each is typed here, and "Charge
 * cards" captures every card ONCE for order + tip (Stripe overcapture).  A
 * slip with no tip: leave it blank, the card is charged for the order.
 *
 * Delivery cards on a driver's run go through Deliveries → cash-out instead,
 * so the driver is paid the tip out of the drawer.  Anything still waiting at
 * 4:30 am is charged automatically with no added tip.
 */
export function TipsScreen({ onOpenDeliveries }: { onOpenDeliveries?: () => void }) {
  const [cards, setCards] = useState<HeldCard[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [tips, setTips] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/pos/tips", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body ? String(body.error) : "The cards could not be loaded.");
      const parsed = heldCardSchema.array().safeParse(body);
      if (!parsed.success) throw new Error("The cards could not be read.");
      setCards(parsed.data); setError(""); setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The cards could not be loaded.");
      setLoaded(true);
    }
  }, []);

  useVisiblePolling(load, 60_000);

  const here = useMemo(() => cards.filter((card) => !card.with_driver), [cards]);
  const drivers = useMemo(() => cards.filter((card) => card.with_driver), [cards]);
  const entered = here.map((card) => ({ card, cents: parseTipInput(tips[card.order_id] ?? "") }));
  const invalid = entered.filter((line) => line.cents === null);
  const tooBig = entered.filter((line) => line.cents !== null && line.cents > tipRoom(line.card));
  const tipTotal = entered.reduce((sum, line) => sum + (line.cents ?? 0), 0);

  async function charge(lines: { card: HeldCard; cents: number | null }[]) {
    if (busy || !lines.length) return;
    if (lines.some((line) => line.cents === null)) { setNotice({ tone: "warn", text: "One of the tips isn't a number. Fix the boxes in red." }); return; }
    setBusy(true); setNotice(null);
    try {
      const response = await fetch("/api/pos/tips", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ tips: lines.map((line) => ({ order_id: line.card.order_id, tip_cents: line.cents ?? 0 })) }),
        signal: AbortSignal.timeout(90_000),
      });
      const body = await response.json().catch(() => ({})) as { charged?: number; tips_cents?: number; problems?: string[]; error?: string };
      if (!response.ok) throw new Error(body.error || "The cards could not be charged.");
      const problems = body.problems ?? [];
      setNotice({ tone: problems.length ? "warn" : "ok", text: `✓ Charged ${body.charged ?? lines.length} card${(body.charged ?? lines.length) === 1 ? "" : "s"} with ${formatCents(body.tips_cents ?? 0)} in tips.${problems.length ? ` ${problems.join(" ")}` : ""}` });
      setTips((current) => { const next = { ...current }; for (const line of lines) delete next[line.card.order_id]; return next; });
    } catch (cause) {
      setNotice({ tone: "warn", text: cause instanceof Error ? cause.message : "The cards could not be charged." });
    } finally {
      setBusy(false);
      void load();
    }
  }

  return <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
    <div className="mx-auto grid max-w-5xl gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black">Tips from the slips</h1>
          <p className="text-sm font-bold text-wayne-muted">Type the tip written on each signed slip, then charge the cards. Blank = no tip (charged for the order). Each card is charged once.</p>
        </div>
        <Button disabled={busy || !here.length} onClick={() => { void charge(entered); }} size="lg">{busy ? "Charging…" : `Charge ${here.length} card${here.length === 1 ? "" : "s"}${tipTotal ? ` · ${formatCents(tipTotal)} tips` : ""}`}</Button>
      </div>
      {notice ? <p className={`rounded-xl p-3 text-sm font-bold ${notice.tone === "ok" ? "bg-wayne-ok-soft text-wayne-ok" : "bg-wayne-warn-soft"}`} role="status">{notice.text}</p> : null}
      {error ? <p className="rounded-xl bg-wayne-alert-soft p-3 text-sm font-bold text-wayne-alert">{error}</p> : null}
      {tooBig.length ? <p className="rounded-xl bg-wayne-warn-soft p-3 text-sm font-bold">{tooBig.length === 1 ? "One tip is" : `${tooBig.length} tips are`} more than the card allows — only the most the card can take will be charged.</p> : null}

      {loaded && !here.length && !error ? <p className="rounded-2xl bg-white p-6 text-center font-bold text-wayne-muted">No cards waiting for a tip. 👍</p> : null}

      {here.length ? <ul className="grid gap-2">
        {here.map((card) => {
          const raw = tips[card.order_id] ?? "";
          const cents = parseTipInput(raw);
          const room = tipRoom(card);
          const over = cents !== null && cents > room;
          return <li className="grid gap-2 rounded-2xl border border-wayne-border bg-white p-3 sm:grid-cols-[minmax(0,1fr)_11rem_auto] sm:items-center" key={card.payment_id}>
            <div className="min-w-0">
              <p className="flex flex-wrap items-baseline gap-x-2 text-lg font-black">
                <span>#{ticketNumber(card)}</span>
                <span className="truncate">{card.customer_name || "Customer"}</span>
                {card.is_test ? <span className="rounded bg-wayne-gold/30 px-1.5 text-xs">TEST</span> : null}
              </p>
              <p className="text-sm font-bold text-wayne-muted">
                {sourceNames[card.source] ?? card.source} · {card.fulfillment_type === "delivery" ? "Delivery" : "Pickup"} · {when(card.authorized_at)} · {brandNames[(card.card_brand ?? "").toLowerCase()] ?? card.card_brand ?? "Card"}{card.card_last4 ? ` •${card.card_last4}` : ""}
              </p>
              <p className="text-sm font-bold">Approved {formatCents(card.authorized_cents)}{card.tip_already_cents ? ` (incl. ${formatCents(card.tip_already_cents)} tip already)` : ""} · room for up to {formatCents(room)} more</p>
            </div>
            <label className="grid gap-1 text-xs font-black uppercase tracking-wider text-wayne-muted">Tip on slip ($)
              <input className={`min-h-12 rounded-xl border-2 px-3 text-xl font-black text-wayne-ink ${cents === null ? "border-wayne-alert" : over ? "border-wayne-gold" : "border-wayne-border"}`} inputMode="decimal" onChange={(event) => setTips((current) => ({ ...current, [card.order_id]: event.target.value }))} placeholder="0.00" value={raw} />
            </label>
            <div className="text-right">
              <p className="text-xs font-bold text-wayne-muted">Card charged</p>
              <p className="text-xl font-black">{formatCents(card.authorized_cents + Math.min(cents ?? 0, room))}</p>
              <button className="mt-1 min-h-10 rounded-lg border border-wayne-border px-3 text-sm font-black disabled:opacity-40" disabled={busy || cents === null} onClick={() => { void charge([{ card, cents }]); }} type="button">Charge this one</button>
            </div>
          </li>;
        })}
      </ul> : null}

      {drivers.length ? <section className="rounded-2xl border-2 border-dashed border-wayne-border-strong bg-white p-3">
        <h2 className="font-black">On a driver&apos;s run ({drivers.length})</h2>
        <p className="text-sm text-wayne-muted">These delivery cards get their tip at the driver&apos;s cash-out, so the driver is paid the tip from the drawer: {drivers.map((card) => `#${ticketNumber(card)} ${card.customer_name}`).join(" · ")}</p>
        {onOpenDeliveries ? <Button className="mt-2" onClick={onOpenDeliveries} size="sm" variant="secondary">Go to Deliveries → cash-out</Button> : null}
      </section> : null}

      <p className="text-xs text-wayne-muted">Anything still waiting at 4:30 am is charged automatically for the order with no added tip, so no card approval runs out. Stripe lets a card take up to 50% or $50 more than approved (whichever is greater) on Visa, Mastercard, Discover and Amex.</p>
      {invalid.length ? <p className="sr-only">Some tips are not numbers.</p> : null}
    </div>
  </div>;
}
