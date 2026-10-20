import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { requirePermission } from "@/lib/auth/access";
import { getWorkspaceStoreSettings } from "@/lib/content/queries";
import { getCustomer } from "@/lib/customers/queries";
import { getCustomerPaymentRecords, type CustomerPaymentRecord } from "@/lib/customers/payment-records";
import { formatCents } from "@/lib/menu/schemas";
import { formatAdminDateTime, titleCase } from "@/lib/orders/admin-format";
import { eraseCustomerAction } from "../actions";
export const dynamic = "force-dynamic";
export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) { await requirePermission("customers.view", "/admin/customers"); const { id } = await params; const [customer, settings, records] = await Promise.all([getCustomer(id), getWorkspaceStoreSettings(), getCustomerPaymentRecords(id).catch(() => null)]); if (!customer) notFound(); return <main className="mx-auto max-w-6xl px-5 py-10"><Button asChild variant="secondary"><Link href="/admin/customers">← Customers</Link></Button><p className="mt-7 text-sm font-black uppercase tracking-[0.2em] text-wayne-red">Customer profile</p><h1 className="mt-3 text-4xl font-black">{customer.first_name} {customer.last_name}</h1><p className="mt-2 text-wayne-muted">{customer.phone_normalized}{customer.email_normalized ? ` · ${customer.email_normalized}` : ""}</p><p className="mt-2 text-xs text-wayne-muted">ID: {customer.id}</p><div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Metric label="Orders" value={String(customer.order_count)} /><Metric label="Lifetime spend" value={formatCents(customer.lifetime_spend_cents)} /><Metric label="Average order" value={formatCents(customer.average_order_value_cents)} /><Metric label="Last order" value={formatAdminDateTime(customer.last_order_at, settings.timezone)} /></div><div className="mt-6 grid gap-5 lg:grid-cols-2"><Card className="p-5"><h2 className="text-xl font-black">Current segments</h2><div className="mt-4 flex flex-wrap gap-2">{customer.segments.filter((segment) => segment.active).length ? customer.segments.filter((segment) => segment.active).map((segment) => <Badge key={segment.membership_id}>{segment.name}</Badge>) : <p className="text-wayne-muted">No active segments.</p>}</div><h3 className="mt-6 font-black">Membership history</h3><div className="mt-3 grid gap-2 text-sm">{customer.segments.map((segment) => <p key={segment.membership_id}><strong>{segment.name}</strong> · entered {formatAdminDateTime(segment.entered_at, settings.timezone)}{segment.exited_at ? ` · exited ${formatAdminDateTime(segment.exited_at, settings.timezone)}` : ""}</p>)}</div></Card><Card className="p-5"><h2 className="text-xl font-black">Consent & addresses</h2><p className="mt-3 text-sm">SMS: <strong>{customer.sms_marketing_opt_in ? "Opted in" : "Not opted in"}</strong> · Email: <strong>{customer.email_marketing_opt_in ? "Opted in" : "Not opted in"}</strong></p><div className="mt-4 grid gap-2 text-sm">{customer.addresses.map((address) => <p key={address.id}>{address.is_default ? <strong>Default: </strong> : null}{address.address1}{address.address2 ? `, ${address.address2}` : ""}, {address.city}, {address.state} {address.postal_code}</p>)}</div><h3 className="mt-6 font-black">Consent history</h3><div className="mt-3 grid gap-2 text-sm">{customer.consents.map((consent) => <p key={consent.id}>{titleCase(consent.channel)} {titleCase(consent.status)} · {formatAdminDateTime(consent.occurred_at, settings.timezone)} · {consent.source}</p>)}</div></Card></div><Card className="mt-8 border-wayne-alert/40 p-5"><h2 className="text-xl font-black">Remove this customer</h2><p className="mt-2 max-w-3xl text-sm text-wayne-muted">Erases their name, phone, email, addresses and rewards from this business, and deletes their contact in the Hanafy CRM so they stop receiving texts. Their orders stay so your reports and tax records do not change, with their details scrubbed out of them. This cannot be undone.</p><form action={eraseCustomerAction.bind(null, customer.id)} className="mt-4"><Button type="submit" variant="danger">Erase customer data</Button></form></Card><h2 className="mt-8 text-2xl font-black">Order history</h2><div className="mt-4 grid gap-3">{customer.orders.map((order) => <Link href={`/admin/orders/${order.id}`} key={order.id}><Card className="flex flex-wrap items-center justify-between gap-3 p-4"><span><strong>{order.order_number}</strong> · {formatAdminDateTime(order.placed_at, settings.timezone)}</span><span>{titleCase(order.source)} · {titleCase(order.fulfillment_type)} · {titleCase(order.status)}</span><strong>{formatCents(order.total_cents)}</strong></Card></Link>)}</div><PaymentRecords records={records} timeZone={settings.timezone} /></main>; }
function Metric({ label, value }: { label: string; value: string }) { return <Card className="p-5"><p className="text-sm font-bold text-wayne-muted">{label}</p><p className="mt-1 text-xl font-black">{value}</p></Card>; }

