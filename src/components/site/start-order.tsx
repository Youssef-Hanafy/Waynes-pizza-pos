import Link from "next/link";

/**
 * The whole point of the page. A visitor who came to buy pizza meets exactly one
 * question — picking up or delivered — and each answer is a single large target
 * that lands them in the ordering flow already set to that choice.
 *
 * When ordering is off it says so and gives the phone number, because a closed
 * shop that still takes phone orders should not look like a dead website.
 */
export function StartOrder({
  deliveryEnabled,
  orderingAvailable,
  phone,
  pickupEnabled,
}: {
  deliveryEnabled: boolean;
  orderingAvailable: boolean;
  phone: string;
  pickupEnabled: boolean;
}) {
  const choices = [
    { enabled: pickupEnabled, fulfillment: "pickup", label: "Pickup", note: "Ready at the counter" },
    { enabled: deliveryEnabled, fulfillment: "delivery", label: "Delivery", note: "Brought to your door" },
  ].filter((choice) => choice.enabled);

  return (
    <section className="relative overflow-hidden bg-wayne-green text-wayne-cream">
      <div
        aria-hidden
        className="absolute inset-0 opacity-80 [background-image:radial-gradient(circle_at_12%_-15%,rgba(217,154,33,0.3),transparent_42%),radial-gradient(circle_at_88%_115%,rgba(176,34,34,0.38),transparent_45%)]"
      />
      <div className="relative mx-auto max-w-5xl px-5 py-12 text-center sm:py-16">
        <h1 className="font-display text-4xl font-black uppercase leading-none tracking-tight sm:text-6xl">
          Start your order
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-wayne-cream/75">
          Greek &amp; Italian style pizza, made in Worcester for over fifty years.
        </p>

        {orderingAvailable && choices.length ? (
          <div className="mt-9 grid gap-4 sm:grid-cols-2">
            {choices.map((choice) => (
              <Link
                className="group flex min-h-28 flex-col items-center justify-center rounded-2xl bg-wayne-red px-6 py-6 shadow-raised transition hover:bg-wayne-red-dark focus-visible:bg-wayne-red-dark"
                href={`/menu?fulfillment=${choice.fulfillment}`}
                key={choice.fulfillment}
              >
                <span className="font-display text-3xl font-black uppercase tracking-tight sm:text-4xl">{choice.label}</span>
                <span className="mt-1 text-sm text-white/80">{choice.note}</span>
              </Link>
            ))}
          </div>
        ) : (
          <div className="mx-auto mt-9 max-w-xl rounded-2xl bg-wayne-cream/10 px-6 py-7 ring-1 ring-wayne-cream/20">
            <p className="font-display text-xl font-black">Online ordering is closed right now.</p>
            <p className="mt-2 text-wayne-cream/75">Browse the menu, or call and we&apos;ll take care of you.</p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              {phone ? (
                <a className="inline-flex min-h-12 items-center rounded-xl bg-wayne-red px-6 font-display text-lg font-black text-white transition hover:bg-wayne-red-dark" href={`tel:${phone}`}>
                  Call {phone}
                </a>
              ) : null}
              <Link className="inline-flex min-h-12 items-center rounded-xl bg-wayne-cream/15 px-6 font-bold transition hover:bg-wayne-cream/25" href="/menu">
                See the menu
              </Link>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
