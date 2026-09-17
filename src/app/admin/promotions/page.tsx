import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requirePermission } from "@/lib/auth/access";
import { getStoreSettings } from "@/lib/content/queries";
import { formatAdminDateTime } from "@/lib/orders/admin-format";
import { getPromotions } from "@/lib/promotions/queries";
import { describeDiscount, promotionState, type Promotion } from "@/lib/promotions/schemas";
import { utcToZonedLocal } from "@/lib/time/zoned";
import { archivePromotion, savePromotion } from "./actions";

export const metadata: Metadata = { title: "Promotions" };
export const dynamic = "force-dynamic";

export default async function PromotionsPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string; view?: string }> }) {
  await requirePermission("promotions.manage", "/admin/promotions");
  const [params, settings] = await Promise.all([searchParams, getStoreSettings()]);
  const showArchived = params.view === "archived";
  const { promotions, readAt } = await getPromotions(showArchived);
  const state = (promotion: Promotion) => promotionState(promotion, readAt);

  return <main className="mx-auto max-w-6xl px-5 py-10">
    <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">Marketing</p>
    <h1 className="mt-3 text-4xl font-black">Promotion codes</h1>
    <p className="mt-3 max-w-3xl text-wayne-muted">Codes work online and at the POS. Times use Wayne&apos;s {settings.timezone} clock. Per-customer limits are tracked by phone number, so a limited code needs a customer on POS tickets. Cancelling an order gives its use back.</p>
    {params.saved ? <p role="status" className="mt-5 rounded-xl bg-wayne-ok-soft p-4 font-bold text-wayne-ok">{params.saved}</p> : null}
    {params.error ? <p role="alert" className="mt-5 rounded-xl bg-wayne-alert-soft p-4 font-bold text-wayne-alert">{params.error}</p> : null}
    <Card className="mt-7 p-5"><h2 className="text-xl font-black">New promotion</h2><PromotionForm timeZone={settings.timezone} /></Card>
    <div className="mt-9 flex flex-wrap items-center justify-between gap-3"><h2 className="text-2xl font-black">{showArchived ? "Archived promotions" : "Current promotions"}</h2><Button asChild variant="secondary"><a href={showArchived ? "/admin/promotions" : "/admin/promotions?view=archived"}>{showArchived ? "Show current" : "Show archived"}</a></Button></div>
    <div className="mt-4 grid gap-4">{promotions.map((promotion) => <Card className="p-5" key={promotion.id}>
      <div className="flex flex-wrap items-start justify-between gap-3"><div><strong className="font-mono text-2xl">{promotion.code}</strong><p className="font-bold">{describeDiscount(promotion)}{promotion.minimum_order_cents ? ` on orders over $${(promotion.minimum_order_cents / 100).toFixed(2)}` : ""}{promotion.fulfillment_type ? ` · ${promotion.fulfillment_type} only` : ""}{promotion.members_only ? " · Rewards members only" : ""}</p>{promotion.description ? <p className="text-sm text-wayne-muted">{promotion.description}</p> : null}<p className="mt-1 text-sm text-wayne-muted">Used {promotion.uses_count}{promotion.total_usage_limit ? ` of ${promotion.total_usage_limit}` : ""} times{promotion.per_customer_limit ? ` · max ${promotion.per_customer_limit} per customer` : ""}{promotion.starts_at ? ` · starts ${formatAdminDateTime(promotion.starts_at, settings.timezone)}` : ""}{promotion.ends_at ? ` · ends ${formatAdminDateTime(promotion.ends_at, settings.timezone)}` : ""}</p></div><Badge className={state(promotion) === "Live" ? "bg-wayne-ok-soft text-wayne-ok" : "bg-wayne-cream-deep text-wayne-muted"}>{state(promotion)}</Badge></div>
      {!promotion.archived_at ? <details className="mt-4"><summary className="cursor-pointer font-bold">Edit</summary><PromotionForm promotion={promotion} timeZone={settings.timezone} /><form action={archivePromotion} className="mt-3"><input name="id" type="hidden" value={promotion.id} /><Button variant="danger">Archive code</Button></form></details> : null}
    </Card>)}{!promotions.length ? <Card className="p-8 text-center text-wayne-muted">{showArchived ? "No archived promotions." : "No promotions yet. Create one above."}</Card> : null}</div>
  </main>;
}

function PromotionForm({ promotion, timeZone }: { promotion?: Promotion; timeZone: string }) {
  const key = promotion?.id ?? "new";
  const amount = promotion ? promotion.discount_value / 100 : "";
  return <form action={savePromotion} className="mt-4 grid gap-4 md:grid-cols-3">
    {promotion ? <input name="id" type="hidden" value={promotion.id} /> : null}
    {promotion ? <input name="code" type="hidden" value={promotion.code} /> : <Input className="uppercase" id={`code-${key}`} label="Code" maxLength={40} name="code" pattern="[A-Za-z0-9_\-]{2,40}" required />}
    <label className="grid gap-2 text-sm font-semibold" htmlFor={`type-${key}`}>Discount type<select className="min-h-11 rounded-lg border border-wayne-border bg-white px-3 font-normal" defaultValue={promotion?.discount_type ?? "percent"} id={`type-${key}`} name="discount_type"><option value="percent">Percent off</option><option value="fixed">Dollars off</option></select></label>
    <Input defaultValue={amount} id={`amount-${key}`} label="Amount (% or $)" min="0.01" name="discount_amount" required step="0.01" type="number" />
    <div className="md:col-span-3"><Input defaultValue={promotion?.description ?? ""} id={`description-${key}`} label="Description (staff-facing)" maxLength={500} name="description" /></div>
    <Input defaultValue={promotion ? promotion.minimum_order_cents / 100 : 0} id={`minimum-${key}`} label="Minimum order ($)" min="0" name="minimum_order" step="0.01" type="number" />
    <label className="grid gap-2 text-sm font-semibold" htmlFor={`fulfillment-${key}`}>Applies to<select className="min-h-11 rounded-lg border border-wayne-border bg-white px-3 font-normal" defaultValue={promotion?.fulfillment_type ?? ""} id={`fulfillment-${key}`} name="fulfillment_type"><option value="">Pickup and delivery</option><option value="pickup">Pickup only</option><option value="delivery">Delivery only</option></select></label>
    <div className="grid gap-2 pt-7"><label className="flex items-center gap-2 text-sm font-semibold"><input defaultChecked={promotion?.active ?? true} name="active" type="checkbox" />Active</label><label className="flex items-center gap-2 text-sm font-semibold"><input defaultChecked={promotion?.members_only ?? false} name="members_only" type="checkbox" />Wayne&apos;s Rewards members only</label></div>
    <Input defaultValue={utcToZonedLocal(promotion?.starts_at ?? null, timeZone)} id={`starts-${key}`} label="Starts (optional)" name="starts_at" type="datetime-local" />
    <Input defaultValue={utcToZonedLocal(promotion?.ends_at ?? null, timeZone)} id={`ends-${key}`} label="Ends (optional)" name="ends_at" type="datetime-local" />
    <div />
    <Input defaultValue={promotion?.total_usage_limit ?? ""} id={`total-${key}`} label="Total uses allowed (blank = unlimited)" min="1" name="total_usage_limit" step="1" type="number" />
    <Input defaultValue={promotion?.per_customer_limit ?? ""} id={`per-${key}`} label="Uses per customer (blank = unlimited)" min="1" name="per_customer_limit" step="1" type="number" />
    <Button className="self-end">{promotion ? "Save changes" : "Create promotion"}</Button>
  </form>;
}
