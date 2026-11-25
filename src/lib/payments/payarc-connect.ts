import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const serialSchema = z.string().regex(/^\d{10}$/);
const originSchema = z.url({ protocol: /^https$/, hostname: /^(?:[a-z0-9-]+\.)+[a-z]+$/i })
  .refine((value) => new URL(value).origin === value);
const connectOriginSchema = originSchema.refine((value) => /^https:\/\/(?:test)?payarcconnectapi\.(?:payarc\.net|curvpos\.com)$/.test(value));
const configSchema = z.object({
  environment: z.enum(["production", "sandbox"]),
  locationId: z.uuid(),
  serial: serialSchema,
  mid: z.string().regex(/^\d{12}$/),
  loginMid: z.string().regex(/^\d{12,16}$/),
  email: z.email(),
  clientSecret: z.string().min(1),
  apiToken: z.string().min(1),
  connectToken: z.string().min(1).optional(),
  callbackOrigin: originSchema,
  loginOrigin: connectOriginSchema,
  apiOrigin: connectOriginSchema,
}).refine(({ environment, loginOrigin, apiOrigin }) =>
  [loginOrigin, apiOrigin].every((origin) => origin.startsWith("https://test") === (environment === "sandbox")),
);

export type PayarcConnectConfig = z.infer<typeof configSchema>;

export function payarcConnectConfig(env: Record<string, string | undefined> = process.env) {
  const sandbox = env.PAYARC_ENVIRONMENT === "sandbox";
  const parsed = configSchema.safeParse({
    environment: env.PAYARC_ENVIRONMENT,
    locationId: env.PAYARC_CONNECT_LOCATION_ID,
    serial: env.PAYARC_CONNECT_TERMINAL_SERIAL,
    mid: env.PAYARC_CONNECT_MID,
    loginMid: env.PAYARC_CONNECT_LOGIN_MID?.trim() || env.PAYARC_CONNECT_MID,
    email: env.PAYARC_CONNECT_EMAIL,
    clientSecret: env.PAYARC_CONNECT_CLIENT_SECRET,
    apiToken: env.PAYARC_API_TOKEN,
    connectToken: env.PAYARC_CONNECT_API_TOKEN?.trim() || undefined,
    callbackOrigin: env.PAYARC_CONNECT_CALLBACK_ORIGIN,
    loginOrigin: env.PAYARC_CONNECT_LOGIN_ORIGIN || (sandbox ? "https://testpayarcconnectapi.curvpos.com" : undefined),
    apiOrigin: env.PAYARC_CONNECT_API_ORIGIN || (sandbox ? "https://testpayarcconnectapi.payarc.net" : undefined),
  });
  return parsed.success ? parsed.data : null;
}

function callbackKey(config: PayarcConnectConfig, paymentId: string) {
  return createHmac("sha256", config.clientSecret)
    .update(`payarc-connect-callback:v1:${config.environment}:${paymentId}`)
    .digest("hex");
}

export function payarcConnectCallbackAuthorized(config: PayarcConnectConfig, paymentId: string, key: string | null) {
  return Boolean(key && /^[a-f0-9]{64}$/.test(key) &&
    timingSafeEqual(Buffer.from(key, "hex"), Buffer.from(callbackKey(config, paymentId), "hex")));
}

const attemptSchema = z.object({
  id: z.uuid(),
  terminal_checkout_id: z.uuid().nullable(),
  status: z.enum(["pending", "captured", "failed", "voided"]),
  amount_cents: z.number().int().positive(),
  metadata: z.object({
    payarc_connect_ref: z.string().regex(/^[a-f0-9]{16}$/),
    payarc_connect_tip_cents: z.number().int().nonnegative(),
    payarc_connect_tax_cents: z.number().int().nonnegative(),
    payarc_connect_serial: serialSchema,
    environment: z.enum(["production", "sandbox"]),
  }),
});
export { attemptSchema as payarcConnectAttemptSchema };
export type PayarcConnectAttempt = z.infer<typeof attemptSchema>;

const noticeSchema = z.object({
  traceId: z.uuid(),
  transactionId: z.string(),
  transType: z.literal("SALE").optional(),
});

