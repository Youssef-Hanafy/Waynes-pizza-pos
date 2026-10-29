import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyStripeWebhookEvent } from "@/lib/payments/stripe-webhook";
import { captureHeldCards } from "@/lib/payments/tip-capture";
import { PaymentProviderError, type ProviderPayment } from "@/lib/payments/provider";
import { startTipPostgres, workspaceId, ownerId } from "./helpers/tip-postgres";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/payments/config", () => ({ resolvePaymentProvider: async () => ({ ok: true, value: { provider } }) }));

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const intents = new Map<string, ProviderPayment>();
const keys = new Map<string, string>();
let charges: string[] = [];
let loseResponse = false;
const provider = {
  code: "stripe",
  getPaymentStatus: vi.fn(async (id: string) => ({ ...intents.get(id)! })),
  createSavedCardIntent: vi.fn(async (input: { idempotencyKey: string; amountCents: number }) => {
    await pause(40);
    const existing = keys.get(input.idempotencyKey);
    if (existing) return intents.get(existing)!;
    const id = `pi_replacement_${randomUUID()}`;
    keys.set(input.idempotencyKey, id);
    const result: ProviderPayment = { providerPaymentId: id, status: "pending", providerStatus: "requires_confirmation", amountCents: input.amountCents, cardBrand: "visa", cardLast4: "4242", receiptUrl: null, failureReason: null };
    intents.set(id, result);
    return result;
  }),
  confirmSavedCardIntent: vi.fn(async (id: string): Promise<ProviderPayment> => {
    await pause(40);
    const existing = intents.get(id)!;
    if (existing.status === "voided") throw new Error("Cannot confirm canceled intent");
    const result = { ...existing, status: "captured" as const, providerStatus: "succeeded" };
    if (existing.status !== "captured") charges.push(id);
    intents.set(id, result);
    if (loseResponse) { loseResponse = false; throw new PaymentProviderError("Lost Stripe response", "NETWORK", true); }
    return result;
  }),
  voidPayment: vi.fn(async (id: string) => { const result = { ...intents.get(id)!, status: "voided" as const, providerStatus: "canceled" }; intents.set(id, result); return result; }),
  // Kept solely to reproduce these same three assertions against the baseline API.
  chargeSavedCard: async (input: { idempotencyKey: string; amountCents: number }) => {
    const prepared = await provider.createSavedCardIntent(input);
    return provider.confirmSavedCardIntent(prepared.providerPaymentId!);
  },
  capturePayment: vi.fn(async (id: string, input: { amountCents: number }) => {
    await pause(40);
    const result = { ...intents.get(id)!, status: "captured" as const, providerStatus: "succeeded", amountCents: input.amountCents };
    if (intents.get(id)?.status !== "captured") charges.push(id);
    intents.set(id, result);
    return result;
  }),
  releaseHold: vi.fn(async (id: string) => { const result = { ...intents.get(id)!, status: "voided" as const, providerStatus: "canceled" }; intents.set(id, result); return result; }),
};

