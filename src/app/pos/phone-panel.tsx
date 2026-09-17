"use client";

import { useCallback, useEffect, useState } from "react";
import { phoneLineBoardSchema, type PhoneLine } from "@/lib/phone/schemas";

/**
 * The phone panel.
 *
 * Wayne's has two lines.  When one rings, the caller ID box on the network
 * reports it, and the tile for that line lights up with the number and — if
 * they have ordered before — who it is.  Tapping the tile pulls their card onto
 * the ticket, which is the whole point: the order starts before "hello" is
 * finished.
 *
 * A line with nothing on it still shows, because a cashier reaching for the
 * phone needs to see at a glance which of the two is ringing.
 */

const POLL_MS = 3000;
/** After this long a ring is history, not a live call, and the tile goes quiet. */
const LIVE_WINDOW_MS = 5 * 60 * 1000;

function formatPhone(value: string | null, fallback: string) {
  const digits = (value ?? "").replace(/\D/g, "").replace(/^1/, "");
  if (digits.length !== 10) return value || fallback || "Unknown caller";
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function sinceLabel(startedAt: string, now: number) {
  const seconds = Math.max(0, Math.round((now - Date.parse(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

export function PhonePanel({ onPickCall }: { onPickCall: (phone: string) => void }) {
  const [lines, setLines] = useState<PhoneLine[]>([]);
  const [error, setError] = useState("");
  /* "Ringing" and "40s ago" both depend on the clock, and reading the clock while
     rendering makes the panel disagree with itself between paints. The poll owns
     the clock: one tick, one consistent picture. */
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/phone/lines", { cache: "no-store" });
      if (!response.ok) throw new Error("unavailable");
      const parsed = phoneLineBoardSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("invalid");
      setLines(parsed.data);
      setError("");
    } catch {
      // A caller ID box that is unplugged must not take the register down, so
      // the panel says so quietly and the cashier keeps taking orders by hand.
      setError("Caller ID is not reporting right now.");
    }
  }, []);

  useEffect(() => {
    const poll = () => {
      setNow(Date.now());
      void load();
    };
    queueMicrotask(poll);
    const timer = window.setInterval(poll, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  return (
    <section className="rounded-xl border border-wayne-border bg-wayne-cream p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-black uppercase tracking-[0.16em]">Phone</h3>
        <span className="text-xs font-bold text-wayne-muted">{error ? "Offline" : "Live"}</span>
      </div>
      <div className="mt-2 grid gap-2">
        {lines.length ? (
          lines.map((line) => {
            const call = line.call;
            const live = Boolean(call && !call.ended_at && now - Date.parse(call.started_at) < LIVE_WINDOW_MS);
            const number = call ? formatPhone(call.caller_number, call.caller_number_raw) : "";
            const who = call?.customer
              ? `${call.customer.first_name} ${call.customer.last_name}`
              : call?.caller_name || "";
            return (
              <button
                className={`rounded-xl border p-3 text-left transition active:scale-[0.98] disabled:cursor-default disabled:opacity-60 ${
                  live ? "border-wayne-ok bg-white shadow-sm ring-2 ring-wayne-ok" : "border-wayne-border bg-white"
                }`}
                disabled={!call?.caller_number}
                key={line.line_number}
                onClick={() => call?.caller_number && onPickCall(call.caller_number)}
                type="button"
              >
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-sm">{line.label}</strong>
                  {live ? (
                    <span className="rounded-full bg-wayne-ok px-2 py-0.5 text-[0.65rem] font-black uppercase tracking-wider text-white">
                      Ringing
                    </span>
                  ) : null}
                </div>
                {call ? (
                  <>
                    <p className="mt-1 text-lg font-black leading-tight">{number}</p>
                    <p className="text-xs font-bold text-wayne-muted">
                      {who ? `${who} · ` : ""}
                      {call.customer ? `${call.customer.order_count} orders · ` : "New caller · "}
                      {sinceLabel(call.started_at, now)}
                    </p>
                  </>
                ) : (
                  <p className="mt-1 text-sm text-wayne-muted">No calls yet</p>
                )}
              </button>
            );
          })
        ) : (
          <p className="rounded-xl bg-white p-3 text-sm text-wayne-muted">
            {error || "Waiting for the first call…"}
          </p>
        )}
      </div>
    </section>
  );
}
