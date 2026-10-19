import Link from "next/link";
import { MenuImage } from "@/components/site/menu-image";
import { formatCents } from "@/lib/menu/schemas";
import type { PublicSpecial } from "@/lib/menu/specials";

/**
 * A special on the Offers page: the real photo from Admin → Menu (never a
 * stock or generated one), the price, and one tap to order it.
 */
export function SpecialCard({ special }: { special: PublicSpecial }) {
  const ends = special.ends_on ? new Date(`${special.ends_on}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : null;
  return (
    <article className="flex h-full flex-col overflow-hidden rounded-2xl border-2 border-wayne-gold/60 bg-white">
      <MenuImage alt={special.image_alt || special.name} name={special.name} path={special.image_path} sizes="(max-width: 640px) 90vw, 30vw" />
      <div className="flex flex-1 flex-col p-5">
        <p className="text-xs font-black uppercase tracking-[0.18em] text-wayne-red">⭐ Special{ends ? ` · through ${ends}` : ""}</p>
        <h3 className="mt-1 font-display text-2xl font-black leading-tight text-wayne-ink">{special.name}</h3>
        {special.note ? <p className="mt-1 font-bold text-wayne-red">{special.note}</p> : null}
        {special.description ? <p className="mt-2 flex-1 text-sm leading-6 text-wayne-muted">{special.description}</p> : <span className="flex-1" />}
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-wayne-border pt-4">
          <span className="text-2xl font-black text-wayne-ink">{special.size_count > 1 ? "From " : ""}{formatCents(special.price_cents)}</span>
          <Link className="rounded-xl bg-wayne-red px-4 py-2 font-black text-white hover:opacity-90" href={`/menu?item=${special.id}`}>Order now</Link>
        </div>
      </div>
    </article>
  );
}
