import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { resolvePaymentProvider } from "@/lib/payments/config";
import { posKeyedCardIntentSchema } from "@/lib/payments/schemas";
import { PaymentProviderError } from "@/lib/payments/provider";
import { executePayarcPayment, settlePayarcPayment, type PayarcAttempt } from "@/lib/payments/payarc-operation";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { z } from "zod";

const chargeSchema = posKeyedCardIntentSchema.extend({ source_id: z.string().min(1).max(4000), expected_amount_cents: z.number().int().positive().max(10_000_000) });
const checkSchema = z.object({ payment_id: z.uuid() });

export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!access?.workspace_id || !hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const body: unknown = await request.json().catch(() => null);
  const resolved = await resolvePaymentProvider("online", { workspaceId: access.workspace_id, locationId: access.location_id ?? null });
  if (!resolved.ok || resolved.value.provider.code !== "payarc") return Response.json({ error: "Payarc keyed payments are not available." }, { status: 503 });
  const { provider, connection } = resolved.value;
  const service = createServiceSupabaseClient();
  try {
    const check = checkSchema.safeParse(body);
    if (check.success) {
      const { data: payment, error } = await service.from("payments").select("id,provider_payment_id,status,metadata")
        .eq("id", check.data.payment_id).eq("workspace_id", access.workspace_id).eq("provider", "payarc")
        .eq("metadata->>payarc_connection_id", connection.id).maybeSingle();
      if (error || !payment) return Response.json({ error: "Payment not found." }, { status: 404 });
      if (!payment.provider_payment_id) return Response.json({ payment_id: payment.id, payment_status: payment.status }, { headers: { "Cache-Control": "no-store" } });
      const outcome = await settlePayarcPayment(service, connection.id, await provider.getPaymentStatus(payment.provider_payment_id));
      return Response.json({ payment_id: outcome.payment_id, payment_status: outcome.status }, { headers: { "Cache-Control": "no-store" } });
    }
    const parsed = chargeSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: "Invalid Payarc payment request." }, { status: 400 });
    const { data, error } = await service.rpc("wayne_begin_payarc_payment", {
      target_connection_id: connection.id, target_order_id: parsed.data.order_id,
      request_key: parsed.data.idempotency_key, expected_cents: parsed.data.expected_amount_cents,
      split_cents: parsed.data.amount_cents ?? null, actor_id: access.profile_id,
    });
    if (error || !data) return Response.json({ error: "The order total changed or a payment is already open. Refresh and check the ticket before paying." }, { status: 409 });
    const attempt = data as PayarcAttempt;
    try {
      const outcome = await executePayarcPayment(service, provider, connection.id, attempt, parsed.data.source_id, parsed.data.idempotency_key);
      return Response.json({ payment_id: outcome.payment_id, payment_status: outcome.status }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return Response.json({ payment_id: attempt.payment_id, payment_status: error instanceof PaymentProviderError && !error.retryable ? "failed" : "pending", error: error instanceof PaymentProviderError ? error.message : "Check this card before paying again." }, { status: error instanceof PaymentProviderError && !error.retryable ? 402 : 502, headers: { "Cache-Control": "no-store" } });
    }
  } catch {
    return Response.json({ error: "Payarc could not be checked. Do not charge again until this payment is reviewed." }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
