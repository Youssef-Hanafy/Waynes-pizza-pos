/**
 * A random UUID (v4) that works everywhere the POS runs.
 *
 * crypto.randomUUID() only exists on https pages (and localhost).  The POS
 * Android app in the emulator opens the dev server at http://10.0.2.2, where
 * it is missing, so this falls back to crypto.getRandomValues(), which every
 * browser has on any page.  Never Math.random(): these ids are idempotency
 * keys and database ids.
 */
export function uuid(): string {
  const source = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (source && typeof source.randomUUID === "function") return source.randomUUID();
  if (!source || typeof source.getRandomValues !== "function") throw new Error("No secure random number generator is available.");
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
