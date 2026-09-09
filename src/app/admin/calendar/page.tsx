import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { requirePermission } from "@/lib/auth/access";
import { getStoreSettings } from "@/lib/content/queries";
import { formatCents } from "@/lib/menu/schemas";
import { monthForTimeZone } from "@/lib/orders/admin-format";
import { getAdminOrderCalendar } from "@/lib/orders/admin-queries";
import { getCalendarCells, shiftMonth } from "@/lib/orders/calendar";

export const metadata: Metadata = { title: "Order calendar" };
export const dynamic = "force-dynamic";
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export default async function AdminCalendarPage({ searchParams }: { searchParams: Promise<{ month?: string | string[] }> }) {
  await requirePermission("orders.view", "/admin/calendar");
  const [settings, query] = await Promise.all([getStoreSettings(), searchParams]);
  const rawMonth = Array.isArray(query.month) ? query.month[0] : query.month;
  const month = monthSchema.safeParse(rawMonth).success ? rawMonth! : monthForTimeZone(settings.timezone);
  const days = await getAdminOrderCalendar(month);
  const byDate = new Map(days.map((day) => [day.service_date, day]));
  const cells = getCalendarCells(month);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: settings.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const title = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      <div className="flex flex-wrap items-end justify-between gap-5"><div><p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">Orders</p><h1 className="mt-3 text-4xl font-black">Monthly calendar</h1><p className="mt-3 text-wayne-muted">Daily counts and active sales use {settings.timezone} business dates.</p></div><Button asChild variant="secondary"><Link href="/admin/orders">Order history</Link></Button></div>
      <div className="mt-8 flex items-center justify-between gap-4"><Button asChild variant="secondary"><Link href={`/admin/calendar?month=${shiftMonth(month, -1)}`}>← Previous</Link></Button><h2 className="text-center text-2xl font-black">{title}</h2><Button asChild variant="secondary"><Link href={`/admin/calendar?month=${shiftMonth(month, 1)}`}>Next →</Link></Button></div>
      <div className="mt-5 hidden overflow-hidden rounded-2xl border border-wayne-border bg-white sm:block"><div className="grid grid-cols-7 bg-wayne-ink text-center text-xs font-black uppercase tracking-wide text-white">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <div className="p-3" key={day}>{day}</div>)}</div><div className="grid grid-cols-7">{cells.map((cell) => { const day = byDate.get(cell.date); return <Link aria-current={cell.date === today ? "date" : undefined} aria-label={`View orders for ${cell.date}`} className={`min-h-32 border-r border-t border-wayne-border p-3 transition hover:bg-wayne-cream ${cell.inMonth ? "" : "bg-stone-50 text-stone-400"} ${cell.date === today ? "bg-amber-50 ring-2 ring-inset ring-wayne-red" : ""}`} href={`/admin/orders?from=${cell.date}&to=${cell.date}`} key={cell.date}><strong>{cell.day}{cell.date === today ? <span className="ml-2 rounded-full bg-wayne-red px-2 py-1 text-xs text-white">Today</span> : null}</strong>{day ? <div className="mt-4"><p className="font-black text-wayne-red">{day.order_count} order{day.order_count === 1 ? "" : "s"}</p><p className="text-sm font-bold">{formatCents(day.active_total_cents)}</p><p className="mt-1 text-xs text-wayne-muted">{day.pickup_count} pickup · {day.delivery_count} delivery</p></div> : <p className="mt-4 text-xs text-wayne-muted">No orders</p>}</Link>; })}</div></div>
      <div className="mt-5 grid gap-3 sm:hidden">{cells.filter((cell) => cell.inMonth).map((cell) => { const day = byDate.get(cell.date); return <Link aria-label={`View orders for ${cell.date}`} href={`/admin/orders?from=${cell.date}&to=${cell.date}`} key={cell.date}><Card className="flex min-h-20 items-center justify-between gap-4 p-4"><div><strong>{new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${cell.date}T00:00:00Z`))}</strong><p className="text-sm text-wayne-muted">{day ? `${day.pickup_count} pickup · ${day.delivery_count} delivery` : "No orders"}</p></div><div className="text-right"><strong className="text-wayne-red">{day?.order_count ?? 0}</strong><p className="text-sm font-bold">{formatCents(day?.active_total_cents ?? 0)}</p></div></Card></Link>; })}</div>
    </main>
  );
}
