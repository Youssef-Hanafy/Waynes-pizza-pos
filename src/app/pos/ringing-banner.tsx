"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { callerCardInfo } from "@/lib/phone/caller-display";
import { callOnLine, type PhoneCallView } from "@/lib/phone/phone-state";
import { usePhoneState } from "@/stores/phone-store";

type Props = {
  /** A ticket with items (or a payment) is in progress on this register: taking the call would close it. */
  busy: boolean;
  onTakeOrder: (call: PhoneCallView) => void;
  onOpenLine: (call: PhoneCallView) => void;
};

/**
 * Caller ID on every screen (owner, 2026-10-27): the moment Line 1 or Line 2
 * rings, the caller's name, number and address show across the top of the
 * POS — before anyone answers — like a saved contact on a cell phone.  It never
 * takes the cashier off a ticket they are ringing up: with items on the ticket
 * it only shows who is calling.
 */
export function RingingBanner({ busy, onTakeOrder, onOpenLine }: Props) {
  const state = usePhoneState();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const ringing = state.lines
    .map((line) => callOnLine(state, line.line))
    .filter((call): call is PhoneCallView => call !== null && call.status === "incoming" && !hidden.has(call.key));
  if (!ringing.length) return null;

  return <div aria-live="assertive" className="shrink-0 border-b-4 border-wayne-ok bg-wayne-ok-soft" role="alert">
    {ringing.map((call) => {
      const info = callerCardInfo(call);
      return <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2" key={call.key}>
        <span className="animate-pulse rounded-full bg-wayne-ok px-3 py-1 text-sm font-black uppercase tracking-wider text-white">☎ Line {call.line}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-2xl font-black leading-tight">{info.name}</p>
          <p className="truncate text-lg font-bold">
            {info.phone}
            {info.address ? <span className="font-black"> · 📍 {info.address}</span> : null}
          </p>
          <p className="truncate text-sm font-bold text-wayne-muted">{info.detail}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {busy ? <>
            <span className="self-center text-sm font-black">Finish this ticket, then take the call</span>
            <Button onClick={() => onOpenLine(call)} size="lg" variant="secondary">Open line now</Button>
          </> : call.matches.length > 1
            ? <Button onClick={() => onOpenLine(call)} size="lg">Pick customer</Button>
            : <Button onClick={() => onTakeOrder(call)} size="lg">Take order</Button>}
          <Button onClick={() => setHidden((current) => new Set(current).add(call.key))} size="lg" variant="ghost">Hide</Button>
        </div>
      </div>;
    })}
  </div>;
}
