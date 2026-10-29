"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { callerCardInfo } from "@/lib/phone/caller-display";
import { callOnLine, type PhoneCallView } from "@/lib/phone/phone-state";
import { getTerminalLabel, usePhoneState } from "@/stores/phone-store";

/**
 * Which calls the box shows: every line still ringing, plus a call this
 * register opened ("Open line now", or tapped on the Phone screen) whose order
 * hasn't started yet — so going back to the ticket never makes the caller
 * disappear (owner, 2026-10-29: "the caller ID box … sometimes just doesn't
 * show up").  A call another register picked up is theirs and is not shown.
 */
export function bannerCalls(lines: readonly (PhoneCallView | null)[], me: { profileId: string; terminal: string }, hidden: ReadonlySet<string>): PhoneCallView[] {
  return lines.filter((call): call is PhoneCallView => {
    if (!call || hidden.has(call.key)) return false;
    if (call.status === "incoming") return true;
    if (call.status !== "selected") return false;
    return !call.serverId || (Boolean(me.profileId) && call.claimedById === me.profileId) || (Boolean(call.claimedTerminal) && call.claimedTerminal === me.terminal);
  });
}

type Props = {
  /** The signed-in staff profile on this register. */
  profileId: string;
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
export function RingingBanner({ profileId, busy, onTakeOrder, onOpenLine }: Props) {
  const state = usePhoneState();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const box = useRef<HTMLDivElement>(null);
  const ringing = bannerCalls(state.lines.map((line) => callOnLine(state, line.line)), { profileId, terminal: getTerminalLabel() }, hidden);
  const showing = ringing.length > 0;

  /*
   * Always on top (owner, 2026-10-29: "if he's taking an order it just doesn't
   * show up at all").  The box used to sit under any open window — the item's
   * options, Discount, Open item, the drawer, the orders panel — so while
   * ringing up a pizza the caller was hidden.  Now the box stays above them,
   * and while it shows, those windows start just below it
   * (html[data-pos-ringing] in globals.css) so nothing in them is covered.
   */
  useEffect(() => {
    const root = document.documentElement;
    if (!showing) {
      root.removeAttribute("data-pos-ringing");
      root.style.removeProperty("--pos-ring-bottom");
      return;
    }
    const measure = () => {
      const bottom = box.current ? Math.max(0, Math.round(box.current.getBoundingClientRect().bottom)) : 0;
      root.style.setProperty("--pos-ring-bottom", `${bottom}px`);
    };
    measure();
    root.setAttribute("data-pos-ringing", "");
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (observer && box.current) observer.observe(box.current);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    // A notice line appearing above the box moves it down without resizing it.
    const settle = window.setInterval(measure, 1_000);
    return () => {
      window.clearInterval(settle);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      root.removeAttribute("data-pos-ringing");
      root.style.removeProperty("--pos-ring-bottom");
    };
  }, [showing]);

  if (!showing) return null;

  return <div aria-live="assertive" className="sticky top-0 z-[90] shrink-0 border-b-4 border-wayne-ok bg-wayne-ok-soft shadow-lg" ref={box} role="alert">
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
