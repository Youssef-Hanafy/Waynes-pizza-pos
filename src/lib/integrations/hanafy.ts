import { createHmac, timingSafeEqual } from "node:crypto";

export function signHanafyEnvelope(secret: string, timestamp: string, body: string) {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function secureTokenEquals(actual: string, expected: string) {
  const received = Buffer.from(actual); const configured = Buffer.from(expected);
  return received.length === configured.length && timingSafeEqual(received, configured);
}
