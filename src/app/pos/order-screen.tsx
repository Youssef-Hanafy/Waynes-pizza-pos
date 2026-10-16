"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { StoreSettings } from "@/lib/content/schemas";
import { formatCents, type PublicMenu } from "@/lib/menu/schemas";
import { cartLineUnitCents, cartSubtotalCents, describeLineModifiers, findMenuItem } from "@/lib/orders/cart";
import { draftLabel, draftToAddItemsPayload, type PosDraft } from "@/lib/orders/drafts";
import { posItemsAddedSchema } from "@/lib/pos/schemas";
import type { CartLine } from "@/lib/orders/schemas";
import type { OpenOrder } from "@/lib/orders/status";
import type { CheckoutPaymentConfig } from "@/lib/payments/schemas";
import { formatPhone } from "@/lib/phone/normalize";
import { draftSync, useSyncState } from "@/stores/draft-sync";
import { requestReceipt } from "@/lib/printing/request-receipt";
import { getHardwareRuntime } from "@/stores/hardware-store";
import { orderActions, paymentPromptStore, useActiveDraft, useDrafts } from "@/stores/order-store";
import { phoneActions } from "@/stores/phone-store";
import { showOnCustomerScreen } from "@/stores/customer-display-link";
import { FitGrid } from "./fit-grid";
import { ticketNumber } from "@/lib/orders/ticket-number";
import { PosItemDialog } from "./item-dialog";
import { PaymentPrompt } from "./payments-screen";
import { releaseOrderPrint, releaseOrderPrintNow } from "@/lib/printing/release-print";
import { StartOrderCard } from "./start-order-card";
import { OpenItemDialog } from "./open-item-dialog";

type MenuItem = PublicMenu[number]["items"][number];

type Props = {
  canManageDiscount: boolean;
  menu: PublicMenu;
  settings: StoreSettings;
  onOpenPhone: () => void;
  /** Stripe (online) connection for keyed-in cards; null when Stripe isn't connected. */
  keyedCardConfig: Extract<CheckoutPaymentConfig, { provider: "stripe" }> | null;
  /** Admin → Hardware → Payment terminal is the Stripe Reader M2. */
  stripeReader: boolean;
};

/**
 * The ordering screen (build sheet §10).  Everything about the ticket lives in
 * the active draft, so holding it, taking a second call and coming back leaves
 * it exactly as it was (§36), and a refresh does too (test 15).
 */
