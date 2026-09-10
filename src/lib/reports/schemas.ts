import { z } from "zod";

const splitRowSchema = z.object({ key: z.string(), order_count: z.number().int().nonnegative(), total_cents: z.number().int().nonnegative() });
export const reportSummarySchema = z.object({
  order_count: z.number().int().nonnegative(), gross_sales_cents: z.number().int(), discount_cents: z.number().int(), refund_cents: z.number().int(), net_sales_cents: z.number().int(), average_order_cents: z.number().int(),
  source_rows: z.array(splitRowSchema), fulfillment_rows: z.array(splitRowSchema), payment_rows: z.array(splitRowSchema),
});
export const dailySalesSchema = z.object({ service_date: z.string(), order_count: z.number().int().nonnegative(), sales_cents: z.number().int(), refund_cents: z.number().int(), net_sales_cents: z.number().int() });
export const itemReportSchema = z.object({ category_name: z.string(), item_name: z.string(), quantity: z.number().int().nonnegative(), sales_cents: z.number().int() });
export type ReportSummary = z.infer<typeof reportSummarySchema>;
export type DailySales = z.infer<typeof dailySalesSchema>;
export type ItemReport = z.infer<typeof itemReportSchema>;
