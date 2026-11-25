import "server-only";

import type { CurrentAccess } from "@/lib/auth/permissions";
import { readPaymentConnection } from "@/lib/payments/config";
import { paymentErrorMessage, terminalActionSchema } from "@/lib/payments/schemas";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import type { z } from "zod";
import {
  cancelPayarcConnectSale, payarcConnectAttemptSchema, payarcConnectConfig, payarcConnectAccessToken,
  payarcConnectNoticeTrace, payarcConnectOutcome, readPayarcConnectSale, sendPayarcConnectSale,
  type PayarcConnectAttempt, type PayarcConnectConfig,
} from "./payarc-connect";

type Service = ReturnType<typeof createServiceSupabaseClient>;
type TerminalRequest = z.infer<typeof terminalActionSchema>;
const attemptFields = "id,terminal_checkout_id,status,amount_cents,metadata";

const stateResponse = (attempt: PayarcConnectAttempt, state = attempt.status, reason?: string) =>
  Response.json({ payment_id: attempt.id, amount_cents: attempt.amount_cents, state, ...(reason ? { reason } : {}) }, { headers: { "Cache-Control": "no-store" } });

export async function getPayarcConnectReader(access: Pick<CurrentAccess, "workspace_id" | "location_id">) {
  // A configured counter owns this tender, even if setup is incomplete.
  if (!access.workspace_id || !access.location_id || access.location_id !== process.env.PAYARC_CONNECT_LOCATION_ID) return null;
  const config = payarcConnectConfig();
  if (!config) return { ready: false as const };
  const service = createServiceSupabaseClient();
  const { data, error } = await service.from("payment_terminals").select("id,label")
    .eq("workspace_id", access.workspace_id).eq("location_id", config.locationId)
    .eq("device_id", config.serial).eq("status", "active").eq("terminal_type", "provider_reader").maybeSingle();
  if (error || !data) return { ready: false as const };
  return { ready: true as const, config, reader: { id: data.id as string, label: data.label as string, payarc_connect: true as const } };
}

async function saveState(service: Service, paymentId: string, payload: object): Promise<PayarcConnectAttempt["status"]> {
  const { data, error } = await service.rpc("wayne_settle_payarc_connect_payment", { target_payment_id: paymentId, payload });
  if (error || !data) throw new Error("Could not record the reader result.");
  return data as PayarcConnectAttempt["status"];
}

export async function applyPayarcConnectOutcome(service: Service, attempt: PayarcConnectAttempt, body: unknown) {
  const result = payarcConnectOutcome(body, attempt);
  if (!result) return attempt.status;
  return saveState(service, attempt.id, {
    status: result.status, trace_id: result.traceId, provider_status: result.providerStatus,
    charge_id: result.chargeId, card_brand: result.card?.brand, card_last4: result.card?.last4,
    failure_reason: result.failureReason,
  });
}

export async function reconcilePayarcConnectNotice(service: Service, config: PayarcConnectConfig, attempt: PayarcConnectAttempt, notice: unknown) {
  if (attempt.status !== "pending") return true;
  if (attempt.metadata.environment !== config.environment || attempt.metadata.payarc_connect_serial !== config.serial) return false;
  const traceId = payarcConnectNoticeTrace(notice, attempt);
  if (!traceId) return false;

  // An inbound notification can only prompt a lookup. Payarc Connect's
  // authenticated response establishes the final outcome.
  const token = await payarcConnectAccessToken(config);
  const transaction = await readPayarcConnectSale(config, token, traceId);
  const state = await applyPayarcConnectOutcome(service, { ...attempt, terminal_checkout_id: traceId }, transaction);
  return state !== "pending";
}

export async function readPayarcConnectAttempt(service: Service, paymentId: string) {
  const { data, error } = await service.from("payments").select(attemptFields).eq("id", paymentId)
    .eq("provider", "payarc").eq("metadata->>entry", "payarc_connect").maybeSingle();
  if (error) throw new Error("Could not load the reader payment.");
  return data ? payarcConnectAttemptSchema.parse(data) : null;
}

