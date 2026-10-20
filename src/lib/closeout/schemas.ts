import { z } from "zod";
import { readableSlipLines, type PrintLayout, type PrintLine } from "@/lib/printing/document";

/** The day's close out (database: wayne_day_closeout). Counts arrive as numbers or numeric strings. */
const n = z.coerce.number().int().catch(0);

const brandSchema = z.object({ count: n, cents: n, in_store_cents: n, online_cents: n });
const shiftTotalsSchema = z.object({
  id: z.uuid(), register_label: z.string(), opened_at: z.string(),
  opening_cash_cents: n, cash_sales_cents: n, cash_refunds_cents: n, paid_in_cents: n, paid_out_cents: n,
  drop_cents: n, driver_cash_cents: n, expected_cash_cents: n,
});

export const dayCloseoutSchema = z.object({
  day: z.string(),
  timezone: z.string(),
  sales: z.object({
    order_count: n, item_count: n, subtotal_cents: n, discount_cents: n, delivery_fee_cents: n, tax_cents: n, tip_cents: n,
    total_cents: n, net_sales_cents: n, pickup_count: n, delivery_count: n, pickup_total_cents: n, delivery_total_cents: n,
  }),
  by_source: z.record(z.string(), z.object({ count: n, total_cents: n })).catch({}),
  tenders: z.object({
    cash_cents: n, cash_count: n, cash_at_counter_cents: n, cash_from_drivers_cents: n,
    card_cents: n, card_count: n, card_in_store_cents: n, card_online_cents: n, card_held_for_tip_cents: n,
    other_cents: n, card_tips_cents: n, cash_tips_cents: n,
  }),
  card_brands: z.record(z.string(), brandSchema).catch({}),
  online: z.object({
    order_count: n, pickup_count: n, delivery_count: n, subtotal_cents: n, discount_cents: n, delivery_fee_cents: n,
    tax_cents: n, tip_cents: n, total_cents: n, paid_card_cents: n, paid_cash_cents: n, unpaid_count: n, unpaid_cents: n,
  }),
  in_store: z.object({ order_count: n, counter_count: n, phone_count: n, total_cents: n }),
  refunds: z.object({ count: n, cents: n, cash_cents: n }),
  voids: z.object({ count: n, total_cents: n }),
  unpaid: z.object({
    count: n, total_cents: n,
    orders: z.array(z.object({ id: z.uuid(), order_number: z.string(), customer_name: z.string().nullable().transform((value) => value ?? ""), source: z.string(), fulfillment_type: z.string(), total_cents: n, payment_method: z.string() })).catch([]),
  }),
  drawer: z.object({
    open_shifts: z.array(shiftTotalsSchema).catch([]),
    closed_today: z.array(z.object({ id: z.uuid(), register_label: z.string(), closed_at: z.string().nullable(), opening_cash_cents: n, expected_cash_cents: n, counted_cash_cents: n, variance_cents: n })).catch([]),
  }),
  /** Tips are not store income (owner, 2026-10-13). Missing on a database from before this. */
  tip_payout: z.object({
    owner_card_tips_cents: n, owner_card_tip_count: n, owner_cash_tips_cents: n, driver_tips_cents: n, income_cents: n,
  }).nullable().optional().catch(null),
  saved: z.object({
    business_date: z.string(), counted_cash_cents: n, expected_cash_cents: n, variance_cents: n, note: z.string(),
    closed_at: z.string(), closed_by_name: z.string().nullable().optional(), denominations: z.record(z.string(), n).catch({}),
  }).nullable().catch(null),
});
export type DayCloseout = z.infer<typeof dayCloseoutSchema>;

export const saveCloseoutSchema = z.object({
  business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  counted_cash_cents: z.number().int().min(0).max(10_000_000),
  denominations: z.record(z.string().max(10), z.number().int().min(0).max(100_000)).default({}),
  note: z.string().trim().max(1000).default(""),
  close_drawer: z.boolean().default(true),
});

/** Bills and coins in a US drawer, with their value in cents. */
export const DENOMINATIONS: readonly { key: string; label: string; cents: number; roll?: boolean }[] = [
  { key: "100", label: "$100", cents: 10_000 }, { key: "50", label: "$50", cents: 5_000 }, { key: "20", label: "$20", cents: 2_000 },
  { key: "10", label: "$10", cents: 1_000 }, { key: "5", label: "$5", cents: 500 }, { key: "2", label: "$2", cents: 200 }, { key: "1", label: "$1", cents: 100 },
  { key: "0.25", label: "Quarters", cents: 25 }, { key: "0.10", label: "Dimes", cents: 10 }, { key: "0.05", label: "Nickels", cents: 5 }, { key: "0.01", label: "Pennies", cents: 1 },
];

export function countedFromDenominations(counts: Record<string, number>) {
  return DENOMINATIONS.reduce((sum, denomination) => sum + Math.max(0, Math.floor(counts[denomination.key] ?? 0)) * denomination.cents, 0);
}

/**
 * What should be in the drawer: the open drawer's own expectation when one
 * is open (float + cash taken + paid in + driver cash − paid out − drops);
 * otherwise what today's closed drawers expected; otherwise the day's cash
 * takings less cash refunds.
 */
