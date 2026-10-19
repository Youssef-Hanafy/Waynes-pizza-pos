"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/menu/schemas";
import { discountInputValue, discountLabel, posDiscountSchema, type PosDiscount } from "@/lib/pos/discounts";
import { dollarsToCents } from "./open-item-dialog";

export type AppliedDiscount = { type: "fixed" | "percent"; value: string; reason: string; presetId: string };

/** Saved discounts are read once per register and kept, so the box opens instantly next time. */
let cachedDiscounts: PosDiscount[] | null = null;

/**
 * Discount (owner, 2026-10-19), next to Open item: one of the discounts saved
 * in Admin → Discounts, or a $ off / % off typed here.  A saved discount can be
 * used by anyone on the register; typing your own amount needs a manager
 * (the database checks both).
 */
export function DiscountDialog({ subtotalCents, current, canManageDiscount, onApply, onRemove, onClose }: {
  subtotalCents: number;
  current: AppliedDiscount | null;
  canManageDiscount: boolean;
  onApply: (discount: AppliedDiscount) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [saved, setSaved] = useState<PosDiscount[] | null>(cachedDiscounts);
  const [loadError, setLoadError] = useState("");
  const [kind, setKind] = useState<"fixed" | "percent">(current && !current.presetId ? current.type : "fixed");
  const [amount, setAmount] = useState(current && !current.presetId ? current.value : "");
  const [reason, setReason] = useState(current && !current.presetId ? current.reason : "");
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    fetch("/api/pos/discounts", { cache: "no-store", signal: AbortSignal.timeout(8000) })
      .then(async (response) => {
        const parsed = posDiscountSchema.array().safeParse(response.ok ? await response.json() : null);
        if (!parsed.success) throw new Error("Saved discounts are unavailable right now.");
        cachedDiscounts = parsed.data;
        if (live) { setSaved(parsed.data); setLoadError(""); }
      })
      .catch((cause: unknown) => { if (live && !cachedDiscounts) setLoadError(cause instanceof Error && cause.name !== "TimeoutError" ? cause.message : "Saved discounts are unavailable right now."); });
    return () => { live = false; };
  }, []);

  const typedCents = kind === "fixed" ? dollarsToCents(amount) : null;
  const typedPercent = kind === "percent" ? Number(amount.replace(/[%\s]/g, "")) : Number.NaN;
  const previewCents = kind === "fixed"
    ? Math.min(subtotalCents, typedCents ?? 0)
    : Number.isFinite(typedPercent) ? Math.min(subtotalCents, Math.round(subtotalCents * typedPercent / 100)) : 0;

  function previewOf(discount: PosDiscount) {
    return discount.discount_type === "fixed" ? Math.min(subtotalCents, discount.discount_value) : Math.min(subtotalCents, Math.round(subtotalCents * discount.discount_value / 10_000));
  }

  function applyTyped() {
    if (kind === "fixed" && (typedCents === null || typedCents <= 0)) { setError("Type the dollars off, e.g. 5 or 2.50"); return; }
    if (kind === "fixed" && typedCents !== null && typedCents > 100_000) { setError("That discount is too high."); return; }
    if (kind === "percent" && (!Number.isFinite(typedPercent) || typedPercent <= 0 || typedPercent > 100)) { setError("Type a percent between 1 and 100."); return; }
    if (reason.trim().length < 3) { setError("Say why (at least 3 letters) — it goes on the order."); return; }
    onApply({ type: kind, value: kind === "fixed" ? ((typedCents ?? 0) / 100).toFixed(2) : String(Math.round(typedPercent * 100) / 100), reason: reason.trim().slice(0, 500), presetId: "" });
  }

  return <div aria-modal="true" className="fixed inset-0 z-50 bg-black/60 p-3 sm:grid sm:place-items-center" role="dialog">
    <form className="mx-auto max-h-[calc(100vh-1.5rem)] w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl" onSubmit={(event) => { event.preventDefault(); applyTyped(); }}>
      <div className="flex items-start justify-between gap-3">
        <div><h2 className="text-2xl font-black">Discount</h2><p className="text-sm font-bold text-wayne-muted">Taken off the food total ({formatCents(subtotalCents)}), before tax.</p></div>
        <button aria-label="Close" className="min-h-11 min-w-11 rounded-xl text-2xl font-black hover:bg-wayne-cream" onClick={onClose} type="button">×</button>
      </div>

      <p className="mt-4 text-sm font-black uppercase tracking-[0.14em] text-wayne-muted">Saved discounts</p>
      {saved === null && !loadError ? <p className="mt-2 text-sm text-wayne-muted">Loading…</p> : null}
      {loadError ? <p className="mt-2 rounded-xl bg-wayne-warn-soft p-2 text-sm font-bold">{loadError}</p> : null}
      {saved && !saved.length ? <p className="mt-2 rounded-xl bg-wayne-cream p-3 text-sm text-wayne-muted">None yet — a manager adds them in Admin → Discounts.</p> : null}
      {saved?.length ? <div className="mt-2 grid grid-cols-2 gap-2">
        {saved.map((discount) => {
          const chosen = current?.presetId === discount.id;
          return <button aria-pressed={chosen} className={`flex min-h-16 flex-col items-start justify-center rounded-2xl border-2 px-3 py-2 text-left transition active:scale-95 ${chosen ? "border-wayne-green bg-wayne-green text-white" : "border-wayne-border bg-wayne-cream hover:border-wayne-green"}`} key={discount.id}
            onClick={() => onApply({ type: discount.discount_type, value: discountInputValue(discount), reason: discount.name, presetId: discount.id })} type="button">
            <strong className="text-base font-black leading-tight">{discount.name}</strong>
            <span className={`text-sm font-bold ${chosen ? "text-white/85" : "text-wayne-red"}`}>{discountLabel(discount)} · −{formatCents(previewOf(discount))}</span>
          </button>;
        })}
      </div> : null}

      <p className="mt-5 text-sm font-black uppercase tracking-[0.14em] text-wayne-muted">Or type one</p>
      {canManageDiscount ? <>
        <div className="mt-2 inline-flex rounded-xl bg-wayne-cream p-1" role="group">
          <button aria-pressed={kind === "fixed"} className={`min-h-11 rounded-lg px-5 font-black ${kind === "fixed" ? "bg-wayne-green text-white" : ""}`} onClick={() => { setKind("fixed"); setError(""); }} type="button">$ off</button>
          <button aria-pressed={kind === "percent"} className={`min-h-11 rounded-lg px-5 font-black ${kind === "percent" ? "bg-wayne-green text-white" : ""}`} onClick={() => { setKind("percent"); setError(""); }} type="button">% off</button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="grid gap-1.5 text-sm font-bold" htmlFor="pos-discount-amount">{kind === "fixed" ? "Dollars off" : "Percent off"}
            <input autoComplete="off" className="min-h-12 rounded-xl border border-wayne-border px-3 text-2xl font-black" id="pos-discount-amount" inputMode="decimal" onChange={(event) => { setAmount(event.target.value); setError(""); }} placeholder={kind === "fixed" ? "0.00" : "10"} value={amount} />
          </label>
          <div className="grid content-end"><p className="text-sm font-bold text-wayne-muted">Takes off</p><p className="text-2xl font-black text-wayne-red">−{formatCents(previewCents)}</p></div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(kind === "fixed" ? ["1", "2", "5", "10"] : ["5", "10", "15", "20", "50"]).map((quick) => <button className="min-h-11 rounded-full border border-wayne-border bg-white px-3 text-sm font-black" key={quick} onClick={() => { setAmount(quick); setError(""); }} type="button">{kind === "fixed" ? `$${quick}` : `${quick}%`}</button>)}
        </div>
        <label className="mt-3 grid gap-1.5 text-sm font-bold" htmlFor="pos-discount-reason">Reason (goes on the order)
          <input autoComplete="off" className="min-h-11 rounded-xl border border-wayne-border px-3 font-normal" id="pos-discount-reason" maxLength={500} onChange={(event) => { setReason(event.target.value); setError(""); }} placeholder="e.g. Wrong order last time" value={reason} />
        </label>
        {error ? <p className="mt-3 rounded-xl bg-wayne-alert-soft p-2 text-sm font-bold text-wayne-alert" role="alert">{error}</p> : null}
        <Button className="mt-4 min-h-14 w-full text-lg" type="submit">Apply · −{formatCents(previewCents)}</Button>
      </> : <p className="mt-2 rounded-xl bg-wayne-cream p-3 text-sm text-wayne-muted">Typing your own $ or % off needs a manager. Use a saved discount above, or ask a manager to sign in.</p>}

      {current ? <Button className="mt-3 w-full" onClick={onRemove} variant="secondary">Remove the discount</Button> : null}
    </form>
  </div>;
}
