"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { StoreSettings } from "@/lib/content/schemas";
import type { HardwareSettings } from "@/lib/hardware/schemas";
import type { PublicMenu } from "@/lib/menu/schemas";
import type { CheckoutPaymentConfig } from "@/lib/payments/schemas";
import { activeDraft, draftFromCall, draftHasContent, isDraftIdle } from "@/lib/orders/drafts";
import { ringingCallsToOpen } from "@/lib/phone/phone-state";
import type { PosCustomer } from "@/lib/pos/schemas";
import { useHardwareState } from "@/stores/hardware-store";
import { orderActions, orderStore, paymentPromptStore, useActiveDraft, useDrafts } from "@/stores/order-store";
import { getAutoOpenCalls, getTerminalLabel, phoneActions, phoneStore, setAutoOpenCalls, setTerminalLabel, usePhoneBadge } from "@/stores/phone-store";
import { useHardware } from "@/stores/use-hardware";
import { PrintStationBadge, PrintStationPanel, printStationWarning } from "@/components/pos/print-station-panel";
import { StripeReaderStatus } from "@/components/pos/stripe-reader-panel";
import { connectStripeReader, describeNativeApp, keepStripeReaderConnected, startStripeReader } from "@/stores/stripe-reader";
import { getOnlineChimeEnabled, playOrderChime, setOnlineChimeEnabled, useOnlineOrderAlerts } from "@/stores/online-order-alerts";
import { formatCents } from "@/lib/menu/schemas";
import { usePrintStationRunner } from "@/stores/use-print-station";
import { dismissNotice, useSyncState } from "@/stores/draft-sync";
import { useDraftSync } from "@/stores/use-draft-sync";
import { closeOutUnsentTickets, keepUnsettledOrder } from "@/stores/ticket-closeout";
import { CustomersScreen } from "./customers-screen";
import { DrawerPanel } from "./drawer-panel";
import { OpenDrawerButton } from "./open-drawer-button";
import { DeliveriesScreen } from "./deliveries-screen";
import { setCustomerTipOptions, startCustomerDisplayLink } from "@/stores/customer-display-link";
import { TestOrdersPanel } from "./test-orders-panel";
import { ClockButton } from "./clock-button";
import { OpenOrdersPanel } from "./open-orders-panel";
import { CurrentOrdersRail } from "./current-orders-rail";
import { DayOrdersScreen } from "./day-orders-screen";
import { CloseoutScreen } from "./closeout-screen";
import { TipsScreen } from "./tips-screen";
import { OrderScreen } from "./order-screen";
import { PosKeyboard, getPosKeyboardSetting, setPosKeyboardSetting } from "./pos-keyboard";
import { PaymentsScreen } from "./payments-screen";
import { PhoneScreen, type StartPhoneOrder } from "./phone-screen";
import { SimulatorPanel } from "./simulator-panel";
import { installDeviceErrorLogging, logDevice } from "@/lib/pos/device-log";

type Section = "order" | "phone" | "pay" | "orders" | "today" | "customers" | "delivery" | "tips" | "closeout" | "more";

type Props = {
  menu: PublicMenu;
  settings: StoreSettings;
  hardware: HardwareSettings;
  staffName: string;
  profileId: string;
  canManageDiscount: boolean;
  canManageOrders: boolean;
  canOpenAdmin: boolean;
  canManageHardware: boolean;
  /** Manager: sees and runs the end-of-day close out. */
  canCloseOut: boolean;
  /** Phase 5: module-aware sections for this workspace. */
  callerIdEnabled: boolean;
  deliveryEnabled: boolean;
  workspaceName: string;
  keyedCardConfig: Extract<CheckoutPaymentConfig, { provider: "stripe" }> | null;
};

/**
 * The POS shell (build sheet §6): a tablet-first landscape frame with the
 * permanent header and the sections staff move between.
 *
 * Sections are switched in place rather than by navigation, so the ticket
 * being entered, the phone state and the hardware connection all survive
 * moving around.  A ringing phone lights the PHONE button but never takes
 * the cashier away from what they are doing (§6, §34.1).
 */