describe("tip adjustment across independent PostgreSQL sessions", () => {
  let db: Awaited<ReturnType<typeof startTipPostgres>>;
  beforeAll(async () => { db = await startTipPostgres(); }, 120_000);
  afterAll(async () => { await db?.stop(); });
  afterEach(async () => { await db.closeTestClients(); });
  beforeEach(async () => {
    intents.clear(); keys.clear(); charges = []; loseResponse = false; vi.clearAllMocks();
    await db.admin.query("update public.pos_tip_capture_control set execution_enabled=true");
  });
  async function fixture() {
    const payment = await db.fixture();
    intents.set(payment.originalId, { providerPaymentId: payment.originalId, status: "authorized", providerStatus: "requires_capture", amountCents: payment.amount, maxCapturableCents: payment.amount, customerId: "cus_test", paymentMethodId: "pm_test", cardBrand: "visa", cardLast4: "4242", receiptUrl: null, failureReason: null });
    return payment;
  }
  async function run(orderId: string, keyPrefix: string, tip = 500) {
    const { api } = await db.service();
    return captureHeldCards({ service: api, workspaceId, locationId: null, requests: [{ order_id: orderId, tip_cents: tip }], keyPrefix });
  }

  it("allows at most one charge when Tips and driver cash-out race", async () => {
    const payment = await fixture();
    const results = await Promise.all([run(payment.orderId, "tips"), run(payment.orderId, "driver-cashout")]);
    expect(results.some((result) => result.captures.length === 1)).toBe(true);
    expect(charges).toHaveLength(1);
  });

  it("does not capture the original hold when scheduled capture races a replacement", async () => {
    const payment = await fixture();
    await Promise.all([run(payment.orderId, "tips"), run(payment.orderId, "auto", 0)]);
    expect(charges).toHaveLength(1);
  });

  it("recovers a lost successful replacement response from another screen without charging again", async () => {
    const payment = await fixture();
    loseResponse = true;
    await run(payment.orderId, "tips");
    const result = await run(payment.orderId, "driver-cashout");
    expect(result.captures).toHaveLength(1);
    expect(charges).toHaveLength(1);
  });

  async function operation(paymentId: string) {
    return (await db.admin.query("select * from public.pos_tip_operations where payment_id=$1", [paymentId])).rows[0];
  }
  async function assertLedger(payment: Awaited<ReturnType<typeof fixture>>, tip = 500) {
    const row = (await db.admin.query("select p.*,o.tip_cents,o.total_cents from public.payments p join public.orders o on o.id=p.order_id where p.id=$1", [payment.paymentId])).rows[0];
    expect(row.status).toBe("captured");
    expect(row.amount_cents).toBe(payment.amount + tip);
    expect(row.total_cents).toBe(payment.amount + tip);
    expect(row.tip_cents).toBe(tip);
    expect(row.provider_payment_id).toBe(charges[0]);
  }
  async function webhook(paymentId: string, api?: Awaited<ReturnType<typeof db.service>>["api"]) {
    const op = await operation(paymentId);
    const intent = intents.get(op.replacement_id ?? op.original_provider_id)!;
    return applyStripeWebhookEvent(api ?? (await db.service()).api, "payment_intent.succeeded", {
      data: { object: { id: intent.providerPaymentId, status: "succeeded", amount_received: intent.amountCents,
        metadata: { wayne_tip_adjust: "true", wayne_tip_operation: op.id } } },
    }, workspaceId, (id) => provider.getPaymentStatus(id));
  }

  it("serializes three entry points and applies the ledger exactly once", async () => {
    const payment = await fixture();
    await Promise.all([run(payment.orderId, "tips"), run(payment.orderId, "driver-cashout"), run(payment.orderId, "auto", 0)]);
    expect(charges).toHaveLength(1);
    const op = await operation(payment.paymentId);
    await assertLedger(payment, op.result.tip_cents);
    expect((await db.admin.query("select count(*)::int n from public.order_events where order_id=$1 and event_type='payment.tip_captured'", [payment.orderId])).rows[0].n).toBe(1);
  });

  it("does not release the original after a provider success whose database write fails", async () => {
    const payment = await fixture();
    const service = await db.service();
    service.failNextRpc("wayne_complete_tip_operation");
    const first = await captureHeldCards({ service: service.api, workspaceId, locationId: null, requests: [{ order_id: payment.orderId, tip_cents: 500 }], keyPrefix: "tips" });
    expect(first.captures).toHaveLength(0);
    expect(charges).toHaveLength(1);
    expect(provider.releaseHold).not.toHaveBeenCalled();
    expect((await operation(payment.paymentId)).state).toBe("pending");
    const recovered = await run(payment.orderId, "auto", 0);
    expect(recovered.captures[0].tip_cents).toBe(500);
    expect(recovered.problems.join(" ")).toContain("newly requested $0.00 was not charged");
    expect(charges).toHaveLength(1);
    await assertLedger(payment);
  });

  it("atomically rolls back ledger/pointer writes if the order write fails, then recovers", async () => {
    const payment = await fixture();
    await db.admin.query(`create function public.tip_test_fail_order() returns trigger language plpgsql as $$ begin if new.id='${payment.orderId}'::uuid then raise exception 'injected order write failure'; end if; return new; end $$;
      create trigger tip_test_fail before update on public.orders for each row execute function public.tip_test_fail_order()`);
    try {
      const failed = await run(payment.orderId, "tips");
      expect(failed.captures).toHaveLength(0);
      expect(charges).toHaveLength(1);
      expect(provider.releaseHold).not.toHaveBeenCalled();
      const row = (await db.admin.query("select status,provider_payment_id from public.payments where id=$1", [payment.paymentId])).rows[0];
      expect(row).toEqual({ status: "authorized", provider_payment_id: payment.originalId });
      expect((await operation(payment.paymentId)).state).toBe("pending");
    } finally {
      await db.admin.query("drop trigger tip_test_fail on public.orders; drop function public.tip_test_fail_order()");
    }
    await run(payment.orderId, "driver-cashout");
    expect(charges).toHaveLength(1);
    await assertLedger(payment);
  });

  it("recovers when the database commits but its successful response is lost", async () => {
    const payment = await fixture();
    const service = await db.service();
    service.loseNextRpcResponse("wayne_complete_tip_operation");
    const failed = await captureHeldCards({ service: service.api, workspaceId, locationId: null, requests: [{ order_id: payment.orderId, tip_cents: 500 }], keyPrefix: "tips" });
    expect(failed.captures).toHaveLength(0);
    expect(provider.releaseHold).not.toHaveBeenCalled();
    expect((await operation(payment.paymentId)).release_pending).toBe(true);
    const recovered = await run(payment.orderId, "auto");
    expect(recovered.captures).toHaveLength(1);
    expect((await operation(payment.paymentId)).release_pending).toBe(false);
    expect(charges).toHaveLength(1);
    await assertLedger(payment);
  });

  it("never confirms an intent before its ID has been durably bound", async () => {
    const payment = await fixture();
    const service = await db.service();
    // plan succeeds; fail the next update (bind) once create returns.
    const create = provider.createSavedCardIntent.getMockImplementation()!;
    provider.createSavedCardIntent.mockImplementationOnce(async (input) => { const result = await create(input); service.failNextRpc("wayne_update_tip_operation"); return result; });
    await captureHeldCards({ service: service.api, workspaceId, locationId: null, requests: [{ order_id: payment.orderId, tip_cents: 500 }], keyPrefix: "tips" });
    expect(provider.confirmSavedCardIntent).not.toHaveBeenCalled();
    expect(charges).toHaveLength(0);
    // Model Stripe idempotency-key expiry: another UNCONFIRMED orphan is safe.
    keys.clear();
    await run(payment.orderId, "driver-cashout");
    expect(intents.size).toBe(3);
    expect(charges).toHaveLength(1);
    await assertLedger(payment);
  });

  it("keeps the bound ID after key expiry and after a lost confirmation response", async () => {
    const payment = await fixture();
    const service = await db.service();
    service.failNextRpc("wayne_complete_tip_operation");
    loseResponse = true;
    await captureHeldCards({ service: service.api, workspaceId, locationId: null, requests: [{ order_id: payment.orderId, tip_cents: 500 }], keyPrefix: "tips" });
    const bound = (await operation(payment.paymentId)).replacement_id;
    keys.clear();
    await run(payment.orderId, "driver-cashout", 700);
    expect((await operation(payment.paymentId)).replacement_id).toBe(bound);
    expect(provider.createSavedCardIntent).toHaveBeenCalledTimes(1);
    expect(charges).toHaveLength(1);
    await assertLedger(payment);
  });

  it.each(["processing", "requires_action"])("does not capture or release the original while the replacement is %s", async (status) => {
    const payment = await fixture();
    provider.confirmSavedCardIntent.mockImplementationOnce(async (id) => {
      const result = { ...intents.get(id)!, status: "pending" as const, providerStatus: status };
      intents.set(id, result); return result;
    });
    expect((await run(payment.orderId, "tips")).captures).toHaveLength(0);
    expect((await run(payment.orderId, "auto", 0)).captures).toHaveLength(0);
    expect(provider.capturePayment).not.toHaveBeenCalled();
    expect(provider.releaseHold).not.toHaveBeenCalled();
    expect(charges).toHaveLength(0);
  });

  it("cancels a definitive decline before charging a separate tip and the original authorization", async () => {
    const payment = await fixture();
    provider.confirmSavedCardIntent.mockImplementationOnce(async (id) => {
      const result = { ...intents.get(id)!, status: "failed" as const, providerStatus: "requires_payment_method" };
      intents.set(id, result); return result;
    });
    const result = await run(payment.orderId, "tips");
    expect(result.captures[0].tip_cents).toBe(500);
    expect(provider.voidPayment.mock.invocationCallOrder[0]).toBeLessThan(provider.capturePayment.mock.invocationCallOrder[0]);
    const op = await operation(payment.paymentId);
    expect(charges).toEqual([op.tip_intent_id, payment.originalId]);
    expect(op.tip_result.amount_cents).toBe(500);
    expect(op.original_result.amount_cents).toBe(payment.amount);
    const row = (await db.admin.query("select status,amount_cents,provider_payment_id,metadata from public.payments where id=$1", [payment.paymentId])).rows[0];
    expect(row.status).toBe("captured");
    expect(row.amount_cents).toBe(payment.amount + 500);
    expect(row.provider_payment_id).toBe(payment.originalId);
    expect(row.metadata.tip_charge_intent).toBe(op.tip_intent_id);
    expect((await run(payment.orderId, "auto", 0)).captures).toHaveLength(1);
    expect(charges).toHaveLength(2);
  });

  const decline = async (id: string) => {
    const answer = { ...intents.get(id)!, status: "failed" as const, providerStatus: "requires_payment_method" };
    intents.set(id, answer); return answer;
  };
  it("keeps the original uncharged when full replacement and separate tip both decline, then permits explicit zero tip", async () => {
    const payment = await fixture();
    provider.confirmSavedCardIntent.mockImplementationOnce(decline).mockImplementationOnce(decline);
    expect((await run(payment.orderId, "tips")).captures).toHaveLength(0);
    expect(charges).toHaveLength(0);
    expect(provider.capturePayment).not.toHaveBeenCalled();
    const before = await operation(payment.paymentId);
    const recovered = await run(payment.orderId, "tips", 0);
    expect(recovered.captures[0].tip_cents).toBe(0);
    const after = await operation(payment.paymentId);
    expect(after.abandoned_tip_id).toBe(before.tip_intent_id);
    expect(charges).toEqual([payment.originalId]);
    expect(intents.get(before.tip_intent_id)?.status).toBe("voided");
  });
  it("recovers a separately charged tip after the order capture loses its answer, across worker restart", async () => {
    const payment = await fixture();
    provider.confirmSavedCardIntent.mockImplementationOnce(decline);
    provider.capturePayment.mockRejectedValueOnce(new PaymentProviderError("network unavailable", "NETWORK", true));
    expect((await run(payment.orderId, "tips")).captures).toHaveLength(0);
    const pending = await operation(payment.paymentId);
    expect(pending.tip_result.amount_cents).toBe(500);
    expect(charges).toEqual([pending.tip_intent_id]);
    const recovered = await run(payment.orderId, "auto", 0);
    expect(recovered.captures[0].captured_cents).toBe(payment.amount+500);
    expect(charges).toEqual([pending.tip_intent_id,payment.originalId]);
    expect(provider.createSavedCardIntent).toHaveBeenCalledTimes(2);
  });
  it("adopts a retained legacy separate tip identity without charging another tip", async () => {
    const payment = await fixture();
    const legacyId = `pi_legacy_${randomUUID()}`;
    intents.set(legacyId, { ...intents.get(payment.originalId)!, providerPaymentId: legacyId, status: "captured", providerStatus: "succeeded", amountCents:500 });
    await db.admin.query("update public.payments set metadata=metadata||$2::jsonb where id=$1", [payment.paymentId,JSON.stringify({ tip_charge_intent:legacyId,tip_charge_cents:500,tip_charged_separately:true })]);
    const result = await run(payment.orderId,"tips");
    expect(result.captures[0].captured_cents).toBe(payment.amount+500);
    expect(provider.createSavedCardIntent).not.toHaveBeenCalled();
    expect(provider.confirmSavedCardIntent).not.toHaveBeenCalled();
    expect(charges).toEqual([payment.originalId]);
    expect((await operation(payment.paymentId)).tip_intent_id).toBe(legacyId);
  });

  it("adopts an already charged legacy replacement while paused and retains the original reference", async () => {
    const payment = await fixture();
    const id = `pi_legacy_recharge_${randomUUID()}`;
    intents.set(id, { ...intents.get(payment.originalId)!, providerPaymentId:id,status:"captured",providerStatus:"succeeded",amountCents:payment.amount+500,metadata:{wayne_payment_id:payment.paymentId} });
    await db.admin.query("update public.payments set provider_payment_id=$2,metadata=metadata||$3::jsonb where id=$1", [payment.paymentId,id,JSON.stringify({ charged_with_tip:true,replaced_intent:payment.originalId })]);
    await db.admin.query("update public.pos_tip_capture_control set execution_enabled=false");
    const result = await run(payment.orderId,"auto",0);
    expect(result.captures[0].tip_cents).toBe(500);
    expect(charges).toHaveLength(0);
    const op = await operation(payment.paymentId);
    expect(op.original_provider_id).toBe(payment.originalId);
    expect(op.replacement_id).toBe(id);
    expect(op.state).toBe("succeeded");
    expect(provider.createSavedCardIntent).not.toHaveBeenCalled();
    expect(provider.capturePayment).not.toHaveBeenCalled();
  });

  it("treats completed receipt lease cleanup as an idempotent no-op after a lost acknowledgment", async () => {
    const payment = await fixture();
    await run(payment.orderId,"tips");
    const op = await operation(payment.paymentId),service=await db.service();
    const cleanup=await service.api.rpc("wayne_update_tip_operation", {target_operation_id:op.id,worker_token:randomUUID(),action:"release",details:{}});
    expect(cleanup.error).toBeNull();
    expect((cleanup.data as {state:string}).state).toBe("succeeded");
    expect(charges).toHaveLength(1);
  });

  it("does not fall back if replacement cancellation is uncertain", async () => {
    const payment = await fixture();
    provider.confirmSavedCardIntent.mockImplementationOnce(async (id) => ({ ...intents.get(id)!, status: "failed", providerStatus: "requires_payment_method" }));
    provider.voidPayment.mockRejectedValueOnce(new Error("timeout canceling replacement"));
    expect((await run(payment.orderId, "tips")).captures).toHaveLength(0);
    expect(provider.capturePayment).not.toHaveBeenCalled();
    expect(provider.releaseHold).not.toHaveBeenCalled();
  });

  it("resumes the same intent when a delayed confirmation outlives its worker lease", async () => {
    const payment = await fixture();
    let enter!: () => void, resume!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    const confirm = provider.confirmSavedCardIntent.getMockImplementation()!;
    provider.confirmSavedCardIntent.mockImplementationOnce(async (id) => { enter(); await paused; return confirm(id); });
    const first = run(payment.orderId, "tips");
    await entered;
    await db.admin.query("update public.pos_tip_operations set lease_expires_at=now()-interval '1 second' where payment_id=$1", [payment.paymentId]);
    const second = await run(payment.orderId, "driver-cashout", 900);
    resume();
    const firstResult = await first;
    expect(second.captures).toHaveLength(1);
    expect(firstResult.captures).toHaveLength(1);
    expect(provider.createSavedCardIntent).toHaveBeenCalledTimes(1);
    expect(charges).toHaveLength(1);
    await assertLedger(payment);
  });

  it("uses independent PostgreSQL backends and blocks a competing claim until commit", async () => {
    const payment = await fixture();
    const left = await db.connect(), right = await db.connect();
    expect((await left.query("select pg_backend_pid() pid")).rows[0].pid).not.toBe((await right.query("select pg_backend_pid() pid")).rows[0].pid);
    const call = "select public.wayne_claim_tip_operation($1,$2,500,$3,$4) value";
    await left.query("begin; set local role service_role");
    const first = (await left.query(call, [payment.paymentId, workspaceId, randomUUID(), "tips"])).rows[0].value;
    let finished = false;
    const waiting = right.query(call, [payment.paymentId, workspaceId, randomUUID(), "auto"]).then((value) => { finished = true; return value; });
    await pause(50);
    expect(finished).toBe(false);
    await left.query("commit");
    expect((await waiting).rows[0].value.acquired).toBe(false);
    expect(first.acquired).toBe(true);
    expect((await db.admin.query("select count(*)::int n from public.pos_tip_operations where payment_id=$1", [payment.paymentId])).rows[0].n).toBe(1);
  });

  it("allows a corrected tip after a read-only preflight failure", async () => {
    const payment = await fixture();
    provider.getPaymentStatus.mockRejectedValueOnce(new Error("network unavailable"));
    expect((await run(payment.orderId, "tips", 500)).captures).toHaveLength(0);
    expect((await operation(payment.paymentId)).plan).toBeNull();
    expect((await run(payment.orderId, "driver-cashout", 700)).captures[0].tip_cents).toBe(700);
    expect(charges).toHaveLength(1);
    await assertLedger(payment, 700);
  });

  it("preserves a legitimate overcapture without creating a replacement", async () => {
    const payment = await fixture();
    intents.get(payment.originalId)!.maxCapturableCents = payment.amount + 1000;
    expect((await run(payment.orderId, "tips", 700)).captures[0].tip_cents).toBe(700);
    expect(provider.createSavedCardIntent).not.toHaveBeenCalled();
    expect(charges).toEqual([payment.originalId]);
    await assertLedger(payment, 700);
  });

  it("reconciles repeated and concurrent verified webhooks after a failed database write", async () => {
    const payment = await fixture();
    const service = await db.service(); service.failNextRpc("wayne_complete_tip_operation");
    await captureHeldCards({ service: service.api, workspaceId, locationId: null, requests: [{ order_id: payment.orderId, tip_cents: 500 }], keyPrefix: "tips" });
    await Promise.all([webhook(payment.paymentId), webhook(payment.paymentId), run(payment.orderId, "auto", 0)]);
    await webhook(payment.paymentId);
    expect(charges).toHaveLength(1);
    await assertLedger(payment);
    expect((await db.admin.query("select count(*)::int n from public.order_events where order_id=$1 and event_type='payment.tip_captured'", [payment.orderId])).rows[0].n).toBe(1);
  });

  it("rejects webhook reconciliation for the wrong workspace or amount", async () => {
    const payment = await fixture();
    await run(payment.orderId, "tips");
    const op = await operation(payment.paymentId);
    const { api } = await db.service();
    expect((await api.rpc("wayne_reconcile_tip_webhook", { target_workspace_id: randomUUID(), provider_id: op.replacement_id, captured_cents: payment.amount + 500 })).data).toBe(false);
    expect((await api.rpc("wayne_reconcile_tip_webhook", { target_workspace_id: workspaceId, provider_id: op.replacement_id, captured_cents: payment.amount + 600 })).error).not.toBeNull();
    await assertLedger(payment);
  });

  it("denies direct operation writes and RPC execution to authenticated clients", async () => {
    const payment = await fixture();
    const client = await db.connect();
    await client.query("set role authenticated");
    await expect(client.query("select public.wayne_claim_tip_operation($1,$2,500,$3,'tips')", [payment.paymentId, workspaceId, randomUUID()])).rejects.toMatchObject({ code: "42501" });
    await expect(client.query("select * from public.pos_tip_operations")).rejects.toMatchObject({ code: "42501" });
  });

  it("pauses new money movement but still reconciles a completed provider charge", async () => {
    const payment = await fixture();
    const service = await db.service(); service.failNextRpc("wayne_complete_tip_operation");
    await captureHeldCards({ service: service.api, workspaceId, locationId: null, requests: [{ order_id: payment.orderId, tip_cents: 500 }], keyPrefix: "tips" });
    await db.admin.query("update public.pos_tip_capture_control set execution_enabled=false");
    expect((await run(payment.orderId, "auto", 0)).captures).toHaveLength(1);
    const other = await fixture();
    expect((await run(other.orderId, "tips")).captures).toHaveLength(0);
    expect(charges).toHaveLength(1);
    await assertLedger(payment);
  });

  it("retries only hold release after a successful charge and failed cancellation", async () => {
    const payment = await fixture();
    provider.releaseHold.mockRejectedValueOnce(new Error("release timeout"));
    expect((await run(payment.orderId, "tips")).captures).toHaveLength(1);
    expect((await operation(payment.paymentId)).release_pending).toBe(true);
    await run(payment.orderId, "auto");
    expect((await operation(payment.paymentId)).release_pending).toBe(false);
    expect(provider.confirmSavedCardIntent).toHaveBeenCalledTimes(1);
    expect(charges).toHaveLength(1);
  });


  it("retries a create timeout using an unconfirmed intent before any charge", async () => {
    const payment = await fixture();
    const create = provider.createSavedCardIntent.getMockImplementation()!;
    provider.createSavedCardIntent.mockImplementationOnce(async (input) => { await create(input); throw new Error("create response lost"); });
    expect((await run(payment.orderId, "tips")).captures).toHaveLength(0);
    expect(charges).toHaveLength(0);
    expect(provider.confirmSavedCardIntent).not.toHaveBeenCalled();
    expect((await run(payment.orderId, "auto", 0)).captures[0].tip_cents).toBe(500);
    expect(charges).toHaveLength(1);
    await assertLedger(payment);
  });

  it("holds the original when both confirmation and status-read responses time out", async () => {
    const payment = await fixture();
    const confirm = provider.confirmSavedCardIntent.getMockImplementation()!;
    provider.confirmSavedCardIntent.mockImplementationOnce(async (id) => {
      await confirm(id);
      provider.getPaymentStatus.mockRejectedValueOnce(new Error("status timeout"));
      throw new Error("confirmation timeout");
    });
    expect((await run(payment.orderId, "tips")).captures).toHaveLength(0);
    expect(provider.releaseHold).not.toHaveBeenCalled();
    expect(provider.capturePayment).not.toHaveBeenCalled();
    await run(payment.orderId, "driver-cashout");
    expect(charges).toHaveLength(1);
    await assertLedger(payment);
  });

  it("fences stale worker database mutations after another worker takes the lease", async () => {
    const payment = await fixture();
    const { api: first } = await db.service(), { api: second } = await db.service();
    const staleToken = randomUUID();
    const args = { target_payment_id: payment.paymentId, target_workspace_id: workspaceId, requested_tip: 500, worker_token: staleToken, origin: "tips" };
    const claimed = await first.rpc("wayne_claim_tip_operation", args);
    const opId = claimed.data.operation.id;
    await db.admin.query("update public.pos_tip_operations set lease_expires_at=now()-interval '1 second' where id=$1", [opId]);
    expect((await second.rpc("wayne_claim_tip_operation", { ...args, worker_token: randomUUID(), origin: "auto" })).data.acquired).toBe(true);
    const stale = await first.rpc("wayne_update_tip_operation", { target_operation_id: opId, worker_token: staleToken, action: "plan", details: { mode: "capture", amount_cents: payment.amount, fallback_amount_cents: payment.amount } });
    expect(stale.error?.code).toBe("40001");
    expect((await operation(payment.paymentId)).plan).toBeNull();
  });

  it("simulates test cards without calling Stripe and preserves the test tip limit", async () => {
    const payment = await fixture();
    await db.admin.query("update public.payments set provider='test',metadata=metadata || $2::jsonb where id=$1", [payment.paymentId, JSON.stringify({ max_capture_cents: payment.amount + 300 })]);
    await db.admin.query("update public.orders set is_test=true where id=$1", [payment.orderId]);
    const result = await run(payment.orderId, "tips", 500);
    expect(result.captures[0].tip_cents).toBe(300);
    expect(result.captures[0].is_test).toBe(true);
    expect(provider.getPaymentStatus).not.toHaveBeenCalled();
    expect(charges).toHaveLength(0);
    expect((await operation(payment.paymentId)).state).toBe("succeeded");
  });

  it("preserves card tips in driver cash-out without applying the tip or drawer payout twice", async () => {
    const payment = await fixture();
    await db.admin.query("update public.orders set fulfillment_type='delivery',is_test=false where id=$1", [payment.orderId]);
    await db.admin.query("insert into public.delivery_assignments(order_id,driver_id,status) values($1,$2,'delivered')", [payment.orderId, ownerId]);
    const before = Number((await db.admin.query("select coalesce(sum(amount_cents),0) n from public.cash_movements where kind='paid_out'")).rows[0].n);
    const captured = await run(payment.orderId, "driver-cashout");
    expect(captured.captures).toHaveLength(1);
    const client = await db.connect();
    await client.query("begin; set local role authenticated");
    await client.query("select set_config('request.jwt.claim.sub',$1,true)", [ownerId]);
    const cashout = (await client.query("select public.wayne_pos_driver_cashout($1,$2,$3) value", [ownerId, JSON.stringify([{ order_id: payment.orderId, tip_cents: 500 }]), JSON.stringify(captured.captures)])).rows[0].value;
    await client.query("commit");
    expect(cashout.card_tips_cents).toBe(500);
    expect(cashout.order_count).toBe(1);
    await assertLedger(payment);
    const after = Number((await db.admin.query("select coalesce(sum(amount_cents),0) n from public.cash_movements where kind='paid_out'")).rows[0].n);
    expect(after - before).toBe(500);
    await run(payment.orderId, "tips");
    await client.query("begin; set local role authenticated");
    await client.query("select set_config('request.jwt.claim.sub',$1,true)", [ownerId]);
    await expect(client.query("select public.wayne_pos_driver_cashout($1,'[]','[]')", [ownerId])).rejects.toThrow("no deliveries");
    await client.query("rollback");
    expect(Number((await db.admin.query("select coalesce(sum(amount_cents),0) n from public.cash_movements where kind='paid_out'")).rows[0].n)).toBe(after);
    expect(charges).toHaveLength(1);
  });


  it("targets the saved payment during recovery even if the order has another authorization", async () => {
    const payment = await fixture();
    provider.releaseHold.mockRejectedValueOnce(new Error("release timeout"));
    await run(payment.orderId, "tips");
    await db.admin.query("insert into public.payments(id,order_id,provider,provider_payment_id,method,amount_cents,status) values($1,$2,'stripe',$3,'card',1000,'authorized')", [randomUUID(), payment.orderId, `pi_other_${randomUUID()}`]);
    const { api } = await db.service();
    const recovered = await captureHeldCards({ service: api, workspaceId, locationId: null, requests: [{ payment_id: payment.paymentId, order_id: payment.orderId, tip_cents: 500 }], keyPrefix: "auto" });
    expect(recovered.captures[0].payment_id).toBe(payment.paymentId);
    expect((await operation(payment.paymentId)).release_pending).toBe(false);
    expect(charges).toHaveLength(1);
  });

  it("does not release the original or silently accept a different captured amount", async () => {
    const payment = await fixture();
    const confirm = provider.confirmSavedCardIntent.getMockImplementation()!;
    provider.confirmSavedCardIntent.mockImplementationOnce(async (id) => {
      const result = { ...await confirm(id), amountCents: payment.amount + 400 };
      intents.set(id, result); return result;
    });
    expect((await run(payment.orderId, "tips")).captures).toHaveLength(0);
    expect((await run(payment.orderId, "auto", 0)).captures).toHaveLength(0);
    expect(charges).toHaveLength(1);
    expect(provider.capturePayment).not.toHaveBeenCalled();
    expect(provider.releaseHold).not.toHaveBeenCalled();
    expect((await operation(payment.paymentId)).state).toBe("pending");
  });

});
