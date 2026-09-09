import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { requirePermission } from "@/lib/auth/access";
import { getStoreSettings } from "@/lib/content/queries";
import { formatCents } from "@/lib/menu/schemas";
import { formatAdminDateTime, titleCase } from "@/lib/orders/admin-format";
import { getAdminOrderDetail } from "@/lib/orders/admin-queries";

export const metadata: Metadata = { title: "Order detail" };
export const dynamic = "force-dynamic";

export default async function AdminOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePermission("orders.view", `/admin/orders/${id}`);
  if (!z.uuid().safeParse(id).success) notFound();
  const [order, settings] = await Promise.all([getAdminOrderDetail(id), getStoreSettings()]);
  if (!order) notFound();
  const address = order.delivery_address_snapshot as Record<string, string> | null;
  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      <Button asChild variant="secondary"><Link href="/admin/orders">← Order history</Link></Button>
      <div className="mt-6 flex flex-wrap items-end justify-between gap-5">
        <div><p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">Order detail</p><h1 className="mt-2 text-4xl font-black">{order.order_number}</h1><p className="mt-2 text-wayne-muted">Placed {formatAdminDateTime(order.placed_at, settings.timezone)}</p></div>
        <div className="flex gap-2"><Badge>{titleCase(order.status)}</Badge><Badge className="bg-stone-700">{titleCase(order.fulfillment_type)}</Badge></div>
      </div>
      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="grid gap-6">
          <Card className="p-6"><h2 className="text-2xl font-black">Items</h2><div className="mt-4 divide-y divide-wayne-border">{order.items.map((item) => <div className="py-4" key={item.id}><div className="flex justify-between gap-4"><div><strong>{item.quantity}× {item.item_name_snapshot}</strong>{item.variant_name_snapshot ? <p className="text-sm text-wayne-muted">{item.variant_name_snapshot}</p> : null}</div><strong>{formatCents(item.line_total_cents)}</strong></div>{item.modifiers.length ? <ul className="mt-2 text-sm text-wayne-muted">{item.modifiers.map((modifier) => <li key={modifier.id}>{modifier.quantity > 1 ? `${modifier.quantity}× ` : ""}{modifier.modifier_name_snapshot} ({formatCents(modifier.price_delta_cents)})</li>)}</ul> : null}{item.special_instructions ? <p className="mt-2 text-sm"><strong>Item note:</strong> {item.special_instructions}</p> : null}</div>)}</div></Card>
          <Card className="p-6"><h2 className="text-2xl font-black">Timeline</h2><ol className="mt-5 grid gap-5 border-l-2 border-wayne-border pl-5">{order.events.length ? order.events.map((event) => <li key={event.id}><strong>{titleCase(event.event_type)}</strong>{event.from_status || event.to_status ? <p className="text-sm">{event.from_status ? titleCase(event.from_status) : "—"} → {event.to_status ? titleCase(event.to_status) : "—"}</p> : null}<p className="text-sm text-wayne-muted">{formatAdminDateTime(event.created_at, settings.timezone)}{event.actor_name ? ` · ${event.actor_name}` : " · System"}</p></li>) : <li className="text-wayne-muted">No events have been recorded.</li>}</ol></Card>
        </div>
        <aside className="grid content-start gap-6">
          <Card className="p-6"><h2 className="text-xl font-black">Customer</h2><p className="mt-3 font-bold">{order.customer_name_snapshot}</p><p><a className="underline" href={`tel:${order.customer_phone_snapshot}`}>{order.customer_phone_snapshot}</a></p>{order.customer_email_snapshot ? <p><a className="break-all underline" href={`mailto:${order.customer_email_snapshot}`}>{order.customer_email_snapshot}</a></p> : null}{address ? <div className="mt-4 border-t border-wayne-border pt-4"><strong>Delivery address</strong><p>{[address.address1, address.address2, [address.city, address.state, address.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ")}</p>{address.delivery_instructions ? <p className="mt-2 text-sm text-wayne-muted">{address.delivery_instructions}</p> : null}</div> : null}</Card>
          <Card className="p-6"><h2 className="text-xl font-black">Totals</h2><div className="mt-4 grid gap-2"><Total label="Subtotal" value={order.subtotal_cents} />{order.discount_cents ? <Total label="Discount" value={-order.discount_cents} /> : null}{order.delivery_fee_cents ? <Total label="Delivery fee" value={order.delivery_fee_cents} /> : null}<Total label="Tax" value={order.tax_cents} />{order.tip_cents ? <Total label="Tip" value={order.tip_cents} /> : null}<Total emphasis label="Total" value={order.total_cents} /></div>{order.discounts.map((discount) => <p className="mt-3 text-sm text-wayne-muted" key={discount.id}>{discount.code_snapshot}: −{formatCents(discount.amount_cents)}</p>)}</Card>
          <Card className="p-6"><h2 className="text-xl font-black">Operations</h2><Info label="Source" value={titleCase(order.source)} /><Info label="Payment" value={`${titleCase(order.payment_method)} · ${titleCase(order.payment_status)}`} /><Info label="Promised" value={formatAdminDateTime(order.promised_at, settings.timezone)} /><Info label="Accepted" value={formatAdminDateTime(order.accepted_at, settings.timezone)} /><Info label="Ready" value={formatAdminDateTime(order.ready_at, settings.timezone)} /><Info label="Completed" value={formatAdminDateTime(order.completed_at, settings.timezone)} /><p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm">Processor payment and refund records begin in a later approved phase. This order currently uses the Phase 2 payment boundary.</p></Card>
          {order.special_instructions ? <Card className="p-6"><h2 className="text-xl font-black">Order note</h2><p className="mt-3">{order.special_instructions}</p></Card> : null}
        </aside>
      </div>
    </main>
  );
}

function Total({ emphasis, label, value }: { emphasis?: boolean; label: string; value: number }) { return <div className={`flex justify-between ${emphasis ? "mt-2 border-t border-wayne-border pt-4 text-lg font-black" : ""}`}><span>{label}</span><span>{formatCents(value)}</span></div>; }
function Info({ label, value }: { label: string; value: string }) { return <div className="mt-4"><p className="text-xs font-black uppercase tracking-wide text-wayne-muted">{label}</p><p>{value}</p></div>; }