export function payarcConnectNoticeTrace(input: unknown, attempt: PayarcConnectAttempt) {
  const notice = noticeSchema.safeParse(input);
  if (!notice.success || notice.data.transactionId !== attempt.metadata.payarc_connect_ref ||
      (attempt.terminal_checkout_id && notice.data.traceId !== attempt.terminal_checkout_id)) return null;
  return notice.data.traceId;
}

const outcomeSchema = noticeSchema.extend({
  status: z.string(),
  error: z.object({ code: z.string() }).nullish().catch(undefined),
  chargeId: z.string().trim().min(1).max(200).nullish(),
  amount: z.object({
    total: z.number().int(),
    approved: z.number().int(),
    currency: z.literal("USD"),
    tip: z.number().int().nullish(),
    tax: z.number().int().nullish(),
  }).optional(),
  card: z.object({
    last4: z.string().regex(/^\d{4}$/).optional(),
    brand: z.string().regex(/^[a-z0-9 _-]{1,30}$/i).optional(),
  }).optional().catch(undefined),
});

export function payarcConnectOutcome(input: unknown, attempt: PayarcConnectAttempt) {
  const result = outcomeSchema.safeParse(input);
  if (!result.success) return null;
  const { traceId, transactionId, status, chargeId, amount, card, error } = result.data;
  if (transactionId !== attempt.metadata.payarc_connect_ref ||
      (attempt.terminal_checkout_id && traceId !== attempt.terminal_checkout_id)) return null;

  const outcome = status.trim().toUpperCase();
  if (["APPROVED", "SUCCESS"].includes(outcome)) {
    if (!chargeId || !amount || amount.total !== attempt.amount_cents || amount.approved !== attempt.amount_cents ||
        (amount.tip ?? 0) !== attempt.metadata.payarc_connect_tip_cents ||
        (amount.tax ?? 0) !== attempt.metadata.payarc_connect_tax_cents) return null;
    return { status: "captured", traceId, providerStatus: outcome, chargeId, card };
  }
  if ((amount?.approved ?? 0) > 0) return null;
  if (["DECLINE", "DECLINED"].includes(outcome)) return { status: "failed", traceId, providerStatus: outcome };
  if (["CANCELLED", "CANCELED"].includes(outcome)) return { status: "voided", traceId, providerStatus: outcome };
  if (amount?.approved === 0 && ["ABORTED", "100002 ABORTED"].includes(outcome)) {
    return { status: "voided", traceId, providerStatus: outcome };
  }
  if (outcome === "100001 TIMEOUT" && error?.code === "TRANSACTION_FAILED" &&
      amount?.approved === 0 && amount.total === 0) {
    return { status: "failed", traceId, providerStatus: outcome, failureReason: "The reader timed out before approving a card." };
  }
  // An unconfirmed timeout or duplicate can still conceal an approval.
  return null;
}

let loginCache: { config: PayarcConnectConfig; token: string; expiresAt: number } | undefined;

