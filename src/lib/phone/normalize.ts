/**
 * Phone numbers, the way the database stores them (§14).
 *
 * Mirrors `public.wayne_normalize_phone()` exactly, so the POS can match and
 * display a caller the instant a ring arrives — before any round trip — and
 * the server will agree with it afterwards.
 *
 *   508-555-1234 · (508) 555-1234 · 5085551234 · +1 508 555 1234  →  +15085551234
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  let digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length === 10 ? `+1${digits}` : null;
}

/** (508) 555-1234 for a US number; whatever came in, trimmed, otherwise. */
export function formatPhone(raw: string | null | undefined, fallback = "Unknown number"): string {
  const normalized = normalizePhone(raw);
  if (!normalized) return (raw ?? "").trim() || fallback;
  const digits = normalized.slice(2);
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** Two numbers are the same caller when they normalize to the same thing. */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizePhone(a);
  return left !== null && left === normalizePhone(b);
}