export function OrderScreen({ canManageDiscount, menu, settings, onOpenPhone, keyedCardConfig, stripeReader }: Props) {
  const draft = useActiveDraft();
  const { drafts, activeId } = useDrafts();
  const held = drafts.filter((candidate) => candidate.id !== activeId);
  const { remote } = useSyncState();
  const update = orderActions.update;

  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null);
  const [editingLine, setEditingLine] = useState<CartLine | null>(null);
  /** The open-item box: null closed, "new", or the line being changed. */
  const [openItem, setOpenItem] = useState<CartLine | "new" | null>(null);
  const [itemSearch, setItemSearch] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  /** The order just sent, shown with the payment prompt until it is paid or left to pay later. */
  const [created, setCreated] = useState<{ order: OpenOrder; duplicate: boolean; delivery: boolean; added?: "merged" | "add_on" } | null>(null);
  const [printNote, setPrintNote] = useState("");
  /** The payment screen the cashier left with "Add more items": Cancel and Add both come back to it (owner, 2026-10-16). */
  const [returnTo, setReturnTo] = useState<{ order: OpenOrder; delivery: boolean } | null>(null);
  const ticketListRef = useRef<HTMLDivElement>(null);
  const paying = created !== null;
  useEffect(() => {
    paymentPromptStore.set(paying);
    return () => paymentPromptStore.set(false);
  }, [paying]);

  /** Through the printer layer only (§23): which printer, and how, is Admin → Hardware's business. */
  async function print(kind: "receipt" | "kitchen") {
    if (!created) return;
    if (kind === "receipt") {
      setPrintNote("Printing…");
      setPrintNote((await requestReceipt(created.order.id)).message);
      return;
    }
    // Still waiting for the payment step: print the queued ticket now instead of a second copy.
    if (await releaseOrderPrintNow(created.order.id)) { setPrintNote("Kitchen ticket is printing now."); return; }
    const runtime = getHardwareRuntime();
    if (!runtime) { setPrintNote("Printing is still starting up. Try again in a moment."); return; }
    setPrintNote("Printing…");
    const result = await runtime.kitchenPrinter.printKitchenTicket(created.order.id);
    setPrintNote(result.ok ? (result.jobId === "print-dialog" ? "Sent to the print dialog." : "Sent to the printer.") : result.reason);
  }

  const [confirmClear, setConfirmClear] = useState(false);

  const visibleMenu = useMemo(() => menu.map((category) => ({ ...category, items: category.items.filter((item) => item.name.toLowerCase().includes(itemSearch.trim().toLowerCase())) })).filter((category) => category.items.length), [itemSearch, menu]);
  const cart = draft.cart;
  const noProfile = draft.customerMode === "walk_in";
  /** Adding items to an order already sent (owner, 2026-10-13). */
  const addTo = draft.addTo;
  const subtotal = cartSubtotalCents(menu, cart);
  const manualInput = Number(draft.manualValue) || 0;
  const previewDiscount = addTo ? 0 : draft.manualType === "fixed" ? Math.min(subtotal, Math.round(manualInput * 100)) : draft.manualType === "percent" ? Math.min(subtotal, Math.round(subtotal * manualInput / 100)) : 0;
  // Added items never pay the delivery fee again.
  const deliveryFee = !addTo && draft.fulfillment === "delivery" ? settings.delivery_fee_cents : 0;
  // The $2 delivery fee is not taxed (owner, 2026-10-11) — same as the database.
  const tax = Math.round((subtotal - previewDiscount) * settings.tax_rate_basis_points / 10_000);
  const previewTotal = subtotal - previewDiscount + deliveryFee + tax;

  // The customer screen follows the ticket as it is rung up (owner, 2026-10-11).
  useEffect(() => {
    if (created) return;
    if (!cart.length) { showOnCustomerScreen({ phase: "idle" }); return; }
    const lines = cart.map((line) => {
      const item = findMenuItem(menu, line.menu_item_id);
      const variant = item?.variants.find((candidate) => candidate.id === line.variant_id);
      const notes = describeLineModifiers(item, line).map((note) => note.label);
      if (line.open_item) return { name: line.open_item.name, detail: line.special_instructions.slice(0, 200), quantity: line.quantity, cents: line.open_item.price_cents * line.quantity };
      return { name: item?.name ?? "Item", detail: [variant?.name, ...notes].filter(Boolean).join(" · ").slice(0, 200), quantity: line.quantity, cents: cartLineUnitCents(menu, line) * line.quantity };
    });
    showOnCustomerScreen({ phase: "order", lines, subtotal_cents: subtotal, discount_cents: previewDiscount, delivery_fee_cents: deliveryFee, tax_cents: tax, total_cents: previewTotal });
  }, [cart, created, menu, subtotal, previewDiscount, deliveryFee, tax, previewTotal]);

  // The newest item is always in view while ringing up (owner, 2026-10-16).
  const lineCount = cart.length;
  const lastLineCount = useRef(lineCount);
  useEffect(() => {
    const list = ticketListRef.current;
    if (list && lineCount > lastLineCount.current) list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
    lastLineCount.current = lineCount;
  }, [lineCount]);

  function setCart(next: CartLine[]) { update({ cart: next }); }

  const fromCall = Boolean(draft.phoneCallKey);

  /** Add the ticket's items to the order it was opened for (Today's Orders → Add items). */
  async function submitAddition() {
    if (!addTo || submitting) return;
    if (!cart.length) { setError("Add at least one item."); return; }
    setSubmitting(true); setError("");
    try {
      const response = await fetch(`/api/pos/orders/${addTo.orderId}/items`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draftToAddItemsPayload(draft)), signal: AbortSignal.timeout(20_000),
      });
      const body: unknown = await response.json().catch(() => null);
      const parsed = posItemsAddedSchema.safeParse(body);
      if (!response.ok || !parsed.success) throw new Error(body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : "The items could not be added.");
      const result = parsed.data;
      setPrintNote("");
      setCreated({
        duplicate: result.duplicate, delivery: addTo.fulfillment === "delivery", added: result.mode,
        order: {
          id: result.order_id, order_number: result.order_number, daily_number: result.daily_number ?? addTo.dailyNumber,
          parent_order_id: result.mode === "add_on" ? (result.parent_order_id ?? addTo.orderId) : null,
          total_cents: result.total_cents, customer_name: returnTo?.order.customer_name ?? addTo.customerName, fulfillment_type: addTo.fulfillment, source: returnTo?.order.source ?? draft.source,
          status: "placed", payment_method: "", payment_status: "unpaid", placed_at: new Date().toISOString(), promised_at: null, ready_at: null,
          is_test: draft.isTest,
        },
      });
      void draftSync.discard(draft);
      orderActions.clearActive();
      setReturnTo(null);
    } catch (cause) {
      // Same key on the next try: the items can never be added twice.
      setError(cause instanceof Error && cause.name !== "TimeoutError" ? cause.message : "No answer — tap Add again (it won't add them twice).");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitOrder() {
    if (addTo) { await submitAddition(); return; }
    if (!cart.length) { setError("Add at least one item to the ticket."); return; }
    if (submitting) return;
    setSubmitting(true); setError("");
    // Only a server answer counts as sent (§30). A dropped connection keeps the
    // ticket and resends it, with the same idempotency key, when it is back.
    // Walk-ins without a profile always go out as pickup (see draftToOrderPayload).
    const delivery = draft.fulfillment === "delivery" && !noProfile;
    const customerName = draft.customer ? `${draft.customer.first_name} ${draft.customer.last_name}` : `${draft.firstName} ${draft.lastName}`.trim();
    const source = draft.source;
    const result = await draftSync.submit(draft.id);
    setSubmitting(false);
    if (result.ok) {
      setPrintNote("");
      const now = new Date().toISOString();
      setCreated({
        duplicate: result.order.duplicate, delivery,
        order: {
          id: result.order.id, order_number: result.order.order_number, total_cents: result.order.total_cents,
          daily_number: result.order.daily_number ?? null, parent_order_id: null,
          customer_name: customerName, fulfillment_type: delivery ? "delivery" : "pickup", source,
          status: "placed", payment_method: "", payment_status: "unpaid", placed_at: now, promised_at: null, ready_at: null,
          is_test: draft.isTest,
        },
      });
      return;
    }
    setError(result.message);
  }

  async function takeOver(id: string) {
    setError("");
    const result = await draftSync.takeOver(id);
    if (!result.ok) setError(result.message);
  }

  function clearTicket() {
    if (draftHasWork(draft) && !confirmClear) { setConfirmClear(true); return; }
    setConfirmClear(false);
    if (draft.phoneCallKey) void phoneActions.releaseCall(draft.phoneCallKey);
    void draftSync.discard(draft);
    orderActions.clearActive(); setError("");
  }

  /**
   * Payment screen → "Add more items" (owner, 2026-10-16): back to the menu on the
   * same order, then straight back to payment for the new total.  The kitchen
   * ticket stays held, so it prints once with everything on it.
   */
  function addMoreItems() {
    if (!created) return;
    const order = created.order;
    setReturnTo({ order, delivery: created.delivery });
    orderActions.addToOrder({ id: order.id, order_number: order.order_number, daily_number: order.daily_number ?? null, customer_name: order.customer_name, fulfillment_type: order.fulfillment_type, paid: false });
    setCreated(null); setPrintNote(""); setError("");
  }

  function cancelAddition() {
    void draftSync.discard(draft); orderActions.clearActive(); setError("");
    if (returnTo && addTo && returnTo.order.id === addTo.orderId) setCreated({ order: returnTo.order, delivery: returnTo.delivery, duplicate: false });
    setReturnTo(null);
  }

  // The kitchen ticket waits for this payment step so it prints PAID / NOT PAID
  // correctly (owner, 2026-10-12); leaving it lets the ticket print.
  function closePayment() {
    if (created) releaseOrderPrint(created.order.id);
    setCreated(null);
  }

  // Sent: ask for payment right away (owner, 2026-09-30).
  if (created) {
    const resumable = held.filter(isWorthResuming);
    return <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto bg-wayne-cream-deep p-3 sm:p-6">
      <section aria-label="Take payment" className="w-full max-w-4xl rounded-3xl border border-wayne-border bg-white p-5 shadow-xl sm:p-7">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-wayne-ok-soft px-4 py-3">
          <p className="font-black text-wayne-ok">✓ {created.added === "merged" ? `Added to order #${ticketNumber(created.order)} — new total ${formatCents(created.order.total_cents)}` : created.added === "add_on" ? `Add-on to #${ticketNumber(created.order)} sent to the kitchen — paid on its own` : created.duplicate ? "Already sent" : "Sent to the kitchen"} · #{ticketNumber(created.order)}</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-wayne-muted">{created.delivery ? "Kitchen ticket + delivery receipt print" : "Kitchen ticket prints"} once they pay or you tap {created.delivery ? "Cash at the door" : "Pay later"} — marked PAID / NOT PAID</span>
            <Button onClick={() => void print("receipt")} size="sm" variant="secondary">Print receipt</Button>
            <Button onClick={() => void print("kitchen")} size="sm" variant="secondary">Print kitchen now</Button>
          </div>
        </div>
        {printNote ? <p aria-live="polite" className="-mt-3 mb-3 text-sm font-bold">{printNote}</p> : null}
        <h1 className="mb-4 text-3xl font-black">How are they paying?</h1>
        <PaymentPrompt key={`${created.order.id}-${created.order.total_cents}`} keyedCardConfig={keyedCardConfig} onAddItems={addMoreItems} onFinished={closePayment} onPayLater={closePayment} order={created.order} stripeReader={stripeReader} />
        {resumable.length ? <div className="mt-6 grid gap-2 border-t border-wayne-border pt-4"><p className="text-sm font-black uppercase tracking-[0.14em] text-wayne-muted">Tickets on hold</p><div className="flex flex-wrap gap-2">{resumable.map((candidate) => <Button key={candidate.id} onClick={() => { orderActions.resume(candidate.id); closePayment(); }} size="sm" variant="secondary">Resume {draftLabel(candidate)} · {candidate.cart.length} item{candidate.cart.length === 1 ? "" : "s"}</Button>)}</div></div> : null}
      </section>
    </div>;
  }

  const summary = addTo
    ? { icon: "➕", title: `Adding to #${addTo.dailyNumber ?? addTo.orderNumber.replace(/^W0*/, "")}${addTo.customerName ? ` · ${addTo.customerName}` : ""}`, detail: addTo.paid ? "Already paid — these items go out as an add-on and are paid on their own" : "Not paid yet — these items go on the same order" }
    : ticketSummary(draft, settings);
  if (draft.isTest) summary.title = `🧪 TEST · ${summary.title}`;
  const topBar = <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-wayne-border bg-white px-3 py-1.5">
    {addTo ? <div className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl border-2 border-wayne-gold bg-wayne-gold/15 px-2 py-1">
      <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-xl bg-wayne-gold text-xl">{summary.icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-base font-black">{summary.title}</span>
        <span className="block truncate text-sm font-bold text-wayne-muted">{summary.detail}</span>
      </span>
      <button className="ml-auto min-h-11 shrink-0 rounded-lg border border-wayne-border bg-white px-3 text-sm font-bold" onClick={cancelAddition} type="button">{returnTo && returnTo.order.id === addTo.orderId ? "‹ Back to payment" : "Cancel"}</button>
    </div> : draft.started ? <button aria-label="Edit order details" className="flex min-h-11 min-w-0 max-w-full items-center gap-3 rounded-xl px-2 text-left hover:bg-wayne-cream" onClick={() => update({ started: false })} type="button">
      <span aria-hidden className={`grid size-10 shrink-0 place-items-center rounded-xl text-xl ${draft.source === "phone" ? "bg-wayne-green text-white" : "bg-wayne-cream"}`}>{summary.icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-base font-black">{summary.title}</span>
        <span className="block truncate text-sm text-wayne-muted">{summary.detail}</span>
      </span>
      <span className="ml-2 shrink-0 rounded-lg border border-wayne-border px-3 py-1.5 text-sm font-bold">Edit</span>
    </button> : <p className="flex-1 text-sm font-black uppercase tracking-[0.12em] text-wayne-muted">{draft.cart.length ? "Editing order details" : "Starting a new order"}</p>}
    {remote.length ? <details className="relative"><summary className="flex min-h-11 cursor-pointer items-center rounded-full border border-dashed border-wayne-border-strong px-3 text-sm font-bold">Other registers ({remote.length})</summary><div className="absolute right-0 z-40 mt-1 grid w-80 gap-2 rounded-2xl border border-wayne-border bg-white p-3 shadow-xl">{remote.map((ticket) => <div className="rounded-xl border border-wayne-border p-2" key={ticket.id}><p className="text-sm font-bold">{ticket.label || "Ticket"}{ticket.item_count ? ` · ${ticket.item_count} item${ticket.item_count === 1 ? "" : "s"}` : ""}</p><p className="text-xs text-wayne-muted">{ticket.status === "held" ? "On hold" : "Open"} on {ticket.terminal || "another register"}{ticket.owner_name ? ` · ${ticket.owner_name}` : ""}</p><Button className="mt-2 w-full" onClick={() => void takeOver(ticket.id)} size="sm" variant="secondary">Take over here</Button></div>)}</div></details> : null}
    {held.length ? <div className="flex flex-wrap gap-1.5">{held.map((candidate) => <button className="min-h-11 rounded-full border border-wayne-border bg-wayne-cream px-3 text-sm font-bold" key={candidate.id} onClick={() => { orderActions.resume(candidate.id); setError(""); }} type="button">{candidate.submitPending ? "⟳ " : "⏸ "}{draftLabel(candidate)}{candidate.cart.length ? ` · ${candidate.cart.length}` : ""}{candidate.submitPending ? " · sending" : ""}</button>)}</div> : null}
    {draftHasWork(draft) ? <Button onClick={() => { orderActions.hold(); setError(""); }} size="sm" variant="secondary">＋ New order <span className="font-normal text-wayne-muted">(holds this one)</span></Button> : null}
  </div>;

  if (!draft.started) return <div className="flex min-h-0 flex-1 flex-col">
    {topBar}
    <StartOrderCard draft={draft} key={draft.id} onOpenPhone={fromCall ? onOpenPhone : undefined} settings={settings} />
  </div>;

  const itemCount = cart.reduce((sum, line) => sum + line.quantity, 0);
  const addToLabel = addTo ? `#${addTo.dailyNumber ?? addTo.orderNumber.replace(/^W0*/, "")}` : "";
  // One button from ticket to payment (owner, 2026-10-16): it sends the order and opens the payment screen.
  const submitLabel = submitting ? (addTo ? "Adding…" : "Sending…")
    : addTo ? (addTo.paid ? `Add-on to ${addToLabel} · take payment · ${formatCents(previewTotal)}` : `Add to ${addToLabel} · take payment`)
    : draft.submitPending ? "Try sending now"
    : `${draft.isTest ? "TEST · " : ""}Take payment · ${formatCents(previewTotal)}`;
  const shownCategories = itemSearch.trim() ? visibleMenu : visibleMenu.filter((category) => category.id === (categoryId ?? visibleMenu[0]?.id));
  const shownItems = shownCategories.flatMap((category) => category.items);

  return <div className="flex min-h-0 flex-1 flex-col">
    <main className="grid flex-1 grid-cols-1 md:min-h-0 md:grid-cols-[1fr_21rem] lg:grid-cols-[1fr_26rem] xl:grid-cols-[1fr_30rem] 2xl:grid-cols-[1fr_34rem]">
      {/* Order bar over the menu only, so the ticket gets the whole height on the right (owner, 2026-10-16). */}
      <div className="flex min-w-0 flex-col md:min-h-0">
      {topBar}
      <section aria-label="Menu" className="flex min-w-0 flex-1 flex-col gap-2.5 p-3 md:min-h-0">
        {/* Categories as an even grid across the whole width (search takes the last two cells), so the items below get all the height that's left. */}
        <div className="grid shrink-0 gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(7.25rem, 1fr))" }}>
          {visibleMenu.map((category) => {
            const selected = !itemSearch.trim() && category.id === (categoryId ?? visibleMenu[0]?.id);
            return <button aria-pressed={selected} className={`flex min-h-12 items-center justify-center rounded-xl px-2 text-center text-sm font-black leading-tight transition active:scale-95 ${selected ? "bg-wayne-green text-white shadow-md" : "border border-wayne-border bg-white text-wayne-ink shadow-sm hover:bg-wayne-cream"}`} key={category.id} onClick={() => { setCategoryId(category.id); setItemSearch(""); }} type="button">{category.name}</button>;
          })}
          <button className="flex min-h-12 items-center justify-center rounded-xl border-2 border-dashed border-wayne-green bg-white px-2 text-center text-sm font-black leading-tight text-wayne-green active:scale-95" onClick={() => setOpenItem("new")} type="button">＋ Open item</button>
          <input aria-label="Search menu" className="col-span-2 min-h-12 min-w-0 rounded-xl border border-wayne-border bg-white px-3 text-base" onChange={(event) => setItemSearch(event.target.value)} placeholder="🔍  Search" type="search" value={itemSearch} />
        </div>
        {shownItems.length ? <FitGrid className="flex-1" count={shownItems.length} fallbackClassName="grid grid-cols-2 content-start gap-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5" key={itemSearch.trim() ? "search" : (categoryId ?? visibleMenu[0]?.id ?? "")} label="Menu items" minHeight={64} minWidth={120} ratio={1.5}>{(cellHeight) => {
          const roomy = cellHeight === null || cellHeight >= 92;
          return shownItems.map((item) => <button className={`flex min-w-0 flex-col overflow-hidden rounded-xl border border-wayne-border bg-white text-left shadow-sm transition active:scale-95 disabled:opacity-50 ${cellHeight === null ? "min-h-24 p-3" : roomy ? "p-3" : "px-3 py-2"}`} disabled={item.sold_out} key={item.id} onClick={() => setSelectedItem(item)} type="button"><strong className={`line-clamp-2 block leading-tight ${roomy ? "text-lg" : "text-base"}`}>{item.name}</strong><span className={`mt-auto font-black text-wayne-red ${roomy ? "pt-1 text-base" : "text-sm"}`}>{item.variants.length > 1 ? `From ${formatCents(Math.min(...item.variants.map((variant) => variant.price_cents)))}` : formatCents(item.variants[0]?.price_cents ?? item.base_price_cents)}{item.sold_out ? <span className="ml-1 text-wayne-ink">· Sold out</span> : null}</span></button>);
        }}</FitGrid> : <p className="rounded-xl bg-white p-6 text-center text-wayne-muted">{itemSearch.trim() ? `Nothing on the menu matches “${itemSearch}”.` : "Nothing in this category."}</p>}
      </section>
      </div>
      <aside aria-label="Current ticket" className="flex flex-col border-t border-wayne-border bg-white md:min-h-0 md:border-l md:border-t-0">
        <div className="flex shrink-0 items-center justify-between px-3 pt-1.5"><h2 className="text-lg font-black">Ticket{itemCount ? ` · ${itemCount} item${itemCount === 1 ? "" : "s"}` : ""}</h2><button className="min-h-10 px-2 text-sm font-bold text-wayne-red underline" onBlur={() => setConfirmClear(false)} onClick={clearTicket} type="button">{confirmClear ? "Tap again to clear" : "Clear"}</button></div>
        {/* One compact row per item so a whole order fits without scrolling; tap a row for −/+/Edit/Remove (owner, 2026-10-16). */}
        <div className="flex-1 px-1.5 md:min-h-0 md:overflow-y-auto" ref={ticketListRef}>{cart.length ? <ul className="space-y-2 py-1">{cart.map((line) => {
          const item = findMenuItem(menu, line.menu_item_id);
          const variant = item?.variants.find((candidate) => candidate.id === line.variant_id);
          return <TicketLine cents={cartLineUnitCents(menu, line) * line.quantity} detail={line.open_item ? "Open item" : variant?.name ?? ""} key={line.line_id} modifiers={describeLineModifiers(item, line)} note={line.special_instructions} onEdit={() => { if (line.open_item) setOpenItem(line); else if (item) { setEditingLine(line); setSelectedItem(item); } }} onQuantity={(quantity) => setCart(updateQuantity(cart, line.line_id, quantity))} onRemove={() => { setCart(cart.filter((candidate) => candidate.line_id !== line.line_id)); }} quantity={line.quantity} title={line.open_item ? line.open_item.name : item?.name ?? "Item no longer on the menu"} />;
        })}</ul> : <p className="m-1.5 rounded-xl bg-wayne-cream p-5 text-center text-wayne-muted">Tap a menu item to add it.</p>}</div>
        <div className="shrink-0 border-t border-wayne-border px-3 pb-3 pt-2">
          {addTo ? <details className="rounded-xl border border-wayne-border px-2 py-1"><summary className="min-h-9 cursor-pointer content-center text-sm font-bold">Note for the kitchen{draft.orderNote ? " •" : ""}</summary><textarea aria-label="Note for the kitchen" className="mb-1 mt-1 w-full rounded-lg border border-wayne-border p-2" maxLength={500} onChange={(e) => update({ orderNote: e.target.value })} rows={2} value={draft.orderNote} /></details> : <details className="rounded-xl border border-wayne-border px-2 py-1"><summary className="min-h-9 cursor-pointer content-center text-sm font-bold">Notes, promo &amp; discount{draft.orderNote || draft.promoCode || draft.manualType ? " •" : ""}</summary><label className="mt-2 grid gap-2 text-sm font-bold">Order notes<textarea className="rounded-lg border border-wayne-border p-2 font-normal" maxLength={1500} onChange={(e) => update({ orderNote: e.target.value })} rows={2} value={draft.orderNote} /></label><div className="mt-2 grid grid-cols-2 gap-2"><label className="text-sm font-bold">Promotion code<input className="mt-1 min-h-11 w-full rounded-lg border px-2 font-normal uppercase" disabled={Boolean(draft.manualType)} onChange={(e) => update({ promoCode: e.target.value })} value={draft.promoCode} /></label><label className="text-sm font-bold">Payment<select className="mt-1 min-h-11 w-full rounded-lg border bg-white px-2 font-normal" onChange={(e) => update({ paymentMethod: e.target.value as "test_manual" | "cash" })} value={draft.paymentMethod}><option value="test_manual">Normal (pay in Payments)</option><option value="cash">Cash (unpaid)</option></select></label></div>{canManageDiscount ? <div className="mt-2 grid gap-2"><select className="min-h-11 rounded-lg border bg-white px-2" disabled={Boolean(draft.promoCode)} onChange={(e) => update({ manualType: e.target.value as "" | "fixed" | "percent" })} value={draft.manualType}><option value="">No manual discount</option><option value="fixed">Fixed dollars</option><option value="percent">Percent</option></select>{draft.manualType ? <><Input id="pos-manual-value" label={draft.manualType === "fixed" ? "Amount ($)" : "Percent (%)"} min="0" onChange={(e) => update({ manualValue: e.target.value })} step="0.01" type="number" value={draft.manualValue} /><Input id="pos-manual-reason" label="Required reason" onChange={(e) => update({ manualReason: e.target.value })} value={draft.manualReason} /></> : null}</div> : null}</details>}
          <div className="mt-2 flex flex-wrap justify-between gap-x-3 text-sm text-wayne-muted"><span>Subtotal {formatCents(subtotal)}</span>{previewDiscount ? <span>Discount −{formatCents(previewDiscount)}</span> : null}{deliveryFee ? <span>Delivery {formatCents(deliveryFee)}</span> : null}<span>Tax {formatCents(tax)}</span></div>
          <div className="mt-0.5 flex items-baseline justify-between text-2xl font-black"><span>{addTo ? "Adding" : draft.promoCode ? "Est. total*" : "Total"}</span><span>{formatCents(previewTotal)}</span></div>
          {draft.submitPending ? <p aria-live="polite" className="mt-2 rounded-xl bg-wayne-warn-soft p-2 text-sm font-bold">Not sent yet — waiting for the connection. It sends by itself; pressing the button again is safe.</p> : null}
          {error && !draft.submitPending ? <p aria-live="polite" className="mt-2 rounded-xl bg-wayne-alert-soft p-2 text-sm font-bold text-wayne-alert">{error}</p> : null}
          <Button className="mt-2 min-h-14 w-full text-lg" disabled={submitting || !cart.length} onClick={submitOrder}>{submitLabel}</Button>
        </div>
      </aside>
    </main>
    {openItem ? <OpenItemDialog initialLine={openItem === "new" ? null : openItem} onAdd={(line) => { setCart(openItem === "new" ? [...cart, line] : cart.map((candidate) => candidate.line_id === line.line_id ? line : candidate)); setOpenItem(null); }} onClose={() => setOpenItem(null)} /> : null}
    {selectedItem ? <PosItemDialog initialLine={editingLine} item={selectedItem} onAdd={(line) => { setCart(editingLine ? cart.map((candidate) => candidate.line_id === editingLine.line_id ? line : candidate) : [...cart, line]); setEditingLine(null); setSelectedItem(null); }} onClose={() => { setEditingLine(null); setSelectedItem(null); }} /> : null}
  </div>;
}

