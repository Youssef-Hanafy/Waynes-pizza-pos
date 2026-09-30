import { parseWhozzCallingRecord } from "@/lib/phone/schemas";

/**
 * The contract between the POS and the POS Android app (build sheet
 * §19, §52, §59, §62).  The app (android/ in this repo) is a full-screen
 * WebView of this website plus two native abilities, exposed to the page as
 * window.WaynesAndroid; every screen, store and business rule stays here.
 *
 *   caller ID  (native)  UDP socket on the configured port → raw packet text
 *   printer    (native)  bytes → TCP socket at the printer's IP:port
 *   card reader (native) Stripe Terminal SDK ↔ the Stripe Reader M2 over Bluetooth
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

/** What the app reports about the Stripe reader (StripeReader.java statusJson). */
export type NativeStripeStatus = {
  state: "not_ready" | "disconnected" | "discovering" | "connecting" | "updating" | "connected" | "collecting";
  serial?: string | null;
  battery?: number | null;
  charging?: boolean | null;
  detail?: string | null;
  updateProgress?: number | null;
};

/** Messages the reader wants shown while a card is being taken ("Insert, tap or swipe", "Remove card"…). */
export type NativeStripeEvent =
  | { type: "status"; status: NativeStripeStatus }
  | { type: "prompt"; text: string };

export type NativeStripeBridge = {
  status(): NativeStripeStatus;
  /** Find the M2 over Bluetooth and connect it (installing any required reader update first). Resolves with its serial number. */
  connect(options: { locationId: string; simulated?: boolean }): Promise<string>;
  /** Take a card for this PaymentIntent. Resolves with the intent id once the reader has approved it. */
  collect(clientSecret: string): Promise<string>;
  /** Stop the card collection in progress (if any). */
  cancel(): Promise<void>;
  disconnect(): Promise<void>;
  onEvent(listener: (event: NativeStripeEvent) => void): () => void;
  /** The app asks the page for a connection token; the page fetches it with the signed-in session. */
  setTokenSource(fetchToken: () => Promise<string>): void;
};

export type NativeError = Error & { code?: string };

/** What the Android app puts on the page (android/app/src/main/java/com/waynespizza/pos/NativeBridge.java). */
export type WaynesAndroidInterface = {
  info(): string;
  printerSend(callId: string, host: string, port: number, base64: string, timeoutMs: number): void;
  callerIdStart(callId: string, port: number, bindAddress: string, deviceIp: string): void;
  callerIdStop(callId: string): void;
  callerIdStatus(): string;
  /** Stripe Reader M2 (app 1.1+). Absent in older builds of the app. */
  stripeStatus?(): string;
  stripeConnect?(callId: string, locationId: string, simulated: boolean): void;
  stripeCollect?(callId: string, clientSecret: string): void;
  stripeCancel?(callId: string): void;
  stripeDisconnect?(callId: string): void;
  stripeTokenResult?(requestId: string, ok: boolean, value: string): void;
};

declare global {
  interface Window {
    WaynesNativeHardware?: { callerId?: NativeCallerIdBridge; printer?: NativePrinterBridge; stripe?: NativeStripeBridge };
    WaynesAndroid?: WaynesAndroidInterface;
    /** The app calls these back from native threads. */
    __waynesNativeResult?: (callId: string, ok: boolean, code: string, message: string) => void;
    __waynesNativePacket?: (text: string, from: string, receivedAt: number) => void;
    __waynesStripeEvent?: (type: string, json: string) => void;
    __waynesStripeToken?: (requestId: string) => void;
  }
}

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
  const pending = new Map<string, { resolve: (message: string) => void; reject: (error: NativeError) => void }>();
  const packetListeners = new Set<(text: string, from: string, receivedAt: number) => void>();
  target.__waynesNativeResult = (callId, ok, code, message) => {
    const waiting = pending.get(callId);
    if (!waiting) return;
    pending.delete(callId);
    if (ok) waiting.resolve(message);
    else waiting.reject(Object.assign(new Error(message || "The device did not answer."), { code }));
  };
  target.__waynesNativePacket = (text, from, receivedAt) => {
    for (const listener of [...packetListeners]) listener(text, from, receivedAt);
  };
  const callFor = (start: (callId: string) => void, timeoutMs: number) => new Promise<string>((resolve, reject) => {
    sequence += 1;
    const callId = `c${Date.now().toString(36)}${sequence}`;
    const timer = setTimeout(() => {
      if (!pending.delete(callId)) return;
      // The app never answered: treat the outcome as unknown, not as "not sent".
      reject(Object.assign(new Error("The POS app did not answer in time."), { code: "TIMEOUT" }));
    }, timeoutMs);
    pending.set(callId, {
      resolve: (message) => { clearTimeout(timer); resolve(message); },
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

  const call = async (start: (callId: string) => void, timeoutMs: number): Promise<void> => { await callFor(start, timeoutMs); };

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
    ...(android.stripeCollect ? { stripe: createStripeBridge(android, target, callFor) } : {}),
  };
  return hardware;
}

const unknownStripe: NativeStripeStatus = { state: "not_ready", detail: "The app's card reader status could not be read." };

/** The Stripe reader half of the bridge (only built when the app has it). */
function createStripeBridge(android: WaynesAndroidInterface, target: Window, callFor: (start: (callId: string) => void, timeoutMs: number) => Promise<string>): NativeStripeBridge {
  const listeners = new Set<(event: NativeStripeEvent) => void>();
  let fetchToken: (() => Promise<string>) | null = null;
  const emit = (event: NativeStripeEvent) => { for (const listener of [...listeners]) listener(event); };
  target.__waynesStripeEvent = (type, json) => {
    try {
      const body = JSON.parse(json) as Record<string, unknown>;
      if (type === "prompt" && typeof body.text === "string") emit({ type: "prompt", text: body.text });
      if (type === "status") emit({ type: "status", status: body as NativeStripeStatus });
    } catch { /* a malformed event is dropped; the next status poll corrects the screen */ }
  };
  target.__waynesStripeToken = (requestId) => {
    const answer = (ok: boolean, value: string) => { try { android.stripeTokenResult?.(requestId, ok, value); } catch { /* app gone */ } };
    if (!fetchToken) { answer(false, "The POS page is not ready to authorise the card reader."); return; }
    fetchToken().then((secret) => answer(true, secret), (error: unknown) => answer(false, error instanceof Error ? error.message : "The card reader could not be authorised."));
  };
  return {
    status() {
      try { return { ...unknownStripe, ...(JSON.parse(android.stripeStatus?.() ?? "{}") as NativeStripeStatus) }; } catch { return unknownStripe; }
    },
    // A required reader update can take several minutes the first time.
    connect: ({ locationId, simulated = false }) => callFor((id) => android.stripeConnect!(id, locationId, simulated), 15 * 60_000),
    collect: (clientSecret) => callFor((id) => android.stripeCollect!(id, clientSecret), 6 * 60_000),
    cancel: async () => { await callFor((id) => android.stripeCancel!(id), 20_000); },
    disconnect: async () => { await callFor((id) => android.stripeDisconnect!(id), 20_000); },
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setTokenSource(source) { fetchToken = source; },
  };
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
