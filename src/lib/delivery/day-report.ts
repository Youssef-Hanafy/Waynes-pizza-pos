import { z } from "zod";
import type { PrintLayout, PrintLine } from "@/lib/printing/document";
import type { PosCashoutResult } from "./pos-board";

/**
 * A day's deliveries per driver (database: wayne_delivery_day_report) — the
 * delivery close out slip and the driver's tips receipt at cash-out (owner,
 * 2026-10-19: "when closing out a shift print a receipt for driver total tips
 * for the day … paper slips for delivery and store close out").
 */
const n = z.coerce.number().int().catch(0);

export const deliveryDayDriverSchema = z.object({
  driver_id: z.uuid(),
  name: z.string(),
  deliveries: n,
  cashouts: n,
  last_cashout_at: z.string().nullable().optional().transform((value) => value ?? null),
  delivery_total_cents: n,
  cash_orders_cents: n,
  card_tips_cents: n,
  cash_tips_cents: n,
  tips_cents: n,
  hand_in_cents: n,
  pending_count: n,
  pending_cents: n,
  orders: z.array(z.object({
    order_number: z.string(),
    daily_number: z.number().int().nullable().optional().transform((value) => value ?? null),
    paid_by: z.string(),
    total_cents: n,
    tip_cents: n,
    cash_cents: n,
  })).catch([]),
});
export type DeliveryDayDriver = z.infer<typeof deliveryDayDriverSchema>;

export const deliveryDayReportSchema = z.object({
  day: z.string(),
  timezone: z.string(),
  drivers: z.array(deliveryDayDriverSchema).catch([]),
});
export type DeliveryDayReport = z.infer<typeof deliveryDayReportSchema>;

const money = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
const paidByShort: Record<string, string> = { card_held: "Card", card: "Card", paid: "Online", cash_paid: "Paid cash", cash: "Cash" };

function dayLabel(day: string) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function deliveryTotals(report: DeliveryDayReport) {
  return report.drivers.reduce((sum, driver) => ({
    deliveries: sum.deliveries + driver.deliveries,
    deliveryTotal: sum.deliveryTotal + driver.delivery_total_cents,
    cashOrders: sum.cashOrders + driver.cash_orders_cents,
    cardTips: sum.cardTips + driver.card_tips_cents,
    cashTips: sum.cashTips + driver.cash_tips_cents,
    tips: sum.tips + driver.tips_cents,
    handIn: sum.handIn + driver.hand_in_cents,
    pending: sum.pending + driver.pending_count,
  }), { deliveries: 0, deliveryTotal: 0, cashOrders: 0, cardTips: 0, cashTips: 0, tips: 0, handIn: 0, pending: 0 });
}

/** The delivery close out slip: every driver's day, then the totals. Big text — it is read standing at the counter. */
export function deliveryCloseoutLayout(report: DeliveryDayReport, storeName: string): PrintLayout {
  const pair = (left: string, cents: number, bold = false): PrintLine => ({ kind: "pair", left, right: money(cents), bold, tall: true });
  const totals = deliveryTotals(report);
  const lines: PrintLine[] = [
    { kind: "text", text: storeName, align: "center", bold: true, large: true },
    { kind: "text", text: "DELIVERY CLOSE OUT", align: "center", bold: true, tall: true },
    { kind: "text", text: dayLabel(report.day), align: "center", tall: true },
    { kind: "rule" },
  ];
  if (!report.drivers.length) lines.push({ kind: "text", text: "No deliveries.", align: "center", tall: true });
  for (const driver of report.drivers) {
    lines.push(
      { kind: "text", text: driver.name.toUpperCase(), bold: true, tall: true },
      { kind: "pair", left: "Deliveries", right: String(driver.deliveries), tall: true },
      pair("Delivery orders", driver.delivery_total_cents),
      pair("Cash orders", driver.cash_orders_cents),
      pair("Card tips (store paid)", driver.card_tips_cents),
      pair("Cash tips (kept)", driver.cash_tips_cents),
      pair("TOTAL TIPS", driver.tips_cents, true),
      { kind: "pair", left: driver.hand_in_cents >= 0 ? "HANDED IN" : "PAID TO DRIVER", right: money(Math.abs(driver.hand_in_cents)), bold: true, tall: true },
    );
    if (driver.pending_count) lines.push({ kind: "text", text: `!! ${driver.pending_count} not cashed out yet (${money(driver.pending_cents)})`, bold: true, highlight: true, tall: true });
    lines.push({ kind: "rule" });
  }
  lines.push(
    { kind: "text", text: "ALL DRIVERS", bold: true, tall: true },
    { kind: "pair", left: "Deliveries", right: String(totals.deliveries), tall: true },
    pair("Delivery orders", totals.deliveryTotal),
    pair("Cash orders", totals.cashOrders),
    pair("Card tips (store paid)", totals.cardTips),
    pair("Cash tips (kept)", totals.cashTips),
    { kind: "pair", left: "TOTAL TIPS", right: money(totals.tips), bold: true, large: true },
    { kind: "pair", left: totals.handIn >= 0 ? "HANDED IN" : "PAID TO DRIVERS", right: money(Math.abs(totals.handIn)), bold: true, tall: true },
  );
  if (totals.pending) lines.push({ kind: "text", text: `!! ${totals.pending} ${totals.pending === 1 ? "delivery" : "deliveries"} not cashed out yet`, bold: true, highlight: true, tall: true });
  lines.push({ kind: "feed", lines: 3 });
  return { title: `Delivery close out ${report.day}`, lines };
}