function draftHasWork(draft: PosDraft) {
  return draft.cart.length > 0 || draft.source === "phone" || Boolean(draft.customer || draft.firstName || draft.orderNote);
}

function isWorthResuming(draft: PosDraft) {
  return draftHasWork(draft);
}

/** One line saying what this ticket is, for the bar above the menu. */
function ticketSummary(draft: PosDraft, settings: StoreSettings) {
  const who = draft.customer ? `${draft.customer.first_name} ${draft.customer.last_name}` : `${draft.firstName} ${draft.lastName}`.trim();
  const how = draft.source === "phone" ? `Phone${draft.phoneLine ? ` · Line ${draft.phoneLine}` : ""}` : "In store";
  if (draft.customerMode === "walk_in") {
    return { icon: "🚶", title: `${draft.source === "phone" ? "Pickup (no profile)" : "Walk-in"}${who ? ` · ${who}` : ""}`, detail: `${how}${draft.phone && draft.source === "phone" ? ` · ${formatPhone(draft.phone)}` : ""} · tap to change` };
  }
  const phone = draft.phone ? formatPhone(draft.phone) : "";
  if (draft.fulfillment === "delivery") {
    const saved = draft.customer?.addresses.find((address) => address.id === draft.addressId);
    const address = saved ? `${saved.address1}${saved.address2 ? `, ${saved.address2}` : ""}, ${saved.city}` : [draft.address.address1, draft.address.address2, draft.address.city].filter(Boolean).join(", ");
    return { icon: "🚗", title: `Delivery · ${who || "Customer"}`, detail: [phone, address, `+${formatCents(settings.delivery_fee_cents)} delivery`].filter(Boolean).join(" · ") };
  }
  return { icon: "🛍️", title: `Pickup · ${who || "Customer"}`, detail: [phone, how].filter(Boolean).join(" · ") };
}

