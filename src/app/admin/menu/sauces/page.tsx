import Link from "next/link";
import { requirePermission } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { SharedSauce } from "@/lib/menu/shared-sauces";
import { saveSharedSaucePricesAction } from "../actions";
import { SaucePricesForm } from "./prices-form";
export const dynamic = "force-dynamic";
export default async function SaucePricesPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  await requirePermission("menu.manage", "/admin/menu/sauces");
  const query = await searchParams;
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_shared_sauce_catalog");
  if (error) throw new Error("Could not load shared sauce prices. Reload before editing.");
  return <main className="mx-auto max-w-4xl px-5 py-10">
    <Link href="/admin/menu" className="font-bold text-wayne-red">Back to Menu</Link>
    <h1 className="mt-4 text-3xl font-black">Sauce &amp; dressing prices</h1>
    <p className="mt-3 text-wayne-muted">Set each sauce’s extra-portion price once for every item, category and size, online and on the POS. Free portions and default choices stay on the item or category. Blank prices keep the current setup; save a price to make it shared everywhere.</p>
    {query.saved ? <p role="status" className="mt-4 rounded-xl bg-wayne-ok-soft p-4 font-bold text-wayne-ok">Shared prices saved across the menu. Included quantities are unchanged.</p> : null}
    {query.error ? <p role="alert" className="mt-4 rounded-xl bg-wayne-alert-soft p-4 font-bold text-wayne-alert">{query.error}</p> : null}
    <SaucePricesForm key={query.saved ?? "prices"} sauces={(data ?? []) as SharedSauce[]} action={saveSharedSaucePricesAction} />
  </main>;
}
