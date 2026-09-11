import { z } from "zod";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { getReportData, getReportOrders } from "@/lib/reports/queries";

const querySchema = z.object({ dataset: z.enum(["orders", "daily", "items"]), from: z.iso.date(), to: z.iso.date() }).refine((value) => value.to >= value.from, { message: "Invalid date range" });
export async function GET(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "reports.view")) return Response.json({ error: "Report viewing permission required." }, { status: 403 });
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: "Invalid export request." }, { status: 400 });
  const { dataset, from, to } = parsed.data;
  const report = await getReportData(from, to);
  const rows = dataset === "daily" ? [["business_date", "order_count", "order_sales_cents", "refund_cents", "net_sales_cents"], ...report.daily.map((row) => [row.service_date, row.order_count, row.sales_cents, row.refund_cents, row.net_sales_cents])] : dataset === "items" ? [["category", "item", "quantity", "sales_cents"], ...report.items.map((row) => [row.category_name, row.item_name, row.quantity, row.sales_cents])] : await orderRows(from, to);
  return new Response(toCsv(rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="waynes-${dataset}-${from}-to-${to}.csv"`, "Cache-Control": "no-store" } });
}

async function orderRows(from: string, to: string): Promise<Array<Array<string | number | null>>> {
  const orders = await getReportOrders(from, to);
  // Business date and local time are Wayne's America/New_York clock; the UTC column
  // keeps the exact instant for reconciliation with payment providers.
  return [["order_number", "business_date", "placed_at_local", "placed_at_utc", "source", "fulfillment", "status", "payment_method", "discount_cents", "total_cents"], ...orders.map((order) => [order.order_number, order.business_date, order.placed_at_local, new Date(order.placed_at).toISOString(), order.source, order.fulfillment_type, order.status, order.payment_method, order.discount_cents, order.total_cents])];
}
function toCsv(rows: Array<Array<string | number | null>>) { return `\uFEFF${rows.map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n")}\r\n`; }