export async function handlePayarcConnectPayment(access: CurrentAccess, request: TerminalRequest, setup: NonNullable<Awaited<ReturnType<typeof getPayarcConnectReader>>>) {
  if (!setup.ready) return Response.json({ error: "The PAX reader setup is incomplete." }, { status: 503 });
  const { config, reader } = setup;
  if (request.terminal_id !== reader.id) return Response.json({ error: "That reader is unavailable at this counter." }, { status: 404 });
  const service = createServiceSupabaseClient();
  if (request.action === "start") {
    if (!request.expected_amount_cents) return Response.json({ error: "Review the total before sending it to the reader." }, { status: 400 });
    const connection = await readPaymentConnection("online", { workspaceId: access.workspace_id!, locationId: config.locationId });
    if (connection?.provider !== "payarc" || connection.status !== "connected" || connection.environment !== config.environment) {
      return Response.json({ error: "The Payarc merchant account is not ready for this reader." }, { status: 503 });
    }
    const { data, error } = await service.rpc("wayne_begin_payarc_connect_payment", {
      target_connection_id: connection.id, target_order_id: request.order_id, target_terminal_id: reader.id,
      target_location_id: config.locationId, terminal_serial: config.serial, request_key: request.idempotency_key,
      expected_cents: request.expected_amount_cents, split_cents: request.amount_cents ?? null, actor_id: access.profile_id,
    });
    if (error || !data) return Response.json({ error: error ? paymentErrorMessage(error) : "The reader payment could not be opened.", retryable_start: true }, { status: 409 });
    const attempt = payarcConnectAttemptSchema.parse(data);
    if (data.duplicate) return stateResponse(attempt);

    let token: string;
    try { token = await payarcConnectAccessToken(config); }
    catch {
      const reason = "Payarc Connect could not sign in. Check the reader configuration.";
      const state = await saveState(service, attempt.id, { status: "failed", provider_status: "LOGIN_FAILED", failure_reason: reason });
      return stateResponse(attempt, state, reason);
    }
    try {
      const sale = await sendPayarcConnectSale(config, token, attempt);
      if (sale.rejected) {
        const reason = sale.rejected === "TERMINAL_NOT_ON_V3" ? "The reader needs Payarc Connect V3."
          : sale.rejected === "TERMINAL_OFFLINE" ? "The reader is offline." : "Payarc could not verify the reader connection.";
        const state = await saveState(service, attempt.id, { status: "failed", provider_status: sale.rejected, failure_reason: reason });
        return stateResponse(attempt, state, reason);
      }
      if (sale.traceId) await saveState(service, attempt.id, { status: "pending", trace_id: sale.traceId });
    } catch {
      // The sale may already be on the reader. The callback can bind the trace
      // even if the original API response or saving that trace was interrupted.
    }
    return stateResponse(attempt);
  }

  let query = service.from("payments").select(attemptFields).eq("workspace_id", access.workspace_id!)
    .eq("location_id", config.locationId).eq("order_id", request.order_id).eq("terminal_id", reader.id)
    .eq("provider", "payarc").eq("metadata->>entry", "payarc_connect");
  if (request.action === "resume") {
    const { data, error } = await query.eq("status", "pending").maybeSingle();
    if (error) return Response.json({ error: "Existing reader payments could not be checked." }, { status: 503 });
    return data ? stateResponse(payarcConnectAttemptSchema.parse(data)) : Response.json({ state: "none" });
  }
  query = request.payment_id ? query.eq("id", request.payment_id) : query.eq("idempotency_key", request.idempotency_key);
  const { data, error } = await query.maybeSingle();
  if (error || !data) return Response.json({ error: "No matching reader attempt could be loaded." }, { status: error ? 503 : 404 });
  const attempt = payarcConnectAttemptSchema.parse(data);
  if (attempt.status !== "pending") return stateResponse(attempt);
  const cancelling = request.action === "cancel";
  if (!attempt.terminal_checkout_id || attempt.metadata.environment !== config.environment ||
      attempt.metadata.payarc_connect_serial !== config.serial) {
    return cancelling
      ? Response.json({ error: "Payarc has not confirmed the request on this reader. The POS cannot send a cancellation yet." }, { status: 409 })
      : stateResponse(attempt, "pending", "Waiting for Payarc to confirm the request on this reader…");
  }

  try {
    const token = await payarcConnectAccessToken(config);
    if (cancelling) {
      const accepted = await cancelPayarcConnectSale(config, token, attempt.terminal_checkout_id, config.serial);
      if (accepted) return stateResponse(attempt, "pending", "Cancellation requested. Waiting for the reader to confirm.");
      return Response.json({ error: "Payarc could not cancel the reader payment. The POS is still checking its result." }, { status: 409 });
    }
    const body = await readPayarcConnectSale(config, token, attempt.terminal_checkout_id);
    const state = await applyPayarcConnectOutcome(service, attempt, body);
    const outcome = state === "failed" ? payarcConnectOutcome(body, attempt) : null;
    return stateResponse(attempt, state, outcome?.failureReason);
  } catch {
    if (cancelling) return Response.json({ error: "The POS could not confirm the cancellation with Payarc." }, { status: 503 });
    // Polling remains available while a callback or later lookup resolves the attempt.
    return stateResponse(attempt);
  }
}
