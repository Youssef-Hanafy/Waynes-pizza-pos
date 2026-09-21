import { isPhoneLineNumber, status, type HardwareStatus, type IncomingCallEvent, type PhoneLineNumber } from "../types";
import { CallListeners, type CallerIdProvider } from "./provider";

export type SimulatedCall = { line: PhoneLineNumber; phoneNumber: string; callerName?: string };

function randomId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `sim-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Development caller ID (§18).  `simulate()` produces the same
 * IncomingCallEvent the Android provider will, and it travels the same path:
 * provider → event bus → phone store → phone screen.  No separate fake UI.
 */
export class SimulatedCallerIdProvider implements CallerIdProvider {
  readonly kind = "simulated" as const;
  private listeners = new CallListeners();
  private running = false;

  constructor(private readonly options: { deviceId?: string; lineCount?: number } = {}) {}

  async start() {
    this.running = true;
  }

  async stop() {
    this.running = false;
  }

  async getStatus(): Promise<HardwareStatus> {
    return this.running
      ? status("simulated", "Simulated", "Test calls only. No caller ID hardware is being read.")
      : status("disconnected", "Stopped", "The simulator is not running.");
  }

  onIncomingCall(callback: (event: IncomingCallEvent) => void) {
    return this.listeners.add(callback);
  }

  /** Ring a line. Returns the event so a test can follow it through the store. */
  simulate(call: SimulatedCall): IncomingCallEvent {
    if (!this.running) throw new Error("Start the simulated caller ID before ringing a line.");
    const lineCount = this.options.lineCount ?? 8;
    if (!isPhoneLineNumber(call.line) || call.line > lineCount) throw new Error(`Line ${call.line} is not one of the store's ${lineCount} lines.`);
    const event: IncomingCallEvent = {
      id: randomId(),
      deviceId: this.options.deviceId ?? "simulator",
      line: call.line,
      phoneNumber: call.phoneNumber.trim(),
      callerName: call.callerName?.trim() || null,
      occurredAt: new Date().toISOString(),
      source: "simulated",
    };
    this.listeners.emit(event);
    return event;
  }

  /** Send the same ring again, the way a box repeating a UDP packet would (§17). */
  replay(event: IncomingCallEvent) {
    if (!this.running) throw new Error("Start the simulated caller ID before ringing a line.");
    this.listeners.emit({ ...event });
  }
}
