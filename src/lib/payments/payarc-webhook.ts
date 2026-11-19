import "server-only";
import type { PaymentConnection } from "./capabilities";
import type { PaymentProvider } from "./provider";
import type { createServiceSupabaseClient } from "@/lib/supabase/server";
import { settlePayarcPayment } from "./payarc-operation";

/** Never persist Payarc's raw callback: examples include PAN/CVV in request_payload. */
export function payarcWebhookIdentity(rawBody: string): { chargeId: string; refund: boolean } | null {
  try {
    const body = JSON.parse(rawBody);
    const object = body?.api_response?.original?.data ?? body?.api_response?.data;
    const refund = object?.object === "Refund";
    const id = refund ? object.charge_id : object?.object === "Charge" ? object.id : null;
    return typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id) ? { chargeId: id, refund } : null;
  } catch { return null; }
}

/** The unguessable connection URL admits hints; only authenticated API reads settle money. */
export async function receivePayarcWebhook(rawBody: string, connection: PaymentConnection, provider: PaymentProvider, service: ReturnType<typeof createServiceSupabaseClient>) {
  const identity = payarcWebhookIdentity(rawBody);
  if (!identity) return new Response(null, { status: 200 });
  try {
    const payment = await provider.getPaymentStatus(identity.chargeId);
    const bound = await service.from("payments").select("id").eq("workspace_id", connection.workspace_id)
      .eq("provider", "payarc").eq("metadata->>payarc_connection_id", connection.id).eq("provider_payment_id", identity.chargeId).maybeSingle();
    if (bound.error) throw new Error("Payment lookup failed");
    if (!bound.data) {
      const reference = payment.metadata?.wayne_payarc_reference ?? "";
      if (!/^WAYNES [a-f0-9]{18}$/.test(reference)) return new Response(null, { status: 200 });
      const attempt = await service.from("payments").select("id").eq("workspace_id", connection.workspace_id)
        .eq("provider", "payarc").eq("metadata->>payarc_connection_id", connection.id).eq("metadata->>payarc_reference", reference).maybeSingle();
      if (attempt.error) throw new Error("Payment lookup failed");
      if (!attempt.data) return new Response(null, { status: 200 });
    }
    // Scope/reference/amount checks and captured-state fencing happen atomically in SQL.
    const saved = await settlePayarcPayment(service, connection.id, payment);
    if (identity.refund && provider.findRefund) {
      const { data: refunds, error } = await service.from("refunds").select("id,amount_cents,idempotency_key,status")
        .eq("workspace_id", connection.workspace_id).eq("payment_id", saved.payment_id).eq("status", "pending");
      if (error) throw new Error("Refund lookup failed");
      for (const leg of refunds ?? []) {
        const refund = await provider.findRefund({ providerPaymentId: identity.chargeId, amountCents: leg.amount_cents, idempotencyKey: leg.idempotency_key });
        if (!refund?.providerRefundId) continue;
        const result = await service.rpc(refund.status === "pending" ? "wayne_observe_refund" : "wayne_settle_refund", { payload: {
          refund_id: leg.id, provider_refund_id: refund.providerRefundId, status: refund.status, provider_status: refund.providerStatus,
        } });
        if (result.error) throw new Error("Refund reconciliation failed");
      }
    }
    return new Response(null, { status: 200 });
  } catch {
    // No payloads, tokens or secret callback URLs enter the application log.
    return new Response(null, { status: 503 });
  }
}