/**
 * The driver's receipt at cash-out: this cash-out's deliveries and tips, and
 * the driver's TOTAL TIPS FOR THE DAY (every cash-out today).
 */
export function driverTipsLayout(options: { storeName: string; day: string; driverName: string; cashout: PosCashoutResult | null; today: DeliveryDayDriver | null; printedAt?: Date; timeZone?: string }): PrintLayout {
  const { cashout, today } = options;
  const pair = (left: string, cents: number, bold = false): PrintLine => ({ kind: "pair", left, right: money(cents), bold, tall: true });
  const lines: PrintLine[] = [
    { kind: "text", text: options.storeName, align: "center", bold: true, large: true },
    { kind: "text", text: "DRIVER TIPS", align: "center", bold: true, tall: true },
    { kind: "text", text: options.driverName.toUpperCase(), align: "center", bold: true, large: true },
    { kind: "text", text: `${dayLabel(options.day)} · ${(options.printedAt ?? new Date()).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(options.timeZone ? { timeZone: options.timeZone } : {}) })}`, align: "center", tall: true },
    { kind: "rule" },
  ];
  if (cashout) {
    lines.push({ kind: "text", text: "THIS CASH-OUT", bold: true, tall: true });
    for (const line of cashout.detail) {
      lines.push({ kind: "pair", left: `${line.order_number.replace(/^W0*/, "#")} ${paidByShort[line.paid_by] ?? line.paid_by}`, right: `tip ${money(line.tip_cents)}`, tall: true });
    }
    lines.push(
      { kind: "pair", left: "Deliveries", right: String(cashout.order_count), tall: true },
      pair("Cash orders", cashout.cash_orders_cents),
      pair("Card tips (store pays)", cashout.card_tips_cents),
      pair("Cash tips (kept)", cashout.cash_tips_cents),
      { kind: "pair", left: cashout.hand_in_cents >= 0 ? "HANDS IN" : "PAY DRIVER", right: money(Math.abs(cashout.hand_in_cents)), bold: true, large: true },
      { kind: "rule" },
    );
  }
  if (today) {
    lines.push(
      { kind: "text", text: "TODAY", bold: true, tall: true },
      { kind: "pair", left: "Deliveries", right: String(today.deliveries), tall: true },
      pair("Card tips", today.card_tips_cents),
      pair("Cash tips", today.cash_tips_cents),
      { kind: "pair", left: "TIPS TODAY", right: money(today.tips_cents), bold: true, large: true },
    );
    if (today.pending_count) lines.push({ kind: "text", text: `${today.pending_count} more not cashed out yet`, bold: true, tall: true });
  }
  lines.push({ kind: "feed", lines: 2 }, { kind: "text", text: "X______________________________", tall: true }, { kind: "text", text: "Driver", align: "center" }, { kind: "feed", lines: 3 });
  return { title: `Driver tips ${options.driverName}`, lines };
}
