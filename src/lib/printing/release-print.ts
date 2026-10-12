/** Let a held kitchen ticket print now (Pay later, or the payment screen was closed). Best effort. */
export function releaseOrderPrint(orderId: string) {
  void releaseOrderPrintNow(orderId);
}

/** True when a held ticket was waiting and now prints; false when nothing was held (already printed). */
export async function releaseOrderPrintNow(orderId: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/pos/orders/${orderId}/release-print`, { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: "{}" });
    const body = await response.json().catch(() => null) as { released?: boolean } | null;
    return response.ok && body?.released === true;
  } catch {
    return false;
  }
}
