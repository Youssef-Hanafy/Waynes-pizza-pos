import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requirePermission } from "@/lib/auth/access";
import { getWorkspaceStoreSettings } from "@/lib/content/queries";
import { saveTips } from "./actions";

export const metadata: Metadata = { title: "Tips" };
export const dynamic = "force-dynamic";

const dollars = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));

/**
 * Tips (owner, 2026-10-12): the % and $ buttons the customer sees on the
 * customer screen at the counter and at online checkout.
 */
export default async function TipsPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  await requirePermission("content.manage", "/admin/tips");
  const [settings, params] = await Promise.all([getWorkspaceStoreSettings(), searchParams]);
  const percents = settings.suggested_tip_percentages;
  const amounts = settings.suggested_tip_amounts_cents;

  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">Setup</p>
      <h1 className="mt-3 text-4xl font-black">Tips</h1>
      <p className="mt-3 text-wayne-muted">The tip buttons customers tap on the customer screen at the counter (before the card reader) and at online checkout.</p>
      {params.saved ? <p className="mt-5 rounded-xl bg-wayne-ok-soft p-3 font-bold text-wayne-ok">Saved. The customer screen uses the new buttons on the next order.</p> : null}
      {params.error ? <p className="mt-5 rounded-xl bg-wayne-alert-soft p-3 font-bold text-wayne-alert" role="alert">{params.error}</p> : null}

      <form action={saveTips} className="mt-8 grid gap-6">
        <Card className="grid gap-5 p-6">
          <Input defaultValue={amounts.map(dollars).join(", ")} hint="Whole dollars, separated by commas — up to 6. Leave blank for no dollar buttons." label="Dollar tip buttons ($)" name="dollars" placeholder="1, 2, 3, 4, 5" />
          <Input defaultValue={percents.join(", ")} hint="Separated by commas — up to 4." label="Percentage tip buttons (%)" name="percentages" placeholder="15, 18, 20, 25" />
          <label className="flex min-h-11 items-center gap-3 font-bold">
            <input className="h-5 w-5 accent-wayne-red" defaultChecked={settings.tips_enabled} name="tips_enabled" type="checkbox" />
            Ask for a tip at online checkout
          </label>
        </Card>

        <Card className="p-6">
          <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-muted">What the customer sees</p>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {percents.slice(0, 4).map((percent) => <div className="grid min-h-16 place-items-center rounded-2xl bg-wayne-green text-2xl font-black text-white" key={percent}>{percent}%</div>)}
          </div>
          {amounts.length ? <div className="mt-3 grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(amounts.length, 6)}, minmax(0, 1fr))` }}>
            {amounts.map((cents) => <div className="grid min-h-14 place-items-center rounded-2xl border-2 border-wayne-green text-xl font-black text-wayne-green" key={cents}>${dollars(cents)}</div>)}
          </div> : null}
          <div className="mt-3 grid grid-cols-2 gap-3 text-center font-black text-wayne-muted">
            <div className="rounded-2xl border-2 border-wayne-border p-3">Custom amount</div>
            <div className="rounded-2xl border-2 border-wayne-border p-3">No tip</div>
          </div>
          <p className="mt-3 text-xs text-wayne-muted">Preview of the saved buttons — save to update it.</p>
        </Card>

        <div><Button size="lg" type="submit">Save tips</Button></div>
      </form>
    </main>
  );
}
