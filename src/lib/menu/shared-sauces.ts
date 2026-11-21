/** Match sauce sections without treating "No sauce" instructions as products. */
export function isSauceOption(label: string, name: string) {
  return /(sauce|dressing)/i.test(label) && !/^\s*(no|light|lite)\b/i.test(name);
}
export type SharedSauce = { key: string; name: string; price_cents: number | null; min_cents: number; max_cents: number; item_count: number };
