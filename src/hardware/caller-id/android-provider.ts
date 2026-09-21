import { isPhoneLineNumber, status, type HardwareStatus, type IncomingCallEvent } from "../types";
import { CallListeners, type CallerIdProvider } from "./provider";

/**
 * The contract the future Android shell must expose on `window` (§19, §52).
 * Nothing implements it yet — this file only fixes the shape so the native
 * plugin can be written against it without touching any POS screen.
 *
 * The native side owns the UDP socket on the configured port (default 3520),
 * parses CallerID.com's documented Ethernet format, and hands over the fields
 * below.  Parsing is deliberately NOT done here (§19: no invented parser).
 */
export type NativeCallerIdBridge = {
  start(options: { port: number; bindAddress: string; deviceIp?: string }): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<{ state: "listening" | "stopped" | "permission_denied" | "error"; detail?: string }>;
  onCall(callback: (call: { id: string; line: number; phoneNumber: string; callerName?: string | null; occurredAt: string; deviceId?: string; raw?: string }) => void): () => void;
};

declare global {
  interface Window {
    WaynesNativeHardware?: { callerId?: NativeCallerIdBridge };
  }
}

export class AndroidCallerIdProvider implements CallerIdProvider {
  readonly kind = "android_native" as const;
  private listeners = new CallListeners();
  private detach: (() => void) | null = null;

  constructor(private readonly options: { port: number; bindAddress: string; deviceIp?: string }) {}

  private bridge() {
    return typeof window === "undefined" ? undefined : window.WaynesNativeHardware?.callerId;
  }

  async start() {
    const bridge = this.bridge();
    if (!bridge || this.detach) return;
    await bridge.start(this.options);
    this.detach = bridge.onCall((call) => {
      if (!isPhoneLineNumber(call.line)) return;
      this.listeners.emit({
        id: call.id, line: call.line, phoneNumber: call.phoneNumber, callerName: call.callerName ?? null,
        occurredAt: call.occurredAt, deviceId: call.deviceId, rawPayload: call.raw, source: "android_native",
      });
    });
  }

  async stop() {
    this.detach?.();
    this.detach = null;
    await this.bridge()?.stop();
  }

  async getStatus(): Promise<HardwareStatus> {
    const bridge = this.bridge();
    if (!bridge) return status("unavailable", "Not installed", "Android caller ID needs the Wayne's POS app. This browser cannot listen for the caller ID box.");
    const native = await bridge.status();
    if (native.state === "listening") return status("listening", "Listening", `UDP port ${this.options.port}`);
    if (native.state === "permission_denied") return status("error", "Offline", "Local network permission unavailable");
    return status(native.state === "error" ? "error" : "disconnected", native.state === "error" ? "Error" : "Stopped", native.detail);
  }

  onIncomingCall(callback: (event: IncomingCallEvent) => void) {
    return this.listeners.add(callback);
  }
}
