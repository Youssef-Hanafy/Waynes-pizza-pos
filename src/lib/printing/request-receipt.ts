import { getHardwareRuntime } from "@/stores/hardware-store";

/**
 * Print a customer receipt when someone asks for one (pickup and takeout
 * orders don't print one on their own).
 *
 * On the counter tablet (the Wayne's POS app, printer reachable) it prints
 * straight away.  Anywhere else it's queued for the front printer and the
 * print station prints it, so any register or phone can ask.
 */
export async function requestReceipt(orderId: string): Promise<{ ok: boolean; message: string }> {
  const runtime = getHardwareRuntime();
  if (runtime && typeof window !== "undefined" && window.WaynesNativeHardware?.printer) {
    const status = await runtime.receiptPrinter.getStatus().catch(() => null);
    if (status?.state === "connected" && status.label !== "Print dialog") {
      const result = await runtime.receiptPrinter.printReceipt(orderId);
      if (result.ok) return { ok: true, message: "Receipt printed." };
      // Couldn't reach the printer from here: fall back to the queue so it prints when it can.
      if (!result.notSent) return { ok: false, message: result.reason };
    }
  }
  try {
    const response = await fetch(`/api/pos/orders/${orderId}/receipt`, { method: "POST", signal: AbortSignal.timeout(10_000) });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const reason = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : "The receipt could not be sent to the printer.";
      return { ok: false, message: reason };
    }
    const already = body && typeof body === "object" && (body as { status?: unknown }).status === "already_queued";
    return { ok: true, message: already ? "Already on its way to the front printer." : "Sent to the front printer." };
  } catch {
    return { ok: false, message: "No connection. Try again in a moment." };
  }
}
