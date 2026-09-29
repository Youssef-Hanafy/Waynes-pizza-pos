"use client";

import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { IncomingCallEvent, PhoneLineNumber } from "@/hardware/types";
import { getHardwareRuntime } from "@/stores/hardware-store";

const presets: { line: PhoneLineNumber; phoneNumber: string; callerName: string }[] = [
  { line: 1, phoneNumber: "5085551111", callerName: "John Test" },
  { line: 2, phoneNumber: "7745552222", callerName: "Jane Test" },
];

/**
 * Caller ID simulator (build sheet §18).  Rings go through the simulated
 * provider → hardware event bus → phone store, exactly the path the Android
 * caller ID provider will use.  There is no separate fake UI.
 */
export function SimulatorPanel({ lineCount }: { lineCount: number }) {
  const [line, setLine] = useState<PhoneLineNumber>(1);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [callerName, setCallerName] = useState("");
  const [last, setLast] = useState<IncomingCallEvent | null>(null);
  const [message, setMessage] = useState("");

  function ring(call: { line: PhoneLineNumber; phoneNumber: string; callerName?: string }) {
    const simulator = getHardwareRuntime()?.simulator;
    if (!simulator) { setMessage("The simulator is switched off in Admin → Hardware."); return; }
    try {
      const event = simulator.simulate(call);
      setLast(event);
      setMessage(`Line ${call.line} is ringing.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The test call could not be placed.");
    }
  }

  function custom(event: FormEvent) {
    event.preventDefault();
    if (!phoneNumber.trim()) { setMessage("Enter the number that is calling."); return; }
    ring({ line, phoneNumber, callerName });
  }

  return <div className="grid gap-3">
    <div className="flex flex-wrap gap-2">
      {presets.filter((preset) => preset.line <= lineCount).map((preset) => <Button key={preset.line} onClick={() => ring(preset)} variant="secondary">Simulate Line {preset.line} call · {preset.callerName}</Button>)}
      <Button disabled={!last} onClick={() => { if (last) { getHardwareRuntime()?.simulator?.replay(last); setMessage("Sent the same ring again — it should not make a second card."); } }} variant="ghost">Repeat last ring</Button>
    </div>
    <form className="grid gap-2 sm:grid-cols-[7rem_1fr_1fr_auto]" onSubmit={custom}>
      <label className="grid gap-1.5 text-sm font-bold" htmlFor="sim-line">Line
        <select className="min-h-11 rounded-xl border border-wayne-border bg-white px-3" id="sim-line" onChange={(event) => setLine(Number(event.target.value) as PhoneLineNumber)} value={line}>
          {Array.from({ length: lineCount }, (_, index) => <option key={index + 1} value={index + 1}>Line {index + 1}</option>)}
        </select>
      </label>
      <Input id="sim-phone" inputMode="tel" label="Phone" onChange={(event) => setPhoneNumber(event.target.value)} placeholder="508 555 1234" value={phoneNumber} />
      <Input id="sim-name" label="Caller ID name" onChange={(event) => setCallerName(event.target.value)} placeholder="Optional" value={callerName} />
      <Button className="self-end" type="submit">Ring</Button>
    </form>
    {message ? <p aria-live="polite" className="text-sm font-bold">{message}</p> : null}
  </div>;
}