export function expectedCash(report: DayCloseout, isToday = true) {
  // A drawer still open belongs to today; an earlier day compares with its closed drawers.
  if (isToday && report.drawer.open_shifts.length) return report.drawer.open_shifts.reduce((sum, shift) => sum + shift.expected_cash_cents, 0);
  const closed = report.drawer.closed_today.reduce((sum, shift) => sum + shift.expected_cash_cents, 0);
  if (closed) return closed;
  return report.tenders.cash_cents - report.refunds.cash_cents;
}

export const brandLabels: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover", other_card: "Other cards" };
export const sourceLabels: Record<string, string> = { pos: "Counter", phone: "Phone", online: "Online" };

const money = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

/** The close out as a slip for the receipt printer. */
/**
 * The day's tips, kept out of the store's money (owner, 2026-10-13): card
 * tips on every order that isn't a delivery are paid out to the owner; tips on
 * deliveries belong to the drivers (paid at their cash-out).
 */
export function tipPayout(report: DayCloseout) {
  const payout = report.tip_payout;
  return {
    ownerCardTips: payout?.owner_card_tips_cents ?? report.tenders.card_tips_cents,
    ownerCardTipCount: payout?.owner_card_tip_count ?? 0,
    ownerCashTips: payout?.owner_cash_tips_cents ?? 0,
    driverTips: payout?.driver_tips_cents ?? 0,
    income: payout?.income_cents ?? report.sales.total_cents - report.sales.tip_cents,
  };
}

export function closeoutLayout(report: DayCloseout, storeName: string, counted: number | null, isToday = true, payoutName = "the owner"): PrintLayout {
  const expected = expectedCash(report, isToday);
  const tips = tipPayout(report);
  const pair = (left: string, cents: number, bold = false): PrintLine => ({ kind: "pair", left, right: money(cents), bold });
  const lines: PrintLine[] = [
    { kind: "text", text: storeName, align: "center", bold: true, large: true },
    { kind: "text", text: "END OF DAY CLOSE OUT", align: "center", bold: true },
    { kind: "text", text: report.day, align: "center" },
    { kind: "rule" },
    { kind: "text", text: "SALES", bold: true },
    { kind: "pair", left: "Orders", right: String(report.sales.order_count) },
    { kind: "pair", left: "Items", right: String(report.sales.item_count) },
    pair("Food & drink", report.sales.subtotal_cents),
    pair("Discounts", -report.sales.discount_cents),
    pair("Delivery fees", report.sales.delivery_fee_cents),
    pair("Tax", report.sales.tax_cents),
    pair("Tips", report.sales.tip_cents),
    pair("TOTAL COLLECTED", report.sales.total_cents, true),
    pair("STORE INCOME (NO TIPS)", tips.income, true),
    { kind: "rule" },
    { kind: "text", text: "TIPS - NOT STORE INCOME", bold: true },
    pair(`Card tips to pay ${payoutName}`, tips.ownerCardTips, true),
    ...(tips.ownerCashTips ? [pair("Cash tips (in store)", tips.ownerCashTips)] : []),
    ...(tips.driverTips ? [pair("Delivery tips (drivers)", tips.driverTips)] : []),
    { kind: "rule" },
    { kind: "text", text: "PAYMENTS", bold: true },
    pair("Cash", report.tenders.cash_cents),
    pair("Card", report.tenders.card_cents),
    ...Object.entries(report.card_brands).map(([brand, value]) => pair(`  ${brandLabels[brand] ?? brand} (${value.count})`, value.cents)),
    ...(report.tenders.other_cents ? [pair("Other", report.tenders.other_cents)] : []),
    pair("Card tips", report.tenders.card_tips_cents),
    { kind: "rule" },
    { kind: "text", text: "ONLINE ORDERS", bold: true },
    { kind: "pair", left: "Orders", right: String(report.online.order_count) },
    pair("Total", report.online.total_cents, true),
    pair("Paid by card", report.online.paid_card_cents),
    pair("Tips", report.online.tip_cents),
    ...(report.online.unpaid_count ? [pair(`Not paid (${report.online.unpaid_count})`, report.online.unpaid_cents)] : []),
    { kind: "rule" },
    { kind: "text", text: "CASH DRAWER", bold: true },
    pair("Expected", expected),
    ...(counted === null ? [] : [pair("Counted", counted), pair(counted - expected >= 0 ? "Over" : "Short", counted - expected, true)]),
    { kind: "rule" },
    ...(report.refunds.count ? [pair(`Refunds (${report.refunds.count})`, report.refunds.cents)] : []),
    ...(report.voids.count ? [pair(`Voided orders (${report.voids.count})`, report.voids.total_cents)] : []),
    ...(report.unpaid.count ? [pair(`STILL NOT PAID (${report.unpaid.count})`, report.unpaid.total_cents, true)] : []),
    { kind: "feed", lines: 3 },
  ];
  return { title: `Close out ${report.day}`, lines: readableSlipLines(lines) };
}
