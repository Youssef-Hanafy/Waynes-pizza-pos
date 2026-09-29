import { signRequest, type SigV4Credentials } from "./sigv4";

/**
 * AWS End User Messaging SMS (pinpoint-sms-voice-v2) SendTextMessage, called
 * with a SigV4-signed JSON request.  The platform only ever reaches this from
 * the dispatcher, for a connection whose dispatch_mode is 'platform' and whose
 * live_sending switch is on, with MESSAGING_LIVE_SEND=true on the server.
 */
export type AwsSendInput = {
  region: string;
  credentials: SigV4Credentials;
  destination: string;
  body: string;
  originationIdentity: string;
  messageType: "PROMOTIONAL" | "TRANSACTIONAL";
  configurationSetName?: string | null;
};

export type AwsSendResult = { ok: true; messageId: string } | { ok: false; retryable: boolean; error: string; unknown?: boolean };

/** Errors worth another attempt; everything else is a definite "no". */
const retryableTypes = new Set(["ThrottlingException", "InternalServerException", "ServiceUnavailableException", "RequestTimeout"]);

export function classifyAwsError(status: number, type: string | null, message: string): AwsSendResult {
  const shortType = type?.split("#").pop() ?? null;
  const retryable = status >= 500 || status === 429 || (shortType !== null && retryableTypes.has(shortType));
  return { ok: false, retryable, error: `${shortType ?? `HTTP ${status}`}: ${message}`.slice(0, 900) };
}

export async function sendAwsTextMessage(input: AwsSendInput, fetcher: typeof fetch = fetch): Promise<AwsSendResult> {
  if (!/^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(input.region)) return { ok: false, retryable: false, error: "Invalid AWS region on the messaging connection." };
  const host = `sms-voice.${input.region}.amazonaws.com`;
  const body = JSON.stringify({
    DestinationPhoneNumber: input.destination,
    MessageBody: input.body,
    MessageType: input.messageType,
    OriginationIdentity: input.originationIdentity,
    ...(input.configurationSetName ? { ConfigurationSetName: input.configurationSetName } : {}),
  });
  const headers = signRequest(
    {
      method: "POST",
      host,
      headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": "PinpointSMSVoiceV2.SendTextMessage" },
      body,
      region: input.region,
      service: "sms-voice",
    },
    input.credentials,
  );

  let response: Response;
  try {
    response = await fetcher(`https://${host}/`, { method: "POST", headers, body, signal: AbortSignal.timeout(15_000) });
  } catch (cause) {
    // No answer: the text may or may not have gone, so it is never retried
    // automatically (no duplicate texts); the job is marked 'unknown'.
    return { ok: false, retryable: false, unknown: true, error: `No answer from AWS: ${cause instanceof Error ? cause.message : "network error"}` };
  }
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }
  if (response.ok && typeof parsed.MessageId === "string") return { ok: true, messageId: parsed.MessageId };
  if (response.ok) return { ok: false, retryable: false, error: "AWS accepted the request but returned no MessageId." };
  const type = typeof parsed.__type === "string" ? parsed.__type : response.headers.get("x-amzn-errortype");
  const message = typeof parsed.message === "string" ? parsed.message : typeof parsed.Message === "string" ? parsed.Message : text.slice(0, 300);
  return classifyAwsError(response.status, type, message);
}

/**
 * Credentials named by a connection's secret_reference (env:PREFIX), read
 * from the server environment.  Nothing is shared between businesses unless
 * two connections deliberately name the same prefix.
 */
export function credentialsFor(secretReference: string | null, env: NodeJS.ProcessEnv = process.env): SigV4Credentials | null {
  const match = secretReference?.match(/^env:([A-Z][A-Z0-9_]{1,40})$/);
  if (!match) return null;
  const prefix = match[1];
  const accessKeyId = env[`${prefix}_ACCESS_KEY_ID`];
  const secretAccessKey = env[`${prefix}_SECRET_ACCESS_KEY`];
  if (!accessKeyId || !secretAccessKey) return null;
  const sessionToken = env[`${prefix}_SESSION_TOKEN`];
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

/** Real AWS sends need both the connection switch and the server switch. */
export function liveSendingAllowed(job: { live_sending: boolean }, env: NodeJS.ProcessEnv = process.env) {
  return job.live_sending && env.MESSAGING_LIVE_SEND === "true";
}

/** GSM-7 texts split at 153 characters per part, anything else at 67. */
export function smsSegments(body: string) {
  const gsm = /^[\n\r !"#$%&'()*+,\-./0-9:;<=>?@A-Z_a-z£¥èéùìòÇØøÅåΔΦΓΛΩΠΨΣΘΞÆæßÉ¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/.test(body);
  const single = gsm ? 160 : 70;
  const part = gsm ? 153 : 67;
  const length = [...body].length;
  return length <= single ? 1 : Math.ceil(length / part);
}
