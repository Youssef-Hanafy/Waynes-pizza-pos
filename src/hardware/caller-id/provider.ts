import type { CallerIdSource, HardwareStatus, IncomingCallEvent } from "../types";

/**
 * A source of rings (§4).  Implementations:
 *
 *   SimulatedCallerIdProvider  — now: admin/test buttons, same event path as real hardware
 *   CloudCallerIdProvider      — now: rings recorded by the store bridge or another register
 *   AndroidCallerIdProvider    — later: native UDP listener on the tablet (§19)
 *
 * Browser JavaScript never opens a UDP socket (§19); only the Android shell will.
 */
export interface CallerIdProvider {
  readonly kind: CallerIdSource;
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): Promise<HardwareStatus>;
  /** Returns the unsubscribe function. */
  onIncomingCall(callback: (event: IncomingCallEvent) => void): () => void;
}

/** Shared listener bookkeeping for providers. */
export class CallListeners {
  private listeners = new Set<(event: IncomingCallEvent) => void>();

  add(callback: (event: IncomingCallEvent) => void) {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  emit(event: IncomingCallEvent) {
    for (const listener of [...this.listeners]) listener(event);
  }
}
