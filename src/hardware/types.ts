/**
 * Hardware contracts (build sheet §4, §5, §53).
 *
 * Everything the POS knows about physical equipment passes through these
 * types.  Order and phone screens never import a CallerID.com parser, a printer
 * protocol or anything Android — they receive these events and call these
 * interfaces, so swapping the simulator for the future Android provider changes
 * nothing above this folder.
 */

/** The store's physical phone lines. Wayne's has two; the box supports more. */
export type PhoneLineNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export function isPhoneLineNumber(value: number): value is PhoneLineNumber {
  return Number.isInteger(value) && value >= 1 && value <= 8;
}

/** Where a caller event came from. */
export type CallerIdSource = "simulated" | "cloud" | "android_native";

/**
 * One ring, in the shape every provider must produce (§53).  The simulator
 * builds exactly this, and so will the Android UDP provider.
 */
export type IncomingCallEvent = {
  /** Stable event id; the dedupe key end to end (§17). */
  id: string;
  deviceId?: string;
  line: PhoneLineNumber;
  /** As received. Normalized by the phone store, not by providers. */
  phoneNumber: string;
  callerName?: string | null;
  occurredAt: string;
  rawPayload?: string;
  source: CallerIdSource;
  /** Set when the event is already recorded on the server (cloud provider). */
  serverCallId?: string;
};

export type HardwareState =
  | "simulated"
  | "connected"
  | "listening"
  | "disconnected"
  | "not_configured"
  | "unavailable"
  | "error";

export type HardwareStatus = {
  state: HardwareState;
  /** One or two words for a status chip. */
  label: string;
  /** Why, in words staff can act on (§63: never fail silently). */
  detail?: string;
  checkedAt: string;
};

export type HardwareDevice = "caller_id" | "caller_sync" | "receipt_printer" | "kitchen_printer" | "cash_drawer" | "payment_terminal";

export type HardwareEvent =
  | { type: "caller.incoming"; payload: IncomingCallEvent }
  /** Another register (or the store bridge) changed a call: resync the board. */
  | { type: "caller.changed"; payload: { serverCallId: string | null } }
  | { type: "hardware.status"; payload: { device: HardwareDevice; status: HardwareStatus } };

export type PrintResult =
  | { ok: true; jobId?: string }
  /** notSent: certain that nothing reached the printer (safe to retry without a duplicate). */
  | { ok: false; reason: string; notSent?: boolean };

export type PaymentRequest = { orderId: string; orderNumber: string; amountCents: number };

export type PaymentResult =
  /** The provider cannot charge by itself; staff run the card on the external terminal. */
  | { state: "awaiting_manual_confirmation"; instructions: string; amountCents: number }
  | { state: "approved"; providerPaymentId: string; amountCents: number }
  | { state: "declined" | "cancelled" | "failed"; reason: string };

export function status(state: HardwareState, label: string, detail?: string): HardwareStatus {
  return { state, label, detail, checkedAt: new Date().toISOString() };
}

/** A definite "this device is not there" — safe to show, never a false success. */
export class HardwareUnavailableError extends Error {
  readonly code = "hardware_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "HardwareUnavailableError";
  }
}