/** One item on the ticket, as the original card: name, size, price, options, and −/+/Edit/Remove. */
function TicketLine({ title, detail, modifiers, note, cents, quantity, onQuantity, onEdit, onRemove }: { title: string; detail: string; modifiers: { kind: string; label: string }[]; note: string; cents: number; quantity: number; onQuantity: (quantity: number) => void; onEdit: () => void; onRemove: () => void }) {
  return <li className="rounded-xl bg-wayne-cream p-3">
    <div className="flex justify-between gap-2"><div><strong>{quantity}× {title}</strong>{detail ? <p className="text-sm text-wayne-muted">{detail}</p> : null}</div><strong>{formatCents(cents)}</strong></div>
    {modifiers.length ? <p className="mt-1 flex flex-wrap gap-1 text-sm">{modifiers.map((entry) => <span className={`rounded px-1.5 font-bold ${entry.kind === "removed" ? "bg-wayne-red-soft text-wayne-red" : "bg-wayne-ok-soft text-wayne-ok"}`} key={entry.label}>{entry.label}</span>)}</p> : null}
    {note ? <p className="mt-1 text-sm">Note: {note}</p> : null}
    <div className="mt-2 flex gap-2">
      <button aria-label="Decrease item" className="h-11 w-11 rounded-lg border bg-white" onClick={() => onQuantity(quantity - 1)} type="button">−</button>
      <button aria-label="Increase item" className="h-11 w-11 rounded-lg border bg-white" onClick={() => onQuantity(quantity + 1)} type="button">+</button>
      <button className="min-h-11 px-1 text-sm font-bold underline" onClick={onEdit} type="button">Edit</button>
      <button className="ml-auto min-h-11 px-1 text-sm font-bold text-wayne-red" onClick={onRemove} type="button">Remove</button>
    </div>
  </li>;
}
function updateQuantity(cart: CartLine[], lineId: string, quantity: number) { return quantity < 1 ? cart.filter((line) => line.line_id !== lineId) : cart.map((line) => line.line_id === lineId ? { ...line, quantity: Math.min(20, quantity) } : line); }
