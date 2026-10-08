"use client";

import { installNativeBridge, type NativeError, type NativeStripeBridge, type NativeStripeStatus } from "@/hardware/native/bridge";
import { createStore, useStore } from "./create-store";
import { logDevice } from "@/lib/pos/device-log";

/**
 * The Stripe Reader M2 on this register, as the POS page sees it.
 *
 * The reader itself is driven by the POS Android app (Stripe's SDK only runs
 * there); this store mirrors its status for the screens, hands the app a
 * connection token when it asks, and turns connect / take-a-card into
 * promises.  In an ordinary browser `available` stays false.
 */
export type StripeReaderState = {
  available: boolean;
  status: NativeStripeStatus;
  /** What the reader wants the cashier to tell the customer right now. */
  prompt: string;
  /** Last connection problem, in words. */
  error: string;
};

const initial: StripeReaderState = { available: false, status: { state: "not_ready" }, prompt: "", error: "" };
export const stripeReaderStore = createStore<StripeReaderState>(initial);

function native(): NativeStripeBridge | undefined {
  if (typeof window === "undefined") return undefined;
  installNativeBridge();
  return window.WaynesNativeHardware?.stripe;
}

async function readError(response: Response, fallback: string) {
  const body: unknown = await response.json().catch(() => null);
  return body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : fallback;
}

async function post(path: string, body: unknown = {}) {
  return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(25_000) });
}

async function fetchConnectionToken() {
  try {
    const response = await post("/api/pos/stripe-terminal/connection-token");
    if (!response.ok) throw new Error(await readError(response, "The card reader could not be authorised."));
    const body = await response.json() as { secret?: string };
    if (!body.secret) throw new Error("The card reader could not be authorised.");
    logDevice("reader.token_ok");
    return body.secret;
  } catch (cause) {
    logDevice("reader.token_failed", cause instanceof Error ? cause.message : String(cause));
    throw cause;
  }
}

/** Last native activity (any status or prompt event) — lets connect tell "busy" from "the app never answered". */
let lastNativeActivity = 0;

/** What the page knows about the app, for the diagnostics log. */
export function describeNativeApp() {
  if (typeof window === "undefined") return {};
  const android = window.WaynesAndroid as unknown as Record<string, unknown> | undefined;
  let info: unknown = null;
  try { info = android && typeof android.info === "function" ? JSON.parse(String((android.info as () => string)())) : null; } catch { info = "unreadable"; }
  return {
    has_android_bridge: Boolean(android),
    has_stripe_methods: Boolean(android && typeof android.stripeCollect === "function"),
    app_info: info,
    url: window.location.href,
  };
}

let started = false;

/** Wire the app's reader to this page once. Safe to call on every render path. */
export function startStripeReader(): boolean {
  const bridge = native();
  if (!bridge) return false;
  if (started) return true;
  started = true;
  bridge.setTokenSource(fetchConnectionToken);
  const initial = bridge.status();
  logDevice("reader.start", initial.detail ?? "", { state: initial.state, serial: initial.serial ?? null, ...describeNativeApp() });
  bridge.onEvent((event) => {
    lastNativeActivity = Date.now();
    if (event.type === "prompt") logDevice("reader.prompt", event.text);
    else logDevice("reader.status", event.status.detail ?? "", { state: event.status.state, serial: event.status.serial ?? null, battery: event.status.battery ?? null, update: event.status.updateProgress ?? null });
    if (event.type === "prompt") stripeReaderStore.set((state) => ({ ...state, prompt: event.text }));
    else stripeReaderStore.set((state) => ({ ...state, status: event.status, prompt: event.status.state === "collecting" ? state.prompt : "" }));
  });
  stripeReaderStore.set((state) => ({ ...state, available: true, status: bridge.status() }));
  window.setInterval(() => {
    const status = bridge.status();
    stripeReaderStore.set((state) => (state.status.state === status.state && state.status.battery === status.battery && state.status.serial === status.serial && state.status.updateProgress === status.updateProgress ? state : { ...state, status }));
  }, 5000);
  return true;
}

let connecting: Promise<boolean> | null = null;

