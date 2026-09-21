import { parseWhozzCallingRecord } from "@/lib/phone/schemas";

/**
 * The contract between the POS and the Wayne's POS Android app (build sheet
 * §19, §52, §59, §62).  The app (android/ in this repo) is a full-screen
 * WebView of this website plus two native abilities, exposed to the page as
 * window.WaynesAndroid; every screen, store and business rule stays here.
 *
 *   caller ID  (native)  UDP socket on the configured port → raw packet text
 *   printer    (native)  bytes → TCP socket at the printer's IP:port
 *
 * installNativeBridge() adapts those to window.WaynesNativeHardware, which the
 * Android caller ID provider and the network printer provider use.  In an
 * ordinary browser window.WaynesAndroid is absent and nothing is installed.
 *
 * CallerID.com records are parsed HERE, in one place, with the parser checked
 * against the official Ethernet Link manual (see parseWhozzCallingRecord) — the
 * native code forwards the packet untouched (§19: no invented parser).
 */

export type NativeCall = { id: string; line: number; phoneNumber: string; callerName?: string | null; occurredAt: string; deviceId?: string; raw?: string };

export type NativeCallerIdBridge = {
  start(options: { port: number; bindAddress: string; deviceIp?: string }): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<{ state: "listening" | "stopped" | "permission_denied" | "error"; detail?: string }>;
  onCall(callback: (call: NativeCall) => void): () => void;
};

export type NativePrinterBridge = {
  send(options: { host: string; port: number; data: string; timeoutMs?: number }): Promise<void>;
};

/** What the Android app puts on the page (android/app/src/main/java/com/waynespizza/pos/NativeBridge.java). */
export type WaynesAndroidInterface = {
  info(): string;
  printerSend(callId: string, host: string, port: number, base64: string, timeoutMs: number): void;
  callerIdStart(callId: string, port: number, bindAddress: string, deviceIp: string): void;
  callerIdStop(callId: string): void;
  callerIdStatus(): string;
};

declare global {
  interface Window {
    WaynesNativeHardware?: { callerId?: NativeCallerIdBridge; printer?: NativePrinterBridge };
    WaynesAndroid?: WaynesAndroidInterface;
    /** The app calls these back from native threads. */
    __waynesNativeResult?: (callId: string, ok: boolean, code: string, message: string) => void;
    __waynesNativePacket?: (text: string, from: string, receivedAt: number) => void;
  }
}

type NativeError = Error & { code?: string };

/**
 * Turns raw packets into calls, deduplicating the way the build sheet asks
 * (§17): the same ring repeated by the box keeps one id; a new ring after the
 * box reported the previous call ended gets a new one.
 */
export function createPacketInterpreter() {
  const seen = new Map<string, { ended: boolean; generation: number }>();
  return function interpret(text: string, from: string, receivedAt: number): NativeCall | null {
    const record = parseWhozzCallingRecord(text);
    if (!record || record.direction !== "inbound") return null;
    const base = `${record.unit_number || from}|${record.line_number}|${record.caller_number}`;
    const entry = seen.get(base) ?? { ended: false, generation: 0 };
    if (record.event === "end") {
      seen.set(base, { ended: true, generation: entry.generation });
      return null;
    }
    const generation = entry.ended ? entry.generation + 1 : entry.generation;
    seen.set(base, { ended: false, generation });
    if (seen.size > 500) seen.delete(seen.keys().next().value!);
    return {
      id: `cid-${base.replace(/[^0-9A-Za-z]/g, "")}-${generation}-${Math.floor(receivedAt / 3_600_000)}`,
      line: record.line_number,
      phoneNumber: record.caller_number,
      callerName: record.caller_name || null,
      occurredAt: new Date(receivedAt).toISOString(),
      deviceId: record.unit_number || from,
      raw: text,
    };
  };
}

/**
 * Adapts window.WaynesAndroid (synchronous calls, answers delivered later
 * through window.__waynesNativeResult) to promise-based bridges.
 */
export function createAndroidHardware(android: WaynesAndroidInterface, target: Window) {
  let sequence = 0;
  const pending = new Map<string, { resolve: () => void; reject: (error: NativeError) => void }>();
  const packetListeners = new Set<(text: string, from: string, receivedAt: number) => void>();
  target.__waynesNativeResult = (callId, ok, code, message) => {
    const waiting = pending.get(callId);
    if (!waiting) return;
    pending.delete(callId);
    if (ok) waiting.resolve();
    else waiting.reject(Object.assign(new Error(message || "The device did not answer."), { code }));
  };
  target.__waynesNativePacket = (text, from, receivedAt) => {
    for (const listener of [...packetListeners]) listener(text, from, receivedAt);
  };
  const call = (start: (callId: string) => void, timeoutMs: number) => new Promise<void>((resolve, reject) => {
    sequence += 1;
    const callId = `c${Date.now().toString(36)}${sequence}`;
    const timer = setTimeout(() => {
      if (!pending.delete(callId)) return;
      // The app never answered: treat the outcome as unknown, not as "not sent".
      reject(Object.assign(new Error("The Wayne's POS app did not answer in time."), { code: "TIMEOUT" }));
    }, timeoutMs);
    pending.set(callId, {
      resolve: () => { clearTimeout(timer); resolve(); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    try {
      start(callId);
    } catch (error) {
      pending.delete(callId);
      clearTimeout(timer);
      reject(Object.assign(new Error(error instanceof Error ? error.message : "The app refused the request."), { code: "NOT_CONNECTED" }));
    }
  });

  const interpret = createPacketInterpreter();
  const hardware: NonNullable<Window["WaynesNativeHardware"]> = {
    printer: {
      send: ({ host, port, data, timeoutMs = 8000 }) => call((id) => android.printerSend(id, host, port, data, timeoutMs), timeoutMs + 5000),
    },
    callerId: {
      start: ({ port, bindAddress, deviceIp }) => call((id) => android.callerIdStart(id, port, bindAddress, deviceIp ?? ""), 60_000),
      stop: () => call((id) => android.callerIdStop(id), 10_000),
      async status() {
        try {
          const parsed = JSON.parse(android.callerIdStatus()) as { state?: string; detail?: string };
          const state = parsed.state === "listening" || parsed.state === "permission_denied" || parsed.state === "error" ? parsed.state : "stopped";
          return { state, detail: parsed.detail };
        } catch {
          return { state: "error" as const, detail: "The app's caller ID status could not be read." };
        }
      },
      onCall(callback) {
        const listener = (text: string, from: string, receivedAt: number) => {
          const found = interpret(text, from, receivedAt);
          if (found) callback(found);
        };
        packetListeners.add(listener);
        return () => { packetListeners.delete(listener); };
      },
    },
  };
  return hardware;
}

let installed = false;

export function installNativeBridge(): boolean {
  if (typeof window === "undefined" || !window.WaynesAndroid) return false;
  if (!installed || !window.WaynesNativeHardware) {
    window.WaynesNativeHardware = createAndroidHardware(window.WaynesAndroid, window);
    installed = true;
  }
  return true;
}
