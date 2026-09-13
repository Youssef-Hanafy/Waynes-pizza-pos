import Link from "next/link";
import { dealCondition, dealHeadline, type PublicPromotion } from "@/lib/promotions/public";

/**
 * A deal has to answer three things in the half-second someone looks at it: how
 * much do I save, what do I have to do, and what do I type. Everything else is
 * decoration, so the saving is the biggest thing on the card and the code is a
 * field you can read out loud.
 */
export function DealCard({ promotion }: { promotion: PublicPromotion }) {
  const condition = dealCondition(promotion);
  return (
    <article className="flex h-full flex-col rounded-2xl border-2 border-dashed border-wayne-red/30 bg-wayne-red-soft p-6 transition hover:border-wayne-red/60">
      <p className="font-display text-4xl font-black leading-none tracking-tight text-wayne-red">
        {dealHeadline(promotion)}
      </p>
      <p className="mt-3 flex-1 font-semibold leading-6 text-wayne-ink">{promotion.description}</p>
      {condition ? <p className="mt-2 text-sm text-wayne-muted">{condition}</p> : null}
      <div className="mt-5 flex items-center justify-between gap-3 border-t border-wayne-red/20 pt-4">
        <span className="rounded-lg bg-wayne-surface px-3 py-2 font-mono text-sm font-bold tracking-widest text-wayne-ink ring-1 ring-wayne-red/20">
          {promotion.code}
        </span>
        <Link className="font-bold text-wayne-red underline-offset-4 hover:underline" href="/menu">
          Use this deal →
        </Link>
      </div>
    </article>
  );
}
