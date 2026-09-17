"use client";

import Link from "next/link";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCents, type PublicMenu } from "@/lib/menu/schemas";
import {
  CART_STORAGE_KEY,
  cartLineUnitCents,
  cartSubtotalCents,
  findMenuItem,
  readCart,
} from "@/lib/orders/cart";
import { orderCreatedSchema, type CartLine } from "@/lib/orders/schemas";
import {
  cardCheckoutResultSchema,
  type CheckoutPaymentConfig,
} from "@/lib/payments/schemas";
import {
  SquareCardField,
  type Tokenizer,
} from "@/components/payments/square-card-field";
import { GoogleAddressInput } from "@/components/checkout/google-address-input";
import {
  ORDER_DETAILS_STORAGE_KEY,
  readOrderDetails,
  residenceLabels,
  type OrderDetails,
} from "@/lib/orders/order-details";

type Fulfillment = "pickup" | "delivery";
type Props = {
  fulfillment: Fulfillment;
  menu: PublicMenu;
  /** Present only when the owner has switched real card payment on. */
  paymentConfig: CheckoutPaymentConfig | null;
  settings: {
    delivery_enabled: boolean;
    delivery_fee_cents: number;
    delivery_minimum_cents: number;
    pickup_enabled: boolean;
    pickup_minimum_cents: number;
    suggested_tip_percentages: number[];
    tax_rate_basis_points: number;
    test_ordering_enabled: boolean;
    tips_enabled: boolean;
  };
};

