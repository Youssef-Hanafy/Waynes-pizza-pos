"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { MenuImage } from "@/components/site/menu-image";
import { Button } from "@/components/ui/button";
import { isMenuItemAvailableNow } from "@/lib/menu/availability";
import {
  CART_STORAGE_KEY,
  cartLineUnitCents,
  cartSubtotalCents,
  findMenuItem,
  readCart,
} from "@/lib/orders/cart";
import { formatCents, type PublicMenu } from "@/lib/menu/schemas";
import type { CartLine } from "@/lib/orders/schemas";

type Fulfillment = "pickup" | "delivery";
type MenuItem = PublicMenu[number]["items"][number];
type Props = {
  menu: PublicMenu;
  initialFulfillment: Fulfillment;
  orderingOpen: boolean;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  timezone: string;
};

export function OrderMenuClient({
  menu,
  initialFulfillment,
  orderingOpen,
  pickupEnabled,
  deliveryEnabled,
  timezone,
}: Props) {
  const router = useRouter();
  const [fulfillment, setFulfillment] =
    useState<Fulfillment>(initialFulfillment);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [selected, setSelected] = useState<MenuItem | null>(null);
  const [editingLine, setEditingLine] = useState<CartLine | null>(null);

  useEffect(() => {
    const saved = readCart(window.localStorage.getItem(CART_STORAGE_KEY));
    queueMicrotask(() => {
      setCart(saved);
      setHydrated(true);
    });
  }, []);
  useEffect(() => {
    if (hydrated)
      window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
  }, [cart, hydrated]);

  const subtotal = cartSubtotalCents(menu, cart);
  const itemCount = cart.reduce((sum, line) => sum + line.quantity, 0);
  function changeFulfillment(next: Fulfillment) {
    setFulfillment(next);
    router.replace(`/menu?fulfillment=${next}`, { scroll: false });
  }

  return (
    <div className="mx-auto grid max-w-7xl gap-8 px-5 py-10 lg:grid-cols-[1fr_22rem]">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-wayne-border bg-white p-4">
          <div>
            <p className="text-xs font-black uppercase tracking-wider text-wayne-muted">
              Ordering for
            </p>
            <p className="text-xl font-black capitalize">{fulfillment}</p>
          </div>
          <div className="flex gap-2">
            <Button
              disabled={!orderingOpen || !pickupEnabled}
              onClick={() => changeFulfillment("pickup")}
              type="button"
              variant={fulfillment === "pickup" ? "primary" : "secondary"}
            >
              Pickup
            </Button>
            <Button
              disabled={!orderingOpen || !deliveryEnabled}
              onClick={() => changeFulfillment("delivery")}
              type="button"
              variant={fulfillment === "delivery" ? "primary" : "secondary"}
            >
              Delivery
            </Button>
          </div>
        </div>
        {!orderingOpen ? (
          <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 font-semibold">
            Online ordering is currently closed. You can browse, but checkout is
            unavailable.
          </p>
        ) : null}
        {cart.length ? (
          <a className="mt-4 flex items-center justify-between rounded-xl bg-wayne-red px-5 py-4 font-black text-white lg:hidden" href="#cart">
            <span>View cart · {itemCount} item{itemCount === 1 ? "" : "s"}</span><span>{formatCents(subtotal)}</span>
          </a>
        ) : null}
        <nav
          aria-label="Menu categories"
          className="sticky top-0 z-10 -mx-5 mt-8 flex gap-2 overflow-x-auto border-y border-wayne-border bg-wayne-cream/95 px-5 py-3 backdrop-blur"
        >
          {menu.map((category) => (
            <a
              className="whitespace-nowrap rounded-full border border-wayne-border bg-white px-4 py-2 text-sm font-bold"
              href={`#category-${category.id}`}
              key={category.id}
            >
              {category.name}
            </a>
          ))}
        </nav>
        <div className="mt-10 space-y-14">
          {menu.map((category) => (
            <section id={`category-${category.id}`} key={category.id}>
              <h2 className="text-4xl font-black">{category.name}</h2>
              {category.description ? (
                <p className="mt-2 max-w-2xl text-wayne-muted">
                  {category.description}
                </p>
              ) : null}
              <div className="mt-6 grid gap-6 md:grid-cols-2">
                {category.items.map((item) => {
                  const available = isMenuItemAvailableNow(item, timezone);
                  return (
                    <article
                      className={`overflow-hidden rounded-2xl border bg-white shadow-sm ${item.sold_out || !available ? "opacity-65" : ""}`}
                      key={item.id}
                    >
                      <MenuImage
                        alt={item.image_alt || item.name}
                        path={item.image_path}
                      />
                      <div className="p-5">
                        <div className="flex items-start justify-between gap-4">
                          <h3 className="text-xl font-black">{item.name}</h3>
                          <span className="whitespace-nowrap font-black text-wayne-red">
                            {item.variants.length
                              ? `From ${formatCents(Math.min(...item.variants.map((variant) => variant.price_cents)))}`
                              : formatCents(item.base_price_cents)}
                          </span>
                        </div>
                        <p className="mt-3 text-sm leading-6 text-wayne-muted">
                          {item.description}
                        </p>
                        <Button
                          className="mt-5 w-full"
                          disabled={
                            item.sold_out || !available || !orderingOpen
                          }
                          onClick={() => setSelected(item)}
                          type="button"
                        >
                          {item.sold_out
                            ? "Sold out"
                            : !available
                              ? "Unavailable now"
                              : "Customize & add"}
                        </Button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
      <aside className="self-start rounded-2xl border border-wayne-border bg-white p-5 shadow-sm lg:sticky lg:top-5" id="cart">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-black">Your cart</h2>
          <span className="rounded-full bg-wayne-cream px-3 py-1 text-sm font-bold">
            {itemCount} item{itemCount === 1 ? "" : "s"}
          </span>
        </div>
        {cart.length ? (
          <div className="mt-5 grid gap-4">
            {cart.map((line) => {
              const item = findMenuItem(menu, line.menu_item_id);
              const variant = item?.variants.find(
                (candidate) => candidate.id === line.variant_id,
              );
              return (
                <div
                  className="border-b border-wayne-border pb-4"
                  key={line.line_id}
                >
                  <div className="flex justify-between gap-3">
                    <div>
                      <strong>{item?.name ?? "Unavailable item"}</strong>
                      {variant ? (
                        <p className="text-sm text-wayne-muted">
                          {variant.name}
                        </p>
                      ) : null}
                      <CartLineOptions item={item} line={line} />
                    </div>
                    <strong>
                      {formatCents(
                        cartLineUnitCents(menu, line) * line.quantity,
                      )}
                    </strong>
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <button
                        aria-label={`Decrease ${item?.name ?? "item"}`}
                        className="h-9 w-9 rounded-full border"
                        onClick={() =>
                          setCart(
                            updateQuantity(
                              cart,
                              line.line_id,
                              line.quantity - 1,
                            ),
                          )
                        }
                      >
                        −
                      </button>
                      <span className="min-w-5 text-center font-bold">
                        {line.quantity}
                      </span>
                      <button
                        aria-label={`Increase ${item?.name ?? "item"}`}
                        className="h-9 w-9 rounded-full border"
                        onClick={() =>
                          setCart(
                            updateQuantity(
                              cart,
                              line.line_id,
                              line.quantity + 1,
                            ),
                          )
                        }
                      >
                        +
                      </button>
                    </div>
                    <button
                      className="text-sm font-bold underline"
                      onClick={() => {
                        if (!item) return;
                        setEditingLine(line);
                        setSelected(item);
                      }}
                      type="button"
                    >
                      Edit item
                    </button>
                    <button
                      className="text-sm font-bold text-wayne-red underline"
                      onClick={() =>
                        setCart(
                          cart.filter(
                            (candidate) => candidate.line_id !== line.line_id,
                          ),
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
            <div className="flex justify-between text-lg font-black">
              <span>Subtotal</span>
              <span>{formatCents(subtotal)}</span>
            </div>
            <p className="text-xs text-wayne-muted">
              Delivery fee, discounts, tax, and optional tip are finalized
              securely at checkout.
            </p>
            <Button asChild className="w-full">
              <Link href={`/checkout?fulfillment=${fulfillment}`}>
                Continue to checkout
              </Link>
            </Button>
          </div>
        ) : (
          <p className="mt-5 text-wayne-muted">
            Choose an item to begin your {fulfillment} order.
          </p>
        )}
      </aside>
      {selected ? (
        <ItemDialog
          item={selected}
          initialLine={editingLine}
          onAdd={(line) => {
            setCart(
              editingLine
                ? cart.map((candidate) =>
                    candidate.line_id === editingLine.line_id ? line : candidate,
                  )
                : [...cart, line],
            );
            setEditingLine(null);
            setSelected(null);
          }}
          onClose={() => {
            setEditingLine(null);
            setSelected(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ItemDialog({
  item,
  initialLine,
  onAdd,
  onClose,
}: {
  item: MenuItem;
  initialLine: CartLine | null;
  onAdd: (line: CartLine) => void;
  onClose: () => void;
}) {
  const [variantId, setVariantId] = useState<string | null>(
    initialLine?.variant_id ?? item.variants[0]?.id ?? null,
  );
  const [selectedChoices, setSelectedChoices] = useState<
    Record<string, number>
  >(() => initialLine
    ? Object.fromEntries(initialLine.modifiers.map((modifier) => [modifier.choice_id, modifier.quantity]))
    : Object.fromEntries(item.modifier_groups.flatMap((group) => group.choices.filter((choice) => choice.default_selected).map((choice) => [choice.id, 1]))),
  );
  const [quantity, setQuantity] = useState(initialLine?.quantity ?? 1);
  const [instructions, setInstructions] = useState(initialLine?.special_instructions ?? "");
  const [error, setError] = useState("");
  const draftLine = useMemo<CartLine>(
    () => ({
      line_id: "draft",
      menu_item_id: item.id,
      variant_id: variantId,
      quantity,
      special_instructions: instructions,
      modifiers: Object.entries(selectedChoices)
        .filter(([, count]) => count > 0)
        .map(([choice_id, count]) => ({ choice_id, quantity: count })),
    }),
    [instructions, item.id, quantity, selectedChoices, variantId],
  );
  const draftMenu = [
    {
      id: "00000000-0000-4000-8000-000000000000",
      name: "",
      description: "",
      image_path: null,
      image_alt: "",
      items: [item],
    },
  ] as PublicMenu;

  function add() {
    for (const group of item.modifier_groups) {
      const count = group.choices.reduce(
        (sum, choice) => sum + (selectedChoices[choice.id] ?? 0),
        0,
      );
      if (
        count < group.min_select ||
        count > group.max_select ||
        (group.required && count === 0)
      ) {
        setError(
          `${group.customer_label}: choose ${group.min_select === group.max_select ? group.min_select : `${group.min_select}–${group.max_select}`}.`,
        );
        return;
      }
    }
    onAdd({ ...draftLine, line_id: initialLine?.line_id ?? crypto.randomUUID() });
  }

  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      role="dialog"
    >
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex justify-between gap-4">
          <div>
            <h2 className="text-3xl font-black">{item.name}</h2>
            <p className="mt-2 text-wayne-muted">{item.description}</p>
          </div>
          <button
            aria-label="Close item"
            className="h-11 w-11 rounded-full border text-xl"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {item.variants.length ? (
          <fieldset className="mt-6">
            <legend className="font-black">Choose a size</legend>
            <div className="mt-3 grid gap-2">
              {item.variants.map((variant) => (
                <label
                  className="flex min-h-12 items-center justify-between rounded-xl border p-3"
                  key={variant.id}
                >
                  <span>
                    <input
                      checked={variantId === variant.id}
                      className="mr-3"
                      name="variant"
                      onChange={() => setVariantId(variant.id)}
                      type="radio"
                    />
                    {variant.name}
                  </span>
                  <strong>{formatCents(variant.price_cents)}</strong>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        {item.modifier_groups.map((group) => (
          <fieldset className="mt-6" key={group.id}>
            <legend className="font-black">
              {group.customer_label}{" "}
              <span className="text-sm font-normal text-wayne-muted">
                ({group.min_select}–{group.max_select})
              </span>
            </legend>
            <div className="mt-3 grid gap-2">
              {group.choices.map((choice) => {
                const count = selectedChoices[choice.id] ?? 0;
                return (
                  <div
                    className="flex min-h-12 items-center justify-between rounded-xl border p-3"
                    key={choice.id}
                  >
                    <label className="flex flex-1 items-center">
                      <input
                        checked={count > 0}
                        className="mr-3"
                        onChange={(event) =>
                          setSelectedChoices({
                            ...selectedChoices,
                            [choice.id]: event.target.checked ? 1 : 0,
                          })
                        }
                        type="checkbox"
                      />
                      <span>
                        {choice.name}
                        {choice.price_delta_cents ? (
                          <small className="ml-2 text-wayne-muted">
                            {choice.price_delta_cents > 0 ? "+" : ""}
                            {formatCents(choice.price_delta_cents)}
                          </small>
                        ) : null}
                      </span>
                    </label>
                    {group.allow_quantities && count > 0 ? (
                      <div className="flex items-center gap-2">
                        <button
                          aria-label={`Less ${choice.name}`}
                          className="h-8 w-8 rounded-full border"
                          onClick={() =>
                            setSelectedChoices({
                              ...selectedChoices,
                              [choice.id]: Math.max(0, count - 1),
                            })
                          }
                        >
                          −
                        </button>
                        <strong>{count}</strong>
                        <button
                          aria-label={`More ${choice.name}`}
                          className="h-8 w-8 rounded-full border"
                          onClick={() =>
                            setSelectedChoices({
                              ...selectedChoices,
                              [choice.id]: Math.min(20, count + 1),
                            })
                          }
                        >
                          +
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </fieldset>
        ))}
        <label className="mt-6 grid gap-2 font-bold">
          Item instructions
          <textarea
            className="rounded-xl border p-3 font-normal"
            maxLength={500}
            onChange={(event) => setInstructions(event.target.value)}
            rows={3}
            value={instructions}
          />
        </label>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <button
              aria-label="Decrease quantity"
              className="h-11 w-11 rounded-full border"
              onClick={() => setQuantity(Math.max(1, quantity - 1))}
            >
              −
            </button>
            <strong>{quantity}</strong>
            <button
              aria-label="Increase quantity"
              className="h-11 w-11 rounded-full border"
              onClick={() => setQuantity(Math.min(20, quantity + 1))}
            >
              +
            </button>
          </div>
          <Button onClick={add} type="button">
            {initialLine ? "Save changes" : "Add"} ·{" "}
            {formatCents(cartLineUnitCents(draftMenu, draftLine) * quantity)}
          </Button>
        </div>
        {error ? (
          <p
            aria-live="polite"
            className="mt-4 rounded-lg bg-red-50 p-3 text-sm font-bold text-red-800"
          >
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function CartLineOptions({ item, line }: { item: MenuItem | undefined; line: CartLine }) {
  if (!item) return null;
  const options = line.modifiers.flatMap((modifier) =>
    item.modifier_groups.flatMap((group) =>
      group.choices
        .filter((choice) => choice.id === modifier.choice_id)
        .map((choice) => `${modifier.quantity > 1 ? `${modifier.quantity}× ` : ""}${choice.name}`),
    ),
  );
  return <>{options.length ? <p className="mt-1 text-sm text-wayne-muted">{options.join(", ")}</p> : null}{line.special_instructions ? <p className="mt-1 text-sm text-wayne-muted">Note: {line.special_instructions}</p> : null}</>;
}

function updateQuantity(cart: CartLine[], lineId: string, quantity: number) {
  return quantity < 1
    ? cart.filter((line) => line.line_id !== lineId)
    : cart.map((line) =>
        line.line_id === lineId
          ? { ...line, quantity: Math.min(20, quantity) }
          : line,
      );
}