/**
 * Payment records & signatures (owner, 2026-10-19): for every past order, how
 * it was paid — card brand and last 4, how the card was taken, the processor's
 * payment ID, the approval, cash handed over — and the signature taken on the
 * customer screen, so a dispute can be answered from here.
 */
function PaymentRecords({ records, timeZone }: { records: CustomerPaymentRecord[] | null; timeZone: string }) {
  return <section className="mt-10">
    <h2 className="text-2xl font-black">Payment records &amp; signatures</h2>
    <p className="mt-1 text-sm text-wayne-muted">Every order&apos;s payment details and signature, newest first — for a customer who disputes a charge.</p>
    {records === null ? <p className="mt-4 rounded-xl bg-wayne-warn-soft p-4 font-bold">Payment records could not be loaded. Refresh the page.</p>
      : !records.length ? <p className="mt-4 rounded-xl border border-dashed border-wayne-border p-5 text-wayne-muted">No orders yet.</p>
      : <div className="mt-4 grid gap-3">{records.map((order) => <PaymentRecordCard key={order.id} order={order} timeZone={timeZone} />)}</div>}
  </section>;
}

const entryLabels: Record<string, string> = { terminal: "Card reader (tap / insert / swipe)", card_reader: "Card reader", pos_keyed_card: "Card keyed in (phone)", test_keyed: "Keyed in (test)", counter: "At the counter", pos_cashout: "Driver cash-out" };
const providerLabels: Record<string, string> = { stripe: "Stripe", stripe_terminal: "Stripe reader", cash: "Cash", cash_on_delivery: "Cash on delivery", manual_card: "Card reader (separate terminal)", test: "Test" };

