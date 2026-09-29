import { createVerify } from "node:crypto";

/**
 * Amazon SNS HTTPS notification verification.  AWS End User Messaging
 * publishes inbound texts (STOP/START/HELP) and delivery receipts to an SNS
 * topic; SNS then POSTs them here.  A message is trusted only when its RSA
 * signature verifies against a certificate served from an sns.*.amazonaws.com
 * host, and only when its topic is one this deployment expects.
 */
export type SnsMessage = {
  Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: "1" | "2";
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
};

export function parseSnsMessage(value: unknown): SnsMessage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const required = ["Type", "MessageId", "TopicArn", "Message", "Timestamp", "SignatureVersion", "Signature", "SigningCertURL"];
  if (!required.every((key) => typeof record[key] === "string")) return null;
  if (!["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation"].includes(record.Type as string)) return null;
  if (record.SignatureVersion !== "1" && record.SignatureVersion !== "2") return null;
  return record as unknown as SnsMessage;
}

/** Only certificates from SNS itself, over HTTPS. */
export function isTrustedSnsUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(url.hostname);
  } catch {
    return false;
  }
}

/** The exact string SNS signs, in AWS's documented key order. */
export function snsStringToSign(message: SnsMessage) {
  const keys =
    message.Type === "Notification"
      ? ["Message", "MessageId", ...(message.Subject !== undefined ? ["Subject"] : []), "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  return keys.map((key) => `${key}\n${String((message as Record<string, unknown>)[key] ?? "")}\n`).join("");
}

const certificateCache = new Map<string, string>();

export async function verifySnsMessage(message: SnsMessage, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!isTrustedSnsUrl(message.SigningCertURL) || !message.SigningCertURL.endsWith(".pem")) return false;
  let certificate = certificateCache.get(message.SigningCertURL);
  if (!certificate) {
    const response = await fetcher(message.SigningCertURL, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return false;
    certificate = await response.text();
    if (!certificate.includes("BEGIN CERTIFICATE")) return false;
    certificateCache.set(message.SigningCertURL, certificate);
  }
  const verifier = createVerify(message.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1");
  verifier.update(snsStringToSign(message), "utf8");
  verifier.end();
  try {
    return verifier.verify(certificate, message.Signature, "base64");
  } catch {
    return false;
  }
}

export function allowedTopics(env: NodeJS.ProcessEnv = process.env) {
  return (env.MESSAGING_SNS_TOPIC_ARNS ?? "").split(",").map((topic) => topic.trim()).filter(Boolean);
}

/** An inbound text (two-way SMS) as AWS End User Messaging publishes it. */
export type InboundText = { originationNumber: string; destinationNumber: string; messageBody: string; inboundMessageId: string | null };
/** A delivery event as AWS End User Messaging publishes it. */
export type DeliveryEvent = { messageId: string; messageStatus: string; eventId: string };

export function readSmsPayload(message: string): { kind: "inbound"; value: InboundText } | { kind: "delivery"; value: DeliveryEvent } | { kind: "unknown" } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(message) as Record<string, unknown>;
  } catch {
    return { kind: "unknown" };
  }
  if (typeof parsed.originationNumber === "string" && typeof parsed.destinationNumber === "string" && typeof parsed.messageBody === "string") {
    return {
      kind: "inbound",
      value: {
        originationNumber: parsed.originationNumber,
        destinationNumber: parsed.destinationNumber,
        messageBody: parsed.messageBody,
        inboundMessageId: typeof parsed.inboundMessageId === "string" ? parsed.inboundMessageId : null,
      },
    };
  }
  if (typeof parsed.messageId === "string" && typeof parsed.messageStatus === "string") {
    const eventId = [parsed.messageId, parsed.messageStatus, parsed.eventTimestamp ?? ""].join(":");
    return { kind: "delivery", value: { messageId: parsed.messageId, messageStatus: parsed.messageStatus, eventId } };
  }
  return { kind: "unknown" };
}
