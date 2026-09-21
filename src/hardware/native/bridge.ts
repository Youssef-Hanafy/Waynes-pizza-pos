import { parseWhozzCallingRecord } from "@/lib/phone/schemas";

/**
 * The contract between the POS and the Wayne's POS Android app (build sheet
 * §19, §52, §59, §62).  The app adds two small native plugins and nothing
 * else; every screen, store and business rule stays in this web app.
 *
 *   WaynesCallerId  (native)  UDP socket on the configured port → raw packet text
 *   WaynesPrinter   (native)  bytes → TCP socket at the printer's IP:port
 *
 * installNativeBridge() adapts those plugins to window.WaynesNativeHardware,
 * which the Android caller ID provider and the network printer provider use.
 * In an ordinary browser the plugins are absent and nothing is installed.
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

declare global {
  interface Window {
    WaynesNativeHardware?: { callerId?: NativeCallerIdBridge; printer?: NativePrinterBridge };
    Capacitor?: { isNativePlatform?: () => boolean; Plugins?: Record<string, unknown> };
  }
}

type Listener = { remove: () => Promise<void> | void };
type CapacitorCallerIdPlugin = {
  start(options: { port: number; bindAddress: string; deviceIp?: string }): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<{ state: "listening" | "stopped" | "permission_denied" | "error"; detail?: string }>;
  addListener(event: "packet", callback: (packet: { text: string; from: string; receivedAt: number }) => void): Promise<Listener> | Listener;
};
type CapacitorPrinterPlugin = { send(options: { host: string; port: number; data: string; timeoutMs?: number }): Promise<void> };

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

export function installNativeBridge(): boolean {
  if (typeof window === "undefined" || !window.Capacitor?.isNativePlatform?.()) return false;
  const plugins = window.Capacitor.Plugins ?? {};
  const callerPlugin = plugins.WaynesCallerId as CapacitorCallerIdPlugin | undefined;
  const printerPlugin = plugins.WaynesPrinter as CapacitorPrinterPlugin | undefined;
  const hardware: NonNullable<Window["WaynesNativeHardware"]> = {};

  if (callerPlugin) {
    const interpret = createPacketInterpreter();
    hardware.callerId = {
      start: (options) => callerPlugin.start(options),
      stop: () => callerPlugin.stop(),
      status: () => callerPlugin.status(),
      onCall(callback) {
        let handle: Listener | null = null;
        let cancelled = false;
        void Promise.resolve(callerPlugin.addListener("packet", (packet) => {
          const call = interpret(packet.text, packet.from, packet.receivedAt);
          if (call) callback(call);
        })).then((listener) => { if (cancelled) void listener.remove(); else handle = listener; });
        return () => { cancelled = true; if (handle) void handle.remove(); };
      },
    };
  }
  if (printerPlugin) hardware.printer = { send: (options) => printerPlugin.send(options) };
  window.WaynesNativeHardware = hardware;
  return true;
}
