import { z } from "zod";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { resolvePaymentProvider } from "@/lib/payments/config";
import { executePayarcPayment, type PayarcAttempt } from "@/lib/payments/payarc-operation";
import { PaymentProviderError } from "@/lib/payments/provider";
import { spokenDatabaseMessage } from "@/lib/errors/database";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

const inputSchema = z.object({
  idempotency_key: z.string().min(16).max(160),
  expected_amount_cents: z.number().int().positive().max(10_000_000),
  customer_approved: z.literal(true),
});

/** No browser-supplied card, token, payment ID or price can select what is charged. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCurrentAccess();
  if (!access?.workspace_id || !hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const orderId = z.uuid().safeParse((await params).id);
  const input = inputSchema.safeParse(await request.json().catch(() => null));
  if (!orderId.success || !input.success) return Response.json({ error: "Review the extra amount and confirm the customer's approval." }, { status: 400 });
  const resolved = await resolvePaymentProvider("online", { workspaceId: access.workspace_id, locationId: access.location_id ?? null });
  if (!resolved.ok || resolved.value.provider.code !== "payarc" || !resolved.value.provider.createAdditionalPayment) {
    return Response.json({ error: "Charging the original online card is not available. Collect the added balance with another payment method." }, { status: 503 });
  }
  const { connection, provider } = resolved.value;
  const service = createServiceSupabaseClient();
  const { data, error } = await service.rpc("wayne_begin_online_extra_payment", {
    target_order_id: orderId.data, target_workspace_id: access.workspace_id, target_location_id: access.location_id ?? null,
    target_connection_id: connection.id, request_key: input.data.idempotency_key,
    expected_cents: input.data.expected_amount_cents, actor_id: access.profile_id,
  });
  if (error || !data) {
    const refused = Boolean(error?.code && ["22023", "40001", "42501", "P0002"].includes(error.code));
    return Response.json({ error: spokenDatabaseMessage(error ?? { message: "" }, refused ? "The order changed or another payment is open. Refresh and review the balance." : "The extra charge reservation could not be confirmed. Check this same request before charging again."),
      ...(!refused ? { payment_status: "pending" } : {}) }, { status: refused ? 409 : 502 });
  }
  const attempt = data as PayarcAttempt & { original_provider_payment_id: string };
  try {
    const outcome = await executePayarcPayment(service, provider, connection.id, attempt, "", input.data.idempotency_key, attempt.original_provider_payment_id);
    return Response.json({ payment_id: outcome.payment_id, payment_status: outcome.status, amount_cents: attempt.amount_cents }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    return Response.json({ payment_id: attempt.payment_id, payment_status: cause instanceof PaymentProviderError && !cause.retryable ? "failed" : "pending",
      error: cause instanceof PaymentProviderError ? cause.message : "The extra charge needs review. Check this payment before charging again." }, { status: cause instanceof PaymentProviderError && !cause.retryable ? 402 : 502 });
  }
}