function PaymentRecordCard({ order, timeZone }: { order: CustomerPaymentRecord; timeZone: string }) {
  const card = order.payments.find((payment) => payment.card_last4);
  const signed = order.signatures.length > 0;
  return <details className="rounded-2xl border border-wayne-border bg-white">
    <summary className="flex min-h-14 cursor-pointer flex-wrap items-center justify-between gap-3 px-4 py-3">
      <span><strong>{order.order_number}</strong>{order.daily_number ? ` (#${order.daily_number})` : ""} · {formatAdminDateTime(order.placed_at, timeZone)}{order.is_test ? " · TEST" : ""}</span>
      <span className="text-sm">{titleCase(order.fulfillment_type)} · {titleCase(order.payment_status || order.status)}{card ? ` · ${card.card_brand ? titleCase(card.card_brand) : "Card"} ····${card.card_last4}` : order.payment_method ? ` · ${titleCase(order.payment_method)}` : ""}{signed ? " · ✍ Signed" : ""}</span>
      <strong>{formatCents(order.total_cents)}</strong>
    </summary>
    <div className="grid gap-4 border-t border-wayne-border p-4 lg:grid-cols-[16rem_1fr]">
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        <dt>Subtotal</dt><dd className="text-right">{formatCents(order.subtotal_cents)}</dd>
        {order.discount_cents ? <><dt>Discount</dt><dd className="text-right">−{formatCents(order.discount_cents)}</dd></> : null}
        {order.delivery_fee_cents ? <><dt>Delivery fee</dt><dd className="text-right">{formatCents(order.delivery_fee_cents)}</dd></> : null}
        <dt>Tax</dt><dd className="text-right">{formatCents(order.tax_cents)}</dd>
        <dt>Tip</dt><dd className="text-right">{formatCents(order.tip_cents)}</dd>
        <dt className="font-black">Total</dt><dd className="text-right font-black">{formatCents(order.total_cents)}</dd>
        <dt className="col-span-2 mt-2"><Link className="font-bold text-wayne-red underline" href={`/admin/orders/${order.id}`}>Open the order →</Link></dt>
      </dl>
      <div className="grid gap-3">
        {order.payments.length ? <div className="overflow-x-auto"><table className="w-full min-w-[40rem] text-left text-sm">
          <thead><tr className="border-b border-wayne-border text-xs uppercase tracking-wider text-wayne-muted"><th className="py-1 pr-2">Payment</th><th className="pr-2">How</th><th className="pr-2 text-right">Amount</th><th className="pr-2">Status</th><th className="pr-2">When</th><th>Reference</th></tr></thead>
          <tbody>{order.payments.map((payment) => <tr className="border-b border-wayne-border align-top last:border-0" key={payment.id}>
            <td className="py-1.5 pr-2 font-bold">{payment.method === "card" ? `${payment.card_brand ? titleCase(payment.card_brand) : "Card"}${payment.card_last4 ? ` ····${payment.card_last4}` : ""}` : titleCase(payment.method || "payment")}{payment.method === "cash" && payment.tendered_cents ? <span className="block text-xs font-normal text-wayne-muted">Handed {formatCents(payment.tendered_cents)} · change {formatCents(payment.change_cents ?? 0)}</span> : null}</td>
            <td className="pr-2">{entryLabels[payment.entry] ?? (payment.provider === "stripe" && order.source === "online" ? "Online checkout" : providerLabels[payment.provider] ?? (payment.provider ? titleCase(payment.provider) : ""))}{payment.taken_by ? <span className="block text-xs text-wayne-muted">by {payment.taken_by}</span> : null}</td>
            <td className="pr-2 text-right font-bold">{formatCents(payment.amount_cents)}{payment.tip_cents ? <span className="block text-xs font-normal text-wayne-muted">incl. tip {formatCents(payment.tip_cents)}</span> : null}</td>
            <td className="pr-2">{titleCase(payment.status || "")}{payment.failure_reason ? <span className="block text-xs text-wayne-alert">{payment.failure_reason}</span> : null}</td>
            <td className="pr-2 text-xs">{payment.captured_at ? `Charged ${formatAdminDateTime(payment.captured_at, timeZone)}` : payment.authorized_at ? `Approved ${formatAdminDateTime(payment.authorized_at, timeZone)}` : payment.failed_at ? `Failed ${formatAdminDateTime(payment.failed_at, timeZone)}` : formatAdminDateTime(payment.created_at, timeZone)}</td>
            <td className="break-all text-xs">{payment.provider_payment_id}{payment.approval_code ? <span className="block">Approval {payment.approval_code}</span> : null}{payment.receipt_url ? <a className="block font-bold text-wayne-red underline" href={payment.receipt_url} rel="noreferrer" target="_blank">Processor receipt</a> : null}</td>
          </tr>)}</tbody>
        </table></div> : <p className="text-sm text-wayne-muted">No payment recorded on this order.</p>}
        {order.refunds.length ? <p className="text-sm">{order.refunds.map((refund, index) => <span className="block" key={index}>Refund {formatCents(refund.amount_cents)} · {titleCase(refund.status)} · {formatAdminDateTime(refund.created_at, timeZone)}{refund.reason ? ` · ${refund.reason}` : ""}</span>)}</p> : null}
        {order.signatures.length ? <div className="flex flex-wrap gap-3">{order.signatures.map((signature) => <figure className="rounded-xl border border-wayne-border bg-white p-2" key={signature.id}>
          {/* Shown as an image so nothing in the drawing can run on this page. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="Customer signature" className="h-28 w-72 object-contain" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(signature.signature_svg)}`} />
          <figcaption className="mt-1 text-xs text-wayne-muted">Signed {formatAdminDateTime(signature.signed_at, timeZone)}{signature.tip_cents ? ` · tip ${formatCents(signature.tip_cents)}` : ""}</figcaption>
        </figure>)}</div> : <p className="text-xs text-wayne-muted">No signature on the customer screen for this order{order.fulfillment_type === "delivery" ? " (delivery slips are signed on paper)" : ""}.</p>}
      </div>
    </div>
  </details>;
}
