import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AutoRefresh } from "@/components/ops/auto-refresh";
import { requirePermission } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { getStoreSettings } from "@/lib/content/queries";
import { formatCents } from "@/lib/menu/schemas";
import { formatAdminDateTime, titleCase } from "@/lib/orders/admin-format";
import { getAdminOrderDetail } from "@/lib/orders/admin-queries";
import { isOpenOrderStatus, nextHandOff } from "@/lib/orders/status";
import { getOrderPayments } from "@/lib/payments/queries";
import { paymentStatusLabels, refundableCents, type OrderPayment } from "@/lib/payments/schemas";
import { changeOrderStatus, refundOrderPayment, voidOrderPayment } from "./actions";

export const metadata: Metadata = { title: "Order detail" };
export const dynamic = "force-dynamic";

const savedMessages: Record<string, string> = {
  completed: "Order marked complete.",
  out_for_delivery: "Order marked out for delivery.",
  cancelled: "Order cancelled. The reason is saved in the timeline and audit log.",
  refunded: "Refund sent. It is recorded on the order and in the audit log.",
  refund_duplicate: "That refund was already submitted.",
  voided: "Payment voided.",
};

export default async function AdminOrderDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  const [{ id }, notice] = await Promise.all([params, searchParams]);
  const access = await requirePermission("orders.view", `/admin/orders/${id}`);
  if (!z.uuid().safeParse(id).success) notFound();
  const [order, settings, payments] = await Promise.all([getAdminOrderDetail(id), getStoreSettings(), getOrderPayments(id)]);
  if (!order) notFound();
  const canManagePayments = hasPermission(access, "payments.manage");
  const address = order.delivery_address_snapshot as Record<string, string> | null;
  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      <Button asChild variant="secondary"><Link href="/admin/orders">← Order history</Link></Button>
      <div className="mt-6 flex flex-wrap items-end justify-between gap-5">
        <div><p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">Order detail</p><h1 className="mt-2 text-4xl font-black">{order.order_number}</h1><p className="mt-2 text-wayne-muted">Placed {formatAdminDateTime(order.placed_at, settings.timezone)}</p></div>
        <div className="flex flex-wrap items-center gap-2">{isOpenOrderStatus(order.status) ? <AutoRefresh intervalMs={20_000} live /> : null}<Badge>{titleCase(order.status)}</Badge><Badge className="bg-stone-700">{titleCase(order.fulfillment_type)}</Badge></div>
      </div>
      {notice.saved && savedMessages[notice.saved] ? <p role="status" className="mt-5 rounded-xl bg-green-50 p-4 font-bold text-green-800">{savedMessages[notice.saved]}</p> : null}
      {notice.error ? <p role="alert" className="mt-5 rounded-xl bg-red-50 p-4 font-bold text-red-800">{notice.error}</p> : null}
      {isOpenOrderStatus(order.status) ? <StatusActions canCancel={hasPermission(access, "orders.cancel")} canManage={hasPermission(access, "orders.manage")} fulfillment={order.fulfillment_type} orderId={order.id} status={order.status} /> : null}
      {order.status === "cancelled" ? <CancellationNotice events={order.events} /> : null}
      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="grid gap-6">
          <Card className="p-6"><h2 className="text-2xl font-black">Items</h2><div className="mt-4 divide-y divide-wayne-border">{order.items.map((item) => <div className="py-4" key={item.id}><div className="flex justify-between gap-4"><div><strong>{item.quantity}× {item.item_name_snapshot}</strong>{item.variant_name_snapshot ? <p className="text-sm text-wayne-muted">{item.variant_name_snapshot}</p> : null}</div><strong>{formatCents(item.line_total_cents)}</strong></div>{item.modifiers.length ? <ul className="mt-2 text-sm text-wayne-muted">{item.modifiers.map((modifier) => <li key={modifier.id}>{modifier.quantity > 1 ? `${modifier.quantity}× ` : ""}{modifier.modifier_name_snapshot} ({formatCents(modifier.price_delta_cents)})</li>)}</ul> : null}{item.special_instructions ? <p className="mt-2 text-sm"><strong>Item note:</strong> {item.special_instructions}</p> : null}</div>)}</div></Card>
          <Card className="p-6"><h2 className="text-2xl font-black">Timeline</h2><ol className="mt-5 grid gap-5 border-l-2 border-wayne-border pl-5">{order.events.length ? order.events.map((event) => <li key={event.id}><strong>{titleCase(event.event_type)}</strong>{event.from_status || event.to_status ? <p className="text-sm">{event.from_status ? titleCase(event.from_status) : "—"} → {event.to_status ? titleCase(event.to_status) : "—"}</p> : null}{typeof event.metadata.reason === "string" ? <p className="text-sm">Reason: {event.metadata.reason}</p> : null}<p className="text-sm text-wayne-muted">{formatAdminDateTime(event.created_at, settings.timezone)}{event.actor_name ? ` · ${event.actor_name}` : " · System"}</p></li>) : <li className="text-wayne-muted">No events have been recorded.</li>}</ol></Card>
        </div>
        <aside className="grid content-start gap-6">
          <Card className="p-6"><h2 className="text-xl font-black">Customer</h2><p className="mt-3 font-bold">{order.customer_name_snapshot}</p><p><a className="underline" href={`tel:${order.customer_phone_snapshot}`}>{order.customer_phone_snapshot}</a></p>{order.customer_email_snapshot ? <p><a className="break-all underline" href={`mailto:${order.customer_email_snapshot}`}>{order.customer_email_snapshot}</a></p> : null}{address ? <div className="mt-4 border-t border-wayne-border pt-4"><strong>Delivery address</strong><p>{[address.address1, address.address2, [address.city, address.state, address.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ")}</p>{address.delivery_instructions ? <p className="mt-2 text-sm text-wayne-muted">{address.delivery_instructions}</p> : null}</div> : null}</Card>
          <Card className="p-6"><h2 className="text-xl font-black">Totals</h2><div className="mt-4 grid gap-2"><Total label="Subtotal" value={order.subtotal_cents} />{order.discount_cents ? <Total label="Discount" value={-order.discount_cents} /> : null}{order.delivery_fee_cents ? <Total label="Delivery fee" value={order.delivery_fee_cents} /> : null}<Total label="Tax" value={order.tax_cents} />{order.tip_cents ? <Total label="Tip" value={order.tip_cents} /> : null}<Total emphasis label="Total" value={order.total_cents} /></div>{order.discounts.map((discount) => <p className="mt-3 text-sm text-wayne-muted" key={discount.id}>{discount.code_snapshot}: −{formatCents(discount.amount_cents)}</p>)}</Card>
          <Card className="p-6"><h2 className="text-xl font-black">Operations</h2><Info label="Source" value={titleCase(order.source)} /><Info label="Payment" value={`${titleCase(order.payment_method)} · ${titleCase(order.payment_status)}`} /><Info label="Promised" value={formatAdminDateTime(order.promised_at, settings.timezone)} /><Info label="Accepted" value={formatAdminDateTime(order.accepted_at, settings.timezone)} /><Info label="Ready" value={formatAdminDateTime(order.ready_at, settings.timezone)} /><Info label="Completed" value={formatAdminDateTime(order.completed_at, settings.timezone)} />{order.status === "cancelled" ? <Info label="Cancelled" value={formatAdminDateTime(order.cancelled_at, settings.timezone)} /> : null}</Card>
          <PaymentsCard canManage={canManagePayments} orderId={order.id} payments={payments} timeZone={settings.timezone} />
          {order.special_instructions ? <Card className="p-6"><h2 className="text-xl font-black">Order note</h2><p className="mt-3">{order.special_instructions}</p></Card> : null}
        </aside>
      </div>
    </main>
  );
}

function Total({ emphasis, label, value }: { emphasis?: boolean; label: string; value: number }) { return <div className={`flex justify-between ${emphasis ? "mt-2 border-t border-wayne-border pt-4 text-lg font-black" : ""}`}><span>{label}</span><span>{formatCents(value)}</span></div>; }
function Info({ label, value }: { label: string; value: string }) { return <div className="mt-4"><p className="text-xs font-black uppercase tracking-wide text-wayne-muted">{label}</p><p>{value}</p></div>; }

function StatusActions({ canCancel, canManage, fulfillment, orderId, status }: { canCancel: boolean; canManage: boolean; fulfillment: string; orderId: string; status: string }) {
  const handOff = nextHandOff(status, fulfillment);
  if (!canManage && !canCancel) return null;
  return <Card className="mt-6 p-5"><h2 className="text-xl font-black">Order actions</h2><p className="mt-1 text-sm text-wayne-muted">Changes are saved with your name and time. Completed and cancelled orders are sent to Hanafy automatically.</p>
    <div className="mt-4 grid gap-5 lg:grid-cols-2">
      {canManage ? <div className="flex flex-wrap items-start gap-3">
        {handOff ? <form action={changeOrderStatus}><Hidden orderId={orderId} status={status} next={handOff.status} /><Button>{handOff.label}</Button></form> : null}
        {status !== "ready" && status !== "out_for_delivery" ? <form action={changeOrderStatus}><Hidden orderId={orderId} status={status} next="completed" /><Button variant="secondary">Complete now (skip kitchen steps)</Button></form> : null}
        {status === "ready" && fulfillment === "delivery" ? <form action={changeOrderStatus}><Hidden orderId={orderId} status={status} next="completed" /><Button variant="secondary">Delivered / completed</Button></form> : null}
      </div> : <div />}
      {canCancel ? <form action={changeOrderStatus} className="grid gap-3 rounded-xl border border-red-200 bg-red-50/40 p-4"><Hidden orderId={orderId} status={status} next="cancelled" />
        <label className="grid gap-2 text-sm font-bold">Cancellation reason<input className="min-h-11 rounded-lg border border-wayne-border bg-white px-3 font-normal" maxLength={500} minLength={3} name="reason" required /></label>
        <label className="flex items-start gap-2 text-sm"><input className="mt-1" name="confirm" required type="checkbox" />I understand this cancels the order, removes it from sales, and cannot be undone. Any collected payment must be refunded separately.</label>
        <Button variant="danger">Cancel order</Button></form> : null}
    </div></Card>;
}

function Hidden({ orderId, status, next }: { orderId: string; status: string; next: string }) {
  return <><input name="order_id" type="hidden" value={orderId} /><input name="expected_status" type="hidden" value={status} /><input name="next_status" type="hidden" value={next} /></>;
}

function CancellationNotice({ events }: { events: Array<{ event_type: string; metadata: Record<string, unknown>; actor_name: string | null }> }) {
  const cancelled = [...events].reverse().find((event) => event.event_type === "order.cancelled");
  if (!cancelled) return null;
  return <p className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4"><strong>Cancelled{cancelled.actor_name ? ` by ${cancelled.actor_name}` : ""}.</strong> {typeof cancelled.metadata.reason === "string" ? `Reason: ${cancelled.metadata.reason}.` : ""}{cancelled.metadata.refund_required === true ? " A payment had been collected — issue the refund with the payment provider." : ""}</p>;
}

/** Processor payments on this order, with refund and void for whoever may issue them. */
function PaymentsCard({ canManage, orderId, payments, timeZone }: { canManage: boolean; orderId: string; payments: OrderPayment[]; timeZone: string }) {
  return (
    <Card className="p-6">
      <h2 className="text-xl font-black">Card payments</h2>
      {payments.length ? (
        <div className="mt-4 grid gap-5">
          {payments.map((payment) => {
            const refundable = refundableCents(payment);
            return (
              <div className="border-t border-wayne-border pt-4 first:border-0 first:pt-0" key={payment.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <strong>{formatCents(payment.amount_cents)}</strong>
                  <Badge className={payment.status === "captured" ? "bg-green-100 text-green-900" : payment.status === "failed" ? "bg-red-100 text-red-900" : ""}>
                    {paymentStatusLabels[payment.status] ?? payment.status}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-wayne-muted">
                  {titleCase(payment.provider)}
                  {payment.card_brand ? ` · ${payment.card_brand}` : ""}
                  {payment.card_last4 ? ` ····${payment.card_last4}` : ""}
                  {` · ${formatAdminDateTime(payment.created_at, timeZone)}`}
                </p>
                {payment.refunded_cents ? <p className="mt-1 text-sm font-bold">Refunded {formatCents(payment.refunded_cents)}</p> : null}
                {payment.failure_reason ? <p className="mt-1 text-sm text-red-800">{payment.failure_reason}</p> : null}
                {payment.receipt_url ? <p className="mt-1 text-sm"><a className="underline" href={payment.receipt_url} rel="noreferrer" target="_blank">Processor receipt ↗</a></p> : null}

                {canManage && refundable > 0 ? (
                  <form action={refundOrderPayment} className="mt-4 grid gap-3 rounded-xl border border-wayne-border bg-stone-50 p-4">
                    <input name="order_id" type="hidden" value={orderId} />
                    <input name="payment_id" type="hidden" value={payment.id} />
                    <input name="idempotency_key" type="hidden" value={`refund-${payment.id}-${payment.refunded_cents}-${refundable}`} />
                    <p className="text-sm font-bold">Refund up to {formatCents(refundable)}</p>
                    <Input defaultValue={(refundable / 100).toFixed(2)} id={`refund-amount-${payment.id}`} inputMode="decimal" label="Amount" name="amount" required />
                    <Input id={`refund-reason-${payment.id}`} label="Reason" maxLength={1000} name="reason" placeholder="Order was wrong" required />
                    <Button type="submit" variant="danger">Refund</Button>
                  </form>
                ) : null}

                {canManage && payment.status === "authorized" && payment.provider_payment_id ? (
                  <form action={voidOrderPayment} className="mt-3">
                    <input name="order_id" type="hidden" value={orderId} />
                    <input name="payment_id" type="hidden" value={payment.id} />
                    <input name="provider_payment_id" type="hidden" value={payment.provider_payment_id} />
                    <Button type="submit" variant="secondary">Void this authorization</Button>
                  </form>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="mt-3 text-sm text-wayne-muted">No card payment has been taken on this order.</p>
      )}
    </Card>
  );
}