export function PosApp(props: Props) {
  const { menu, settings, hardware, staffName, profileId, canManageDiscount, canManageOrders, canOpenAdmin, canManageHardware, canCloseOut, callerIdEnabled, deliveryEnabled, workspaceName, keyedCardConfig } = props;
  // Coming back to the register locks Admin again: the next person has to type
  // a manager PIN to get in (owner, 2026-10-12).
  useEffect(() => { void fetch("/api/admin-lock", { method: "POST" }).catch(() => undefined); }, []);
  const [section, setSection] = useState<Section>("order");
  const [customerFocus, setCustomerFocus] = useState<PosCustomer | null>(null);
  const [phoneFocus, setPhoneFocus] = useState<{ key: string; n: number } | null>(null);
  const [payFocus, setPayFocus] = useState<{ orderId: string; n: number } | null>(null);
  /** Open the Payments screen on one order (from the order-sent screen or the Orders list). */
  function takePayment(orderId: string) {
    // Paying the order that was just sent is not leaving it.
    keepUnsettledOrder(orderId);
    setPayFocus((current) => ({ orderId, n: (current?.n ?? 0) + 1 }));
    setSection("pay");
  }
  const sectionRef = useRef<Section>(section);
  useEffect(() => {
    // Leaving New Order closes out a ticket that was not sent, and its phone call,
    // so the line is free (owner, 2026-10-19: tickets are not held).
    if (sectionRef.current === "order" && section !== "order") closeOutUnsentTickets();
    sectionRef.current = section;
  }, [section]);
  // The customer screen (Fire tablet) mirrors this register.
  useEffect(() => startCustomerDisplayLink(), []);
  // The tip buttons on the customer screen come from Admin → Settings.
  useEffect(() => { setCustomerTipOptions(settings.suggested_tip_percentages, settings.suggested_tip_amounts_cents); }, [settings.suggested_tip_percentages, settings.suggested_tip_amounts_cents]);
  const badge = usePhoneBadge();
  const hardwareState = useHardwareState();
  const { drafts } = useDrafts();
  const currentDraft = useActiveDraft();
  const sendingCount = drafts.filter((draft) => draft.submitPending).length;

  const runtimeReady = useHardware(hardware);
  const stripeReaderOn = hardware.payment_terminal_mode === "integrated";
  const onlineAlerts = useOnlineOrderAlerts(canManageOrders);
  // Diagnostics for the counter tablet: script errors and what this register was given.
  useEffect(() => {
    installDeviceErrorLogging();
    logDevice("pos.open", "", { payment_terminal_mode: hardware.payment_terminal_mode, runtime_ready: runtimeReady, ...describeNativeApp() });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per page load
  }, []);
  // Stripe Reader M2: inside the POS app, connect as soon as the register opens and keep it connected.
  useEffect(() => {
    if (stripeReaderOn && runtimeReady && startStripeReader()) { void connectStripeReader(); keepStripeReaderConnected(); }
  }, [stripeReaderOn, runtimeReady]);
  const printStation = usePrintStationRunner(hardware, runtimeReady);
  useDraftSync();
  // Tickets held before 2026-10-19 (and their phone lines) are closed out when the register opens; the one on screen stays.
  useEffect(() => {
    const timer = window.setTimeout(() => closeOutUnsentTickets({ keepActive: true }), 0);
    return () => window.clearTimeout(timer);
  }, []);
  const { notices } = useSyncState();
  const pendingCount = drafts.filter((draft) => draft.submitPending).length;

  /** startOrderFromCall (§32): claim it, carry the caller in, open the order screen. */
  const startPhoneOrder: StartPhoneOrder = async (call, customer, options = {}) => {
    const result = await phoneActions.startOrderFromCall(call.key, options.force ?? false);
    if (!result.ok && result.reason === "claimed") return { ok: false, claimed: true, message: result.message };
    // A call that already ended or timed out on the screen (the caller hung up
    // while their details were being typed) still gets its order — refusing it
    // here is what made "Create customer + start order" look broken (2026-10-11).
    // Offline: the order is still taken; the call links when the order is sent.
    const current = result.ok ? result.call : call;
    orderActions.startOrResumeForCall(call.key, draftFromCall({
      callKey: call.key, callId: current.serverId, line: call.line, phoneNumber: call.phoneNumber,
      callerName: call.callerName, customer, withoutProfile: options.withoutProfile,
    }));
    setSection("order");
    return { ok: true };
  };

  function startCustomerOrder(customer: PosCustomer) {
    const preferred = customer.addresses.find((address) => address.is_default) ?? customer.addresses[0];
    orderActions.start({
      source: "pos", customerMode: "identified", customer, firstName: customer.first_name, lastName: customer.last_name,
      phone: customer.phone, email: customer.email ?? "", addressId: preferred?.id ?? "",
    });
    setSection("order");
  }

  /**
   * Auto pick-up.  When Line 1 or Line 2 rings, the call opens on this register
   * by itself if the register is idle: an empty ticket or the order lists.
   * Someone in the middle of a ticket, a customer form, settings, or another
   * caller on the phone screen is never pulled away; the PHONE button and the
   * ringing line card light up instead (§34.1).
   */
  useEffect(() => {
    const seen = new Set<string>();
    // Calls already on the lines when the POS opens are not popped.
    for (const call of Object.values(phoneStore.get().calls)) seen.add(call.key);
    let n = 0;
    if (!callerIdEnabled) return;
    return phoneStore.subscribe(() => {
      const ringing = ringingCallsToOpen(phoneStore.get(), seen);
      if (!ringing.length) return;
      for (const call of ringing) seen.add(call.key);
      if (!getAutoOpenCalls()) return;
      const current = sectionRef.current;
      const idle = current === "orders" || current === "delivery"
        || (current === "order" && isDraftIdle(activeDraft(orderStore.get())) && !paymentPromptStore.get());
      if (!idle) return;
      n += 1;
      setPhoneFocus({ key: ringing[0]!.key, n });
      setSection("phone");
    });
  }, [callerIdEnabled]);

  const callerStatus = hardwareState.statuses.caller_id;
  const syncStatus = hardwareState.statuses.caller_sync;
  const warning = !hardwareState.online
    ? `No internet — tickets are saved on this register${pendingCount ? `; ${pendingCount} will send when it is back` : ""}`
    : pendingCount ? `${pendingCount} ticket${pendingCount === 1 ? "" : "s"} waiting to send`
    : callerStatus && callerStatus.state === "error" ? `Caller ID: ${callerStatus.detail ?? callerStatus.label}`
    : syncStatus && syncStatus.state === "disconnected" && runtimeReady ? "Live phone updates reconnecting"
    : printStationWarning(printStation);

  const tabs: { id: Section; label: string }[] = [
    { id: "order", label: `${draftHasContent(currentDraft) ? "Current Order" : "New Order"}${sendingCount ? ` · ${sendingCount} sending` : ""}` },
    ...(callerIdEnabled ? [{ id: "phone" as const, label: badge.waiting ? `Phone (${badge.waiting})` : "Phone" }] : []),
    { id: "pay", label: "Payments" },
    ...(canManageOrders ? [{ id: "orders" as const, label: "Orders" }] : []),
    { id: "today", label: "Today's Orders" },
    { id: "customers", label: "Customers" },
    ...(canManageOrders && deliveryEnabled && settings.delivery_enabled ? [{ id: "delivery" as const, label: "Deliveries" }] : []),
    ...(canCloseOut ? [{ id: "tips" as const, label: "Tips" }, { id: "closeout" as const, label: "Close Out" }] : []),
    { id: "more", label: "More" },
  ];

  // --pos-kb-h: the on-screen keyboard's height, so the page sits above it.
  return <div className={`flex min-h-screen flex-col bg-wayne-cream-deep lg:h-screen lg:overflow-hidden ${section === "order" ? "md:h-screen md:overflow-hidden" : ""}`} style={{ paddingBottom: "var(--pos-kb-h, 0px)" }}>
    <PosKeyboard />
    <header className="flex shrink-0 flex-wrap items-center gap-2 bg-wayne-green px-3 py-2 text-wayne-cream">
      <strong className="mr-auto text-lg font-black uppercase tracking-[0.08em]">{workspaceName}</strong>
      {callerIdEnabled ? <button aria-label={badge.waiting ? `Phone lines, ${badge.waiting} waiting` : "Phone lines"} className={`min-h-11 rounded-xl px-4 text-base font-black uppercase tracking-wider transition ${badge.ringing ? "animate-pulse bg-wayne-ok text-white ring-4 ring-white/60" : badge.waiting ? "bg-wayne-cream text-wayne-green" : "bg-white/10 text-wayne-cream hover:bg-white/20"}`} onClick={() => { setPhoneFocus(null); setSection("phone"); }} type="button">☎ Phone{badge.waiting ? ` (${badge.waiting})` : ""}</button> : null}
      <PrintStationBadge />
      <OpenDrawerButton />
      <DrawerPanel timeZone={settings.timezone} />
      <span className="hidden text-sm font-bold text-wayne-cream/80 sm:inline">{staffName}</span>
      <ClockButton />
      {canOpenAdmin ? <Button asChild size="sm" variant="secondary"><Link href="/admin">🔒 Admin</Link></Button> : null}
    </header>
    {warning ? <p className="shrink-0 bg-wayne-warn-soft px-3 py-1.5 text-sm font-bold" role="status">⚠ {warning}</p> : null}
    {onlineAlerts.alerts.length ? <div className="flex shrink-0 flex-wrap items-center gap-3 bg-wayne-gold px-3 py-2 text-wayne-ink" role="alert">
      <span aria-hidden className="animate-bounce text-2xl">🔔</span>
      <p className="min-w-0 flex-1 font-black">
        {onlineAlerts.alerts.length === 1 ? "New online order" : `${onlineAlerts.alerts.length} new online orders`}
        <span className="ml-2 font-bold">{onlineAlerts.alerts.slice(-3).map((order) => `${order.order_number} · ${order.customer_name || "Customer"} · ${order.fulfillment_type === "delivery" ? "Delivery" : "Pickup"} · ${formatCents(order.total_cents)}`).join("   |   ")}</span>
      </p>
      <Button onClick={() => { const delivery = onlineAlerts.alerts.every((order) => order.fulfillment_type === "delivery") && deliveryEnabled && settings.delivery_enabled; onlineAlerts.acknowledge(); setPhoneFocus(null); setPayFocus(null); setSection(delivery ? "delivery" : "orders"); }} size="sm" variant="brand">View</Button>
      <Button onClick={onlineAlerts.acknowledge} size="sm" variant="secondary">Got it</Button>
    </div> : null}
    {notices.map((notice) => <div className={`flex shrink-0 items-center justify-between gap-3 px-3 py-1.5 text-sm font-bold ${notice.tone === "warn" ? "bg-wayne-alert-soft text-wayne-alert" : "bg-wayne-ok-soft text-wayne-ok"}`} key={notice.id} role="status"><span>{notice.text}</span><button aria-label="Dismiss" className="min-h-9 px-2" onClick={() => dismissNotice(notice.id)} type="button">×</button></div>)}
    <nav aria-label="POS sections" className="flex shrink-0 gap-1 overflow-x-auto border-b border-wayne-border bg-white px-2 py-1.5">
      {tabs.map((tab) => <button aria-current={section === tab.id ? "page" : undefined} className={`min-h-11 whitespace-nowrap rounded-xl px-4 text-sm font-black transition ${section === tab.id ? "bg-wayne-green text-wayne-cream" : tab.id === "phone" && badge.ringing ? "bg-wayne-ok-soft text-wayne-ok" : "text-wayne-ink hover:bg-wayne-cream"}`} key={tab.id} onClick={() => { setPhoneFocus(null); setPayFocus(null); setSection(tab.id); }} type="button">{tab.label}</button>)}
      {/* Open this on the tablet that faces the customer (owner, 2026-10-11). */}
      {/* A full page load (not a client-side link), so this tablet stops acting as a register. */}
      <a className="ml-auto flex min-h-11 items-center whitespace-nowrap rounded-xl border border-dashed border-wayne-border-strong px-4 text-sm font-black text-wayne-ink hover:bg-wayne-cream" href="/pos/display">🖥 Customer screen</a>
    </nav>

    {section === "order" ? <div className="flex min-h-0 flex-1">
      <CurrentOrdersRail canSeeOrders={canManageOrders} onOpenOrders={() => { setPayFocus(null); setSection(canManageOrders ? "orders" : "today"); }} onPay={takePayment} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <OrderScreen canManageDiscount={canManageDiscount} keyedCardConfig={keyedCardConfig} menu={menu} onOpenPhone={() => { if (callerIdEnabled) setSection("phone"); }} settings={settings} stripeReader={stripeReaderOn} />
      </div>
    </div> : null}
    {section === "pay" ? <PaymentsScreen initialOrderId={payFocus?.orderId ?? null} keyedCardConfig={keyedCardConfig} onAddItems={(order) => {
      // Same as Today's Orders → Add items; adding to an unpaid order brings its payment straight back with the new total.
      orderActions.addToOrder({ id: order.id, order_number: order.order_number, daily_number: order.daily_number ?? null, customer_name: order.customer_name, fulfillment_type: order.fulfillment_type, paid: order.paid_cents > 0 });
      setPayFocus(null); setSection("order");
    }} key={payFocus ? `pay-${payFocus.n}` : "pay"} stripeReader={stripeReaderOn} timeZone={settings.timezone} /> : null}
    {section === "phone" && callerIdEnabled ? <PhoneScreen focusKey={phoneFocus?.key ?? null} key={phoneFocus ? `focus-${phoneFocus.n}` : "phone"} onOpenCustomer={(customer) => { setCustomerFocus(customer); setSection("customers"); }} onStartOrder={startPhoneOrder} profileId={profileId} simulatorAvailable={runtimeReady && hardware.simulator_enabled} timeZone={settings.timezone} /> : null}
    {section === "today" ? <DayOrdersScreen onAddItems={(order) => {
      // Add items to an order already sent (owner, 2026-10-13): the menu opens with a ticket for just the extra items,
      // and they go on that same order even if it was paid (owner, 2026-10-19).
      orderActions.addToOrder({ id: order.id, order_number: order.order_number, daily_number: order.daily_number, customer_name: order.customer_name, fulfillment_type: order.fulfillment_type, paid: order.paid_cents > 0 || order.payment_status === "paid" || order.payment_status === "authorized" });
      setPayFocus(null); setSection("order");
    }} onPay={takePayment} timeZone={settings.timezone} /> : null}
    {section === "orders" && canManageOrders ? <div className="min-h-0 flex-1 overflow-y-auto p-4"><OpenOrdersPanel inline onPay={takePayment} timeZone={settings.timezone} /></div> : null}
    {section === "delivery" && canManageOrders && deliveryEnabled ? <DeliveriesScreen storeName={settings.store_name || workspaceName} timeZone={settings.timezone} /> : null}
    {section === "customers" ? <CustomersScreen focus={customerFocus} key={customerFocus?.id ?? "search"} onStartOrder={startCustomerOrder} timeZone={settings.timezone} /> : null}
    {section === "tips" && canCloseOut ? <TipsScreen onOpenDeliveries={canManageOrders && deliveryEnabled && settings.delivery_enabled ? () => setSection("delivery") : undefined} /> : null}
    {section === "closeout" && canCloseOut ? <CloseoutScreen onOpenTips={() => setSection("tips")} storeName={settings.store_name || workspaceName} tipPayoutName={settings.tip_payout_name || "the owner"} /> : null}
    {section === "more" ? <MoreScreen canManageHardware={canManageHardware} hardware={hardware} runtimeReady={runtimeReady} /> : null}
  </div>;
}

