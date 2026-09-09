import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { Button } from "@/components/ui/button";
import { getStoreSettings } from "@/lib/content/queries";
import { formatCents } from "@/lib/menu/schemas";
import { getPublicOrderStatus } from "@/lib/orders/queries";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Order confirmation",
  robots: { index: false, follow: false },
};

export default async function OrderStatusPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const [{ id }, query, settings] = await Promise.all([
    params,
    searchParams,
    getStoreSettings(),
  ]);
  if (
    !z.uuid().safeParse(id).success ||
    !z.uuid().safeParse(query.token).success
  )
    notFound();
  const order = await getPublicOrderStatus(id, query.token!);
  if (!order) notFound();
  const address = order.delivery_address as Record<string, string> | null;
  return (
    <div className="min-h-screen">
      <SiteHeader settings={settings} />
      <main className="mx-auto max-w-3xl px-5 py-12">
        <div className="rounded-3xl border border-wayne-border bg-white p-6 shadow-sm sm:p-9">
          <p className="text-sm font-black uppercase tracking-[0.2em] text-green-700">
            Order saved
          </p>
          <h1 className="mt-3 text-4xl font-black">
            Thank you, {order.customer_name.split(" ")[0]}!
          </h1>
          <p className="mt-3 text-lg">
            Order <strong>{order.order_number}</strong> is placed for{" "}
            <strong className="capitalize">{order.fulfillment_type}</strong>.
          </p>
          <div className="mt-5 rounded-2xl border border-amber-300 bg-amber-50 p-5">
            <strong>TEST / MANUAL payment</strong>
            <p className="mt-1 text-sm">
              No card payment was collected. Payment status:{" "}
              {order.payment_status}.
            </p>
          </div>
          <div className="mt-7 grid gap-4 sm:grid-cols-2">
            <Info label="Status" value={order.status.replaceAll("_", " ")} />
            <Info
              label="Estimated time"
              value={
                order.promised_at
                  ? new Intl.DateTimeFormat("en-US", {
                      timeZone: settings.timezone,
                      hour: "numeric",
                      minute: "2-digit",
                    }).format(new Date(order.promised_at))
                  : "To be confirmed"
              }
            />
          </div>
          {address ? (
            <div className="mt-6 rounded-xl bg-wayne-cream p-4">
              <strong>Delivery to</strong>
              <p>
                {[
                  address.address1,
                  address.address2,
                  `${address.city}, ${address.state} ${address.postal_code}`,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </p>
              {address.delivery_instructions ? (
                <p className="mt-1 text-sm text-wayne-muted">
                  {address.delivery_instructions}
                </p>
              ) : null}
            </div>
          ) : null}
          <h2 className="mt-8 text-2xl font-black">Order details</h2>
          <div className="mt-4 divide-y divide-wayne-border">
            {order.items.map((item) => (
              <div className="py-4" key={item.id}>
                <div className="flex justify-between gap-4">
                  <div>
                    <strong>
                      {item.quantity}× {item.name}
                    </strong>
                    {item.variant_name ? (
                      <p className="text-sm text-wayne-muted">
                        {item.variant_name}
                      </p>
                    ) : null}
                  </div>
                  <strong>{formatCents(item.line_total_cents)}</strong>
                </div>
                {item.modifiers.length ? (
                  <p className="mt-2 text-sm text-wayne-muted">
                    {item.modifiers
                      .map(
                        (modifier) =>
                          `${modifier.quantity > 1 ? `${modifier.quantity}× ` : ""}${modifier.name}`,
                      )
                      .join(", ")}
                  </p>
                ) : null}
                {item.special_instructions ? (
                  <p className="mt-2 text-sm">
                    Note: {item.special_instructions}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
          <div className="mt-5 grid gap-2">
            <Total label="Subtotal" value={order.subtotal_cents} />
            {order.discount_cents ? (
              <Total label="Discount" value={-order.discount_cents} />
            ) : null}
            {order.delivery_fee_cents ? (
              <Total label="Delivery fee" value={order.delivery_fee_cents} />
            ) : null}
            <Total label="Tax" value={order.tax_cents} />
            {order.tip_cents ? (
              <Total label="Tip" value={order.tip_cents} />
            ) : null}
            <Total emphasis label="Total" value={order.total_cents} />
          </div>
          {order.special_instructions ? (
            <p className="mt-6 rounded-xl bg-wayne-cream p-4">
              <strong>Order note:</strong> {order.special_instructions}
            </p>
          ) : null}
          <p className="mt-7 text-sm text-wayne-muted">
            Save this private page to check the order after refreshing. For
            help, call {settings.public_phone}.
          </p>
          <Button asChild className="mt-5">
            <Link href="/">Return home</Link>
          </Button>
        </div>
      </main>
      <SiteFooter settings={settings} />
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-wayne-cream p-4">
      <p className="text-xs font-black uppercase tracking-wider text-wayne-muted">
        {label}
      </p>
      <p className="mt-1 font-black capitalize">{value}</p>
    </div>
  );
}
function Total({
  emphasis = false,
  label,
  value,
}: {
  emphasis?: boolean;
  label: string;
  value: number;
}) {
  return (
    <div
      className={`flex justify-between ${emphasis ? "mt-2 border-t pt-4 text-xl font-black" : ""}`}
    >
      <span>{label}</span>
      <span>{formatCents(value)}</span>
    </div>
  );
}
