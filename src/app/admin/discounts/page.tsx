import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { requirePermission } from "@/lib/auth/access";
import { adminPosDiscountSchema, discountLabel, type AdminPosDiscount } from "@/lib/pos/discounts";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { removePosDiscount, savePosDiscount } from "./actions";

export const metadata: Metadata = { title: "POS discounts" };
export const dynamic = "force-dynamic";

/**
 * POS discounts (owner, 2026-10-19): "in admin you can add discounts that will
 * appear there" — the buttons in the POS Discount box.  Any cashier can use a
 * saved one; typing your own $ / % off on the POS still needs a manager.
 * (Codes customers type in at checkout live in Promotions.)
 */
export default async function DiscountsPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  await requirePermission("pos.discount.manage", "/admin/discounts");
  const supabase = await createServerSupabaseClient();
  const [{ data, error }, params] = await Promise.all([supabase.rpc("wayne_admin_pos_discounts"), searchParams]);
  const parsed = adminPosDiscountSchema.array().safeParse(data);
  const discounts = parsed.success ? parsed.data : [];

  return (
    <main className="mx-auto max-w-5xl px-5 py-10">
      <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">Point of sale</p>
      <h1 className="mt-3 text-4xl font-black">Discounts</h1>
      <p className="mt-3 max-w-3xl text-wayne-muted">
        These are the buttons in the POS <strong>Discount</strong> box (next to Open item). Anyone on the register can use them; the amount is set here,
        so nobody types it. Dollars off or percent off come off the food total before tax. Codes customers type in online are in Promotions.
      </p>
      {params.saved ? <p className="mt-5 rounded-xl border border-wayne-ok/30 bg-wayne-ok-soft p-4 font-semibold text-wayne-ok">{params.saved}</p> : null}
      {params.error ? <p className="mt-5 rounded-xl border border-wayne-alert/30 bg-wayne-alert-soft p-4 font-semibold text-wayne-alert">{params.error}</p> : null}
      {error || !parsed.success ? <p className="mt-5 rounded-xl border border-wayne-alert/30 bg-wayne-alert-soft p-4 font-semibold text-wayne-alert">The saved discounts could not be loaded. Refresh to try again.</p> : null}

      <Card className="mt-8 p-6">
        <h2 className="text-2xl font-black">Add a discount</h2>
        <DiscountForm />
      </Card>

      <h2 className="mt-10 text-2xl font-black">On the POS ({discounts.filter((discount) => discount.active).length})</h2>
      {discounts.length ? (
        <div className="mt-4 grid gap-4">
          {discounts.map((discount) => (
            <Card className={`p-5 ${discount.active ? "" : "opacity-70"}`} key={discount.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-xl font-black">{discount.name} <span className="text-wayne-red">{discountLabel(discount)}</span></h3>
                  <p className="text-sm font-bold text-wayne-muted">{discount.active ? "On the POS" : "Switched off — not on the POS"} · used on {discount.times_used} order{discount.times_used === 1 ? "" : "s"}</p>
                </div>
                <form action={removePosDiscount}><input name="id" type="hidden" value={discount.id} /><Button type="submit" variant="danger">Remove</Button></form>
              </div>
              <details className="mt-3">
                <summary className="min-h-11 cursor-pointer content-center font-bold">Edit</summary>
                <DiscountForm discount={discount} />
              </details>
            </Card>
          ))}
        </div>
      ) : <p className="mt-4 rounded-2xl border-2 border-dashed border-wayne-border p-6 text-wayne-muted">No discounts yet. Add your usual ones above — for example “Employee meal 50%”, “Police / Fire 10%”, or “$5 off — sorry!”.</p>}
    </main>
  );
}

function DiscountForm({ discount }: { discount?: AdminPosDiscount }) {
  const amount = discount ? String(Number((discount.discount_value / 100).toFixed(2))) : "";
  return (
    <form action={savePosDiscount} className="mt-4 grid gap-4 md:grid-cols-[1fr_10rem_9rem_7rem] md:items-end">
      {discount ? <input name="id" type="hidden" value={discount.id} /> : null}
      <label className="grid gap-1.5 text-sm font-semibold">Name (on the button and the receipt)
        <input className="min-h-11 rounded-lg border border-wayne-border px-3 font-normal" defaultValue={discount?.name ?? ""} maxLength={60} name="name" placeholder="e.g. Employee meal" required />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">Type
        <select className="min-h-11 rounded-lg border border-wayne-border bg-white px-3 font-normal" defaultValue={discount?.discount_type ?? "percent"} name="discount_type">
          <option value="percent">% off</option>
          <option value="fixed">$ off</option>
        </select>
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">Amount
        <input className="min-h-11 rounded-lg border border-wayne-border px-3 font-normal" defaultValue={amount} inputMode="decimal" name="amount" placeholder="10" required />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">Order
        <input className="min-h-11 rounded-lg border border-wayne-border px-3 font-normal" defaultValue={discount?.sort_order ?? 0} name="sort_order" type="number" />
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm font-semibold md:col-span-2"><input className="size-5 accent-wayne-red" defaultChecked={discount?.active ?? true} name="active" type="checkbox" />On the POS</label>
      <div className="md:col-span-2 md:text-right"><Button type="submit">{discount ? "Save" : "Add discount"}</Button></div>
    </form>
  );
}