const deviceNames: Record<string, string> = {
  caller_id: "Caller ID", caller_sync: "Live phone updates", receipt_printer: "Receipt printer",
  kitchen_printer: "Kitchen printer", cash_drawer: "Cash drawer", payment_terminal: "Card terminal",
};

function MoreScreen({ canManageHardware, hardware, runtimeReady }: { canManageHardware: boolean; hardware: HardwareSettings; runtimeReady: boolean }) {
  const { statuses, online } = useHardwareState();
  const [terminal, setTerminal] = useState("");
  const [saved, setSaved] = useState(false);
  const [autoOpen, setAutoOpen] = useState(true);
  const [chime, setChime] = useState(true);
  const [keyboard, setKeyboard] = useState<"auto" | "on" | "off">("auto");
  useEffect(() => {
    const timer = window.setTimeout(() => { setTerminal(getTerminalLabel()); setAutoOpen(getAutoOpenCalls()); setChime(getOnlineChimeEnabled()); setKeyboard(getPosKeyboardSetting()); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  return <div className="min-h-0 flex-1 overflow-y-auto p-4">
    <div className="mx-auto grid max-w-3xl gap-4">
      <section className="rounded-3xl bg-white p-5 shadow-sm">
        <h2 className="text-xl font-black">This register</h2>
        <p className="mt-1 text-sm text-wayne-muted">Other registers see this name when you take a call.</p>
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); setTerminalLabel(terminal); setSaved(true); }}>
          <label className="grid flex-1 gap-1.5 text-sm font-bold" htmlFor="terminal-name">Register name<input className="min-h-11 rounded-xl border border-wayne-border px-3 font-normal" id="terminal-name" maxLength={60} onChange={(event) => { setTerminal(event.target.value); setSaved(false); }} value={terminal} /></label>
          <Button type="submit">{saved ? "Saved" : "Save"}</Button>
        </form>
        <label className="mt-4 flex min-h-11 items-start gap-3 text-sm">
          <input checked={chime} className="mt-1 size-5" onChange={(event) => { setChime(event.target.checked); setOnlineChimeEnabled(event.target.checked); }} type="checkbox" />
          <span><strong className="block text-base">Chime for new online orders</strong>Rings when an order comes in from the website, and again every 30 seconds until someone taps <em>Got it</em>. <button className="font-bold underline" onClick={(event) => { event.preventDefault(); playOrderChime(); }} type="button">Test the chime</button></span>
        </label>
        <label className="mt-4 flex min-h-11 items-start gap-3 text-sm">
          <input checked={autoOpen} className="mt-1 size-5" onChange={(event) => { setAutoOpen(event.target.checked); setAutoOpenCalls(event.target.checked); }} type="checkbox" />
          <span><strong className="block text-base">Pick up calls automatically</strong>When Line 1 or Line 2 rings and this register isn&apos;t in the middle of a ticket, the caller&apos;s card opens by itself. Turn off on a register that shouldn&apos;t jump to the phone (e.g. a kitchen tablet).</span>
        </label>
        <div className="mt-4 text-sm">
          <strong className="block text-base">On-screen keyboard</strong>
          <span>Wayne&apos;s compact keyboard along the bottom, instead of the tablet&apos;s own (which covers half the screen). Auto = on for the counter tablet, off with a mouse.</span>
          <div className="mt-2 inline-flex rounded-xl bg-wayne-cream p-1" role="group">
            {(["auto", "on", "off"] as const).map((value) => <button aria-pressed={keyboard === value} className={`min-h-11 rounded-lg px-4 font-black ${keyboard === value ? "bg-wayne-green text-white" : ""}`} key={value} onClick={() => { setKeyboard(value); setPosKeyboardSetting(value); }} type="button">{value === "auto" ? "Auto" : value === "on" ? "Wayne's keyboard" : "Tablet keyboard"}</button>)}
          </div>
        </div>
      </section>
      <section className="rounded-3xl bg-white p-5 shadow-sm">
        <h2 className="text-xl font-black">Hardware</h2>
        <ul className="mt-3 divide-y divide-wayne-border">
          <li className="flex justify-between gap-3 py-2"><span className="font-bold">Internet</span><span>{online ? "✓ Online" : "⚠ Offline"}</span></li>
          {Object.entries(deviceNames).map(([device, name]) => {
            const status = statuses[device as keyof typeof statuses];
            return <li className="flex flex-wrap justify-between gap-3 py-2" key={device}><span className="font-bold">{name}</span><span className="text-right text-sm">{status ? <><strong>{status.label}</strong>{status.detail ? <span className="block text-wayne-muted">{status.detail}</span> : null}</> : runtimeReady ? "—" : "Starting…"}</span></li>;
          })}
        </ul>
        <p className="mt-3 text-sm text-wayne-muted">Caller ID provider: <strong>{hardware.caller_id_provider === "simulated" ? "Simulated" : hardware.caller_id_provider === "cloud" ? "Store bridge (cloud)" : "Android app"}</strong> · {hardware.caller_line_count} lines</p>
        {canManageHardware ? <Button asChild className="mt-3" variant="secondary"><Link href="/admin/hardware">Admin → Hardware</Link></Button> : null}
      </section>
      {hardware.payment_terminal_mode === "integrated" ? <section className="rounded-3xl bg-white p-5 shadow-sm"><h2 className="text-xl font-black">Card reader</h2><p className="mb-3 mt-1 text-sm text-wayne-muted">Stripe Reader M2 over Bluetooth. Press its button once to wake it; it stays connected to this tablet.</p><StripeReaderStatus /></section> : null}
      <PrintStationPanel />
      <TestOrdersPanel />
      {hardware.simulator_enabled ? <section className="rounded-3xl bg-white p-5 shadow-sm"><h2 className="text-xl font-black">Test calls</h2><p className="mb-3 mt-1 text-sm text-wayne-muted">Rings a line through the same path the real caller ID box will use.</p><SimulatorPanel lineCount={hardware.caller_line_count} /></section> : null}
    </div>
  </div>;
}