export function CheckoutClient({
  fulfillment,
  menu,
  paymentConfig,
  settings,
}: Props) {
  const router = useRouter();
  const [cart, setCart] = useState<CartLine[]>([]);
  const [ready, setReady] = useState(false);
  const [tipCents, setTipCents] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const tokenizer = useRef<Tokenizer | null>(null);
  const [cardReady, setCardReady] = useState(false);
  /* Whatever the customer told us before they started ordering — their name, and
     for delivery the address — is filled in here so nobody types it twice. */
  const [details, setDetails] = useState<OrderDetails | null>(null);
  useEffect(() => {
    const savedDetails = readOrderDetails(window.localStorage.getItem(ORDER_DETAILS_STORAGE_KEY));
    queueMicrotask(() => setDetails(savedDetails));
  }, []);
  useEffect(() => {
    const saved = readCart(window.localStorage.getItem(CART_STORAGE_KEY));
    queueMicrotask(() => {
      setCart(saved);
      setReady(true);
    });
  }, []);
  const subtotal = cartSubtotalCents(menu, cart);
  const deliveryFee =
    fulfillment === "delivery" ? settings.delivery_fee_cents : 0;
  const tax = Math.round(
    ((subtotal + deliveryFee) * settings.tax_rate_basis_points) / 10_000,
  );
  const total = subtotal + deliveryFee + tax + tipCents;
  const minimum =
    fulfillment === "delivery"
      ? settings.delivery_minimum_cents
      : settings.pickup_minimum_cents;
  const enabled =
    settings.test_ordering_enabled &&
    (fulfillment === "delivery"
      ? settings.delivery_enabled
      : settings.pickup_enabled);

  const handleTokenizer = useCallback((next: Tokenizer | null) => {
    tokenizer.current = next;
    setCardReady(Boolean(next));
  }, []);

  /**
   * Whether it is a house or a third-floor apartment is the single most useful
   * thing a driver can be told, and it is asked for before the order starts. It
   * would be lost if it stayed in the browser, so it rides along on the line the
   * driver actually reads.
   */
  function deliveryInstructions(typed: string) {
    if (fulfillment !== "delivery" || !details) return typed;
    const residence = residenceLabels[details.residence_type];
    if (!residence || typed.toLowerCase().includes(residence.toLowerCase())) return typed;
    return [residence, typed.trim()].filter(Boolean).join(" · ");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPending(true);
    const form = new FormData(event.currentTarget);
    const idempotencyKey =
      window.sessionStorage.getItem("wayne-order-idempotency-v1") ??
      crypto.randomUUID();
    window.sessionStorage.setItem("wayne-order-idempotency-v1", idempotencyKey);
    const payload = {
      idempotency_key: idempotencyKey,
      fulfillment_type: fulfillment,
      first_name: String(form.get("first_name") ?? ""),
      last_name: String(form.get("last_name") ?? ""),
      phone: String(form.get("phone") ?? ""),
      email: String(form.get("email") ?? ""),
      sms_opt_in: form.get("sms_opt_in") === "on",
      email_opt_in: form.get("email_opt_in") === "on",
      tip_cents: tipCents,
      promo_code: String(form.get("promo_code") ?? ""),
      special_instructions: String(form.get("special_instructions") ?? ""),
      address: {
        address1: String(form.get("address1") ?? ""),
        address2: String(form.get("address2") ?? ""),
        city: String(form.get("city") ?? ""),
        state: String(form.get("state") ?? ""),
        postal_code: String(form.get("postal_code") ?? ""),
        delivery_instructions: deliveryInstructions(
          String(form.get("delivery_instructions") ?? ""),
        ),
      },
      items: cart.map((line) => ({
        menu_item_id: line.menu_item_id,
        variant_id: line.variant_id,
        quantity: line.quantity,
        special_instructions: line.special_instructions,
        modifiers: line.modifiers,
      })),
    };
    // Keep the saved copy in step with whatever they actually submitted, so the
    // address on the menu page is the one the order went to, and their next
    // order starts from the corrected version rather than the old one.
    try {
      window.localStorage.setItem(
        ORDER_DETAILS_STORAGE_KEY,
        JSON.stringify({
          ...(details ?? {}),
          fulfillment,
          first_name: payload.first_name,
          last_name: payload.last_name,
          phone: payload.phone,
          residence_type: details?.residence_type ?? "house",
          ...payload.address,
        }),
      );
    } catch {
      // Storage being unavailable is not a reason to fail an order.
    }

    try {
      if (paymentConfig) {
        if (!tokenizer.current) {
          setError("Card entry is still loading. Wait a moment and try again.");
          return;
        }
        // The card is tokenized in the processor's own frame; only a one-time token
        // reaches this code, and the order and the charge happen in one request so a
        // closed tab cannot leave a paid order unplaced.
        const card = await tokenizer.current({
          amountCents: total,
          billingPostalCode: String(form.get("postal_code") ?? "") || undefined,
        });
        const response = await fetch("/api/payments/card", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            order: payload,
            payment: {
              source_id: card.token,
              verification_token: card.verificationToken,
              idempotency_key: idempotencyKey,
            },
          }),
        });
        const body: unknown = await response.json();
        if (!response.ok) {
          setError(
            typeof body === "object" && body !== null && "error" in body
              ? String(body.error)
              : "The payment could not be completed.",
          );
          return;
        }
        const paid = cardCheckoutResultSchema.safeParse(body);
        if (!paid.success) {
          setError(
            "The payment confirmation was invalid. Please call Wayne's Pizza before paying again.",
          );
          return;
        }
        window.localStorage.removeItem(CART_STORAGE_KEY);
        window.sessionStorage.removeItem("wayne-order-idempotency-v1");
        router.push(
          `/order/${paid.data.id}?token=${paid.data.public_access_token}`,
        );
        return;
      }

      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        setError(
          typeof body === "object" && body !== null && "error" in body
            ? String(body.error)
            : "Order could not be placed.",
        );
        return;
      }
      const result = orderCreatedSchema.safeParse(body);
      if (!result.success) {
        setError("Order confirmation was invalid. Please call Wayne's Pizza.");
        return;
      }
      window.localStorage.removeItem(CART_STORAGE_KEY);
      window.sessionStorage.removeItem("wayne-order-idempotency-v1");
      router.push(
        `/order/${result.data.id}?token=${result.data.public_access_token}`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error && paymentConfig
          ? cause.message
          : "Connection problem. Your cart is safe; please try again.",
      );
    } finally {
      setPending(false);
    }
  }

  if (!ready)
    return <p className="mt-8 text-wayne-muted">Loading your cart…</p>;
  if (!cart.length)
    return (
      <div className="mt-8 rounded-2xl border border-wayne-border bg-white p-8 text-center">
        <h2 className="text-2xl font-black">Your cart is empty</h2>
        <Button asChild className="mt-5">
          <Link href={`/menu?fulfillment=${fulfillment}`}>Return to menu</Link>
        </Button>
      </div>
    );

  return (
    <form
      className="mt-8 grid gap-7 lg:grid-cols-[1fr_22rem]"
      onSubmit={submit}
    >
      <div className="grid gap-6">
        <section className="rounded-2xl border border-wayne-border bg-white p-6">
          <h2 className="text-2xl font-black">Your details</h2>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <Input
              defaultValue={details?.first_name ?? ""}
              key={`first-${details?.first_name ?? ""}`}
              label="First name"
              name="first_name"
              required
            />
            <Input
              defaultValue={details?.last_name ?? ""}
              key={`last-${details?.last_name ?? ""}`}
              label="Last name"
              name="last_name"
              required
            />
            <Input
              defaultValue={details?.phone ?? ""}
              key={`phone-${details?.phone ?? ""}`}
              label="Phone"
              name="phone"
              required
              type="tel"
            />
            <Input label="Email (optional)" name="email" type="email" />
          </div>
        </section>
        {fulfillment === "delivery" ? (
          <section className="rounded-2xl border border-wayne-border bg-white p-6">
            <h2 className="text-2xl font-black">Delivery address</h2>
            {details?.address1 ? (
              /* The address they gave before they started ordering, shown back to
                 them here so a wrong street is caught now and not by a driver. */
              <p className="mt-3 rounded-xl bg-wayne-ok-soft p-3 text-sm font-semibold">
                Delivering to {details.address1}
                {details.address2 ? `, ${details.address2}` : ""} —{" "}
                {residenceLabels[details.residence_type].toLowerCase()}. Change
                anything below if it is not right.
              </p>
            ) : null}
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <GoogleAddressInput
                defaultValue={details?.address1 ?? ""}
                key={`address1-${details?.address1 ?? ""}`}
              />
              <Input
                defaultValue={details?.address2 ?? ""}
                key={`address2-${details?.address2 ?? ""}`}
                label="Apartment / unit (optional)"
                name="address2"
              />
              <Input
                defaultValue={details?.city ?? ""}
                key={`city-${details?.city ?? ""}`}
                label="City"
                name="city"
                required
              />
              <Input
                defaultValue={details?.state || "MA"}
                key={`state-${details?.state ?? ""}`}
                label="State"
                name="state"
                required
              />
              <Input
                defaultValue={details?.postal_code ?? ""}
                key={`zip-${details?.postal_code ?? ""}`}
                label="Postal code"
                name="postal_code"
                required
              />
            </div>
            <TextArea
              defaultValue={details?.delivery_instructions ?? ""}
              key={`instructions-${details?.delivery_instructions ?? ""}`}
              label="Delivery instructions (optional)"
              name="delivery_instructions"
            />
          </section>
        ) : null}
        <section className="rounded-2xl border border-wayne-border bg-white p-6">
          <h2 className="text-2xl font-black">Deals & order notes</h2>
          <p className="mt-2 text-sm text-wayne-muted">
            Keep up with Wayne’s deals if you’d like. These choices are optional
            and do not affect your order updates.
          </p>
          <div className="mt-4 grid gap-3">
            <Check label="Send me Wayne's Pizza text deals" name="sms_opt_in" />
            <Check
              label="Send me Wayne's Pizza email deals"
              name="email_opt_in"
            />
          </div>
          <div className="mt-5">
            <TextArea
              label="Order instructions (optional)"
              name="special_instructions"
            />
          </div>
        </section>
        {paymentConfig ? (
          <section className="rounded-2xl border border-wayne-border bg-white p-6">
            <h2 className="text-2xl font-black">Card payment</h2>
            <p className="mt-2 text-sm text-wayne-muted">
              Your card is charged for {formatCents(total)} when you place the
              order.
            </p>
            <div className="mt-4">
              <SquareCardField
                config={paymentConfig}
                onReady={handleTokenizer}
                onStatus={setError}
              />
            </div>
          </section>
        ) : (
          <section className="rounded-2xl border border-wayne-warn/40 bg-wayne-warn-soft p-6">
            <h2 className="text-2xl font-black">TEST / MANUAL payment</h2>
            <p className="mt-2">
              No card information is requested and no payment is collected. This
              order is saved as unpaid test data.
            </p>
          </section>
        )}
      </div>
      <aside className="self-start rounded-2xl border border-wayne-border bg-white p-5 shadow-sm lg:sticky lg:top-5">
        <h2 className="text-2xl font-black capitalize">{fulfillment} order</h2>
        <div className="mt-5 grid gap-4">
          {cart.map((line) => {
            const item = findMenuItem(menu, line.menu_item_id);
            const variant = item?.variants.find(
              (candidate) => candidate.id === line.variant_id,
            );
            return (
              <div
                className="border-b border-wayne-border pb-3"
                key={line.line_id}
              >
                <div className="flex justify-between gap-3">
                  <div>
                    <strong>
                      {line.quantity}× {item?.name ?? "Unavailable item"}
                    </strong>
                    {variant ? (
                      <p className="text-sm text-wayne-muted">{variant.name}</p>
                    ) : null}
                    <CartLineOptions item={item} line={line} />
                  </div>
                  <strong>
                    {formatCents(cartLineUnitCents(menu, line) * line.quantity)}
                  </strong>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-5 grid gap-2 text-sm">
          <TotalRow label="Subtotal" value={subtotal} />
          <TotalRow label="Estimated delivery fee" value={deliveryFee} />
          <TotalRow label="Estimated tax" value={tax} />
          <TotalRow label="Tip" value={tipCents} />
          <TotalRow emphasis label="Estimated total" value={total} />
        </div>
        <label className="mt-5 grid gap-2 text-sm font-semibold">
          Promo code
          <input
            className="min-h-11 rounded-lg border px-3"
            name="promo_code"
          />
        </label>
        <p className="mt-2 text-xs text-wayne-muted">
          Discount eligibility and all totals are verified by the database when
          placed.
        </p>
        {settings.tips_enabled ? (
          <div className="mt-5">
            <strong className="text-sm">Tip</strong>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                className="rounded-full border px-3 py-2 text-sm font-bold"
                onClick={() => setTipCents(0)}
                type="button"
              >
                None
              </button>
              {settings.suggested_tip_percentages.map((percent) => (
                <button
                  className="rounded-full border px-3 py-2 text-sm font-bold"
                  key={percent}
                  onClick={() =>
                    setTipCents(Math.round((subtotal * percent) / 100))
                  }
                  type="button"
                >
                  {percent}%
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {subtotal < minimum ? (
          <p className="mt-4 rounded-lg bg-wayne-alert-soft p-3 text-sm font-bold text-wayne-alert">
            Add {formatCents(minimum - subtotal)} to meet the {fulfillment}{" "}
            minimum.
          </p>
        ) : null}
        {error ? (
          <p
            aria-live="polite"
            className="mt-4 rounded-lg bg-wayne-alert-soft p-3 text-sm font-bold text-wayne-alert"
          >
            {error}
          </p>
        ) : null}
        <Button
          className="mt-5 w-full"
          disabled={
            pending ||
            !enabled ||
            subtotal < minimum ||
            (Boolean(paymentConfig) && !cardReady)
          }
          type="submit"
        >
          {pending
            ? paymentConfig
              ? "Charging once…"
              : "Placing once…"
            : paymentConfig
              ? `Pay ${formatCents(total)} and place order`
              : "Place test order"}
        </Button>
        <Button asChild className="mt-3 w-full" variant="secondary">
          <Link href={`/menu?fulfillment=${fulfillment}`}>Edit cart</Link>
        </Button>
      </aside>
    </form>
  );
}

function CartLineOptions({
  item,
  line,
}: {
  item: PublicMenu[number]["items"][number] | undefined;
  line: CartLine;
}) {
  if (!item) return null;
  const options = line.modifiers.flatMap((modifier) =>
    item.modifier_groups.flatMap((group) =>
      group.choices
        .filter((choice) => choice.id === modifier.choice_id)
        .map(
          (choice) =>
            `${modifier.quantity > 1 ? `${modifier.quantity}× ` : ""}${choice.name}`,
        ),
    ),
  );
  return (
    <>
      {options.length ? (
        <p className="mt-1 text-sm text-wayne-muted">{options.join(", ")}</p>
      ) : null}
      {line.special_instructions ? (
        <p className="mt-1 text-sm text-wayne-muted">
          Note: {line.special_instructions}
        </p>
      ) : null}
    </>
  );
}

function Check({ label, name }: { label: string; name: string }) {
  return (
    <label className="flex min-h-11 items-center gap-3 text-sm font-semibold">
      <input className="h-5 w-5 accent-wayne-red" name={name} type="checkbox" />
      {label}
    </label>
  );
}
function TextArea({ defaultValue = "", label, name }: { defaultValue?: string; label: string; name: string }) {
  return (
    <label className="grid gap-2 text-sm font-semibold">
      {label}
      <textarea
        className="rounded-xl border p-3 font-normal"
        defaultValue={defaultValue}
        maxLength={1000}
        name={name}
        rows={3}
      />
    </label>
  );
}
function TotalRow({
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
      className={`flex justify-between ${emphasis ? "mt-2 border-t pt-3 text-lg font-black" : ""}`}
    >
      <span>{label}</span>
      <span>{formatCents(value)}</span>
    </div>
  );
}