export async function payarcConnectAccessToken(config: PayarcConnectConfig) {
  if (config.connectToken) return config.connectToken;
  if (loginCache && loginCache.expiresAt > Date.now() &&
      loginCache.config.loginMid === config.loginMid && loginCache.config.email === config.email &&
      loginCache.config.loginOrigin === config.loginOrigin && loginCache.config.apiOrigin === config.apiOrigin &&
      loginCache.config.apiToken === config.apiToken && loginCache.config.clientSecret === config.clientSecret) return loginCache.token;
  const response = await fetch(`${config.loginOrigin}/Login`, {
    method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8_000),
    headers: { Authorization: `Bearer ${config.apiToken}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ Email: config.email, MID: config.loginMid, ClientSecret: config.clientSecret, SecretKey: config.apiToken }),
  });
  const body = await response.json().catch(() => null);
  const result = z.object({
    ErrorCode: z.literal(0),
    BearerTokenInfo: z.object({ AccessToken: z.string().min(1), ExpiresIn: z.number().nonnegative().optional() }),
  }).safeParse(body);
  if (!response.ok || !result.success) throw new Error("Payarc Connect authentication failed.");
  const { AccessToken: token, ExpiresIn: expiresIn = 0 } = result.data.BearerTokenInfo;
  loginCache = { config, token, expiresAt: Date.now() + Math.max(0, Math.min(45, expiresIn - 10)) * 1000 };
  return token;
}

async function connectRequest(config: PayarcConnectConfig, token: string, path: string, key: string, payload?: object) {
  const response = await fetch(`${config.apiOrigin}/v3${path}`, {
    method: payload ? "POST" : "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8_000),
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json", "X-Idempotency-Key": key },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  return { ok: response.ok, httpStatus: response.status, body: await response.json().catch(() => null) as unknown };
}

type ConnectResponse = Awaited<ReturnType<typeof connectRequest>>;

function connectSaleOutcome(reply: ConnectResponse | null): { traceId?: string; rejected?: string } {
  if (!reply) return {};
  const result = z.object({
    traceId: z.uuid().optional(),
    response: z.object({ status: z.string().optional(), error: z.object({ code: z.string() }).nullish() }),
  }).safeParse(reply.body);
  const traceId = result.success ? result.data.traceId : undefined;
  if (reply.ok && result.success && result.data.response.status === "SUCCESS" && traceId) return { traceId };
  const code = result.success ? result.data.response.error?.code : undefined;
  if (!reply.ok && code && ["TERMINAL_OFFLINE", "TERMINAL_NOT_ON_V3", "TERMINAL_STATUS_UNAVAILABLE"].includes(code)) return { rejected: code };
  return {};
}

export async function sendPayarcConnectSale(config: PayarcConnectConfig, token: string, attempt: PayarcConnectAttempt) {
  const { payarc_connect_ref, payarc_connect_tip_cents: tip, payarc_connect_tax_cents: tax, payarc_connect_serial: terminalId } = attempt.metadata;
  const total = attempt.amount_cents;
  const payload = {
    tenantId: config.mid, terminalId, transactionId: payarc_connect_ref, tenderType: "CREDIT",
    amount: { total, subtotal: total - tip - tax, currency: "USD", tip, tax },
    tipRequestFlag: false, printReceipt: 0,
    callbackURL: `${config.callbackOrigin}/api/payments/payarc-connect/${attempt.id}?key=${callbackKey(config, attempt.id)}`,
  };
  const send = () => connectRequest(config, token, "/transactions/sale", attempt.id, payload).catch(() => null);
  const reply = await send();
  const outcome = connectSaleOutcome(reply);
  if (outcome.traceId || outcome.rejected) return outcome;
  const proxyRejected = reply?.httpStatus === 403 && reply.body && typeof reply.body === "object" && "cloudflare_error" in reply.body;
  if (!reply || reply.ok || reply.httpStatus >= 500 || [408, 429].includes(reply.httpStatus) || proxyRejected) {
    // The terminal transaction ID, exact payload and idempotency key must stay identical.
    return connectSaleOutcome(await send());
  }
  return outcome;
}

export async function readPayarcConnectSale(config: PayarcConnectConfig, token: string, traceId: string) {
  const result = await connectRequest(config, token, `/transactions/${traceId}`, randomUUID());
  return result.ok ? result.body : null;
}

export async function cancelPayarcConnectSale(config: PayarcConnectConfig, token: string, traceId: string, terminalId: string) {
  const response = await connectRequest(config, token, `/transactions/${traceId}/cancel`, randomUUID(), { tenantId: config.mid, terminalId });
  return response.ok;
}

export async function checkPayarcConnectReader(config: PayarcConnectConfig) {
  const token = await payarcConnectAccessToken(config);
  const result = await connectRequest(config, token, `/terminals/${config.serial}/connectivity`, randomUUID());
  const parsed = z.object({ serialNumber: serialSchema.optional(), online: z.boolean().nullable() }).safeParse(result.body);
  if (!result.ok || !parsed.success || (parsed.data.serialNumber && parsed.data.serialNumber !== config.serial)) {
    throw new Error("Payarc Connect could not verify this reader.");
  }
  return parsed.data.online;
}
