"use client";

import { RewardsButton } from "@/components/site/rewards-experience";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { SiteIcon } from "@/components/site/site-icon";
import { MenuImage } from "@/components/site/menu-image";
import { Button } from "@/components/ui/button";
import { isMenuItemAvailableNow } from "@/lib/menu/availability";
import {
  CART_STORAGE_KEY,
  cartLineUnitCents,
  cartSubtotalCents,
  choicePriceDeltaCents,
  findMenuItem,
  readCart,
} from "@/lib/orders/cart";
import { formatCents, type PublicMenu } from "@/lib/menu/schemas";
import { OrderStartGate } from "@/components/site/order-start-gate";
import {
  ORDER_DETAILS_STORAGE_KEY,
  estimateRange,
  orderDetailsComplete,
  readOrderDetails,
  residenceLabels,
  type OrderDetails,
} from "@/lib/orders/order-details";
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
  initialItemId?: string;
  pickupMinutes: number;
  deliveryMinutes: number;
};

export function OrderMenuClient({
  menu,
  initialFulfillment,
  orderingOpen,
  pickupEnabled,
  deliveryEnabled,
  timezone,
  initialItemId,
  pickupMinutes,
  deliveryMinutes,
}: Props) {
  const router = useRouter();
  const [fulfillment, setFulfillment] = useState<Fulfillment>(
    initialFulfillment === "delivery" && deliveryEnabled
      ? "delivery"
      : pickupEnabled
        ? "pickup"
        : "delivery",
  );
  const [cart, setCart] = useState<CartLine[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [selected, setSelected] = useState<MenuItem | null>(() =>
    initialItemId ? (findMenuItem(menu, initialItemId) ?? null) : null,
  );
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState(menu[0]?.id ?? "");
  const [announcement, setAnnouncement] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const visibleMenu = normalizedQuery
    ? menu
        .map((category) => ({
          ...category,
          items: category.items.filter((item) =>
            `${item.name} ${item.description}`
              .toLowerCase()
              .includes(normalizedQuery),
          ),
        }))
        .filter((category) => category.items.length)
    : menu.filter((category) => category.id === activeCategory);
  useEffect(() => {
    function followHash() {
      const id = window.location.hash.replace("#category-", "");
      if (menu.some((category) => category.id === id)) {
        setActiveCategory(id);
        setQuery("");
      }
    }
    queueMicrotask(followHash);
    window.addEventListener("hashchange", followHash);
    return () => window.removeEventListener("hashchange", followHash);
  }, [menu]);
  const [editingLine, setEditingLine] = useState<CartLine | null>(null);
  /* Delivery cannot be quoted without an address and pickup cannot be called
     out without a name, so both are asked for before the first item goes in the
     cart rather than at the end. */
  const [details, setDetails] = useState<OrderDetails | null>(null);
  const [detailsReady, setDetailsReady] = useState(false);
  /* null means "decide from what we know": the gate opens by itself when the
     details for this fulfillment are missing. Opening or dismissing it by hand
     overrides that until the fulfillment changes. */
  const [gateManual, setGateManual] = useState<boolean | null>(null);

  useEffect(() => {
    const saved = readOrderDetails(window.localStorage.getItem(ORDER_DETAILS_STORAGE_KEY));
    queueMicrotask(() => {
      setDetails(saved);
      setDetailsReady(true);
    });
  }, []);
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

  const fulfillmentAvailable =
    fulfillment === "pickup" ? pickupEnabled : deliveryEnabled;
  const canCheckout = orderingOpen && fulfillmentAvailable;
  const subtotal = cartSubtotalCents(menu, cart);
  const itemCount = cart.reduce((sum, line) => sum + line.quantity, 0);
  function changeFulfillment(next: Fulfillment) {
    setFulfillment(next);
    // Delivery and pickup ask for different things, so the question is open again.
    setGateManual(null);
    router.replace(`/menu?fulfillment=${next}`, { scroll: false });
  }

  function saveDetails(next: OrderDetails) {
    setDetails(next);
    try {
      window.localStorage.setItem(ORDER_DETAILS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // A browser with storage blocked still gets to order; checkout simply asks
      // for the address again rather than failing here.
    }
    setGateManual(null);
  }

  function cancelGate() {
    setGateManual(false);
    // "Switch to pickup" is the honest way out of the delivery question: someone
    // who cannot give an address can still come and get it.
    if (fulfillment === "delivery" && pickupEnabled) changeFulfillment("pickup");
  }

  const detailsSet = orderDetailsComplete(details, fulfillment);
  // Ask as soon as the choice is made, not when they try to leave with a cart.
  const gateOpen = gateManual ?? (detailsReady && orderingOpen && !detailsSet);

  function chooseCategory(categoryId: string) {
    setActiveCategory(categoryId);
    setQuery("");
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#category-${categoryId}`);
    window.requestAnimationFrame(() => document.getElementById(`category-${categoryId}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  return (
    <div className="site-container ordering-layout">
      <div className="menu-main">
        {detailsSet && details ? (
          <div className="order-gate-summary">
            <SiteIcon name={fulfillment === "delivery" ? "truck" : "bag"} size={17} />
            <span>
              {fulfillment === "delivery" ? (
                <>
                  <strong>{details.address1}</strong>
                  {details.address2 ? `, ${details.address2}` : ""} ·{" "}
                  {residenceLabels[details.residence_type]} ·{" "}
                  {estimateRange(deliveryMinutes)}
                </>
              ) : (
                <>
                  Pickup for <strong>{details.first_name}</strong> ·{" "}
                  {estimateRange(pickupMinutes)}
                </>
              )}
            </span>
            <button onClick={() => setGateManual(true)} type="button">
              Change
            </button>
          </div>
        ) : null}
        <div className="fulfillment-toolbar">
          <div>
            <span className="eyebrow">YOUR ORDER, YOUR WAY</span>
            <p>
              <SiteIcon
                name={fulfillment === "pickup" ? "bag" : "truck"}
                size={16}
              />
              <strong>
                {fulfillment === "pickup" ? "Pickup" : "Delivery"}
              </strong>
              <span>
                · Approx.{" "}
                {fulfillment === "pickup" ? pickupMinutes : deliveryMinutes} min
              </span>
            </p>
          </div>
          <div className="fulfillment-toggle">
            <button
              type="button"
              aria-pressed={fulfillment === "pickup"}
              disabled={!pickupEnabled}
              onClick={() => changeFulfillment("pickup")}
            >
              <SiteIcon name="bag" size={16} />
              Pickup
            </button>
            <button
              type="button"
              aria-pressed={fulfillment === "delivery"}
              disabled={!deliveryEnabled}
              onClick={() => changeFulfillment("delivery")}
            >
              <SiteIcon name="truck" size={16} />
              Delivery
            </button>
          </div>
        </div>
        <label className="menu-search">
          <SiteIcon name="search" size={19} />
          <input
            type="search"
            aria-label="Search the menu"
            placeholder="Search for your next favorite…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
            >
              <SiteIcon name="close" size={17} />
            </button>
          )}
        </label>
        {!orderingOpen ? (
          <p className="mt-4 rounded-xl border border-wayne-warn/30 bg-wayne-warn-soft p-4 font-semibold">
            Online ordering is currently closed. You can browse, but checkout is
            unavailable.
          </p>
        ) : null}
        <div className="menu-category-board">
          <p>Pick a category</p>
          <div className="menu-category-cards">
            {menu.map((category) => (
              <button
                aria-pressed={!query && activeCategory === category.id}
                className="menu-category-card"
                key={category.id}
                onClick={() => chooseCategory(category.id)}
                type="button"
              >
                <MenuImage
                  alt={category.image_alt || category.name}
                  name={category.name}
                  path={category.image_path}
                  sizes="(max-width: 700px) 45vw, 200px"
                />
                <span>
                  {category.name}
                  <small>
                    {category.items.length} item
                    {category.items.length === 1 ? "" : "s"}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </div>
        <nav aria-label="Menu categories" className="menu-category-nav">
          {menu.map((category) => (
            <button
              type="button"
              aria-pressed={!query && activeCategory === category.id}
              key={category.id}
              onClick={() => chooseCategory(category.id)}
            >
              {category.name}
            </button>
          ))}
        </nav>
        <div className="menu-results" aria-live="polite">
          {query && (
            <p>
              {visibleMenu.reduce(
                (sum, category) => sum + category.items.length,
                0,
              )}{" "}
              results for “{query}”
            </p>
          )}
          {!visibleMenu.length && (
            <div className="menu-no-results">
              <SiteIcon name="search" size={36} />
              <h2>No bites just yet.</h2>
              <p>Try “pizza,” “chicken,” or another favorite.</p>
              <button className="text-link" onClick={() => setQuery("")}>
                Browse the menu <SiteIcon name="arrow" size={18} />
              </button>
            </div>
          )}
        </div>
        <div className="mt-6 space-y-14">
          {visibleMenu.map((category) => (
            <section
              className="menu-category-section"
              id={`category-${category.id}`}
              key={category.id}
            >
              <div className="menu-category-heading">
                <h2>{category.name}</h2>
                <span>{category.items.length} delicious choices</span>
              </div>
              {category.description ? (
                <p className="mt-2 max-w-2xl text-wayne-muted">
                  {category.description}
                </p>
              ) : null}
              <div className="menu-product-grid">
                {category.items.map((item) => {
                  const available = isMenuItemAvailableNow(item, timezone);
                  return (
                    <article
                      className={`menu-product group ${item.sold_out || !available ? "opacity-65" : ""}`}
                      key={item.id}
                    >
                      <MenuImage
                        alt={item.image_alt || item.name}
                        name={item.name}
                        category={category.name}
                        path={item.image_path}
                      />
                      <div className="menu-product-content">
                        <div className="menu-product-heading">
                          <h3 className="menu-product-name">{item.name}</h3>
                          <span className="menu-product-price">
                            {item.variants.length
                              ? `From ${formatCents(Math.min(...item.variants.map((variant) => variant.price_cents)))}`
                              : formatCents(item.base_price_cents)}
                          </span>
                        </div>
                        <p className="menu-product-description">
                          {item.description}
                        </p>
                        <Button
                          className="menu-customize-button"
                          disabled={item.sold_out || !available || !canCheckout}
                          onClick={() => setSelected(item)}
                          type="button"
                        >
                          {item.sold_out ? (
                            "Sold out"
                          ) : !available ? (
                            "Unavailable now"
                          ) : (
                            <>
                              <span>Customize & add</span>
                              <SiteIcon name="plus" size={17} />
                            </>
                          )}
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
      <aside className="order-cart" id="cart">
        <p className="eyebrow cart-eyebrow">
          <SiteIcon name="bag" size={16} /> MADE FOR YOU
        </p>
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-black">Your order</h2>
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
                        className="cart-quantity-button"
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
                        className="cart-quantity-button"
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
            {canCheckout && detailsSet ? (
              <Link
                className="order-button cart-checkout"
                href={`/checkout?fulfillment=${fulfillment}`}
              >
                Continue to checkout <SiteIcon name="arrow" size={18} />
              </Link>
            ) : canCheckout ? (
              <button
                className="order-button cart-checkout"
                onClick={() => setGateManual(true)}
                type="button"
              >
                {fulfillment === "delivery" ? "Add your address" : "Add your name"}{" "}
                <SiteIcon name="arrow" size={18} />
              </button>
            ) : (
              <p className="site-notice">Checkout is currently closed.</p>
            )}
          </div>
        ) : (
          <div className="cart-empty">
            <div>
              <SiteIcon name="pizza" size={48} />
            </div>
            <h3>Good things go in here.</h3>
            <p>
              Your next favorite is on the menu.
              <br />
              Add something delicious to get started.
            </p>
            <span>Made fresh. Made for you.</span>
          </div>
        )}
        <p className="cart-note">
          <SiteIcon name="check" size={14} /> Customize every bite before
          checkout.
        </p>
        <RewardsButton className="cart-rewards-link">Pizza person? Join Wayne’s Rewards →</RewardsButton>
      </aside>

      <div role="status" className={announcement ? "cart-toast" : "sr-only"}>
        {announcement && (
          <>
            <SiteIcon name="check" size={17} />
            <span>{announcement}</span>
            <a href="#cart">View order</a>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => setAnnouncement("")}
            >
              <SiteIcon name="close" size={15} />
            </button>
          </>
        )}
      </div>
      {(
        <a className="mobile-cart-bar" href="#cart">
          <span>
            <SiteIcon name="bag" size={20} />
            View order · {itemCount}
          </span>
          <strong>
            {formatCents(subtotal)} <SiteIcon name="arrow" size={18} />
          </strong>
        </a>
      )}
      <OrderStartGate
        deliveryMinutes={deliveryMinutes}
        fulfillment={fulfillment}
        initial={details}
        onCancel={cancelGate}
        onSave={saveDetails}
        open={gateOpen}
        pickupMinutes={pickupMinutes}
      />
      {selected ? (
        <ItemDialog
          item={selected}
          orderingOpen={
            canCheckout &&
            !selected.sold_out &&
            isMenuItemAvailableNow(selected, timezone)
          }
          category={
            menu.find((category) =>
              category.items.some((item) => item.id === selected.id),
            )?.name || ""
          }
          initialLine={editingLine}
          onAdd={(line) => {
            setCart(
              editingLine
                ? cart.map((candidate) =>
                    candidate.line_id === editingLine.line_id
                      ? line
                      : candidate,
                  )
                : [...cart, line],
            );
            setAnnouncement(
              `${selected.name} ${editingLine ? "updated" : "added to your order"}`,
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
  category,
  orderingOpen,
  initialLine,
  onAdd,
  onClose,
}: {
  item: MenuItem;
  category: string;
  orderingOpen: boolean;
  initialLine: CartLine | null;
  onAdd: (line: CartLine) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      dialog?.close();
      previousFocus?.focus();
    };
  }, []);
  const [variantId, setVariantId] = useState<string | null>(
    initialLine?.variant_id ?? item.variants[0]?.id ?? null,
  );
  const [selectedChoices, setSelectedChoices] = useState<
    Record<string, number>
  >(() =>
    initialLine
      ? Object.fromEntries(
          initialLine.modifiers.map((modifier) => [
            modifier.choice_id,
            modifier.quantity,
          ]),
        )
      : Object.fromEntries(
          item.modifier_groups.flatMap((group) =>
            group.choices
              .filter((choice) => choice.default_selected)
              .map((choice) => [choice.id, 1]),
          ),
        ),
  );
  const [quantity, setQuantity] = useState(initialLine?.quantity ?? 1);
  const [instructions, setInstructions] = useState(
    initialLine?.special_instructions ?? "",
  );
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
    onAdd({
      ...draftLine,
      line_id: initialLine?.line_id ?? crypto.randomUUID(),
    });
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="item-dialog-title"
      className="item-dialog"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="item-dialog-card">
        <div className="item-dialog-photo">
          <MenuImage
            alt={item.image_alt || item.name}
            name={item.name}
            category={category}
            path={item.image_path}
            sizes="(max-width: 640px) 100vw, 640px"
          />
          <button
            aria-label="Close item"
            className="item-dialog-close"
            onClick={onClose}
          >
            <SiteIcon name="close" />
          </button>
        </div>
        <div className="item-dialog-body">
          <p className="eyebrow">LET’S MAKE IT YOURS</p>
          <h2 id="item-dialog-title">{item.name}</h2>
          <p className="item-dialog-description">
            {item.description ||
              "Your Wayne’s favorite. Choose your size and make it just right."}
          </p>
          {item.variants.length ? (
            <fieldset className="mt-6">
              <legend className="font-black">Choose a size</legend>
              <div className="mt-3 grid gap-2">
                {item.variants.map((variant) => (
                  <label
                    className="item-choice"
                    data-selected={variantId === variant.id}
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
                  // what this option costs on the size chosen above
                  const delta = choicePriceDeltaCents(choice, variantId);
                  return (
                    <div
                      className="item-choice"
                      data-selected={count > 0}
                      key={choice.id}
                    >
                      <label className="flex flex-1 items-center">
                        <input
                          checked={count > 0}
                          className="mr-3"
                          onChange={(event) =>
                            setSelectedChoices({
                              ...selectedChoices,
                              ...(group.max_select === 1
                                ? Object.fromEntries(
                                    group.choices.map((option) => [
                                      option.id,
                                      0,
                                    ]),
                                  )
                                : {}),
                              [choice.id]: event.target.checked ? 1 : 0,
                            })
                          }
                          name={`modifier-${group.id}`}
                          type={
                            group.max_select === 1 && group.required
                              ? "radio"
                              : "checkbox"
                          }
                        />
                        <span>
                          {choice.name}
                          {delta ? (
                            <small className="ml-2 text-wayne-muted">
                              {delta > 0 ? "+" : ""}
                              {formatCents(delta)}
                            </small>
                          ) : null}
                        </span>
                      </label>
                      {group.allow_quantities && count > 0 ? (
                        <div className="flex items-center gap-2">
                          <button
                            aria-label={`Less ${choice.name}`}
                            className="cart-quantity-button"
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
                            className="cart-quantity-button"
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
          <div className="item-dialog-actions">
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
            <Button
              className="dialog-add-button"
              disabled={!orderingOpen}
              onClick={add}
              type="button"
            >
              {initialLine ? "Save changes" : "Add"} ·{" "}
              {formatCents(cartLineUnitCents(draftMenu, draftLine) * quantity)}
            </Button>
          </div>
          {error ? (
            <p
              aria-live="polite"
              className="mt-4 rounded-lg bg-wayne-alert-soft p-3 text-sm font-bold text-wayne-alert"
            >
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </dialog>
  );
}

function CartLineOptions({
  item,
  line,
}: {
  item: MenuItem | undefined;
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

function updateQuantity(cart: CartLine[], lineId: string, quantity: number) {
  return quantity < 1
    ? cart.filter((line) => line.line_id !== lineId)
    : cart.map((line) =>
        line.line_id === lineId
          ? { ...line, quantity: Math.min(20, quantity) }
          : line,
      );
}
