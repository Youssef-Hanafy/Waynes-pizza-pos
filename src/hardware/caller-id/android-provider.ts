import { isPhoneLineNumber, status, type HardwareStatus, type IncomingCallEvent } from "../types";
import type { NativeCallerIdBridge } from "../native/bridge";
import { CallListeners, type CallerIdProvider } from "./provider";

/**
 * Caller ID from the Wayne's POS Android app (§19, §52).  The app's native
 * plugin listens on the configured UDP port and src/hardware/native/bridge.ts
 * turns each CallerID.com record into the call shape below; this provider
 * only adapts it to the same IncomingCallEvent the simulator produces.
 */

export class AndroidCallerIdProvider implements CallerIdProvider {
  readonly kind = "android_native" as const;
  private listeners = new CallListeners();
  private detach: (() => void) | null = null;

  constructor(private readonly options: { port: number; bindAddress: string; deviceIp?: string }) {}

  private bridge(): NativeCallerIdBridge | undefined {
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