/** Find and connect the M2. Resolves true when it is ready to take cards. */
export function connectStripeReader(options: { simulated?: boolean } = {}): Promise<boolean> {
  const bridge = native();
  if (!bridge || !startStripeReader()) return Promise.resolve(false);
  if (bridge.status().state === "connected") return Promise.resolve(true);
  if (connecting) return connecting;
  connecting = (async () => {
    stripeReaderStore.set((state) => ({ ...state, error: "" }));
    try {
      logDevice("reader.connect_begin", "", { state: bridge.status().state, simulated: Boolean(options.simulated) });
      const response = await post("/api/pos/stripe-terminal/location");
      if (!response.ok) throw new Error(await readError(response, "The card reader's store location could not be set up."));
      const { location_id: locationId } = await response.json() as { location_id?: string };
      if (!locationId) throw new Error("The card reader's store location could not be set up.");
      logDevice("reader.location_ok", locationId);
      const startedAt = Date.now();
      // The app answers a connect within seconds (a permission prompt, "Looking for the reader…").
      // If it says nothing at all for a minute, it never received the request: say so instead of
      // leaving "Connecting…" on screen for the full 15-minute update allowance.
      let check = 0;
      const silent = new Promise<never>((_, reject) => {
        check = window.setInterval(() => {
          if (lastNativeActivity >= startedAt) { window.clearInterval(check); return; }
          if (Date.now() - startedAt > 60_000) {
            window.clearInterval(check);
            reject(Object.assign(new Error("The Wayne's POS app did not respond to the card reader request. Close Wayne's POS completely (Settings → Apps → Wayne's POS → Force stop), open it again, then tap Connect reader."), { code: "APP_SILENT" }));
          }
        }, 3000);
      });
      silent.catch(() => undefined);
      let serial: string;
      try {
        serial = await Promise.race([bridge.connect({ locationId, simulated: options.simulated }), silent]);
      } finally {
        window.clearInterval(check);
      }
      logDevice("reader.connected", String(serial ?? ""), { state: bridge.status().state });
      stripeReaderStore.set((state) => ({ ...state, status: bridge.status(), error: "" }));
      return true;
    } catch (cause) {
      logDevice("reader.connect_failed", cause instanceof Error ? cause.message : String(cause), { code: (cause as NativeError)?.code ?? null, status: bridge.status() as unknown as Record<string, unknown> });
      stripeReaderStore.set((state) => ({ ...state, status: bridge.status(), error: cause instanceof Error ? cause.message : "The card reader could not be connected." }));
      return false;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

export type CollectOutcome =
  | { ok: true; intentId: string }
  | { ok: false; code: "DECLINED" | "CANCELED" | "NOT_CONNECTED" | "UNKNOWN"; message: string };

/** Ask the reader to take a card for this PaymentIntent. */
export async function collectWithStripeReader(clientSecret: string): Promise<CollectOutcome> {
  const bridge = native();
  if (!bridge) return { ok: false, code: "NOT_CONNECTED", message: "The card reader works in the POS Android app only." };
  stripeReaderStore.set((state) => ({ ...state, prompt: "" }));
  logDevice("reader.collect_begin", "", { state: bridge.status().state });
  try {
    const intentId = await bridge.collect(clientSecret);
    logDevice("reader.collect_ok", intentId);
    return { ok: true, intentId };
  } catch (cause) {
    const error = cause as NativeError;
    logDevice("reader.collect_failed", error.message ?? "", { code: error.code ?? null });
    const code = error.code === "DECLINED" || error.code === "CANCELED" || error.code === "NOT_CONNECTED" ? error.code : "UNKNOWN";
    return { ok: false, code, message: error.message || "The card reader did not finish." };
  } finally {
    stripeReaderStore.set((state) => ({ ...state, prompt: "" }));
  }
}

export async function cancelStripeReaderCollect() {
  try { await native()?.cancel(); } catch { /* nothing was collecting */ }
}

export function useStripeReader() {
  return useStore(stripeReaderStore, (state) => state, initial);
}

export const stripeReaderLabels: Record<NativeStripeStatus["state"], string> = {
  not_ready: "Starting…",
  disconnected: "Not connected",
  discovering: "Looking for the reader…",
  connecting: "Connecting…",
  updating: "Updating the reader…",
  connected: "Ready",
  collecting: "Taking a card…",
};
