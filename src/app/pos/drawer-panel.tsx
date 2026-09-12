"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  cashMovementLabels, expectedCashCents, needsVarianceNote, parseCashCountInput,
  posDrawerSchema, varianceCents, varianceLabel,
  type CashMovementKind, type PosDrawer,
} from "@/lib/cash/schemas";
import { formatCents } from "@/lib/menu/schemas";

const empty: PosDrawer = { registers: [], shift: null };

/**
 * The counter's cash drawer. Opening needs a counted float, every movement needs a
 * reason, and closing needs a count — the drawer works out what it should be holding
 * and shows the difference before anything is saved.
 */
export function DrawerPanel({ timeZone }: { timeZone: string }) {
  const [open, setOpen] = useState(false);
  const [drawer, setDrawer] = useState<PosDrawer>(empty);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [registerId, setRegisterId] = useState("");
  const [float, setFloat] = useState("");
  const [movementKind, setMovementKind] = useState<CashMovementKind>("paid_out");
  const [movementAmount, setMovementAmount] = useState("");
  const [movementReason, setMovementReason] = useState("");
  const [counted, setCounted] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/pos/drawer", { cache: "no-store", signal: AbortSignal.timeout(8000) });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body ? String(body.error) : "The drawer is unavailable.");
      const parsed = posDrawerSchema.safeParse(body);
      if (!parsed.success) throw new Error("The drawer data was invalid.");
      if (mounted.current) {
        setDrawer(parsed.data);
        setRegisterId((current) => current || (parsed.data.registers.find((register) => !register.open)?.id ?? ""));
        setError("");
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "The drawer is unavailable.");
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const first = window.setTimeout(() => { void load(); }, 0);
    const timer = window.setInterval(() => { void load(); }, 15_000);
    return () => { mounted.current = false; window.clearTimeout(first); window.clearInterval(timer); };
  }, [load]);

  async function send(body: Record<string, unknown>, success: string) {
    if (pending) return false;
    setPending(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/pos/drawer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(12_000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "That could not be saved.");
      setNotice(success);
      await load();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That could not be saved.");
      await load();
      return false;
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  async function openDrawer() {
    const amount = parseCashCountInput(float);
    if (!amount.ok) { setError(amount.error); return; }
    if (!registerId) { setError("Choose a register."); return; }
    if (await send({ action: "open", register_id: registerId, opening_cash_cents: amount.cents }, "Drawer open.")) setFloat("");
  }

  async function recordMovement() {
    if (!shift) return;
    const amount = parseCashCountInput(movementAmount);
    if (!amount.ok) { setError(amount.error); return; }
    if (amount.cents <= 0) { setError("Enter an amount greater than zero."); return; }
    if (movementReason.trim().length < 3) { setError("Every cash movement needs a reason."); return; }
    if (await send({ action: "movement", shift_id: shift.id, kind: movementKind, amount_cents: amount.cents, reason: movementReason.trim() },
      `${cashMovementLabels[movementKind]} recorded.`)) {
      setMovementAmount(""); setMovementReason("");
    }
  }

  async function closeDrawer() {
    if (!shift) return;
    const amount = parseCashCountInput(counted);
    if (!amount.ok) { setError(amount.error); return; }
    const difference = varianceCents(amount.cents, expected);
    if (needsVarianceNote(difference, closeNote)) {
      setError(`The drawer is ${varianceLabel(difference).toLowerCase()} by ${formatCents(Math.abs(difference))}. Explain the difference before closing.`);
      return;
    }
    if (await send({ action: "close", shift_id: shift.id, counted_cash_cents: amount.cents, close_note: closeNote.trim() },
      "Drawer closed. The closeout is in Admin → Cash.")) {
      setCounted(""); setCloseNote("");
    }
  }

  const shift = drawer.shift;
  const expected = shift ? expectedCashCents(shift) : 0;
  const countedCents = parseCashCountInput(counted);
  const liveVariance = shift && countedCents.ok ? varianceCents(countedCents.cents, expected) : null;
  const time = (value: string) => new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(value));

  return <>
    <Button onClick={() => setOpen(true)} variant="secondary">
      {shift ? `Drawer ${formatCents(expected)}` : "Drawer closed"}
    </Button>
    {open ? <div aria-modal="true" aria-label="Cash drawer" className="fixed inset-0 z-50 flex justify-end bg-black/50" role="dialog">
      <section className="h-full w-full max-w-lg overflow-y-auto bg-white p-5 text-wayne-ink shadow-2xl">
        <div className="flex items-center justify-between gap-3">
          <div><h2 className="text-2xl font-black">Cash drawer</h2><p className="text-sm text-wayne-muted">Every movement is recorded with your name and a reason.</p></div>
          <Button onClick={() => setOpen(false)} variant="secondary">Close</Button>
        </div>
        {error ? <p className="mt-4 rounded-xl bg-red-50 p-3 text-sm font-bold text-red-800" role="alert">{error}</p> : null}
        {notice ? <p className="mt-4 rounded-xl bg-green-50 p-3 text-sm font-bold text-green-800" role="status">{notice}</p> : null}

        {!shift ? <div className="mt-6 grid gap-4">
          <h3 className="text-xl font-black">Open a drawer</h3>
          {drawer.registers.length ? <>
            <label className="grid gap-2 text-sm font-bold">Register
              <select className="min-h-12 rounded-lg border border-wayne-border bg-white px-3" onChange={(event) => setRegisterId(event.target.value)} value={registerId}>
                {drawer.registers.map((register) => <option disabled={register.open} key={register.id} value={register.id}>{register.label}{register.open ? " — already open" : ""}</option>)}
              </select>
            </label>
            <label className="grid gap-2 text-sm font-bold">Opening cash you counted
              <input className="min-h-14 rounded-lg border border-wayne-border px-4 text-xl font-black" inputMode="decimal" onChange={(event) => setFloat(event.target.value)} placeholder="150.00" value={float} />
            </label>
            <Button className="min-h-14 text-lg" disabled={pending} onClick={() => { void openDrawer(); }}>{pending ? "Saving…" : "Open drawer"}</Button>
          </> : <p className="rounded-xl border border-dashed border-wayne-border p-6 text-center text-wayne-muted">No register has been set up yet. An owner or manager adds one in Admin → Cash.</p>}
        </div> : <div className="mt-6 grid gap-6">
          <div className="rounded-2xl border border-wayne-border p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h3 className="text-xl font-black">{shift.register_label}</h3>
              <span className="text-sm text-wayne-muted">{shift.opened_by_name} · opened {time(shift.opened_at)}</span>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <Row label="Opening float" value={shift.opening_cash_cents} />
              <Row label="Cash sales" value={shift.cash_sales_cents} />
              <Row label="Cash refunds" value={-shift.cash_refunds_cents} />
              <Row label="Paid in" value={shift.paid_in_cents} />
              <Row label="Driver cash in" value={shift.driver_cash_cents} />
              <Row label="Paid out" value={-shift.paid_out_cents} />
              <Row label="Dropped to safe" value={-shift.drop_cents} />
            </dl>
            <p className="mt-4 border-t border-wayne-border pt-4 text-lg font-black">Drawer should hold {formatCents(expected)}</p>
          </div>

          <div className="rounded-2xl border border-wayne-border p-5">
            <h3 className="text-xl font-black">Move cash</h3>
            <div className="mt-3 grid gap-3">
              <label className="grid gap-2 text-sm font-bold">What is this
                <select className="min-h-12 rounded-lg border border-wayne-border bg-white px-3" onChange={(event) => setMovementKind(event.target.value as CashMovementKind)} value={movementKind}>
                  {Object.entries(cashMovementLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label className="grid gap-2 text-sm font-bold">Amount
                <input className="min-h-12 rounded-lg border border-wayne-border px-4 font-bold" inputMode="decimal" onChange={(event) => setMovementAmount(event.target.value)} placeholder="12.00" value={movementAmount} />
              </label>
              <label className="grid gap-2 text-sm font-bold">Reason
                <input className="min-h-12 rounded-lg border border-wayne-border px-4" maxLength={500} onChange={(event) => setMovementReason(event.target.value)} placeholder="Napkins from the corner shop" value={movementReason} />
              </label>
              <Button disabled={pending} onClick={() => { void recordMovement(); }} variant="secondary">{pending ? "Saving…" : "Record movement"}</Button>
            </div>
            {shift.movements.length ? <ul className="mt-4 grid gap-2 border-t border-wayne-border pt-4 text-sm">
              {shift.movements.map((movement) => <li key={movement.id}>
                <strong>{cashMovementLabels[movement.kind]} {formatCents(movement.amount_cents)}</strong>
                <span className="text-wayne-muted"> · {movement.reason} · {movement.actor_name ?? "Unknown"} · {time(movement.created_at)}</span>
              </li>)}
            </ul> : null}
          </div>

          <div className="rounded-2xl border border-wayne-border p-5">
            <h3 className="text-xl font-black">Close the drawer</h3>
            <p className="mt-1 text-sm text-wayne-muted">Count the cash in the drawer and enter the total. Do not look at the expected figure first.</p>
            <div className="mt-3 grid gap-3">
              <label className="grid gap-2 text-sm font-bold">Counted cash
                <input className="min-h-14 rounded-lg border border-wayne-border px-4 text-xl font-black" inputMode="decimal" onChange={(event) => setCounted(event.target.value)} placeholder="0.00" value={counted} />
              </label>
              {liveVariance !== null ? <p className={`text-sm font-bold ${liveVariance === 0 ? "text-green-800" : "text-wayne-red"}`}>
                {liveVariance === 0 ? "Balanced." : `${varianceLabel(liveVariance)} by ${formatCents(Math.abs(liveVariance))}.`}
              </p> : null}
              <label className="grid gap-2 text-sm font-bold">Note {liveVariance !== null && Math.abs(liveVariance) >= 500 ? "(required)" : "(optional)"}
                <input className="min-h-12 rounded-lg border border-wayne-border px-4" maxLength={1000} onChange={(event) => setCloseNote(event.target.value)} placeholder="Miscount on change earlier" value={closeNote} />
              </label>
              <Button className="min-h-14 text-lg" disabled={pending} onClick={() => { void closeDrawer(); }}>{pending ? "Saving…" : "Count and close"}</Button>
            </div>
          </div>
        </div>}
      </section>
    </div> : null}
  </>;
}

function Row({ label, value }: { label: string; value: number }) {
  return <div className="flex justify-between gap-3"><dt className="text-wayne-muted">{label}</dt><dd className="font-bold">{formatCents(value)}</dd></div>;
}
