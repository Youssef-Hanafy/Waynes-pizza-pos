/**
 * Hanafy billing money helpers (Phase 11).  Money is always integer cents;
 * dollars typed by a person are parsed as text, never through floating point.
 */
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatMoney(cents: number | null | undefined) {
  return usd.format((cents ?? 0) / 100);
}

/** "1,299.5" → 129950; "12" → 1200; anything else → null. */
export function parseDollarsToCents(value: string): number | null {
  const cleaned = value.replace(/[$,\s]/g, "");
  const match = /^(-)?(\d{1,9})(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!match) return null;
  const whole = Number(match[2]);
  const fraction = Number((match[3] ?? "").padEnd(2, "0"));
  const cents = whole * 100 + fraction;
  return match[1] ? -cents : cents;
}
